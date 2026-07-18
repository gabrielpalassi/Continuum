// SPDX-License-Identifier: GPL-3.0-or-later
// Window-management behavior adapted from Mosaic WM
// by Cléo Menezes Jr. and contributors:
// https://github.com/CleoMenezesJr/MosaicWM
// Window management utilities and workspace operations

import * as Logger from './logger.js';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as WorkspaceSwitcherPopup from 'resource:///org/gnome/shell/ui/workspaceSwitcherPopup.js';
import {afterWorkspaceSwitch} from './timing.js';
import {MONITOR_PLACEMENT_TIMEOUT_MS, RETILE_DELAY_MS, TileZone} from './constants.js';
import * as WindowState from './windowState.js';
import {IS_MINIATURE} from './windowState.js';
import {isWindowAlive, isWorkspaceAlive} from './liveness.js';

const BLACKLISTED_WM_CLASSES = ['org.gnome.Screenshot', 'Gnome-screenshot'];

import GObject from 'gi://GObject';

export const WindowingManager = GObject.registerClass(
    {
        GTypeName: 'ContinuumWindowingManager',
    },
    class WindowingManager extends GObject.Object {
        _init() {
            super._init();
            this._edgeTilingManager = null;
            this._animationsManager = null;
            this._tilingManager = null;
            this._timeoutRegistry = null;
            this._overflowStartCallback = null;
            this._overflowEndCallback = null;

            // Cache for getMonitorWorkspaceWindows; invalidated at start of each tiling operation.
            // Each cache generation groups the workspace's windows for every monitor in
            // one native list_windows() pass.
            // WeakMap<Workspace, Map<String, Window[]>>
            this._windowsCache = new WeakMap();
        }

        setEdgeTilingManager(manager) {
            this._edgeTilingManager = manager;
        }

        setAnimationsManager(manager) {
            this._animationsManager = manager;
        }

        setTilingManager(manager) {
            this._tilingManager = manager;
        }

        setTimeoutRegistry(registry) {
            this._timeoutRegistry = registry;
        }

        setOverflowCallbacks(startCallback, endCallback) {
            this._overflowStartCallback = startCallback;
            this._overflowEndCallback = endCallback;
        }

        getTimestamp() {
            return global.get_current_time();
        }

        getWorkspace() {
            return global.workspace_manager.get_active_workspace();
        }

        invalidateWindowsCache() {
            this._cacheVersion = (this._cacheVersion || 0) + 1;
        }

        getMonitorWorkspaceWindows(workspace, monitor, allow_unrelated) {
            if (!workspace) return [];

            let workspaceCache = this._windowsCache.get(workspace);
            if (!workspaceCache || workspaceCache._version !== this._cacheVersion) {
                workspaceCache = new Map();
                workspaceCache._version = this._cacheVersion;

                const allByMonitor = new Map();
                const relatedByMonitor = new Map();
                for (const window of workspace.list_windows()) {
                    const windowMonitor = window.get_monitor();
                    if (!allByMonitor.has(windowMonitor)) {
                        allByMonitor.set(windowMonitor, []);
                        relatedByMonitor.set(windowMonitor, []);
                    }
                    allByMonitor.get(windowMonitor).push(window);
                    if (this.isRelated(window)) relatedByMonitor.get(windowMonitor).push(window);
                }

                const monitorIds = new Set([
                    ...allByMonitor.keys(),
                    ...Array.from({length: global.display.get_n_monitors()}, (_, i) => i),
                ]);
                for (const monitorId of monitorIds) {
                    workspaceCache.set(`${monitorId}-0`, relatedByMonitor.get(monitorId) ?? []);
                    workspaceCache.set(`${monitorId}-1`, allByMonitor.get(monitorId) ?? []);
                }
                this._windowsCache.set(workspace, workspaceCache);
            }

            const cacheKey = `${monitor}-${allow_unrelated ? 1 : 0}`;
            if (workspaceCache.has(cacheKey)) {
                return workspaceCache.get(cacheKey);
            }

            return [];
        }

        tryTileWithSnappedWindow(window, edgeTiledWindow, previousWorkspace) {
            if (!this._edgeTilingManager) {
                Logger.error('tryTileWithSnappedWindow: edgeTilingManager not set');
                return false;
            }

            const workspace = window.get_workspace();
            const monitor = window.get_monitor();
            const workArea = workspace.get_work_area_for_monitor(monitor);

            const tileState = this._edgeTilingManager.getWindowState(edgeTiledWindow);

            if (!tileState || tileState.zone === TileZone.NONE) {
                Logger.log('Existing window is not edge-tiled, cannot tile');
                return false;
            }

            let direction;
            if (
                tileState.zone === TileZone.LEFT_FULL ||
                tileState.zone === TileZone.TOP_LEFT ||
                tileState.zone === TileZone.BOTTOM_LEFT
            ) {
                direction = 'right';
            } else if (
                tileState.zone === TileZone.RIGHT_FULL ||
                tileState.zone === TileZone.TOP_RIGHT ||
                tileState.zone === TileZone.BOTTOM_RIGHT
            ) {
                direction = 'left';
            } else {
                Logger.log('Unsupported edge tile zone for dual-tiling');
                return false;
            }

            const existingFrame = edgeTiledWindow.get_frame_rect();
            const existingWidth = existingFrame.width;
            const availableWidth = workArea.width - existingWidth;

            Logger.log(
                `Auto-tiling: existing window width=${existingWidth}px, available=${availableWidth}px`
            );

            let targetX, targetY, targetWidth, targetHeight;

            if (direction === 'left') {
                targetX = workArea.x;
                targetY = workArea.y;
                targetWidth = availableWidth;
                targetHeight = workArea.height;
            } else {
                // right
                targetX = workArea.x + existingWidth;
                targetY = workArea.y;
                targetWidth = availableWidth;
                targetHeight = workArea.height;
            }

            try {
                this._edgeTilingManager.saveWindowState(window);

                window.unmaximize();
                window.move_resize_frame(false, targetX, targetY, targetWidth, targetHeight);

                const zone = direction === 'left' ? TileZone.LEFT_FULL : TileZone.RIGHT_FULL;
                const state = this._edgeTilingManager.getWindowState(window);
                if (state) {
                    state.zone = zone;
                    Logger.log(
                        `Dual-tiling: Updated window ${window.get_id()} state to zone ${zone}`
                    );

                    this._edgeTilingManager.setupResizeListener(window);
                }

                this._edgeTilingManager.registerAutoTileDependency(window, edgeTiledWindow);

                Logger.log(
                    `Successfully dual-tiled window ${window.get_wm_class()} to ${direction} (${targetWidth}x${targetHeight})`
                );
                return true;
            } catch (error) {
                Logger.log(`Failed to tile window: ${error.message}`);
                if (previousWorkspace) {
                    window.change_workspace(previousWorkspace);
                }
                return false;
            }
        }

        createOrReuseAdjacentWorkspace(originWorkspace) {
            const workspaceManager = global.workspace_manager;
            const currentIndex = originWorkspace.index();
            const nextIndex = currentIndex + 1;
            const totalWorkspaces = workspaceManager.get_n_workspaces();
            const nextWorkspace =
                nextIndex < totalWorkspaces
                    ? workspaceManager.get_workspace_by_index(nextIndex)
                    : null;

            let targetWorkspace;
            if (nextWorkspace && nextWorkspace.list_windows().length === 0) {
                Logger.log(`[WORKSPACE] Reusing existing empty workspace at WS-${nextIndex}`);
                targetWorkspace = nextWorkspace;
            } else {
                Logger.log(`[WORKSPACE] Creating new workspace and inserting at WS-${nextIndex}`);
                targetWorkspace = workspaceManager.append_new_workspace(false, this.getTimestamp());
                workspaceManager.reorder_workspace(targetWorkspace, nextIndex);
            }

            return targetWorkspace;
        }

        moveOversizedWindow(window, options = {switchFocus: true}) {
            return new Promise(resolve => {
                const workspaceManager = global.workspace_manager;
                const monitor = window.get_monitor();

                // Notify that overflow is starting
                if (this._overflowStartCallback) {
                    this._overflowStartCallback();
                }

                // Flag window as overflow-moved to prevent tiling errors
                WindowState.set(window, 'movedByOverflow', true);

                // Use current workspace as origin to prevent overflow target loops.
                const currentIndex = window.get_workspace().index();

                Logger.log(`moveOversizedWindow: origin=${currentIndex}`);

                const isSacred = this.isMaximizedOrFullscreen(window);
                const nextIndex = currentIndex + 1;
                const totalWorkspaces = workspaceManager.get_n_workspaces();
                let target_workspace = null;

                // GNOME's dynamic workspaces might not have a workspace at nextIndex yet
                const nextWorkspace =
                    nextIndex < totalWorkspaces
                        ? workspaceManager.get_workspace_by_index(nextIndex)
                        : null;

                if (isSacred) {
                    Logger.log(
                        `[PLACEMENT] Sacred window detected - targeting strictly WS-${nextIndex} for isolation`
                    );
                    target_workspace = this.createOrReuseAdjacentWorkspace(
                        workspaceManager.get_workspace_by_index(currentIndex)
                    );
                } else {
                    Logger.log(
                        `[PLACEMENT] Overflow window detected - targeting strictly WS-${nextIndex}`
                    );
                    if (
                        nextWorkspace &&
                        this._tilingManager &&
                        this._tilingManager.canFitWindow(window, nextWorkspace, monitor)
                    ) {
                        Logger.log(`[PLACEMENT] Window fits in existing adjacent WS-${nextIndex}`);
                        target_workspace = nextWorkspace;
                    } else {
                        Logger.log(
                            `[PLACEMENT] Adjacent WS-${nextIndex} is full or missing - creating new workspace`
                        );
                        target_workspace = this.createOrReuseAdjacentWorkspace(
                            workspaceManager.get_workspace_by_index(currentIndex)
                        );
                    }
                }

                const previous_workspace = window.get_workspace();
                const switchFocusRequested = options.switchFocus !== false;

                window.change_workspace(target_workspace);

                // Defer activation to next idle (no artificial delay)
                this._timeoutRegistry.addIdle(() => {
                    const workspaceIndex = target_workspace.index();
                    if (
                        workspaceIndex < 0 ||
                        workspaceIndex >= workspaceManager.get_n_workspaces()
                    ) {
                        Logger.warn(`Workspace no longer valid: ${workspaceIndex}`);
                        resolve(target_workspace);
                        return GLib.SOURCE_REMOVE;
                    }

                    // Decide focus after any ongoing workspace switch completes,
                    // avoiding fights with user-initiated navigation.
                    afterWorkspaceSwitch(() => {
                        const stillOnOrigin =
                            global.workspace_manager.get_active_workspace() === previous_workspace;
                        if (stillOnOrigin && switchFocusRequested) {
                            target_workspace.activate(global.get_current_time());
                            this.showWorkspaceSwitcher(target_workspace, monitor);
                        }
                    }, this._timeoutRegistry);

                    // Re-tile after window has settled
                    if (this._tilingManager) {
                        Logger.log(
                            'moveOversizedWindow: workspace switch done, retiling immediately and then waiting for animations'
                        );

                        // First, repair any aborted smart-resize corruption in the origin workspace before the window was ejected
                        if (previous_workspace.index() !== target_workspace.index()) {
                            this._tilingManager.tileWorkspaceWindows(
                                previous_workspace,
                                null,
                                monitor
                            );
                        }

                        // Tile target workspace IMMEDIATELY to prevent "leap to 0,0"
                        this._tilingManager.tileWorkspaceWindows(target_workspace, null, monitor);

                        afterWorkspaceSwitch(() => {
                            try {
                                // Perfectly tile the target workspace again after GNOME animations finish
                                this._tilingManager.tileWorkspaceWindows(
                                    target_workspace,
                                    null,
                                    monitor
                                );

                                // Check position after tiling
                                this._timeoutRegistry.addIdle(
                                    () => {
                                        try {
                                            if (!isWindowAlive(window)) {
                                                return;
                                            }
                                            const finalFrame = window.get_frame_rect();
                                            const workArea =
                                                target_workspace.get_work_area_for_monitor(monitor);
                                            const expectedX =
                                                Math.floor(
                                                    (workArea.width - finalFrame.width) / 2
                                                ) + workArea.x;
                                            const expectedY =
                                                Math.floor(
                                                    (workArea.height - finalFrame.height) / 2
                                                ) + workArea.y;
                                            const positionError =
                                                Math.abs(finalFrame.x - expectedX) +
                                                Math.abs(finalFrame.y - expectedY);

                                            if (positionError > 10) {
                                                Logger.log(
                                                    `moveOversizedWindow: window mispositioned by ${positionError}px, retiling`
                                                );
                                                this._tilingManager.tileWorkspaceWindows(
                                                    target_workspace,
                                                    null,
                                                    monitor
                                                );
                                            }
                                        } finally {
                                            WindowState.remove(window, 'movedByOverflow');
                                            WindowState.remove(window, 'overflowOriginWorkspace');

                                            if (this._overflowEndCallback) {
                                                this._overflowEndCallback();
                                            }
                                            resolve(target_workspace);
                                        }
                                        return GLib.SOURCE_REMOVE;
                                    },
                                    'windowing_positionCheck',
                                    GLib.PRIORITY_DEFAULT_IDLE
                                );
                            } catch (e) {
                                Logger.error(`Error during moveOversizedWindow retiling: ${e}`);

                                WindowState.remove(window, 'movedByOverflow');
                                WindowState.remove(window, 'overflowOriginWorkspace');

                                if (this._overflowEndCallback) {
                                    this._overflowEndCallback();
                                }
                                resolve(target_workspace);
                            }
                        }, this._timeoutRegistry);
                    } else {
                        WindowState.remove(window, 'movedByOverflow');
                        WindowState.remove(window, 'overflowOriginWorkspace');

                        if (this._overflowEndCallback) {
                            this._overflowEndCallback();
                        }
                        resolve(target_workspace);
                    }

                    return GLib.SOURCE_REMOVE;
                });
            });
        }

        // The exclusion reasons that already hold before the window has any geometry.
        // Callers running that early (entrance setup) must ask this instead of
        // isExcluded, since an unmapped window reports 0x0 and reads as a 1×1 helper.
        isExcludedByPolicy(meta_window) {
            if (!this.isRelated(meta_window) || meta_window.minimized) {
                return true;
            }

            if (meta_window.is_above()) {
                return true;
            }

            const wmClass = meta_window.get_wm_class();
            if (wmClass && BLACKLISTED_WM_CLASSES.includes(wmClass)) {
                return true;
            }

            return false;
        }

        isExcluded(meta_window) {
            if (this.isExcludedByPolicy(meta_window)) {
                return true;
            }

            // 1×1 XWayland utility windows (clipboard helpers) must not enter the layout.
            // get_frame_rect on a disposed MetaWindow segfaults libmutter, so only
            // read it while the window is alive (dead windows keep prior semantics).
            if (isWindowAlive(meta_window)) {
                const frame = meta_window.get_frame_rect();
                if (frame.width <= 1 && frame.height <= 1) {
                    return true;
                }
            }

            return false;
        }

        isRelated(meta_window) {
            if (meta_window.is_attached_dialog()) {
                return false;
            }

            if (meta_window.get_transient_for() !== null) {
                return false;
            }

            if (meta_window.window_type !== Meta.WindowType.NORMAL) {
                return false;
            }

            if (meta_window.is_skip_taskbar()) {
                return false;
            }

            if (this.isTrulySticky(meta_window)) {
                return false;
            }

            return true;
        }

        // With workspaces-only-on-primary, Mutter reports every window on a secondary monitor
        // as on-all-workspaces. That's the monitor policy talking, not the user pinning a
        // window, so it stays a normal mosaic member. The overview layout asks this too; both
        // have to agree on what sticky means or they end up laying out different mosaics.
        isTrulySticky(meta_window) {
            if (!meta_window.is_on_all_workspaces()) {
                return false;
            }

            const stickyByMonitorPolicy =
                Meta.prefs_get_workspaces_only_on_primary() && !meta_window.is_on_primary_monitor();
            return !stickyByMonitorPolicy;
        }

        isMaximizedOrFullscreen(window) {
            return window.is_maximized() || window.is_fullscreen();
        }

        hasSacredWindow(workspace, monitor, excludeWindowId = null) {
            if (!workspace || monitor === null || monitor === undefined) return false;

            const windows = this.getMonitorWorkspaceWindows(workspace, monitor);
            return windows.some(
                w =>
                    (!excludeWindowId || w.get_id() !== excludeWindowId) &&
                    this.isMaximizedOrFullscreen(w)
            );
        }

        getSacredOccupant(window, workspace, monitor) {
            if (!window || !workspace || monitor === null || monitor === undefined) return null;

            this.invalidateWindowsCache();
            return (
                this.getMonitorWorkspaceWindows(workspace, monitor).find(
                    candidate =>
                        candidate.get_id() !== window.get_id() &&
                        !this.isExcluded(candidate) &&
                        this.isMaximizedOrFullscreen(candidate)
                ) ?? null
            );
        }

        // An explicit move owns its destination. Sacred isolation is still the right
        // default for newly opened windows, but applying it to a user move either leaves
        // a normal arrival floating over the maximized window or sends a maximized
        // arrival straight back where it came from. Move the incumbent instead, keeping
        // both windows' maximized state intact.
        async makeRoomForUserPlacement(window, workspace, monitor, origin = null) {
            const incumbent = this.getSacredOccupant(window, workspace, monitor);
            if (!incumbent) return false;

            Logger.log(
                `[USER-PLACEMENT] Window ${window.get_id()} owns WS-${workspace.index()} monitor ${monitor}; relocating sacred incumbent ${incumbent.get_id()}`
            );

            const originWorkspace = origin?.workspace;
            const originMonitor = origin?.monitor;
            const validOrigin =
                isWorkspaceAlive(originWorkspace) &&
                originMonitor !== null &&
                originMonitor !== undefined &&
                originMonitor >= 0 &&
                originMonitor < global.display.get_n_monitors() &&
                (originWorkspace !== workspace || originMonitor !== monitor);

            let originIsEmpty = false;
            if (validOrigin) {
                this.invalidateWindowsCache();
                originIsEmpty =
                    this.getMonitorWorkspaceWindows(originWorkspace, originMonitor).filter(
                        candidate =>
                            candidate.get_id() !== window.get_id() &&
                            candidate.get_id() !== incumbent.get_id() &&
                            !this.isExcluded(candidate)
                    ).length === 0;
            }

            if (originIsEmpty) {
                const incumbentWorkspace = incumbent.get_workspace();
                const incumbentMonitor = incumbent.get_monitor();
                WindowState.set(incumbent, 'userPlacementDisplaced', true);

                try {
                    if (incumbentWorkspace !== originWorkspace)
                        incumbent.change_workspace(originWorkspace);

                    if (incumbentMonitor !== originMonitor) {
                        const moveStarted = this.moveWindowToMonitor(
                            incumbent,
                            originWorkspace,
                            incumbentMonitor,
                            originMonitor
                        );
                        if (!moveStarted) WindowState.remove(incumbent, 'userPlacementDisplaced');
                    } else {
                        this._timeoutRegistry?.addIdle(() => {
                            WindowState.remove(incumbent, 'userPlacementDisplaced');
                            this.invalidateWindowsCache();
                            return GLib.SOURCE_REMOVE;
                        }, 'windowing_clearUserPlacementDisplacement');
                    }

                    this.invalidateWindowsCache();
                    if (!this.isMaximizedOrFullscreen(window))
                        this._tilingManager?.tileWorkspaceWindows(
                            workspace,
                            window,
                            monitor,
                            false
                        );
                    Logger.log(
                        `[USER-PLACEMENT] Sacred incumbent ${incumbent.get_id()} moved into the vacated origin`
                    );
                    return true;
                } catch (e) {
                    WindowState.remove(incumbent, 'userPlacementDisplaced');
                    Logger.warn(
                        `[USER-PLACEMENT] Could not move incumbent into the vacated origin: ${e.message}`
                    );
                }
            }

            // The origin still has siblings, so putting a maximized window there would
            // merely recreate the same conflict. Isolate the incumbent and leave the
            // user's requested destination untouched.
            await this.moveOversizedWindow(incumbent, {switchFocus: false});
            this.invalidateWindowsCache();
            if (!this.isMaximizedOrFullscreen(window))
                this._tilingManager?.tileWorkspaceWindows(workspace, window, monitor, false);
            return true;
        }

        // Placement is workspace-wide: a full source monitor should not force a new
        // workspace while another monitor in the same workspace can accept the window.
        // Prefer emptier monitors so a vacant display wins over squeezing an existing
        // mosaic. canFitWindow also enforces sacred isolation per monitor, which means a
        // maximized/fullscreen window will only select an otherwise empty monitor.
        findAvailableMonitorForWindow(
            window,
            workspace,
            sourceMonitor,
            relaxed = false,
            overrideSize = null
        ) {
            if (!window || !workspace || !this._tilingManager) return null;

            const nMonitors = global.display.get_n_monitors();
            if (nMonitors <= 1) return null;

            const candidates = [];
            for (let monitor = 0; monitor < nMonitors; monitor++) {
                if (monitor === sourceMonitor) continue;

                const workArea = workspace.get_work_area_for_monitor(monitor);
                if (!workArea || workArea.width <= 0 || workArea.height <= 0) continue;

                const windowCount = this.getMonitorWorkspaceWindows(workspace, monitor).filter(
                    w => w.get_id() !== window.get_id() && !this.isExcluded(w)
                ).length;
                candidates.push({monitor, windowCount});
            }

            candidates.sort((a, b) => a.windowCount - b.windowCount || a.monitor - b.monitor);

            const isSacred = this.isMaximizedOrFullscreen(window);
            for (const {monitor, windowCount} of candidates) {
                // Do not let canFitWindow's pending-arrival filter make an occupied
                // monitor look empty to a sacred window.
                if (isSacred && windowCount > 0) continue;

                if (
                    this._tilingManager.canFitWindow(
                        window,
                        workspace,
                        monitor,
                        relaxed,
                        overrideSize
                    )
                ) {
                    Logger.log(
                        `[PLACEMENT] Window ${window.get_id()} can use monitor ${monitor} on WS-${workspace.index()}`
                    );
                    return monitor;
                }
            }

            return null;
        }

        moveWindowToMonitor(window, workspace, sourceMonitor, targetMonitor, onSettled = null) {
            if (
                targetMonitor === null ||
                targetMonitor === undefined ||
                targetMonitor === sourceMonitor
            )
                return false;

            const pendingTarget = WindowState.get(window, 'monitorPlacementTarget');
            if (pendingTarget !== undefined) {
                if (pendingTarget === targetMonitor) {
                    Logger.log(
                        `[PLACEMENT] Window ${window.get_id()} is already moving to monitor ${targetMonitor}; skipping duplicate request`
                    );
                    onSettled?.(false);
                    return true;
                }
                Logger.log(
                    `[PLACEMENT] Window ${window.get_id()} already has pending monitor target ${pendingTarget}; ignoring conflicting target ${targetMonitor}`
                );
                onSettled?.(false);
                return false;
            }

            Logger.log(
                `[PLACEMENT] Moving window ${window.get_id()} from monitor ${sourceMonitor} to available monitor ${targetMonitor} on WS-${workspace.index()}`
            );
            // Usually window-created prepared this before Mutter's map effect began.
            // Keep this fallback for the opposite signal ordering, where window-added
            // resolves placement first.
            if (WindowState.get(window, 'openedMaximized')) {
                WindowState.set(window, 'monitorPlacementEntrancePending', true);
                WindowState.remove(window, 'pendingFirstPlacement');
                this._animationsManager?.cancelPendingEntrance(window);
                const actor = window.get_compositor_private();
                if (actor && !actor.is_destroyed()) {
                    Main.wm.skipNextEffect(actor);
                    actor.remove_all_transitions();
                    actor.set_translation(0, 0, 0);
                    actor.set_scale(1, 1);
                    actor.opacity = 0;
                    this._timeoutRegistry?.addIdle(() => {
                        if (
                            WindowState.get(window, 'monitorPlacementTarget') !== undefined &&
                            !actor.is_destroyed()
                        ) {
                            actor.remove_transition('opacity');
                            actor.opacity = 0;
                        }
                        return GLib.SOURCE_REMOVE;
                    }, 'windowing_holdMonitorPlacementEntrance');
                }
            }
            WindowState.set(window, 'monitorPlacementSource', sourceMonitor);
            WindowState.set(window, 'monitorPlacementTarget', targetMonitor);
            try {
                window.move_to_monitor(targetMonitor);
            } catch (e) {
                WindowState.remove(window, 'monitorPlacementSource');
                WindowState.remove(window, 'monitorPlacementTarget');
                if (WindowState.get(window, 'monitorPlacementEntrancePending')) {
                    WindowState.remove(window, 'monitorPlacementEntrancePending');
                    this._animationsManager?.animateMonitorPlacementEntrance(window);
                }
                Logger.warn(
                    `[PLACEMENT] Failed moving window ${window.get_id()} to monitor ${targetMonitor}: ${e.message}`
                );
                onSettled?.(false);
                return false;
            }
            this.invalidateWindowsCache();

            // Do not tile either monitor yet: move_to_monitor updates MetaWindow
            // asynchronously, so an immediate source pass can still include the window
            // that is leaving. Both sides are settled exactly once below.

            let elapsed = 0;
            let lastStableFrame = null;
            const settlePlacement = () => {
                let currentMonitor;
                try {
                    currentMonitor = window.get_monitor();
                } catch (_e) {
                    WindowState.remove(window, 'monitorPlacementSource');
                    WindowState.remove(window, 'monitorPlacementTarget');
                    WindowState.remove(window, 'monitorPlacementEntrancePending');
                    WindowState.remove(window, 'userPlacementDisplaced');
                    onSettled?.(false);
                    return GLib.SOURCE_REMOVE;
                }

                const actor = window.get_compositor_private();
                if (actor && actor.is_destroyed()) {
                    WindowState.remove(window, 'monitorPlacementSource');
                    WindowState.remove(window, 'monitorPlacementTarget');
                    WindowState.remove(window, 'monitorPlacementEntrancePending');
                    WindowState.remove(window, 'userPlacementDisplaced');
                    onSettled?.(false);
                    return GLib.SOURCE_REMOVE;
                }

                // Require the destination frame to stay unchanged for two probes. The
                // monitor property can flip before a fullscreen client commits the
                // correctly sized buffer, which would otherwise reveal a visible resize.
                const needsStableEntrance =
                    WindowState.get(window, 'monitorPlacementEntrancePending') === true;
                if (currentMonitor === targetMonitor && !needsStableEntrance) {
                    this.finishMonitorPlacement(window, workspace, targetMonitor);
                    onSettled?.(true);
                    return GLib.SOURCE_REMOVE;
                } else if (currentMonitor === targetMonitor && actor?.mapped) {
                    const frame = window.get_frame_rect();
                    const stable =
                        lastStableFrame &&
                        frame.x === lastStableFrame.x &&
                        frame.y === lastStableFrame.y &&
                        frame.width === lastStableFrame.width &&
                        frame.height === lastStableFrame.height;
                    if (stable) {
                        this.finishMonitorPlacement(window, workspace, targetMonitor);
                        onSettled?.(true);
                        return GLib.SOURCE_REMOVE;
                    }
                    lastStableFrame = {
                        x: frame.x,
                        y: frame.y,
                        width: frame.width,
                        height: frame.height,
                    };
                } else {
                    lastStableFrame = null;
                }

                elapsed += RETILE_DELAY_MS;
                if (elapsed < MONITOR_PLACEMENT_TIMEOUT_MS) return GLib.SOURCE_CONTINUE;

                Logger.warn(
                    `[PLACEMENT] Timed out waiting for window ${window.get_id()} to reach monitor ${targetMonitor}`
                );
                WindowState.remove(window, 'monitorPlacementSource');
                WindowState.remove(window, 'monitorPlacementTarget');
                WindowState.remove(window, 'userPlacementDisplaced');
                this.invalidateWindowsCache();
                if (this._tilingManager)
                    this._tilingManager.tileWorkspaceWindows(workspace, null, sourceMonitor, false);
                if (WindowState.get(window, 'monitorPlacementEntrancePending')) {
                    WindowState.remove(window, 'monitorPlacementEntrancePending');
                    this._animationsManager?.animateMonitorPlacementEntrance(window);
                }
                onSettled?.(false);
                return GLib.SOURCE_REMOVE;
            };

            if (this._timeoutRegistry) {
                this._timeoutRegistry.add(
                    RETILE_DELAY_MS,
                    settlePlacement,
                    'windowing_settleMonitorPlacement'
                );
            } else {
                settlePlacement();
            }

            return true;
        }

        finishMonitorPlacement(window, workspace, enteredMonitor = null) {
            const targetMonitor = WindowState.get(window, 'monitorPlacementTarget');
            if (targetMonitor === undefined) return false;
            if (enteredMonitor !== null && enteredMonitor !== targetMonitor) return false;
            if (!isWindowAlive(window) || window.get_monitor() !== targetMonitor) return false;

            const sourceMonitor = WindowState.get(window, 'monitorPlacementSource');
            WindowState.remove(window, 'monitorPlacementSource');
            WindowState.remove(window, 'monitorPlacementTarget');
            WindowState.remove(window, 'userPlacementDisplaced');
            this.invalidateWindowsCache();

            if (this._tilingManager) {
                if (sourceMonitor !== undefined && sourceMonitor !== targetMonitor)
                    this._tilingManager.tileWorkspaceWindows(workspace, null, sourceMonitor, false);
                // Sacred windows own the whole destination monitor and are deliberately
                // excluded from Mosaic layouts, so there is nothing to compute there.
                if (!this.isMaximizedOrFullscreen(window))
                    this._tilingManager.tileWorkspaceWindows(workspace, null, targetMonitor, false);
            }

            if (WindowState.get(window, 'monitorPlacementEntrancePending')) {
                WindowState.remove(window, 'monitorPlacementEntrancePending');
                this._animationsManager?.animateMonitorPlacementEntrance(window);
            }

            Logger.log(`[PLACEMENT] Window ${window.get_id()} settled on monitor ${targetMonitor}`);
            return true;
        }

        // After a close, distribute normal mosaic windows across every monitor in the
        // workspace. A move is allowed only when it reduces a count imbalance of at
        // least two windows and canFitWindow confirms the destination has room. Sacred,
        // edge-tiled and miniature windows keep their explicit monitor placement.
        rebalanceWorkspaceMonitors(workspace, preferredMonitor = null, {deferTiling = false} = {}) {
            const emptyDeferredResult = () => ({
                moved: 0,
                affectedMonitors: [],
                movedWindows: [],
            });
            if (!workspace || !this._tilingManager || global.display.get_n_monitors() <= 1)
                return deferTiling ? emptyDeferredResult() : 0;

            const nMonitors = global.display.get_n_monitors();
            let moved = 0;
            const affectedMonitors = new Set();
            const movedWindows = [];
            const movedWindowIds = new Set();
            const monitors = [];

            // Build this once and update it after every selected move. Mutter applies
            // move_to_monitor asynchronously, so re-reading get_monitor() inside this
            // loop otherwise sees the old state and can select the same window twice.
            this.invalidateWindowsCache();
            for (let monitor = 0; monitor < nMonitors; monitor++) {
                const workArea = workspace.get_work_area_for_monitor(monitor);
                if (!workArea || workArea.width <= 0 || workArea.height <= 0) continue;

                const windows = this.getMonitorWorkspaceWindows(workspace, monitor).filter(
                    w => isWindowAlive(w) && !this.isExcluded(w)
                );
                monitors.push({monitor, windows});
            }

            // Every move reduces the source/target count difference, so n windows is a
            // strict upper bound and also protects against unexpected compositor state.
            const maxMoves = monitors.reduce((sum, entry) => sum + entry.windows.length, 0);
            while (moved < maxMoves) {
                const targets = monitors
                    .slice()
                    .sort(
                        (a, b) =>
                            a.windows.length - b.windows.length ||
                            (a.monitor === preferredMonitor
                                ? -1
                                : b.monitor === preferredMonitor
                                  ? 1
                                  : 0) ||
                            a.monitor - b.monitor
                    );
                const sources = monitors
                    .slice()
                    .sort((a, b) => b.windows.length - a.windows.length || a.monitor - b.monitor);

                let selected = null;
                for (const target of targets) {
                    for (const source of sources) {
                        if (
                            source.monitor === target.monitor ||
                            source.windows.length <= target.windows.length + 1
                        )
                            continue;

                        const focusedId = global.display.focus_window?.get_id();
                        const candidates = source.windows
                            .filter(
                                w =>
                                    !movedWindowIds.has(w.get_id()) &&
                                    !this.isMaximizedOrFullscreen(w) &&
                                    !this._edgeTilingManager?.isEdgeTiled(w) &&
                                    !WindowState.get(w, IS_MINIATURE)
                            )
                            .sort((a, b) => {
                                const aFocused = a.get_id() === focusedId ? 1 : 0;
                                const bFocused = b.get_id() === focusedId ? 1 : 0;
                                return (
                                    aFocused - bFocused ||
                                    (WindowState.get(b, 'addedTime') ?? 0) -
                                        (WindowState.get(a, 'addedTime') ?? 0) ||
                                    b.get_id() - a.get_id()
                                );
                            });

                        const candidate = candidates.find(w =>
                            this._tilingManager.canFitWindow(
                                w,
                                workspace,
                                target.monitor,
                                false,
                                null,
                                [...target.windows, w]
                            )
                        );
                        if (candidate) {
                            selected = {window: candidate, source, target};
                            break;
                        }
                    }
                    if (selected) break;
                }

                if (!selected) break;

                Logger.log(
                    `[REBALANCE] Moving window ${selected.window.get_id()} from monitor ${selected.source.monitor} to ${selected.target.monitor} after close`
                );
                try {
                    // Batch the physical moves first. Tiling source+target for every
                    // individual move repeats the most expensive layout work and also
                    // lets monitor-enter signals start duplicate evaluation passes.
                    WindowState.set(selected.window, 'monitorRebalanceInProgress', true);
                    selected.window.move_to_monitor(selected.target.monitor);
                } catch (e) {
                    WindowState.remove(selected.window, 'monitorRebalanceInProgress');
                    Logger.warn(
                        `[REBALANCE] Failed moving window ${selected.window.get_id()}: ${e.message}`
                    );
                    break;
                }

                // Keep the projected state authoritative for the rest of this batch.
                selected.source.windows = selected.source.windows.filter(
                    w => w.get_id() !== selected.window.get_id()
                );
                selected.target.windows.push(selected.window);
                movedWindowIds.add(selected.window.get_id());
                affectedMonitors.add(selected.source.monitor);
                affectedMonitors.add(selected.target.monitor);
                movedWindows.push(selected.window);
                moved++;
            }

            if (moved > 0) {
                this.invalidateWindowsCache();
                if (deferTiling) {
                    return {
                        moved,
                        affectedMonitors: [...affectedMonitors],
                        movedWindows,
                    };
                }

                for (const monitor of affectedMonitors)
                    this._tilingManager.tileWorkspaceWindows(workspace, null, monitor, false);

                const clearMoveFlags = () => {
                    for (const window of movedWindows)
                        WindowState.remove(window, 'monitorRebalanceInProgress');
                    return GLib.SOURCE_REMOVE;
                };
                if (this._timeoutRegistry)
                    this._timeoutRegistry.add(
                        RETILE_DELAY_MS,
                        clearMoveFlags,
                        'windowing_clearMonitorRebalanceFlags'
                    );
                else clearMoveFlags();

                Logger.log(
                    `[REBALANCE] Balanced WS-${workspace.index()} across monitors with ${moved} move(s)`
                );
            }
            return deferTiling ? emptyDeferredResult() : moved;
        }

        showWorkspaceSwitcher(workspace, monitorIndex = -1) {
            if (!workspace) return;

            const index = workspace.index();
            Logger.log(`[SWITCHER] Activating OSD for WS-${index}`);

            // Default to primary monitor if none specified
            if (monitorIndex === -1) {
                monitorIndex = Main.layoutManager.primaryIndex;
            }

            Logger.log(
                `showWorkspaceSwitcher: showing WorkspaceSwitcherPopup for workspace ${index} on monitor ${monitorIndex}`
            );

            try {
                if (!Main.wm._workspaceSwitcherPopup) {
                    Main.wm._workspaceSwitcherPopup =
                        new WorkspaceSwitcherPopup.WorkspaceSwitcherPopup();
                }

                if (!WindowState.get(Main.wm._workspaceSwitcherPopup, 'destroyConnected')) {
                    Main.wm._workspaceSwitcherPopup.connect('destroy', () => {
                        Main.wm._workspaceSwitcherPopup = null;
                    });
                    WindowState.set(Main.wm._workspaceSwitcherPopup, 'destroyConnected', true);
                }

                Main.wm._workspaceSwitcherPopup.display(index);
            } catch (e) {
                Logger.warn(`WorkspaceSwitcherPopup failed: ${e.message}`);
            }
        }
        destroy() {
            this._edgeTilingManager = null;
            this._animationsManager = null;
            this._tilingManager = null;
            this._timeoutRegistry = null;
            this._overflowStartCallback = null;
            this._overflowEndCallback = null;
            this._windowsCache = new WeakMap();
        }
    }
);
