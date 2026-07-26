// SPDX-License-Identifier: GPL-3.0-or-later
// Window-management behavior adapted from Mosaic WM
// by Cléo Menezes Jr. and contributors:
// https://github.com/CleoMenezesJr/MosaicWM
// WindowHandler manages window lifecycle signals and state transitions.

import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Logger from './logger.js';
import * as constants from './constants.js';
import {TileZone} from './constants.js';
import * as WindowState from './windowState.js';
import {IS_MINIATURE} from './windowState.js';
import {ComputedLayouts} from './mosaicModel.js';
import {isWindowAlive, isWorkspaceAlive} from './liveness.js';
import {orderWindowsByMru, restoreBeforeRearrange} from './layoutPlanning.js';
import {afterWorkspaceSwitch, afterAnimations, afterWindowClose, monotonicNow} from './timing.js';

export const WindowHandler = GObject.registerClass(
    {
        GTypeName: 'ContinuumWindowHandler',
    },
    class WindowHandler extends GObject.Object {
        _init(extension) {
            super._init();
            this._ext = extension;
            this._workspaceLocks = new WeakMap();

            this._evaluationQueue = [];
            this._isEvaluatingQueue = false;

            this._windowSignals = new WeakMap(); // WeakMap so signal IDs are released when the window is GC'd
            this._scheduledMonitorRebalances = [];
            this._readinessWaiters = new Set();
        }

        destroy() {
            for (const entry of this._evaluationQueue)
                WindowState.remove(entry.window, 'pendingInQueue');
            this._evaluationQueue = [];
            this._isEvaluatingQueue = false;
            this._scheduledMonitorRebalances = [];
            for (const waiter of this._readinessWaiters) {
                for (const id of waiter.ids) waiter.window.disconnect(id);
            }
            this._readinessWaiters.clear();
        }

        // Some windows aren't identifiable at map time (wm_class can arrive seconds
        // late), so retry the gate whenever the relevant state changes.
        _awaitWindowReadiness(window, tryProceed) {
            const waiter = {window, ids: []};
            const finish = () => {
                for (const id of waiter.ids) window.disconnect(id);
                waiter.ids = [];
                this._readinessWaiters.delete(waiter);
            };
            const retry = () => {
                if (!isWindowAlive(window)) {
                    finish();
                    return;
                }
                if (tryProceed()) finish();
            };
            for (const signal of ['notify::wm-class', 'size-changed', 'notify::minimized'])
                waiter.ids.push(window.connect(signal, retry));
            waiter.ids.push(window.connect('unmanaged', finish));
            this._readinessWaiters.add(waiter);
        }

        // Claiming the entrance hides the actor and cancels Mutter's open animation,
        // betting the tile pass eases it in. Whoever the tile pass won't touch (sacred
        // or opening alone) can't take that bet: the failsafe a full second later would
        // be their only way back to visible.
        shouldSkipSlideIn(window) {
            return (
                WindowState.get(window, 'movedByOverflow') ||
                this._ext._overflowInProgress ||
                this.windowingManager.isMaximizedOrFullscreen(window) ||
                this.windowingManager.isExcludedByPolicy(window) ||
                !this._hasSiblings(window)
            );
        }

        _findBornSacredMonitorTarget(window) {
            if (
                !this.windowingManager.isMaximizedOrFullscreen(window) ||
                this.windowingManager.isExcluded(window)
            )
                return null;

            const workspace = window.get_workspace();
            const monitor = window.get_monitor();
            if (!workspace || monitor === null || monitor < 0) return null;

            this.windowingManager.invalidateWindowsCache();
            const hasSourceSiblings = this.windowingManager
                .getMonitorWorkspaceWindows(workspace, monitor)
                .some(w => w.get_id() !== window.get_id());
            if (!hasSourceSiblings) return null;

            return this.windowingManager.findAvailableMonitorForWindow(window, workspace, monitor);
        }

        _revealPendingMonitorPlacementEntrance(window) {
            if (!WindowState.get(window, 'monitorPlacementEntrancePending')) return;
            WindowState.remove(window, 'monitorPlacementEntrancePending');
            this.animationsManager.animateMonitorPlacementEntrance(window);
        }

        // Floating windows never enter the tile pass that would clear opacity=0;
        // reveal so the slide-in failsafe isn't their only path to visibility.
        revealPendingEntrance(window) {
            if (!WindowState.get(window, 'pendingFirstPlacement')) return;
            WindowState.remove(window, 'pendingFirstPlacement');
            this.animationsManager.cancelPendingEntrance(window);
            const actor = isWindowAlive(window) ? window.get_compositor_private() : null;
            if (actor && !actor.is_destroyed()) {
                actor.remove_transition('opacity');
                actor.opacity = 255;
            }
        }

        // Lock a workspace to prevent recursive or conflicting tiling triggers.
        // Reference-counted: overlapping tileWorkspaceWindows calls (e.g. drag-end
        // and resize-end firing close together) each hold their own depth, so the
        // workspace stays locked until every holder has unlocked.
        lockWorkspace(workspace) {
            if (!workspace) return;
            const depth = (this._workspaceLocks.get(workspace) ?? 0) + 1;
            this._workspaceLocks.set(workspace, depth);
            Logger.log(`Workspace ${workspace.index()} LOCKED for tiling (depth=${depth})`);
        }

        unlockWorkspace(workspace) {
            if (!workspace) return;
            const depth = (this._workspaceLocks.get(workspace) ?? 0) - 1;
            if (depth <= 0) {
                this._workspaceLocks.delete(workspace);
                Logger.log(`Workspace ${workspace.index()} UNLOCKED`);
            } else {
                this._workspaceLocks.set(workspace, depth);
                Logger.log(`Workspace ${workspace.index()} unlock (depth=${depth}, still locked)`);
            }
        }

        isWorkspaceLocked(workspace) {
            if (!workspace) return false;
            return (this._workspaceLocks.get(workspace) ?? 0) > 0;
        }

        get isEvaluatingQueue() {
            return this._isEvaluatingQueue;
        }

        get windowingManager() {
            return this._ext.windowingManager;
        }
        get tilingManager() {
            return this._ext.tilingManager;
        }
        get edgeTilingManager() {
            return this._ext.edgeTilingManager;
        }
        get animationsManager() {
            return this._ext.animationsManager;
        }
        get _timeoutRegistry() {
            return this._ext._timeoutRegistry;
        }

        connectWindowSignals(window) {
            if (!window || this._windowSignals.has(window)) return;

            Logger.log(`Connecting signals for window ${window.get_id()}`);
            const ids = [];

            ids.push(
                window.connect('unmanaged', win => {
                    Logger.log(`Window ${win.get_id()} (unmanaged) - cleaning up`);
                    // Distinguish a real close from workspace/monitor removal before the
                    // generic window-removed timeout gets a chance to re-tile locally.
                    WindowState.set(win, 'closeFinalizationPending', true);
                    this.animationsManager.removeAnimatingWindow(win.get_id());
                    const ws = win.get_workspace();
                    if (ws) this.onWindowRemoved(ws, win);
                    this.disconnectWindowSignals(win);
                })
            );

            // Have two signals that fires when (un)maximize, so we coalesce it via idle.
            let pendingMaximizeCheck = false;
            ['notify::maximized-horizontally', 'notify::maximized-vertically'].forEach(signal => {
                ids.push(
                    window.connect(signal, win => {
                        if (pendingMaximizeCheck) return;
                        pendingMaximizeCheck = true;
                        this._timeoutRegistry.addIdle(() => {
                            pendingMaximizeCheck = false;
                            if (!isWindowAlive(win)) return GLib.SOURCE_REMOVE;

                            // Entering/exiting sacred state is owned by resizeHandler, normally
                            // driven by the WM size-change signal. This property notify is a
                            // backup for apps where that signal doesn't fire reliably; calling
                            // these twice for the same transition is safe (see resizeHandler.js).
                            if (this.windowingManager.isMaximizedOrFullscreen(win)) {
                                if (!WindowState.get(win, 'openedMaximized')) {
                                    this._ext.resizeHandler.tryEnterSacred(win);
                                }
                            } else if (WindowState.get(win, 'openedMaximized')) {
                                Logger.log(
                                    `Window ${win.get_id()} born maximized - skipping sacred exit, treating as normal unmaximize`
                                );
                                WindowState.remove(win, 'openedMaximized');
                                WindowState.remove(win, 'unmaximizing');
                                WindowState.remove(win, 'isEnteringSacred');
                                this._settleBornSacredExit(win, 'unmaximize');
                            } else {
                                this._ext.resizeHandler.tryExitSacred(win);
                            }
                            return GLib.SOURCE_REMOVE;
                        });
                    })
                );
            });

            // Detect Fullscreen changes, same backup pattern as maximize above.
            ids.push(
                window.connect('notify::fullscreen', win => {
                    if (this.windowingManager.isMaximizedOrFullscreen(win)) {
                        if (!WindowState.get(win, 'openedMaximized')) {
                            this._ext.resizeHandler.tryEnterSacred(win);
                        }
                    } else if (WindowState.get(win, 'openedMaximized')) {
                        Logger.log(
                            `Window ${win.get_id()} born fullscreen - skipping sacred exit, treating as normal`
                        );
                        WindowState.remove(win, 'openedMaximized');
                        WindowState.remove(win, 'unmaximizing');
                        WindowState.remove(win, 'isEnteringSacred');
                        this._settleBornSacredExit(win, 'unfullscreen');
                    } else {
                        this._ext.resizeHandler.tryExitSacred(win);
                    }
                })
            );

            ids.push(
                window.connect('size-changed', win => {
                    ComputedLayouts.delete(win);
                    if (
                        WindowState.get(win, 'isSmartResizing') ||
                        WindowState.get(win, 'isReverseSmartResizing')
                    ) {
                        // During queue evaluation, skip all processing so target sizes stay
                        // consistent for subsequent canFitWindow/tryFitWithResize calls
                        if (this._isEvaluatingQueue) return;
                        const target = WindowState.get(win, 'targetSmartResizeSize');
                        if (target) WindowState.set(win, 'targetSmartResizeSize', null);
                        this.tilingManager.tileWorkspaceWindows(
                            win.get_workspace(),
                            null,
                            win.get_monitor()
                        );
                    }
                })
            );

            ids.push(
                window.connect('position-changed', win => {
                    ComputedLayouts.delete(win);
                })
            );

            ids.push(window.connect('notify::above', win => this.handleExclusionStateChange(win)));
            ids.push(
                window.connect('notify::on-all-workspaces', win =>
                    this.handleExclusionStateChange(win)
                )
            );
            ids.push(
                window.connect('notify::minimized', win => this.handleExclusionStateChange(win))
            );

            this._windowSignals.set(window, ids);

            const currentExclusion = this.windowingManager.isExcluded(window);
            WindowState.set(window, 'previousExclusionState', currentExclusion);

            const currentWorkspace = window.get_workspace();
            if (currentWorkspace) {
                WindowState.set(window, 'previousWorkspace', currentWorkspace.index());
            }
        }

        disconnectWindowSignals(window) {
            const ids = this._windowSignals.get(window);
            if (ids) {
                ids.forEach(id => window.disconnect(id));
                this._windowSignals.delete(window);
                Logger.log(`Disconnected signals for window ${window.get_id()}`);
            }

            ComputedLayouts.delete(window);

            WindowState.remove(window, 'previousExclusionState');
            WindowState.remove(window, 'previousWorkspace');
        }

        _isFrameMonitorSized(win) {
            const ws = win.get_workspace();
            const mon = win.get_monitor();
            const wa = ws && mon !== null ? ws.get_work_area_for_monitor(mon) : null;
            const frame = win.get_frame_rect();
            return !!wa && frame.width >= wa.width && frame.height >= wa.height;
        }

        // The state flips before the client commits the size that goes with it, so the frame
        // here can still be the maximized one. Tiling on it sends a configure the client's own
        // late commit then overrides, so wait for that commit.
        _settleBornSacredExit(win, label) {
            if (!this._isFrameMonitorSized(win)) {
                this._captureAndTile(win, label);
                return;
            }

            let sizeId = null;
            let unmanagedId = null;
            const disconnect = () => {
                if (sizeId) win.disconnect(sizeId);
                if (unmanagedId) win.disconnect(unmanagedId);
                sizeId = unmanagedId = null;
            };

            sizeId = win.connect('size-changed', () => {
                disconnect();
                this._captureAndTile(win, label);
            });
            unmanagedId = win.connect('unmanaged', disconnect);
        }

        _captureAndTile(win, label) {
            if (!isWindowAlive(win)) return;

            const ws = win.get_workspace();
            const mon = win.get_monitor();
            // Only capture if nothing's recorded yet, so a later manual resize or
            // Smart Resize decision is never clobbered.
            if (!WindowState.get(win, 'preferredSize')) {
                const settled = win.get_frame_rect();
                const wa = ws && mon !== null ? ws.get_work_area_for_monitor(mon) : null;
                // A client that stays monitor-sized through the exit leaves a frame
                // indistinguishable from maximized. Use 95% of the work area instead so it
                // reads as "nearly full" rather than maximized.
                const isMonitorSized =
                    wa && settled.width >= wa.width && settled.height >= wa.height;
                const size = isMonitorSized
                    ? {width: Math.floor(wa.width * 0.95), height: Math.floor(wa.height * 0.95)}
                    : {width: settled.width, height: settled.height};
                WindowState.set(win, 'preferredSize', size);
                Logger.log(
                    `Captured preferredSize on ${label} for ${win.get_id()}: ${size.width}x${size.height}${isMonitorSized ? ' (95% fallback, no real shrink)' : ''}`
                );
            }

            if (ws) this.tilingManager.tileWorkspaceWindows(ws, win, mon);
        }

        handleExclusionStateChange(window) {
            const windowId = window.get_id();
            const workspace = window.get_workspace();
            const monitor = window.get_monitor();

            const isNowExcluded = this.windowingManager.isExcluded(window);

            const wasExcluded = WindowState.get(window, 'previousExclusionState') || false;
            WindowState.set(window, 'previousExclusionState', isNowExcluded);

            if (wasExcluded === isNowExcluded) {
                return;
            }

            if (isNowExcluded) {
                Logger.log(`Window ${windowId} became excluded; retiling without it`);
                ComputedLayouts.delete(window);

                // Exclusion arriving after opacity=0 was set (e.g. always-on-top
                // toggled mid-entrance) strands the actor invisible; reveal now.
                this.revealPendingEntrance(window);

                this._timeoutRegistry.add(
                    constants.RETILE_DELAY_MS,
                    () => {
                        const remainingWindows = this.windowingManager
                            .getMonitorWorkspaceWindows(workspace, monitor)
                            .filter(
                                w => w.get_id() !== windowId && !this.windowingManager.isExcluded(w)
                            );

                        const workArea = this.edgeTilingManager.calculateRemainingSpace(
                            workspace,
                            monitor
                        );
                        let restored = false;
                        if (workArea) {
                            restored = this.tilingManager.tryRestoreWindowSizes(
                                remainingWindows,
                                workArea
                            );
                        } else {
                            Logger.log('WindowHandler: Skipped restore - invalid workArea');
                        }

                        this.tilingManager.tileWorkspaceWindows(workspace, null, monitor, false);

                        if (restored) {
                            this._timeoutRegistry.add(
                                constants.RESIZE_SETTLE_DELAY_MS,
                                () => {
                                    for (const w of remainingWindows) {
                                        WindowState.remove(w, 'isReverseSmartResizing');
                                    }
                                    return GLib.SOURCE_REMOVE;
                                },
                                'windowHandler_excludeRestoreSettle'
                            );
                        }
                        return GLib.SOURCE_REMOVE;
                    },
                    'windowHandler_excludeRetile'
                );
            } else {
                Logger.log(`Window ${windowId} became included; treating as new window arrival`);

                this._timeoutRegistry.add(constants.RETILE_DELAY_MS, () => {
                    const workArea = this.edgeTilingManager.calculateRemainingSpace(
                        workspace,
                        monitor
                    );
                    if (!workArea) {
                        Logger.log('WindowHandler: Skipped include - invalid workArea');
                        return GLib.SOURCE_REMOVE;
                    }
                    const existingWindows = this.windowingManager
                        .getMonitorWorkspaceWindows(workspace, monitor)
                        .filter(
                            w =>
                                w.get_id() !== window.get_id() &&
                                !this.windowingManager.isExcluded(w)
                        );

                    if (this.tilingManager.canFitWindow(window, workspace, monitor)) {
                        Logger.log('Re-included window fits without resize');
                        WindowState.set(window, 'justReturnedFromExclusion', true);
                        this.tilingManager.tileWorkspaceWindows(workspace, window, monitor, false);
                        return GLib.SOURCE_REMOVE;
                    }

                    // Try smart resize (now synchronous). Treat the re-included window
                    // as focused, since Mutter's focus_window may still point at the
                    // previously focused sibling, which would otherwise be excluded
                    // from miniaturization candidates alongside newWindow.
                    const resizeResult = this.tilingManager.tryFitWithResize(
                        window,
                        existingWindows,
                        workArea,
                        workspace,
                        window
                    );

                    if (resizeResult?.success) {
                        Logger.log('Re-include: Smart resize applied - tiling workspace');
                        WindowState.set(window, 'justReturnedFromExclusion', true);
                        this.tilingManager._isSmartResizingBlocked = true;
                        try {
                            this.tilingManager._pendingMiniatureWindows =
                                resizeResult.pendingWindows ?? [];
                            this.tilingManager.tileWorkspaceWindows(
                                workspace,
                                null,
                                monitor,
                                false
                            );
                        } finally {
                            this.tilingManager._isSmartResizingBlocked = false;
                        }
                    } else {
                        Logger.log('Re-include: Smart resize not applicable - moving to overflow');
                        this.windowingManager
                            .moveOversizedWindow(window)
                            .catch(e => Logger.error(`Re-include overflow failed: ${e}`));
                    }

                    return GLib.SOURCE_REMOVE;
                });
            }
        }

        onWindowLeftMonitor(monitor, window) {
            if (!this._windowSignals.has(window)) return;

            if (WindowState.get(window, 'monitorPlacementTarget') !== undefined) {
                this.windowingManager.invalidateWindowsCache();
                return;
            }

            if (WindowState.get(window, 'monitorRebalanceInProgress')) {
                this.windowingManager.invalidateWindowsCache();
                return;
            }

            // Mutter flips on_all_workspaces (workspaces-only-on-primary) before emitting this,
            // so the window may already report no workspace of its own.
            const workspace =
                window.get_workspace() ?? global.workspace_manager.get_active_workspace();
            if (!workspace) return;

            // Internal placement has its own source/target transaction. Everything else
            // is an explicit compositor/user move, so remember the vacancy it creates;
            // an occupied sacred destination can give its incumbent that vacancy.
            WindowState.set(window, 'userMoveOrigin', {workspace, monitor});

            Logger.log(`Window ${window.get_id()} left monitor ${monitor}`);

            // onWindowRemoved runs before this signal and can only see the destination
            // monitor, so leave the source behind for its deferred count to pick up.
            WindowState.set(window, 'leftMonitor', monitor);
            WindowState.set(window, 'leftMonitorAt', monotonicNow());

            this.windowingManager.invalidateWindowsCache();

            // Under a grab the drag passes own the layout; retiling here on top of them feeds
            // reverse smart resize back into tiling forever. stopDrag retiles the source.
            if (this._ext.dragHandler._draggedWindow) return;

            this._timeoutRegistry.add(
                constants.RETILE_DELAY_MS,
                () => {
                    this.retileSourceAfterUserMove(window, workspace, monitor);
                    return GLib.SOURCE_REMOVE;
                },
                'windowHandler_leftMonitorRetile'
            );
        }

        // A monitor move frees the same capacity as a close/workspace departure. Give a
        // miniature on the source monitor first claim on it before committing a normal
        // retile. restoreMiniature emits its own synchronous restoration signal, which
        // owns the resulting layout when restoration succeeds.
        retileSourceAfterUserMove(movedWindow, workspace, monitor) {
            if (!isWorkspaceAlive(workspace)) return false;

            this.windowingManager.invalidateWindowsCache();
            const remainingWindows = this.windowingManager
                .getMonitorWorkspaceWindows(workspace, monitor)
                .filter(
                    candidate =>
                        candidate.get_id() !== movedWindow.get_id() &&
                        !this.edgeTilingManager.isEdgeTiled(candidate) &&
                        !this.windowingManager.isExcluded(candidate)
                );

            return restoreBeforeRearrange(
                () => this.tryAutoRestoreMiniature(remainingWindows, workspace, monitor),
                () => {
                    this.animationsManager.setMembershipChangeBounce(true);
                    this.tilingManager.tileWorkspaceWindows(workspace, null, monitor, false);
                    this.animationsManager.setMembershipChangeBounce(false);
                }
            );
        }

        _moveWindowToMonitorAndWait(window, workspace, sourceMonitor, targetMonitor) {
            return new Promise(resolve => {
                const started = this.windowingManager.moveWindowToMonitor(
                    window,
                    workspace,
                    sourceMonitor,
                    targetMonitor,
                    resolve
                );
                if (!started) resolve(false);
            });
        }

        // A user-maximized window owns the monitor where the action happened. Evacuate
        // its siblings instead of applying automatic sacred placement to the window the
        // user just maximized. Miniatures go first so newly available monitor capacity
        // can restore them before ordinary overflow placement consumes it.
        async makeRoomForUserMaximize(window, workspace, monitor) {
            this.windowingManager.invalidateWindowsCache();
            const mru = this.windowingManager.getMRUOrder(workspace);
            const siblings = orderWindowsByMru(
                this.windowingManager
                    .getMonitorWorkspaceWindows(workspace, monitor)
                    .filter(
                        candidate =>
                            candidate.get_id() !== window.get_id() &&
                            !this.windowingManager.isExcluded(candidate)
                    ),
                mru
            ).sort((a, b) => {
                const aMiniature = WindowState.get(a, IS_MINIATURE) ? 0 : 1;
                const bMiniature = WindowState.get(b, IS_MINIATURE) ? 0 : 1;
                return aMiniature - bMiniature;
            });

            for (const sibling of siblings) {
                if (!isWindowAlive(sibling)) continue;

                this.windowingManager.invalidateWindowsCache();
                const targetMonitor = this.windowingManager.findAvailableMonitorForWindow(
                    sibling,
                    workspace,
                    monitor
                );

                let targetWorkspace = workspace;
                let settledMonitor = targetMonitor;
                if (targetMonitor !== null) {
                    const moved = await this._moveWindowToMonitorAndWait(
                        sibling,
                        workspace,
                        monitor,
                        targetMonitor
                    );
                    if (!moved) {
                        targetWorkspace = await this.windowingManager.moveOversizedWindow(sibling, {
                            switchFocus: false,
                        });
                        settledMonitor = sibling.get_monitor();
                    }
                } else {
                    targetWorkspace = await this.windowingManager.moveOversizedWindow(sibling, {
                        switchFocus: false,
                    });
                    settledMonitor = sibling.get_monitor();
                }

                if (
                    targetWorkspace &&
                    settledMonitor !== null &&
                    WindowState.get(sibling, IS_MINIATURE)
                ) {
                    this.windowingManager.invalidateWindowsCache();
                    const targetWindows = this.windowingManager
                        .getMonitorWorkspaceWindows(targetWorkspace, settledMonitor)
                        .filter(candidate => !this.windowingManager.isExcluded(candidate));
                    this.tryAutoRestoreMiniature(targetWindows, targetWorkspace, settledMonitor);
                }
            }

            this.windowingManager.invalidateWindowsCache();
            const remainingSiblings = this.windowingManager
                .getMonitorWorkspaceWindows(workspace, monitor)
                .filter(
                    candidate =>
                        candidate.get_id() !== window.get_id() &&
                        !this.windowingManager.isExcluded(candidate)
                );
            return remainingSiblings.length === 0;
        }

        onWindowEnteredMonitor(monitor, window) {
            if (!this._windowSignals.has(window)) return;

            if (WindowState.get(window, 'monitorPlacementTarget') !== undefined) {
                // move_to_monitor updates MetaWindow asynchronously. The placement
                // timeout owns the one destination retile after the frame settles.
                this.windowingManager.invalidateWindowsCache();
                return;
            }

            if (WindowState.get(window, 'monitorRebalanceInProgress')) {
                this.windowingManager.invalidateWindowsCache();
                return;
            }

            // A grab drag ends in stopDrag, which tiles the destination itself. Overview
            // drags, keyboard moves and monitor hotplug have no grab, so this is the only
            // place that gets the arriving window into the mosaic.
            if (this._ext.dragHandler._draggedWindow) return;

            // An on-all-workspaces window reports no workspace of its own, but it does show
            // up in every workspace's list, so the active one is the right context to tile in.
            const workspace =
                window.get_workspace() ?? global.workspace_manager.get_active_workspace();
            if (!workspace || this.windowingManager.isExcluded(window)) return;

            Logger.log(
                `Window ${window.get_id()} entered monitor ${monitor}; evaluating for mosaic`
            );

            this.windowingManager.invalidateWindowsCache();

            this.enqueueWindowForEvaluation(window, workspace, monitor);
        }

        // Brings back the most recently used miniature when space frees up. Shared by
        // the close, move and live-resize paths so they don't duplicate the fit check.
        tryAutoRestoreMiniature(remainingWindows, workspace, monitor) {
            if (!this._ext.miniatureManager) return false;

            const mru = this.windowingManager.getMRUOrder(workspace);
            const miniatureWindows = orderWindowsByMru(
                remainingWindows.filter(w => WindowState.get(w, IS_MINIATURE)),
                mru
            );

            if (miniatureWindows.length === 0) return false;

            const workArea = this._ext.tilingManager.getUsableWorkArea(workspace, monitor);
            for (const candidate of miniatureWindows) {
                if (
                    !this._ext.tilingManager.canRestoreMiniature(
                        candidate,
                        remainingWindows,
                        workArea
                    )
                ) {
                    Logger.log(
                        `tryAutoRestoreMiniature: keeping mini ${candidate.get_id()} - would overflow if restored`
                    );
                    continue;
                }

                this._ext._miniatureCascadeIds?.delete(candidate.get_id());
                this._ext.miniatureManager.restoreMiniature(candidate, null, {activate: false});
                // 'miniature-restored' fires synchronously; its handler has already run.
                return true;
            }

            return false;
        }

        // Once the close layout has settled, miniatures from anywhere in the workspace
        // get first claim on the monitor that gained space. This takes priority over
        // moving an already-full-size window.
        _tryRestoreWorkspaceMiniature(workspace, preferredMonitor) {
            if (!this._ext.miniatureManager) return false;
            if (
                preferredMonitor === null ||
                preferredMonitor === undefined ||
                preferredMonitor < 0 ||
                preferredMonitor >= global.display.get_n_monitors()
            )
                return false;

            // Only this monitor gained space from the close. Testing every unchanged
            // monitor multiplies canRestoreMiniature's binary-search simulations without
            // finding capacity that was not already there.
            const workArea = this.tilingManager.getUsableWorkArea(workspace, preferredMonitor);
            if (!workArea || workArea.width <= 0 || workArea.height <= 0) return false;
            if (this.windowingManager.hasSacredWindow(workspace, preferredMonitor)) return false;

            const targetWindows = this.windowingManager
                .getMonitorWorkspaceWindows(workspace, preferredMonitor)
                .filter(w => isWindowAlive(w) && !this.windowingManager.isExcluded(w));

            const miniatureWindows = orderWindowsByMru(
                workspace
                    .list_windows()
                    .filter(w => isWindowAlive(w) && WindowState.get(w, IS_MINIATURE)),
                this.windowingManager.getMRUOrder(workspace)
            );

            for (const candidate of miniatureWindows) {
                const sourceMonitor = candidate.get_monitor();
                const simulatedWindows = targetWindows.slice();
                if (!simulatedWindows.some(w => w.get_id() === candidate.get_id()))
                    simulatedWindows.push(candidate);

                if (!this.tilingManager.canRestoreMiniature(candidate, simulatedWindows, workArea))
                    continue;

                if (preferredMonitor !== sourceMonitor) {
                    Logger.log(
                        `[REBALANCE] Moving miniature ${candidate.get_id()} from monitor ${sourceMonitor} to ${preferredMonitor} for restore`
                    );
                    candidate.move_to_monitor(preferredMonitor);
                    this.windowingManager.invalidateWindowsCache();
                    this.tilingManager.tileWorkspaceWindows(workspace, null, sourceMonitor, true);
                }

                Logger.log(
                    `[REBALANCE] Restoring miniature ${candidate.get_id()} on monitor ${preferredMonitor}`
                );
                this._ext._miniatureCascadeIds?.delete(candidate.get_id());
                this._ext.miniatureManager.restoreMiniature(candidate, null, {activate: false});
                return true;
            }

            return false;
        }

        _runMonitorRebalance(workspace, monitor) {
            this.animationsManager.setMembershipChangeBounce(true);
            const restoredMiniature = this._tryRestoreWorkspaceMiniature(workspace, monitor);
            if (!restoredMiniature)
                this.windowingManager.rebalanceWorkspaceMonitors(workspace, monitor);
            this.animationsManager.setMembershipChangeBounce(false);

            if (restoredMiniature) {
                this._queueMonitorRebalance(
                    workspace,
                    monitor,
                    constants.MINIATURE_ANIM_MS + constants.RESIZE_SETTLE_DELAY_MS
                );
            }
        }

        _queueMonitorRebalance(workspace, monitor, delay = 0) {
            if (!workspace || monitor === null || monitor === undefined) return;

            const existing = this._scheduledMonitorRebalances.find(
                entry => entry.workspace === workspace
            );
            if (existing) {
                existing.monitor = monitor;
                return;
            }

            const scheduled = {workspace, monitor};
            this._scheduledMonitorRebalances.push(scheduled);
            this._timeoutRegistry.add(
                delay,
                () => {
                    this._scheduledMonitorRebalances = this._scheduledMonitorRebalances.filter(
                        entry => entry !== scheduled
                    );
                    if (!isWorkspaceAlive(scheduled.workspace)) return GLib.SOURCE_REMOVE;
                    this._runMonitorRebalance(scheduled.workspace, scheduled.monitor);
                    return GLib.SOURCE_REMOVE;
                },
                'windowHandler_monitorRebalanceAfterClose'
            );
        }

        // A real close changes both local capacity and workspace-wide monitor balance.
        // Decide membership first, then perform one final layout per affected monitor;
        // otherwise the local close tile visibly runs before the monitor move tile.
        _finalizeClosedWindow(removedWindow, workspace, monitor, freedWidth, freedHeight) {
            const clearCloseState = () =>
                WindowState.remove(removedWindow, 'closeFinalizationPending');

            // If the generic removal timeout won an unusual signal-order race, the
            // coordinated final pass must still run against post-rebalance membership.
            WindowState.remove(removedWindow, 'closeRetileHandledAt');

            if (!isWorkspaceAlive(workspace)) {
                clearCloseState();
                return;
            }

            // Preserve the existing priority: a miniature that can use the newly freed
            // space gets first claim. Its restore signal owns the destination layout.
            if (this._tryRestoreWorkspaceMiniature(workspace, monitor)) {
                clearCloseState();
                this._queueMonitorRebalance(
                    workspace,
                    monitor,
                    constants.MINIATURE_ANIM_MS + constants.RESIZE_SETTLE_DELAY_MS
                );
                return;
            }

            const rebalance = this.windowingManager.rebalanceWorkspaceMonitors(workspace, monitor, {
                deferTiling: true,
            });
            const movedWindows = rebalance.movedWindows ?? [];
            const affectedMonitors = new Set(rebalance.affectedMonitors ?? []);

            const clearMoveFlags = () => {
                for (const movedWindow of movedWindows)
                    WindowState.remove(movedWindow, 'monitorRebalanceInProgress');
                clearCloseState();
                return GLib.SOURCE_REMOVE;
            };

            const finishLayouts = () => {
                if (!isWorkspaceAlive(workspace)) {
                    clearMoveFlags();
                    return GLib.SOURCE_REMOVE;
                }

                this.windowingManager.invalidateWindowsCache();
                const remainingWindows = this.windowingManager
                    .getMonitorWorkspaceWindows(workspace, monitor)
                    .filter(
                        w =>
                            w.get_id() !== removedWindow.get_id() &&
                            !this.edgeTilingManager.isEdgeTiled(w) &&
                            !this.windowingManager.isExcluded(w)
                    );

                let retileResult = {settleDelay: 0};
                if (remainingWindows.length > 0) {
                    retileResult = this._retileAfterWindowGone(
                        removedWindow,
                        remainingWindows,
                        workspace,
                        monitor,
                        freedWidth,
                        freedHeight,
                        {
                            requireConstrainedCheck: true,
                            reverseLogLabel: '[REVERSE-DESTROYED] Window closed',
                            settleTimeoutName: 'windowHandler_destroyedRestoreSettle',
                        }
                    );
                }

                const finishOtherMonitors = () => {
                    if (isWorkspaceAlive(workspace)) {
                        this.animationsManager.setMembershipChangeBounce(true);
                        for (const affectedMonitor of affectedMonitors) {
                            if (affectedMonitor === monitor) continue;
                            this.tilingManager.tileWorkspaceWindows(
                                workspace,
                                null,
                                affectedMonitor,
                                false
                            );
                        }
                        this.animationsManager.setMembershipChangeBounce(false);
                    }

                    // Keep the suppression through the final move/resize signal burst.
                    if (movedWindows.length > 0) {
                        this._timeoutRegistry.add(
                            constants.RETILE_DELAY_MS,
                            clearMoveFlags,
                            'windowHandler_clearCloseRebalanceFlags'
                        );
                    } else {
                        clearMoveFlags();
                    }
                    return GLib.SOURCE_REMOVE;
                };

                const finalDelay = retileResult?.settleDelay ?? 0;
                if (finalDelay > 0 && affectedMonitors.size > 0) {
                    this._timeoutRegistry.add(
                        finalDelay,
                        finishOtherMonitors,
                        'windowHandler_closeAffectedMonitorsSettle'
                    );
                } else {
                    finishOtherMonitors();
                }
                return GLib.SOURCE_REMOVE;
            };

            if (rebalance.moved > 0) {
                Logger.log(
                    `[REBALANCE] Close transaction moved ${rebalance.moved} window(s); waiting for monitor membership before final layout`
                );
                this._timeoutRegistry.add(
                    constants.RETILE_DELAY_MS,
                    finishLayouts,
                    'windowHandler_closeMembershipSettle'
                );
            } else {
                finishLayouts();
            }
        }

        // Deduped via closeRetileHandledAt since both close signals land here; whichever
        // gets here first does the work, the other (often arriving much later behind
        // afterAnimations) skips. No time expiry: a close never repeats, a DnD move clears
        // the flag on re-enqueue, and an overflow move never claims at all since it never
        // re-enqueues (a stale claim would block the retile at the window's real close).
        // Options below capture real behavioral differences between the two callers, not duplication.
        _retileAfterWindowGone(
            removedWindow,
            remainingWindows,
            workspace,
            monitor,
            freedWidth,
            freedHeight,
            options = {}
        ) {
            const {
                wasMovedByOverflow = false,
                requireConstrainedCheck = false,
                passFreedDimsToRestore = true,
                includeMinisInRestoreCall = false,
                cleanSmartResizingFlags = false,
                requireBothFreedDims = false,
                reverseLogLabel = '[REVERSE]',
                settleLogLabel = null,
                settleTimeoutName = 'windowHandler_closeRetileSettle',
            } = options;

            if (WindowState.get(removedWindow, 'closeRetileHandledAt')) {
                Logger.log(
                    `_retileAfterWindowGone: already handled for ${removedWindow.get_id()} - skipping duplicate`
                );
                return {settleDelay: 0};
            }
            if (!wasMovedByOverflow) WindowState.set(removedWindow, 'closeRetileHandledAt', true);

            if (cleanSmartResizingFlags) {
                Logger.log('[SMART RESIZE] Cleaning up transient flags for remaining windows');
                for (const w of remainingWindows) {
                    WindowState.set(w, 'isSmartResizing', false);
                }
            }

            if (
                !wasMovedByOverflow &&
                this.tryAutoRestoreMiniature(remainingWindows, workspace, monitor)
            ) {
                return {
                    settleDelay: constants.MINIATURE_ANIM_MS + constants.RESIZE_SETTLE_DELAY_MS,
                };
            }

            const restorableWindows = remainingWindows.filter(
                w => !WindowState.get(w, IS_MINIATURE)
            );

            // When the caller doesn't trust its freedWidth/freedHeight, gating the
            // attempt on those values is pointless; e.g. 'unmanaged' can fire after
            // the closed window's frame already reads 0x0.
            const hasFreedSpace =
                !passFreedDimsToRestore ||
                (requireBothFreedDims
                    ? freedWidth > 0 && freedHeight > 0
                    : freedWidth > 0 || freedHeight > 0);
            let shouldTryRestore = hasFreedSpace && restorableWindows.length > 0;
            if (shouldTryRestore && requireConstrainedCheck) {
                shouldTryRestore = restorableWindows.some(w => {
                    const hasTarget = WindowState.get(w, 'targetSmartResizeSize') !== null;
                    const isConstrained = WindowState.get(w, 'isConstrainedByMosaic') === true;
                    return hasTarget || isConstrained;
                });
            }

            let restored = false;
            if (shouldTryRestore) {
                const freedDesc = passFreedDimsToRestore
                    ? `freed ${freedWidth}x${freedHeight}`
                    : 'free space measured from the work area';
                Logger.log(`${reverseLogLabel}: attempting reverse smart resize with ${freedDesc}`);
                const workArea = this._ext.tilingManager.getUsableWorkArea(workspace, monitor);
                const target = includeMinisInRestoreCall ? remainingWindows : restorableWindows;
                restored = this._ext.tilingManager.tryRestoreWindowSizes(target, workArea);
            }

            // Resettling because a window just left, so bounce it like an entrance.
            if (restored) {
                // move_resize_frame above hasn't settled yet; retiling now would read
                // get_frame_rect() before the client acks the new size, hit the layout
                // cache with the stale dimensions, and redraw right back over the restore.
                this._ext._timeoutRegistry.add(
                    constants.RESIZE_SETTLE_DELAY_MS,
                    () => {
                        if (settleLogLabel) Logger.log(settleLogLabel);
                        for (const w of restorableWindows) {
                            WindowState.remove(w, 'isReverseSmartResizing');
                        }
                        this.animationsManager.setMembershipChangeBounce(true);
                        this._ext.tilingManager.tileWorkspaceWindows(
                            workspace,
                            null,
                            monitor,
                            true
                        );
                        this.animationsManager.setMembershipChangeBounce(false);
                        for (const w of restorableWindows) {
                            WindowState.remove(w, 'targetRestoredSize');
                        }
                        return GLib.SOURCE_REMOVE;
                    },
                    settleTimeoutName
                );
            } else {
                this.animationsManager.setMembershipChangeBounce(true);
                this._ext.tilingManager.tileWorkspaceWindows(workspace, null, monitor, true);
                this.animationsManager.setMembershipChangeBounce(false);
            }

            return {
                settleDelay: restored ? constants.RESIZE_SETTLE_DELAY_MS : 0,
            };
        }

        onWindowDestroyed(window) {
            const monitor = window.get_monitor();
            const windowId = window.get_id();
            const windowWorkspace = window.get_workspace();
            WindowState.set(window, 'closeFinalizationPending', true);

            Logger.log(`onWindowDestroyed: ${windowId}`);

            this.disconnectWindowSignals(window);

            if (this._ext.miniatureManager && WindowState.get(window, IS_MINIATURE)) {
                this._ext.miniatureManager.destroyMiniature(window);
            }

            this.edgeTilingManager.clearWindowState(window);

            WindowState.remove(window, 'maximizedUndoInfo');

            if (this.windowingManager.isExcluded(window)) {
                Logger.log('Excluded window closed - no mosaic retile needed');
                WindowState.remove(window, 'closeFinalizationPending');
                return;
            }

            if (windowWorkspace) {
                const workspace = windowWorkspace;

                // Capture destroyed window size for reverse smart resize. The actor
                // may already be disposed during signal delivery, and get_frame_rect
                // on a dead MetaWindow segfaults libmutter.
                const destroyedFrame = isWindowAlive(window) ? window.get_frame_rect() : null;
                const freedWidth = destroyedFrame ? destroyedFrame.width : 0;
                const freedHeight = destroyedFrame ? destroyedFrame.height : 0;

                this.edgeTilingManager.checkQuarterExpansion(workspace, monitor);

                afterWindowClose(() => {
                    afterAnimations(
                        this._ext.animationsManager,
                        () => {
                            this._finalizeClosedWindow(
                                window,
                                workspace,
                                monitor,
                                freedWidth,
                                freedHeight
                            );
                        },
                        this._ext._timeoutRegistry,
                        constants.ANIMATION_DURATION_MS + constants.RESIZE_SETTLE_DELAY_MS
                    );
                }, this._ext._timeoutRegistry);
            } else {
                WindowState.remove(window, 'closeFinalizationPending');
            }
        }

        enqueueWindowForEvaluation(window, workspace, monitor) {
            const windowId = window.get_id();
            // A (re)considered window voids any earlier close-retile dedup claim; cleared
            // before the dedupe returns below so a skipped re-enqueue still resets it.
            WindowState.remove(window, 'closeRetileHandledAt');
            if (this._evaluationQueue.some(entry => entry.window.get_id() === windowId)) {
                Logger.log(`Skipping duplicate enqueue for window ${windowId}`);
                return;
            }
            // window-created and window-added both land here for a new window, so
            // skip if we just evaluated it.
            const lastEvaluatedAt = WindowState.get(window, 'lastEvaluatedAt');
            if (
                lastEvaluatedAt &&
                !WindowState.get(window, 'userMoveOrigin') &&
                monotonicNow() - lastEvaluatedAt < constants.DUPLICATE_EVALUATION_WINDOW_MS
            ) {
                Logger.log(
                    `Skipping re-enqueue for window ${windowId} - evaluated ${Math.round(monotonicNow() - lastEvaluatedAt)}ms ago`
                );
                return;
            }
            Logger.log(`Enqueueing window ${windowId} for evaluation`);
            WindowState.set(window, 'pendingInQueue', true);
            this._evaluationQueue.push({window, workspace, monitor});
            if (!this._isEvaluatingQueue) {
                this._processEvaluationQueue().catch(e => {
                    Logger.error(`Evaluation queue failed: ${e}\n${e.stack}`);
                    for (const entry of this._evaluationQueue)
                        WindowState.remove(entry.window, 'pendingInQueue');
                    this._evaluationQueue = [];
                    this._isEvaluatingQueue = false;
                });
            }
        }

        async _processEvaluationQueue() {
            if (this._isEvaluatingQueue || this._evaluationQueue.length === 0) {
                return;
            }

            this._isEvaluatingQueue = true;
            let lastOverflowWorkspace = null;
            // Track the expected workspace so we can detect manual user switches
            let expectedWorkspace = null;
            // Track workspaces that already overflowed to prevent infinite cascade loops.
            const overflowedWorkspaces = new Set();

            while (this._evaluationQueue.length > 0) {
                let {window, workspace, monitor} = this._evaluationQueue.shift();
                WindowState.remove(window, 'pendingInQueue');
                WindowState.set(window, 'lastEvaluatedAt', monotonicNow());

                if (!isWindowAlive(window)) {
                    Logger.log('Evaluation queue: window destroyed before evaluation, skipping');
                    continue;
                }

                // An Overview drop belongs to the workspace the user chose, even
                // though another workspace remains active behind the Overview.
                const arrivedFromDnD = WindowState.get(window, 'arrivedFromDnD') === true;
                WindowState.remove(window, 'arrivedFromDnD');

                // Guard against invalid workspace (can occur if workspace was removed during async smart resize)
                if (workspace.index() < 0) {
                    const currentWorkspace = window.get_workspace();
                    if (currentWorkspace && currentWorkspace.index() >= 0) {
                        Logger.log(
                            `Evaluation queue: stale workspace (index -1), using window's current WS-${currentWorkspace.index()}`
                        );
                        workspace = currentWorkspace;
                    } else {
                        Logger.log(
                            `Evaluation queue: window ${window.get_id()} has invalid workspace, skipping`
                        );
                        WindowState.remove(window, 'arrivalPending');
                        continue;
                    }
                }

                // Use the active workspace as the source of truth to detect manual user switches.
                const activeWorkspace = this.windowingManager.getWorkspace();
                const targetWorkspace = lastOverflowWorkspace || expectedWorkspace || workspace;

                if (
                    !arrivedFromDnD &&
                    activeWorkspace &&
                    targetWorkspace &&
                    activeWorkspace.index() !== targetWorkspace.index()
                ) {
                    Logger.log(
                        `Evaluation queue: User switched to WS-${activeWorkspace.index()} during processing (expected WS-${targetWorkspace.index()}) - following user`
                    );
                    workspace = activeWorkspace;
                    lastOverflowWorkspace = null; // Reset overflow cascade, user intent takes priority
                    overflowedWorkspaces.clear();
                    window.change_workspace(workspace);
                } else if (lastOverflowWorkspace && lastOverflowWorkspace !== workspace) {
                    // Check if the overflow destination already failed, stop cascading to prevent loops
                    if (overflowedWorkspaces.has(lastOverflowWorkspace.index())) {
                        Logger.log(
                            `Evaluation queue: overflow destination WS-${lastOverflowWorkspace.index()} already failed - stopping cascade, window ${window.get_id()} stays on WS-${workspace.index()}`
                        );
                        lastOverflowWorkspace = null;
                    } else {
                        // Cascade target workspace if a previous window in this batch caused an overflow
                        Logger.log(
                            `Evaluation queue: cascading window ${window.get_id()} to overflow destination WS-${lastOverflowWorkspace.index()}`
                        );
                        workspace = lastOverflowWorkspace;

                        if (window.get_workspace() !== workspace) {
                            WindowState.set(window, 'movedByOverflow', true);
                            window.change_workspace(workspace);
                        }
                    }
                }

                // Track the expected workspace for the next iteration
                expectedWorkspace = workspace;

                Logger.log(
                    `Evaluating queued window ${window.get_id()} on WS-${workspace.index()} (remaining: ${this._evaluationQueue.length})`
                );
                try {
                    const resultWorkspace = await this._ensureWindowFits(
                        window,
                        workspace,
                        monitor,
                        arrivedFromDnD
                    );
                    if (resultWorkspace && resultWorkspace.index() !== workspace.index()) {
                        overflowedWorkspaces.add(workspace.index());
                        lastOverflowWorkspace = resultWorkspace;
                        expectedWorkspace = resultWorkspace;
                    }
                } catch (e) {
                    Logger.error(`Error in evaluation queue for window ${window.get_id()}: ${e}`);
                }

                // Placement resolved either way, so the arrival shield no longer applies
                WindowState.remove(window, 'arrivalPending');

                // Small delay to let animations/mutter settle before evaluating the next window
                await new Promise(resolve => {
                    if (this._timeoutRegistry) {
                        this._timeoutRegistry.add(
                            constants.QUEUE_PROCESS_DELAY_MS,
                            resolve,
                            '_processEvaluationQueue'
                        );
                    } else {
                        resolve();
                    }
                });
            }

            this._isEvaluatingQueue = false;
        }

        async _ensureWindowFits(window, workspace, monitor, arrivedFromDnD = false) {
            // A monitor-enter signal or the window-created path may have relocated the
            // window after this queue entry was captured.
            const currentMonitor = window.get_monitor();
            if (currentMonitor !== null && currentMonitor >= 0 && currentMonitor !== monitor) {
                Logger.log(
                    `ensureWindowFits: Window ${window.get_id()} moved from monitor ${monitor} to ${currentMonitor} while queued`
                );
                monitor = currentMonitor;
            }

            const pendingMonitorTarget = WindowState.get(window, 'monitorPlacementTarget');
            if (pendingMonitorTarget !== undefined) {
                Logger.log(
                    `ensureWindowFits: Window ${window.get_id()} is already moving to monitor ${pendingMonitorTarget}`
                );
                return workspace;
            }

            if (WindowState.get(window, 'isSmartResizing')) {
                Logger.log('ensureWindowFits: Skipping - smart resize in progress');
                return workspace;
            }

            if (WindowState.get(window, 'restoringFromMiniature')) {
                Logger.log(
                    `ensureWindowFits: Skipping - restoring from miniature for ${window.get_id()}`
                );
                return workspace;
            }

            // Runs before constrained fast path: tiling refuses sacred workspaces and would
            // strand a constrained arrival floating there.
            const isIncomingSacred = this.windowingManager.isMaximizedOrFullscreen(window);
            const hasExistingSacred = this.windowingManager.hasSacredWindow(
                workspace,
                monitor,
                window.get_id()
            );
            const workspaceWindows = this.windowingManager
                .getMonitorWorkspaceWindows(workspace, monitor)
                .filter(w => !WindowState.get(w, 'pendingInQueue'));
            const otherWindows = workspaceWindows.filter(w => w.get_id() !== window.get_id());

            const userMoveOrigin = WindowState.get(window, 'userMoveOrigin');
            if (userMoveOrigin && hasExistingSacred) {
                try {
                    if (
                        await this.windowingManager.makeRoomForUserPlacement(
                            window,
                            workspace,
                            monitor,
                            userMoveOrigin
                        )
                    ) {
                        return workspace;
                    }
                } finally {
                    WindowState.remove(window, 'userMoveOrigin');
                }
            } else if (userMoveOrigin) {
                WindowState.remove(window, 'userMoveOrigin');
            }

            if (hasExistingSacred || (isIncomingSacred && otherWindows.length > 0)) {
                const availableMonitor = this.windowingManager.findAvailableMonitorForWindow(
                    window,
                    workspace,
                    monitor
                );
                if (availableMonitor !== null) {
                    this.windowingManager.moveWindowToMonitor(
                        window,
                        workspace,
                        monitor,
                        availableMonitor
                    );
                    return workspace;
                }

                Logger.log(
                    `Sacred Isolation triggered (IncomingSacred: ${isIncomingSacred}, HasExistingSacred: ${hasExistingSacred}) - isolating`
                );
                return await this.windowingManager.moveOversizedWindow(window);
            }

            // Already constrained, so sibling frames may not have settled yet; tile directly to avoid false overflow.
            if (WindowState.get(window, 'isConstrainedByMosaic')) {
                Logger.log(
                    `ensureWindowFits: Window ${window.get_id()} already constrained by mosaic - tiling directly`
                );
                this.tilingManager.tileWorkspaceWindows(workspace, null, monitor, false);
                return workspace;
            }

            // Save preferred size after sacred checks, to avoid capturing monitor-sized dimensions
            this.tilingManager.savePreferredSize(window);

            if (arrivedFromDnD) {
                const monitorWindows = this.windowingManager
                    .getMonitorWorkspaceWindows(workspace, monitor)
                    .filter(
                        w =>
                            !this.edgeTilingManager.isEdgeTiled(w) &&
                            !this.windowingManager.isExcluded(w)
                    );
                const preferredSize = this.tilingManager.getPreferredSize(window);

                if (preferredSize && monitorWindows.length === 1) {
                    const wa = workspace.get_work_area_for_monitor(monitor);
                    const win = monitorWindows[0];
                    const currentRect = win.get_frame_rect();
                    const targetW = Math.min(
                        preferredSize.width,
                        wa.width - constants.WINDOW_SPACING * 2
                    );
                    const targetH = Math.min(
                        preferredSize.height,
                        wa.height - constants.WINDOW_SPACING * 2
                    );
                    Logger.log(`DnD Solo: Fully restoring window to ${targetW}x${targetH}`);
                    win.move_resize_frame(true, currentRect.x, currentRect.y, targetW, targetH);
                } else {
                    const usedWidth = monitorWindows.reduce(
                        (sum, w) => sum + w.get_frame_rect().width,
                        0
                    );
                    const wa = workspace.get_work_area_for_monitor(monitor);
                    const availableExtra =
                        wa.width -
                        usedWidth -
                        (monitorWindows.length + 1) * constants.WINDOW_SPACING;
                    if (availableExtra > constants.ANIMATION_DIFF_THRESHOLD) {
                        Logger.log(
                            `DnD arrival: Extra space ${availableExtra}px - trying expansion`
                        );
                        const restored = this.tilingManager.tryRestoreWindowSizes(
                            monitorWindows,
                            wa
                        );
                        if (restored) {
                            this._timeoutRegistry.add(
                                constants.RESIZE_SETTLE_DELAY_MS,
                                () => {
                                    for (const w of monitorWindows) {
                                        WindowState.remove(w, 'isReverseSmartResizing');
                                    }
                                    return GLib.SOURCE_REMOVE;
                                },
                                'windowHandler_dndRestoreSettle'
                            );
                        }
                    }
                }
            }

            // Use TARGET size for restoration flows to avoid transient overflow ejection.
            const targetSize = WindowState.get(window, 'targetRestoredSize');
            const canFit = this.tilingManager.canFitWindow(
                window,
                workspace,
                monitor,
                false,
                targetSize
            );

            if (canFit) {
                // Placement is workspace-wide even when the source monitor still has
                // room. Keep normal arrivals balanced across displays instead of filling
                // one monitor until it overflows before considering the others.
                const moved = this.windowingManager.rebalanceWorkspaceMonitors(workspace, monitor);
                if (moved === 0) {
                    Logger.log('Window fits - tiling workspace directly');
                    this.tilingManager.tileWorkspaceWindows(workspace, null, monitor, false);
                }
                return workspace;
            }

            // The current monitor is full, but placement belongs to the whole workspace.
            // Try every other monitor before shrinking windows or creating a workspace.
            const availableMonitor = this.windowingManager.findAvailableMonitorForWindow(
                window,
                workspace,
                monitor,
                false,
                targetSize
            );
            if (availableMonitor !== null) {
                this.windowingManager.moveWindowToMonitor(
                    window,
                    workspace,
                    monitor,
                    availableMonitor
                );
                return workspace;
            }

            const workArea = this.tilingManager.getUsableWorkArea(workspace, monitor);

            const allExistingWindows = this.windowingManager
                .getMonitorWorkspaceWindows(workspace, monitor)
                .filter(
                    w =>
                        w.get_id() !== window.get_id() &&
                        !this.edgeTilingManager.isEdgeTiled(w) &&
                        !WindowState.get(w, 'pendingInQueue')
                );

            // Include IS_MINIATURE windows so tryFitWithResize can account for the space they occupy.
            // They are treated as non-resizable fixed participants inside tryFitWithResize.
            const existingWindows = allExistingWindows.filter(
                w => !this.windowingManager.isMaximizedOrFullscreen(w)
            );

            if (existingWindows.length > 0) {
                // Pass the new window as focused override, since Mutter's focus_window
                // may still be the previously focused sibling at this point, which
                // would exclude it from miniaturization alongside newWindow.
                const resizeResult = this.tilingManager.tryFitWithResize(
                    window,
                    existingWindows,
                    workArea,
                    workspace,
                    window
                );
                if (resizeResult?.success) {
                    Logger.log('Smart resize applied, tiling directly');
                    // Block overflow during tiling, since a null reference would otherwise let it expel something
                    this.tilingManager._isSmartResizingBlocked = true;
                    try {
                        this.tilingManager._pendingMiniatureWindows =
                            resizeResult.pendingWindows ?? [];
                        this.tilingManager.tileWorkspaceWindows(workspace, null, monitor, false);
                    } finally {
                        this.tilingManager._isSmartResizingBlocked = false;
                    }
                    return workspace;
                }
            }

            Logger.log(
                `Smart resize failed or skipped - applying Overflow logic (existingWindows=${existingWindows.length}, blocked=${this.tilingManager._isSmartResizingBlocked})`
            );
            return await this.windowingManager.moveOversizedWindow(window);
        }

        // A window opening alone should keep Mutter's native animation instead of
        // getting hidden and swapped for our fade-only entrance, since there's nothing
        // to slide in against. onWindowCreated and onWindowAdded both call this and need
        // to agree, so the result is cached instead of each side recomputing on its own
        // (workspace/monitor can resolve differently by the time the second one runs,
        // and disagreeing would leave the actor hidden with no entrance ever claimed).
        // Defaults to true when workspace/monitor aren't ready yet, since losing a real
        // slide-in is more noticeable than an unnecessary one.
        //
        // TODO: only checks whether any sibling exists, not whether the window ends up
        // boxed in by siblings on every side, which also has no real direction to slide
        // from and should get the native animation too. Telling that apart needs the
        // final tiled layout, which isn't computed yet at this point (skipNextEffect
        // has to be called here, before the layout exists). Options: run an early
        // dry-run tiling pass with the new window included (geometry isn't always
        // settled yet here, so the prediction could be wrong), or a cheaper heuristic
        // from the current siblings alone (e.g. a fully packed grid with no free edge),
        // which would only catch that one shape of enclosure, not every possible one.
        _hasSiblings(window) {
            const cached = WindowState.get(window, 'hasEntranceSiblings');
            if (cached !== undefined) return cached;

            const workspace = window.get_workspace();
            const monitor = window.get_monitor();
            if (!workspace || monitor === null || monitor < 0) return true;

            const result = this.windowingManager
                .getMonitorWorkspaceWindows(workspace, monitor)
                .some(w => w.get_id() !== window.get_id());
            WindowState.set(window, 'hasEntranceSiblings', result);
            return result;
        }

        onWindowCreated(window) {
            this.windowingManager.invalidateWindowsCache();
            // Distinguishes a later user maximize from the pre-creation size-change
            // signal emitted by clients that map already maximized/fullscreen.
            WindowState.set(window, 'creationObserved', true);

            // Shift held at launch: make always-on-top before any tiling runs
            const [, , creationMods] = global.get_pointer();
            if (creationMods & Clutter.ModifierType.SHIFT_MASK) {
                window.make_above();
                Logger.log(`Window ${window.get_id()} opened with Shift, set always-on-top`);
            }

            if (this.windowingManager.isMaximizedOrFullscreen(window)) {
                WindowState.set(window, 'openedMaximized', true);
                // Defense: clean up flags that onSizeChange may have set before window-created fired
                WindowState.remove(window, 'maximizedUndoInfo');
                WindowState.remove(window, 'isEnteringSacred');
                Logger.log(
                    `Window ${window.get_id()} opened maximized - marked for auto-tile check`
                );
            }

            const processWindowCallback = () => {
                const monitor = window.get_monitor();
                const workspace = window.get_workspace();

                if (
                    monitor !== null &&
                    window.wm_class !== null &&
                    isWindowAlive(window) &&
                    workspace.list_windows().length !== 0 &&
                    !window.is_hidden()
                ) {
                    if (this.windowingManager.isExcluded(window)) {
                        Logger.log('Window excluded from tiling');
                        WindowState.remove(window, 'arrivalPending');
                        this.revealPendingEntrance(window);
                        this._revealPendingMonitorPlacementEntrance(window);
                        return GLib.SOURCE_REMOVE;
                    }

                    // Use saved_rect for natural size (get_frame_rect matches monitor if Maximized).
                    if (this.windowingManager.isMaximizedOrFullscreen(window)) {
                        try {
                            const saved =
                                window.saved_rect ||
                                (window.get_saved_rect ? window.get_saved_rect() : null);
                            if (saved && saved.width > 0 && saved.height > 0) {
                                WindowState.set(window, 'openingSize', {
                                    width: saved.width,
                                    height: saved.height,
                                });
                                Logger.log(
                                    `onWindowCreated: Captured openingSize fallback from saved_rect: ${saved.width}x${saved.height}`
                                );
                            } else {
                                // Fallback for natively fullscreen apps with no saved_rect:
                                // Use 80% of work area as a reasonable default window size
                                const workArea = workspace.get_work_area_for_monitor(monitor);
                                if (workArea) {
                                    const fallbackWidth = Math.floor(workArea.width * 0.8);
                                    const fallbackHeight = Math.floor(workArea.height * 0.8);
                                    WindowState.set(window, 'openingSize', {
                                        width: fallbackWidth,
                                        height: fallbackHeight,
                                    });
                                    Logger.log(
                                        `onWindowCreated: No saved_rect for fullscreen window - using 80% fallback: ${fallbackWidth}x${fallbackHeight}`
                                    );
                                }
                            }
                        } catch (e) {
                            Logger.warn(
                                `onWindowCreated: Failed to capture saved_rect: ${e.message}`
                            );
                        }
                    } else {
                        // ONLY save preferred size if the window is NOT maximized/fullscreen upon creation.
                        // This prevents capturing "almost-maximized" frames during the opening animation.
                        this.tilingManager.savePreferredSize(window);
                    }

                    if (this.windowingManager.isMaximizedOrFullscreen(window)) {
                        // Some fullscreen clients omit size-change and only expose
                        // sacred state once mapped. This is still their creation path,
                        // so treat them as born sacred before any monitor move.
                        WindowState.set(window, 'openedMaximized', true);
                        const pendingMonitorTarget = WindowState.get(
                            window,
                            'monitorPlacementTarget'
                        );
                        if (pendingMonitorTarget !== undefined) {
                            Logger.log(
                                `Opened sacred window ${window.get_id()} already has pre-map target monitor ${pendingMonitorTarget}`
                            );
                            WindowState.remove(window, 'arrivalPending');
                            WindowState.set(window, 'lastEvaluatedAt', monotonicNow());
                            return GLib.SOURCE_REMOVE;
                        }

                        this.windowingManager.invalidateWindowsCache();
                        const workspaceWindows = this.windowingManager.getMonitorWorkspaceWindows(
                            workspace,
                            monitor
                        );
                        const otherWindows = workspaceWindows.filter(
                            w => w.get_id() !== window.get_id()
                        );

                        if (otherWindows.length > 0) {
                            const availableMonitor =
                                this.windowingManager.findAvailableMonitorForWindow(
                                    window,
                                    workspace,
                                    monitor
                                );
                            if (availableMonitor !== null) {
                                Logger.log(
                                    'Opened sacred (Max/Full) on occupied monitor - using empty monitor in current workspace'
                                );
                                WindowState.remove(window, 'arrivalPending');
                                WindowState.set(window, 'lastEvaluatedAt', monotonicNow());
                                const moved = this.windowingManager.moveWindowToMonitor(
                                    window,
                                    workspace,
                                    monitor,
                                    availableMonitor
                                );
                                if (!moved) this._revealPendingMonitorPlacementEntrance(window);
                            } else {
                                Logger.log(
                                    'Opened sacred (Max/Full) with no empty monitor - queueing for isolation (SACRED)'
                                );
                                // The evaluation queue owns the same sacred decision.
                                // Isolating here too can race it and create two workspaces.
                                this.enqueueWindowForEvaluation(window, workspace, monitor);
                            }
                            return GLib.SOURCE_REMOVE;
                        } else {
                            Logger.log('Sacred window in empty workspace - keeping here');
                            WindowState.remove(window, 'arrivalPending');
                            this._revealPendingMonitorPlacementEntrance(window);
                            this.tilingManager.tileWorkspaceWindows(
                                workspace,
                                window,
                                monitor,
                                false
                            );
                            return GLib.SOURCE_REMOVE;
                        }
                    }

                    const workspaceWindows = this.windowingManager.getMonitorWorkspaceWindows(
                        workspace,
                        monitor
                    );
                    const edgeTiledWindows = workspaceWindows.filter(w => {
                        const tileState = this.edgeTilingManager.getWindowState(w);
                        return (
                            tileState &&
                            tileState.zone !== TileZone.NONE &&
                            w.get_id() !== window.get_id()
                        );
                    });

                    if (edgeTiledWindows.length === 1 && workspaceWindows.length === 2) {
                        Logger.log('New window: Attempting to tile with edge-tiled window');
                        const tileSuccess = this.windowingManager.tryTileWithSnappedWindow(
                            window,
                            edgeTiledWindows[0],
                            null
                        );

                        if (tileSuccess) {
                            Logger.log('New window: Successfully tiled with edge-tiled window');
                            WindowState.remove(window, 'arrivalPending');
                            this.connectWindowSignals(window);
                            return GLib.SOURCE_REMOVE;
                        }
                        Logger.log('New window: Tiling failed, continuing with normal flow');
                    }

                    if (Main.overview.visible)
                        Logger.log(
                            `Window ${window.get_id()} created while Overview is visible; tiling into the model`
                        );

                    this.enqueueWindowForEvaluation(window, workspace, monitor);

                    return GLib.SOURCE_REMOVE;
                }
                return GLib.SOURCE_CONTINUE;
            };

            const actor = window.get_compositor_private();
            if (actor) {
                const isRelated = this.windowingManager.isRelated(window);
                const pendingMonitorTarget = WindowState.get(window, 'monitorPlacementTarget');
                const openingMonitorTarget =
                    pendingMonitorTarget ??
                    (isRelated ? this._findBornSacredMonitorTarget(window) : null);
                if (openingMonitorTarget !== null) {
                    // Sacred windows normally retain Mutter's native effect because
                    // Mosaic never tiles them. This one is about to cross monitors,
                    // though, so keep it hidden until the destination frame settles.
                    WindowState.set(window, 'monitorPlacementEntrancePending', true);
                    Main.wm.skipNextEffect(actor);
                    actor.opacity = 0;
                    // Reassert after Shell's own map handlers have run. skipNextEffect
                    // prevents the transition, but Shell still writes its final opacity.
                    if (!actor.mapped) {
                        const mappedSignalId = actor.connect('notify::mapped', () => {
                            if (!actor.mapped) return;
                            actor.disconnect(mappedSignalId);
                            if (WindowState.get(window, 'monitorPlacementTarget') !== undefined) {
                                actor.remove_transition('opacity');
                                actor.opacity = 0;
                            }
                        });
                    }

                    // Fullscreen clients without a reliable size-change signal reach
                    // this fallback. Start the move now, before waiting for mapped.
                    if (pendingMonitorTarget === undefined) {
                        const workspace = window.get_workspace();
                        const sourceMonitor = window.get_monitor();
                        if (workspace && sourceMonitor !== null && sourceMonitor >= 0)
                            this.windowingManager.moveWindowToMonitor(
                                window,
                                workspace,
                                sourceMonitor,
                                openingMonitorTarget
                            );
                    }
                    this._timeoutRegistry.add(
                        constants.SLIDE_IN_FAILSAFE_MS,
                        () => {
                            if (
                                WindowState.get(window, 'monitorPlacementEntrancePending') &&
                                WindowState.get(window, 'monitorPlacementTarget') === undefined
                            )
                                this._revealPendingMonitorPlacementEntrance(window);
                            return GLib.SOURCE_REMOVE;
                        },
                        'windowHandler_monitorPlacementEntranceFailsafe'
                    );
                } else if (isRelated && !this.shouldSkipSlideIn(window)) {
                    // Ask Mutter to skip its own open animation outright (the same public
                    // API altTab.js uses to skip the unminimize effect) instead of fighting
                    // it after the fact. Our own pipeline drives the entrance once it knows
                    // the real tiled target and siblings, on its own timeline.
                    Main.wm.skipNextEffect(actor);

                    // onWindowAdded tries to hide the actor too, but it usually runs before
                    // the actor even exists yet (get_compositor_private() is still null there
                    // most of the time). This is the first point we're guaranteed to have it,
                    // so the fade-in actually has something to fade from instead of starting
                    // (and silently staying) at the default opacity of 255.
                    actor.opacity = 0;

                    // animateWindow may run (and defer, per Clutter skipping transitions on
                    // unmapped actors) before the actor is actually mapped. Once it is, give
                    // it the one nudge it needs to actually ease instead of sitting hidden.
                    // One-shot: mapped flips on and off repeatedly later on (e.g. every time
                    // the Overview opens/closes), and runDeferredEntrance only has anything
                    // to do the first time anyway.
                    if (actor.mapped) {
                        this._ext.animationsManager.runDeferredEntrance(window);
                    } else {
                        const mappedSignalId = actor.connect('notify::mapped', () => {
                            if (!actor.mapped) return;
                            actor.disconnect(mappedSignalId);
                            this._ext.animationsManager.runDeferredEntrance(window);
                        });
                    }
                }

                let signalId = null;
                let timeoutId = null;
                let processed = false;

                const processOnce = () => {
                    if (processed) return;
                    processed = true;

                    if (signalId) actor.disconnect(signalId);
                    if (timeoutId) this._timeoutRegistry.remove(timeoutId);

                    if (processWindowCallback() === GLib.SOURCE_CONTINUE) {
                        // Gate closed (e.g. wm_class still unset); retry on state changes
                        this._awaitWindowReadiness(
                            window,
                            () => processWindowCallback() === GLib.SOURCE_REMOVE
                        );
                    }

                    this.connectWindowSignals(window);
                };

                // USE MAPPED SIGNAL: Triggers when the window is added to the scene but before paint.
                // This allows us to position it "before" it appears, effectively skipping the spawn animation.
                if (actor.mapped) {
                    processOnce();
                } else {
                    signalId = actor.connect('notify::mapped', () => {
                        if (actor.mapped) processOnce();
                    });
                }

                // Safety timeout
                timeoutId = this._timeoutRegistry.add(
                    400,
                    () => {
                        // Pre-flight check: If the actor was disposed while waiting, abort safely.
                        if (!isWindowAlive(window)) {
                            Logger.log(
                                'window map timeout - window already disposed, aborting process'
                            );
                            return GLib.SOURCE_REMOVE;
                        }

                        Logger.log('window map timeout - falling back to immediate processing');
                        processOnce();
                        return GLib.SOURCE_REMOVE;
                    },
                    'windowHandler_mapSafety'
                );
            } else {
                // Fallback for non-actor windows (rare in Shell): same signal-driven gate
                if (processWindowCallback() === GLib.SOURCE_CONTINUE)
                    this._awaitWindowReadiness(
                        window,
                        () => processWindowCallback() === GLib.SOURCE_REMOVE
                    );
                this.connectWindowSignals(window);
            }
        }

        onWindowAdded(_workspace, window) {
            this.windowingManager.invalidateWindowsCache();
            if (WindowState.get(window, 'userPlacementDisplaced')) {
                // makeRoomForUserPlacement owns both sides of this internal move.
                return;
            }
            if (!this._ext.windowingManager.isRelated(window)) {
                return;
            }

            // Going on-all-workspaces (sticky, or landing on a secondary monitor under
            // workspaces-only-on-primary) re-adds the window to every workspace at once.
            // It isn't arriving anywhere; the monitor signals own its placement, and
            // running the arrival pipeline here overflows it to another workspace.
            if (window.is_on_all_workspaces()) {
                return;
            }

            this._ext.tilingManager.savePreferredSize(window);

            // addedTime feeds resize settling and rebalance age checks; arrivalPending
            // shields the window until its arrival evaluation resolves placement.
            WindowState.set(window, 'addedTime', monotonicNow());
            WindowState.set(window, 'arrivalPending', true);

            // Flag the first-ever tiling pass for this window so it slides in instead
            // of using the "no jump" continuity math meant for windows that already
            // have a real visual position. onWindowCreated separately asks Mutter to
            // skip its own open animation (skipNextEffect) and nudges animateWindow's
            // deferred entrance once the actor is actually mapped.
            if (!this.shouldSkipSlideIn(window)) {
                WindowState.set(window, 'pendingFirstPlacement', true);
                const actor = window.get_compositor_private();
                // onWindowCreated races independently and may have already started (or
                // queued) the real entrance ease by the time this runs. Resetting opacity
                // here would stomp that mid-flight (a direct property write the ease's own
                // next frame then overwrites again), which is exactly what shows up as a blink.
                if (actor && !this._ext.animationsManager.hasActiveOrPendingEntrance(window))
                    actor.opacity = 0;

                // Failsafe: if animateWindow never claims this window (e.g. excluded
                // right after creation), don't leave it invisible or the flag stuck.
                // pendingFirstPlacement stays true for the entire span of a genuinely
                // running ease (cleared only by its own onStopped), and a slowed-down
                // slow_down_factor easily outlasts this fixed timeout, so re-arm instead
                // of yanking opacity to its final value out from under an ease that's
                // still legitimately mid-flight.
                const scheduleFirstPlacementFailsafe = () => {
                    this._timeoutRegistry.add(
                        constants.SLIDE_IN_FAILSAFE_MS,
                        () => {
                            if (!WindowState.get(window, 'pendingFirstPlacement'))
                                return GLib.SOURCE_REMOVE;
                            if (this._ext.animationsManager.hasActiveOrPendingEntrance(window)) {
                                scheduleFirstPlacementFailsafe();
                                return GLib.SOURCE_REMOVE;
                            }
                            WindowState.remove(window, 'pendingFirstPlacement');
                            const a = isWindowAlive(window)
                                ? window.get_compositor_private()
                                : null;
                            if (a && !a.is_destroyed()) a.opacity = 255;
                            return GLib.SOURCE_REMOVE;
                        },
                        'windowHandler_firstPlacementFailsafe'
                    );
                };
                scheduleFirstPlacementFailsafe();
            }

            const proceedWhenValid = () => {
                const WORKSPACE = window.get_workspace();
                if (!WORKSPACE) return false;

                const WINDOW = window;
                const MONITOR = WINDOW.get_monitor();

                if (!this._ext.tilingManager.checkValidity(MONITOR, WORKSPACE, WINDOW, false))
                    return false;

                const frame = WINDOW.get_frame_rect();
                if (frame.width <= 0 || frame.height <= 0) return false;

                // Detect a DnD across workspaces: window was just removed from a different
                // workspace within SAFETY_TIMEOUT_BUFFER_MS, so this add is the drop side.
                const previousWorkspaceIndex = WindowState.get(WINDOW, 'previousWorkspace');
                const removedTimestamp = WindowState.get(WINDOW, 'removedTimestamp');
                const timeSinceRemoved = removedTimestamp
                    ? monotonicNow() - removedTimestamp
                    : Infinity;

                if (
                    previousWorkspaceIndex !== undefined &&
                    previousWorkspaceIndex !== WORKSPACE.index() &&
                    timeSinceRemoved < constants.SAFETY_TIMEOUT_BUFFER_MS
                ) {
                    // Skip if this is an overflow move, not a real drag-drop
                    if (!WindowState.get(WINDOW, 'movedByOverflow')) {
                        const originWorkspace =
                            global.workspace_manager.get_workspace_by_index(previousWorkspaceIndex);
                        if (originWorkspace) {
                            WindowState.set(WINDOW, 'userMoveOrigin', {
                                workspace: originWorkspace,
                                monitor: WindowState.get(WINDOW, 'leftMonitor') ?? MONITOR,
                            });
                        }
                        // An Overview drop must not activate its destination or close
                        // the Overview. Outside it, retain Continuum's normal feedback.
                        if (!Main.overview.visible) {
                            WORKSPACE.activate(global.get_current_time());
                            this._ext.windowingManager.showWorkspaceSwitcher(WORKSPACE, MONITOR);
                        }

                        // Mark as DnD arrival; triggers expansion after tiling
                        WindowState.set(WINDOW, 'arrivedFromDnD', true);

                        WindowState.remove(WINDOW, 'previousWorkspace');
                        WindowState.remove(WINDOW, 'removedTimestamp');
                        WindowState.remove(WINDOW, 'manualWorkspaceMove');
                    }
                }

                // Mark window as waiting for geometry; prevents premature overflow
                WindowState.set(WINDOW, 'waitingForGeometry', true);

                // Repoll while waitForGeometry returns SOURCE_CONTINUE, bounded
                // so a window that never reports geometry can't poll forever.
                let geometryAttempts = 0;
                this._timeoutRegistry.add(
                    constants.GEOMETRY_CHECK_DELAY_MS,
                    () => {
                        if (
                            ++geometryAttempts > constants.GEOMETRY_WAIT_MAX_ATTEMPTS ||
                            !isWindowAlive(WINDOW)
                        ) {
                            // Giving up here used to strand arrivalPending, and everything that
                            // reads it as "placement unresolved" would shield the window forever.
                            WindowState.remove(WINDOW, 'arrivalPending');
                            return GLib.SOURCE_REMOVE;
                        }
                        return this.waitForGeometry(WINDOW, WORKSPACE, MONITOR);
                    },
                    'windowHandler_geometryCheck'
                );

                return true;
            };

            // First attempt runs on idle, keeping it out of the window-added emission
            this._timeoutRegistry.addIdle(() => {
                if (isWindowAlive(window) && !proceedWhenValid())
                    this._awaitWindowReadiness(window, proceedWhenValid);
                return GLib.SOURCE_REMOVE;
            });
        }

        onWindowRemoved(workspace, window) {
            this.windowingManager.invalidateWindowsCache();
            if (
                WindowState.get(window, 'monitorRebalanceInProgress') ||
                WindowState.get(window, 'userPlacementDisplaced')
            ) {
                return;
            }
            if (!this._ext.windowingManager.isRelated(window)) {
                return;
            }

            // On destroy, both the 'unmanaged' handler and the workspace
            // 'window-removed' signal land here, so dedupe to keep the retile/restore
            // pipeline (and miniature auto-restore) from running twice.
            const now = monotonicNow();
            const lastHandled = WindowState.get(window, 'removalHandledAt');
            if (lastHandled && now - lastHandled < constants.SAFETY_TIMEOUT_BUFFER_MS) {
                Logger.log(
                    `onWindowRemoved: duplicate removal event for ${window.get_id()} - skipping`
                );
                return;
            }
            WindowState.set(window, 'removalHandledAt', now);

            WindowState.set(window, 'previousWorkspace', workspace.index());
            WindowState.set(window, 'removedTimestamp', now);

            const wasMovedByOverflow = WindowState.get(window, 'movedByOverflow');

            // Capture removed window's size before any operations. Guarded since the
            // window may already be disposed when removal comes from a destroy.
            const removedFrame = isWindowAlive(window) ? window.get_frame_rect() : null;
            const freedWidth = removedFrame ? removedFrame.width : 0;
            const freedHeight = removedFrame ? removedFrame.height : 0;

            // Capture monitor at event time (window may move monitors during DnD)
            const removedMonitor = window.get_monitor();

            const actor = window.get_compositor_private();
            if (!actor || actor.is_destroyed()) {
                this._ext.tilingManager.clearPreferredSize(window);
            } else {
                Logger.log(
                    '_windowRemoved: Window still exists (DnD move); keeping preferred size'
                );
            }

            this._timeoutRegistry.add(constants.WINDOW_VALIDITY_CHECK_INTERVAL_MS, () => {
                const WORKSPACE = workspace;

                // A window leaving for another monitor already reports the destination here,
                // which counts the siblings it left behind as zero and reads as an empty
                // workspace. onWindowLeftMonitor fires right after us with the real source.
                const leftMonitorAt = WindowState.get(window, 'leftMonitorAt');
                const cameFromMonitorMove =
                    leftMonitorAt &&
                    monotonicNow() - leftMonitorAt < constants.SAFETY_TIMEOUT_BUFFER_MS;
                const MONITOR = cameFromMonitorMove
                    ? WindowState.get(window, 'leftMonitor')
                    : removedMonitor;

                if (!WORKSPACE || WORKSPACE.index() < 0) {
                    return GLib.SOURCE_REMOVE;
                }

                const removedId = window.get_id();
                const remainingWindows = this._ext.windowingManager
                    .getMonitorWorkspaceWindows(WORKSPACE, MONITOR)
                    .filter(
                        w =>
                            w.get_id() !== removedId &&
                            !this._ext.edgeTilingManager.isEdgeTiled(w) &&
                            !this._ext.windowingManager.isExcluded(w)
                    );

                Logger.log(
                    `_windowRemoved: ${remainingWindows.length} remaining windows, wasOverflowMove=${wasMovedByOverflow}`
                );

                // Actual closes are finalized after the close animation, together with
                // monitor redistribution. Workspace/DnD removals still use this path.
                if (WindowState.get(window, 'closeFinalizationPending')) {
                    Logger.log('_windowRemoved: close transaction owns the final layout');
                    return GLib.SOURCE_REMOVE;
                }

                // Try to restore window sizes with freed space (Reverse Smart Resize)
                // Miniatures are excluded since their slot is fixed and shouldn't be grown to preferred.
                if (remainingWindows.length > 0) {
                    this._retileAfterWindowGone(
                        window,
                        remainingWindows,
                        WORKSPACE,
                        MONITOR,
                        freedWidth,
                        freedHeight,
                        {
                            wasMovedByOverflow,
                            cleanSmartResizingFlags: true,
                            includeMinisInRestoreCall: true,
                            passFreedDimsToRestore: false,
                            requireBothFreedDims: true,
                            reverseLogLabel: '[REVERSE-REMOVED] Window removed',
                            settleLogLabel: 'Retiling after restore delay',
                            settleTimeoutName: 'windowHandler_restoreSettle',
                        }
                    );
                } else {
                    const allRelatedWindows = this._ext.windowingManager
                        .getMonitorWorkspaceWindows(WORKSPACE, MONITOR)
                        .filter(w => w.get_id() !== removedId);
                    if (allRelatedWindows.length === 0) {
                        if (WORKSPACE.index() < 0) {
                            Logger.log(
                                '_windowRemoved: Workspace already destroyed, skipping cleanup'
                            );
                            return GLib.SOURCE_REMOVE;
                        }
                        Logger.log(
                            '_windowRemoved: No related windows remain on monitor; staying on current workspace'
                        );
                        WindowState.remove(window, 'isRestoringSacred');
                    }
                }

                return GLib.SOURCE_REMOVE;
            });
        }

        waitForGeometry(WINDOW, WORKSPACE, MONITOR) {
            const rect = WINDOW.get_frame_rect();

            if (rect.width > 0 && rect.height > 0) {
                WindowState.set(WINDOW, 'waitingForGeometry', false);
                WindowState.set(WINDOW, 'geometryReady', true);

                if (this._ext.windowingManager.isExcluded(WINDOW)) {
                    Logger.log(
                        'waitForGeometry: Window is excluded - connecting signals but skipping tiling'
                    );
                    WindowState.remove(WINDOW, 'arrivalPending');
                    this.connectWindowSignals(WINDOW);
                    this.revealPendingEntrance(WINDOW);
                    return GLib.SOURCE_REMOVE;
                }

                if (WindowState.get(WINDOW, 'monitorPlacementTarget') !== undefined) {
                    Logger.log(
                        `Window ${WINDOW.get_id()} geometry ready while pre-map monitor placement is pending`
                    );
                    WindowState.remove(WINDOW, 'arrivalPending');
                    return GLib.SOURCE_REMOVE;
                }

                const wa = WORKSPACE.get_work_area_for_monitor(MONITOR);
                Logger.log(
                    `Window ${WINDOW.get_id()} ready: size=${rect.width}x${rect.height}, workArea=${wa.width}x${wa.height}`
                );

                if (WindowState.get(WINDOW, 'movedByOverflow')) {
                    Logger.log(
                        'Skipping early tile in waitForGeometry - window was moved by overflow (Flags cleared to prevent leakage)'
                    );
                    WindowState.remove(WINDOW, 'movedByOverflow');
                    WindowState.remove(WINDOW, 'arrivalPending');
                    return GLib.SOURCE_REMOVE;
                }

                if (Main.overview.visible) {
                    Logger.log('Window created while Overview is visible; tiling into the model');
                    this._ext.tilingManager.savePreferredSize(WINDOW);
                    this.connectWindowSignals(WINDOW);
                    this.enqueueWindowForEvaluation(WINDOW, WORKSPACE, MONITOR);
                    return GLib.SOURCE_REMOVE;
                }

                const performTiling = async () => {
                    if (WindowState.get(WINDOW, 'movedByOverflow')) {
                        Logger.log(
                            'Skipping duplicate evaluation queueing - window was already evaluated and moved by overflow'
                        );
                        WindowState.remove(WINDOW, 'arrivalPending');
                        return;
                    }
                    this.enqueueWindowForEvaluation(WINDOW, WORKSPACE, MONITOR);
                };

                const isDnDArrival = WindowState.get(WINDOW, 'arrivedFromDnD');
                const previousWorkspaceIndex = WindowState.get(WINDOW, 'previousWorkspace');

                if (
                    isDnDArrival ||
                    WindowState.get(WINDOW, 'movedByOverflow') ||
                    (previousWorkspaceIndex !== undefined &&
                        previousWorkspaceIndex !== WORKSPACE.index())
                ) {
                    Logger.log('Cross-workspace move: Waiting for workspace animation');
                    afterWorkspaceSwitch(performTiling, this._ext._timeoutRegistry);
                } else {
                    performTiling();
                }

                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        }
    }
);
