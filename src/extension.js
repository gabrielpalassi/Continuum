// SPDX-License-Identifier: GPL-3.0-or-later
// Window-management behavior adapted from Mosaic WM
// by Cléo Menezes Jr. and contributors:
// https://github.com/CleoMenezesJr/MosaicWM

import * as Logger from './logger.js';
import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as OverviewControls from 'resource:///org/gnome/shell/ui/overviewControls.js';
import * as Workspace from 'resource:///org/gnome/shell/ui/workspace.js';
import * as WorkspaceAnimation from 'resource:///org/gnome/shell/ui/workspaceAnimation.js';
import * as Screenshot from 'resource:///org/gnome/shell/ui/screenshot.js';
import * as WindowPreviewModule from 'resource:///org/gnome/shell/ui/windowPreview.js';
import {WindowingManager} from './windowing.js';
import * as constants from './constants.js';
import {SettingsOverrider} from './settingsOverrider.js';
import {EdgeTilingManager} from './edgeTiling.js';
import {TilingManager} from './tiling.js';
import {isWindowAlive, isWorkspaceAlive} from './liveness.js';
import {ReorderingManager} from './reordering.js';
import {SwappingManager} from './swapping.js';
import {DrawingManager} from './drawing.js';
import {AnimationsManager} from './animations.js';
import {MosaicLayoutStrategy, MosaicRenderer} from './mosaicRenderer.js';
import {TimeoutRegistry, createDebounced} from './timing.js';
import {WindowHandler} from './windowHandler.js';
import {DragHandler} from './dragHandler.js';
import {ResizeHandler} from './resizeHandler.js';
import {MiniatureManager} from './miniature.js';
import * as WindowState from './windowState.js';
import {
    IS_MINIATURE,
    MINIATURE_SCALE,
    MINIATURE_EXT_LEFT,
    MINIATURE_EXT_TOP,
    MINIATURE_TARGET_POS,
    MINIATURE_OVERLAY,
} from './windowState.js';
import {WorkspaceOverviewManager} from './workspaceOverview.js';
import {WindowAttentionManager} from './windowAttention.js';

export default class ContinuumExtension extends Extension {
    constructor(metadata) {
        super(metadata);

        this._wmEventIds = [];
        this._displayEventIds = [];
        this._workspaceManEventIds = [];
        this._workspaceEventIds = [];

        this._tileTimeout = null;

        // Prevent new-window entrance effects from racing an overflow move.
        this._overflowInProgress = false;

        this._settingsOverrider = null;

        this.edgeTilingManager = null;
        this.tilingManager = null;
        this.reorderingManager = null;
        this.swappingManager = null;
        this.drawingManager = null;
        this.animationsManager = null;
        this.mosaicRenderer = null;
        this.windowingManager = null;

        this.windowHandler = null;
        this.dragHandler = null;
        this.resizeHandler = null;
        this.workspaceOverviewManager = null;
        this.windowAttentionManager = null;

        this.miniatureManager = null;
        this._miniatureCascadeIds = null;
        this._lastFocusedWindowId = null;
        this._focusWindowChangedId = 0;
        this._miniatureRestoredId = 0;

        this._dnd = null;
        this._dndEnterId = 0;
        this._dndPositionId = 0;
        this._dndLeaveId = 0;
        this._dndActive = false;
        this._dndScheduleRestore = null;
        this._dndPendingWindowId = null;

        this._injectionManager = null;

        this._timeoutRegistry = null;
    }

    _tileWindowWorkspace(meta_window) {
        if (!meta_window) return;
        const workspace = meta_window.get_workspace();
        if (!workspace) return;
        this.tilingManager.tileWorkspaceWindows(workspace, meta_window, null, false);
    }

    _tileAllWorkspaces = () => {
        const nWorkspaces = this._workspaceManager.get_n_workspaces();

        for (let i = 0; i < nWorkspaces; i++) {
            const workspace = this._workspaceManager.get_workspace_by_index(i);
            const nMonitors = global.display.get_n_monitors();
            for (let j = 0; j < nMonitors; j++)
                this.tilingManager.enforceWorkspaceFit(workspace, j);
        }
    };

    _flushMosaicToWindows() {
        const nWorkspaces = this._workspaceManager.get_n_workspaces();
        const nMonitors = global.display.get_n_monitors();

        for (let workspaceIndex = 0; workspaceIndex < nWorkspaces; workspaceIndex++) {
            const workspace = this._workspaceManager.get_workspace_by_index(workspaceIndex);
            for (let monitor = 0; monitor < nMonitors; monitor++)
                this.mosaicRenderer?.flushToWindows(workspace, monitor);
        }
    }

    _workspaceAddSignal = (_, workspaceIdx) => {
        const workspace = this._workspaceManager.get_workspace_by_index(workspaceIdx);
        this._connectWorkspaceWindowSignals(workspace);
    };

    _connectWorkspaceWindowSignals(workspace) {
        const eventIds = [
            workspace.connect('window-added', (ws, win) => this._onWindowAdded(ws, win)),
            workspace.connect('window-removed', (ws, win) => this._onWindowRemoved(ws, win)),
        ];
        this._workspaceEventIds.push([workspace, eventIds]);
    }

    _onWindowAdded(workspace, window) {
        this.windowHandler.onWindowAdded(workspace, window);
        this.workspaceOverviewManager.onWindowAdded(workspace, window);
    }

    _onWindowRemoved(workspace, window) {
        this.windowHandler.onWindowRemoved(workspace, window);
        this.workspaceOverviewManager.onWindowRemoved(workspace, window);
    }

    // Drop bookkeeping for destroyed workspaces, since their signals die with
    // the object, and disconnecting them on disable() would target a dead GObject.
    _workspaceRemovedSignal = () => {
        this._workspaceEventIds = this._workspaceEventIds.filter(([workspace]) =>
            isWorkspaceAlive(workspace, this._workspaceManager)
        );
    };

    enable() {
        Logger.info('Starting Mosaic layout manager.');

        this._timeoutRegistry = new TimeoutRegistry();
        this._workspaceManager = global.workspace_manager;

        // SettingsOverrider already handles a stale override from a previous
        // crash (it restores the schema default when the current value equals
        // the override). Forcing the value here would clobber a user who
        // legitimately disabled attach-modal-dialogs.
        this._mutterSettings = new Gio.Settings({schema_id: 'org.gnome.mutter'});

        this.edgeTilingManager = new EdgeTilingManager();
        this.tilingManager = new TilingManager();
        this.tilingManager.setExtension(this);
        this.reorderingManager = new ReorderingManager();
        this.swappingManager = new SwappingManager({
            tilingManager: this.tilingManager,
            edgeTilingManager: this.edgeTilingManager,
        });
        this.drawingManager = new DrawingManager();
        this.animationsManager = new AnimationsManager();
        this.mosaicRenderer = new MosaicRenderer();
        this.windowingManager = new WindowingManager({
            edgeTilingManager: this.edgeTilingManager,
            animationsManager: this.animationsManager,
            tilingManager: this.tilingManager,
            timeoutRegistry: this._timeoutRegistry,
            onOverflowChange: inProgress => {
                this._overflowInProgress = inProgress;
            },
        });

        this.tilingManager.setEdgeTilingManager(this.edgeTilingManager);
        this.tilingManager.setDrawingManager(this.drawingManager);
        this.tilingManager.setAnimationsManager(this.animationsManager);
        this.tilingManager.setWindowingManager(this.windowingManager);

        this.reorderingManager.setTilingManager(this.tilingManager);
        this.reorderingManager.setEdgeTilingManager(this.edgeTilingManager);
        this.reorderingManager.setAnimationsManager(this.animationsManager);
        this.reorderingManager.setWindowingManager(this.windowingManager);

        this.drawingManager.setEdgeTilingManager(this.edgeTilingManager);

        this.edgeTilingManager.setAnimationsManager(this.animationsManager);
        this.edgeTilingManager.setTimeoutRegistry(this._timeoutRegistry);
        this.edgeTilingManager.setTilingManager(this.tilingManager);
        this.edgeTilingManager.setWindowingManager(this.windowingManager);
        this.animationsManager.setTimeoutRegistry(this._timeoutRegistry);

        this.windowHandler = new WindowHandler(this);
        this.dragHandler = new DragHandler(this);
        this.resizeHandler = new ResizeHandler(this);
        this.workspaceOverviewManager = new WorkspaceOverviewManager({
            workspaceManager: this._workspaceManager,
            mutterSettings: this._mutterSettings,
            timeoutRegistry: this._timeoutRegistry,
        });
        this.windowAttentionManager = new WindowAttentionManager(
            Main.windowAttentionHandler,
            this._timeoutRegistry
        );
        this.windowAttentionManager.enable();

        this.miniatureManager = new MiniatureManager();
        this.miniatureManager.setTimeoutRegistry(this._timeoutRegistry);
        this.miniatureManager.setAnimationsManager(this.animationsManager);
        this.edgeTilingManager.setMiniatureManager(this.miniatureManager);
        this._miniatureCascadeIds = new Set();
        this._lastFocusedWindowId = null;

        this._miniatureRestoredId = this.miniatureManager.connect(
            'miniature-restored',
            (_, window) => this._onMiniatureRestored(window)
        );
        this._focusWindowChangedId = global.display.connect('notify::focus-window', () =>
            this._onFocusWindowChanged()
        );

        this._dnd = global.backend?.get_dnd() ?? null;
        if (this._dnd) {
            this._dndScheduleRestore = createDebounced(
                window => {
                    this._dndPendingWindowId = null;
                    if (isWindowAlive(window) && WindowState.get(window, WindowState.IS_MINIATURE))
                        this.miniatureManager?.restoreMiniature(window, null);
                },
                constants.DND_MINIATURE_RESTORE_DELAY_MS,
                this._timeoutRegistry
            );
            this._dndEnterId = this._dnd.connect('dnd-enter', this._onDndEnter.bind(this));
            this._dndPositionId = this._dnd.connect(
                'dnd-position-change',
                this._onDndPositionChange.bind(this)
            );
            this._dndLeaveId = this._dnd.connect('dnd-leave', this._onDndLeave.bind(this));
        }

        this._settingsOverrider = new SettingsOverrider();

        this._settingsOverrider.add(
            new Gio.Settings({schema_id: 'org.gnome.mutter'}),
            'edge-tiling',
            new GLib.Variant('b', false)
        );

        // Disable attach-modal-dialogs to prevent squashed Overview previews
        // When enabled, attached dialogs expand the window bounding box causing layout issues
        this._settingsOverrider.add(
            this._mutterSettings,
            'attach-modal-dialogs',
            new GLib.Variant('b', false)
        );

        const mutterKeybindings = new Gio.Settings({schema_id: 'org.gnome.mutter.keybindings'});
        const emptyArray = new GLib.Variant('as', []);

        if (mutterKeybindings.get_strv('toggle-tiled-left').includes('<Super>Left')) {
            this._settingsOverrider.add(mutterKeybindings, 'toggle-tiled-left', emptyArray);
        }
        if (mutterKeybindings.get_strv('toggle-tiled-right').includes('<Super>Right')) {
            this._settingsOverrider.add(mutterKeybindings, 'toggle-tiled-right', emptyArray);
        }

        const shellKeybindings = new Gio.Settings({schema_id: 'org.gnome.shell.keybindings'});
        // Super+Alt+Up/Down is our swap-up/down default but also GNOME's stock
        // shift-overview-up/down, so clear GNOME's to keep the combo for recomposition.
        if (shellKeybindings.get_strv('shift-overview-up').includes('<Super><Alt>Up')) {
            this._settingsOverrider.add(shellKeybindings, 'shift-overview-up', emptyArray);
        }
        if (shellKeybindings.get_strv('shift-overview-down').includes('<Super><Alt>Down')) {
            this._settingsOverrider.add(shellKeybindings, 'shift-overview-down', emptyArray);
        }

        this._injectionManager = new InjectionManager();

        // Patch MonitorGroup._init to fix miniature clone positions and scale.
        //
        // GNOME Shell creates Clutter.Clone at (windowActor.x - monitor.x,
        // windowActor.y - monitor.y) with scale=1. For miniature windows, the
        // actor has set_scale + set_translation applied to visually shrink and
        // reposition the frame content at MINIATURE_TARGET_POS. However,
        // Clutter.Clone disables the source actor’s model-view transform during
        // clone paint, so set_scale/set_translation on the source are ignored.
        // The clone paints the source at full size with scale=1.
        //
        // We must apply the miniature scale directly on the clone (set_scale)
        // and position it at the visual frame location (MINIATURE_TARGET_POS),
        // accounting for CSD shadow extents that shift the frame within the actor.
        //
        // InjectionManager.overrideMethod does NOT work for GObject.registerClass
        // methods (resolved via vtable, not JS prototype). Direct prototype
        // replacement of _init DOES work, confirmed by the static-workspace-background
        // extension pattern.
        //
        // TODO: Contribute upstream to gnome-shell/js/ui/workspaceAnimation.js:
        // _createClone should propagate the source actor’s scale and position the
        // clone at the visual frame location, not the raw actor position. This
        // would allow extensions that use actor transforms (tiling WMs, magnifiers,
        // etc.) to work correctly with the native workspace switch animation.
        this._origMonitorGroupInit = WorkspaceAnimation.MonitorGroup.prototype._init;
        const origInit = this._origMonitorGroupInit;
        WorkspaceAnimation.MonitorGroup.prototype._init = function (
            monitor,
            workspaceIndices,
            movingWindow
        ) {
            origInit.call(this, monitor, workspaceIndices, movingWindow);

            // After original _init, all WorkspaceGroups and their clones are created.
            // Fix positions and scale of miniature clones.
            //
            // Clutter.Clone disables the source actor's model-view transform during
            // clone paint, so set_scale/set_translation on the source are ignored.
            // We must apply the miniature scale directly on the clone, and position
            // it at the visual frame location (MINIATURE_TARGET_POS).
            for (const wsGroup of this._workspaceGroups) {
                if (!wsGroup._windowRecords) continue;
                for (const record of wsGroup._windowRecords) {
                    const metaWindow = record.windowActor.meta_window;
                    if (WindowState.get(metaWindow, IS_MINIATURE)) {
                        const tgt = WindowState.get(metaWindow, MINIATURE_TARGET_POS);
                        const sc = WindowState.get(metaWindow, MINIATURE_SCALE);
                        const extL = WindowState.get(metaWindow, MINIATURE_EXT_LEFT) ?? 0;
                        const extT = WindowState.get(metaWindow, MINIATURE_EXT_TOP) ?? 0;
                        if (tgt && sc) {
                            record.clone.set_pivot_point(0, 0);
                            record.clone.set_scale(sc, sc);
                            record.clone.x = tgt.x - monitor.x - extL * sc;
                            record.clone.y = tgt.y - monitor.y - extT * sc;
                        }

                        // _createClone only ever sees the window actor, and the icon
                        // overlay is its sibling, so the icon would vanish for the whole
                        // slide. The overlay already sits at frame scale, hence no set_scale.
                        const overlay = WindowState.get(metaWindow, MINIATURE_OVERLAY);
                        if (overlay && tgt) {
                            const iconClone = new Clutter.Clone({
                                source: overlay,
                                x: tgt.x - monitor.x,
                                y: tgt.y - monitor.y,
                            });
                            overlay.connectObject('destroy', () => iconClone.destroy(), iconClone);
                            wsGroup.add_child(iconClone);
                        }
                    }
                }
            }
        };

        // Patch WindowPreview.boundingBox so the Overview enter/leave animation
        // uses the miniature's VISUAL bounds (set_scale + MINIATURE_TARGET_POS)
        // for the state=0 (session) side of Workspace._allocate's lerp.
        //
        // Without this patch, WindowPreview.boundingBox returns the meta
        // window's full frame_rect (computed by Shell.WindowPreviewLayout in C
        // from meta_window_get_frame_rect, which does NOT know about actor
        // set_scale). The animation then interpolates from "full size at frame
        // position" to "miniature-size slot from MosaicLayoutStrategy", making
        // the miniature visually pop back to full size during the transition.
        //
        // TODO: Contribute upstream: Shell.WindowPreviewLayout should propagate
        // the source actor's scale (and account for actor translation) when
        // computing its bounding box. Extensions using actor transforms (tiling
        // WMs, magnifiers, etc.) would then work with the native overview
        // transition without this patch.
        this._origWindowPreviewBoundingBoxDesc = Object.getOwnPropertyDescriptor(
            WindowPreviewModule.WindowPreview.prototype,
            'boundingBox'
        );
        const origBoundingBoxGetter = this._origWindowPreviewBoundingBoxDesc.get;
        Object.defineProperty(WindowPreviewModule.WindowPreview.prototype, 'boundingBox', {
            configurable: true,
            get() {
                const mw = this.metaWindow;
                if (mw && WindowState.get(mw, IS_MINIATURE)) {
                    const tgt = WindowState.get(mw, MINIATURE_TARGET_POS);
                    const sc = WindowState.get(mw, MINIATURE_SCALE);
                    if (tgt && sc) {
                        const f = mw.get_frame_rect();
                        return {
                            x: tgt.x,
                            y: tgt.y,
                            width: f.width * sc,
                            height: f.height * sc,
                        };
                    }
                }
                return origBoundingBoxGetter.call(this);
            },
        });

        // Mirror ICON_SIZE and ICON_OVERLAP from gnome-shell's windowPreview.js: the
        // icon rests with 30% of itself hanging below the preview's bottom edge.
        const PREVIEW_ICON_SIZE = 64;
        const PREVIEW_ICON_OVERLAP = 0.7;
        const previewProto = WindowPreviewModule.WindowPreview.prototype;

        // The shell already writes translation_y here to follow the preview's hover
        // growth, so our lift has to add to it rather than replace it. A window
        // restored from inside a static overview never re-runs _updateIconScale,
        // so re-check the flag instead of trusting the stored lift.
        this._injectionManager.overrideMethod(
            previewProto,
            '_adjustOverlayOffsets',
            originalMethod => {
                return function (...args) {
                    originalMethod.apply(this, args);
                    if (this._mosaicIconLift && WindowState.get(this.metaWindow, IS_MINIATURE))
                        this._icon.translation_y += this._mosaicIconLift;
                };
            }
        );

        // For a miniature the icon starts centered on the preview (right where the
        // session icon was) and slides down to the native footer anchor. Driven by
        // the adjustment, not an ease, so a half-open swipe leaves it halfway.
        this._injectionManager.overrideMethod(previewProto, '_updateIconScale', originalMethod => {
            return function (...args) {
                const mw = this.metaWindow;
                const {currentState, initialState, finalState} =
                    this._overviewAdjustment.getStateTransitionParams();

                // A straight run to the app grid is one transition from 0 to 2, so
                // currentState alone would sweep through the picker and flash an icon
                // the shell keeps hidden. At rest the two endpoints collapse onto the
                // current state, and _init lands there, so the icon has to be placed.
                const {ControlsState} = OverviewControls;
                const throughPicker =
                    initialState === finalState ||
                    initialState === ControlsState.WINDOW_PICKER ||
                    finalState === ControlsState.WINDOW_PICKER;

                if (
                    !mw ||
                    !WindowState.get(mw, IS_MINIATURE) ||
                    !throughPicker ||
                    currentState > 1
                ) {
                    this._mosaicIconLift = 0;
                    return originalMethod.apply(this, args);
                }

                const t = Math.max(0, Math.min(1, currentState));
                const container = this.window_container;

                // _init runs this before the actor is allocated or styled, so the live box
                // is empty and the icon has no preferred height yet. boundingBox is the
                // size state 0 starts from, and the icon is always ICON_SIZE tall.
                const allocH = container.allocation.get_height() * container.scale_y;
                const visualH = allocH > 0 ? allocH : this.boundingBox.height;
                const [, preferredIconH] =
                    allocH > 0 ? this._icon.get_preferred_height(-1) : [0, 0];
                const iconH = preferredIconH || PREVIEW_ICON_SIZE;

                this._mosaicIconLift =
                    (1 - t) * (iconH * (PREVIEW_ICON_OVERLAP - 0.5) - visualH / 2);
                this._icon.set({scale_x: 1, scale_y: 1});

                // Offsetting an empty box through Shell's method lands NaN in the
                // overlay translation. The native scale offset is zero before the
                // first allocation, so apply our lift directly; otherwise the icon
                // paints at the footer for one frame, jumps to center on allocation,
                // then travels back to the footer during the overview transition.
                if (allocH > 0) {
                    this._adjustOverlayOffsets();
                } else {
                    this._icon.translation_y = this._mosaicIconLift;
                }
                return undefined;
            };
        });

        const layoutProto = Workspace.WorkspaceLayout.prototype;
        this._injectionManager.overrideMethod(layoutProto, '_createBestLayout', originalMethod => {
            const extension = this;
            return function (...args) {
                // Screenshot UI's window picker reuses WorkspaceLayout too, but its
                // window objects don't have metaWindow/source.metaWindow, so the
                // workspace lookup below would just fail and we'd hand back nothing.
                if (!Main.overview.visible) return originalMethod.apply(this, args);

                let workspace = null;
                for (const win of this._sortedWindows) {
                    const mw = win.metaWindow || win.source?.metaWindow;
                    if (mw) {
                        workspace = mw.get_workspace();
                        if (workspace) break;
                    }
                }

                // Opened from inside the overview, the screenshot picker slips past the
                // check above, and its windows carry no metaWindow to locate a workspace
                // with. Without this the mosaic strategy hands back an empty slot list.
                if (!workspace) return originalMethod.apply(this, args);

                let useMosaic = true;
                for (const win of this._sortedWindows) {
                    const mw = win.metaWindow || win.source?.metaWindow;
                    if (!mw) continue;

                    // Fallback to Native GNOME layout if there are non-mosaic windows
                    // (Above, Sticky, Maximized, Fullscreen, Modals, Transients, or Minimized)
                    if (
                        mw.minimized ||
                        mw.is_above() ||
                        extension.windowingManager.isTrulySticky(mw) ||
                        mw.is_fullscreen() ||
                        mw.get_window_type() === Meta.WindowType.MODAL_DIALOG ||
                        mw.is_attached_dialog() ||
                        mw.get_transient_for() !== null
                    ) {
                        useMosaic = false;
                        break;
                    }
                }

                if (!useMosaic) {
                    Logger.log('Overview: Fallback to NATIVE (floating window detected)');
                    this._layoutStrategy = null;
                    return originalMethod.apply(this, args);
                }

                Logger.log(`Overview: Using MOSAIC Strategy for monitor ${this._monitorIndex}`);
                extension.mosaicRenderer?.registerOverviewLayout(
                    workspace,
                    this._monitorIndex,
                    this
                );
                this._layoutStrategy = new MosaicLayoutStrategy({
                    monitor: Main.layoutManager.monitors[this._monitorIndex],
                });
                return this._layoutStrategy.computeLayout(this._sortedWindows, ...args);
            };
        });

        // The picker's window captures at the top of open() need miniatures at
        // full size, but the frozen stage shot right after must see them scaled
        // again; resuming inside screenshot_stage_to_content splits the two.
        const screenshotProto = Screenshot.ScreenshotUI.prototype;
        this._injectionManager.overrideMethod(screenshotProto, 'open', originalMethod => {
            const extension = this;
            return function (...args) {
                extension.miniatureManager?.pauseForScreenshot();
                const result = originalMethod.apply(this, args);
                // no-op normally; clears the pause when open() returned early
                extension.miniatureManager?.resumeFromScreenshot();
                return result;
            };
        });
        this._injectionManager.overrideMethod(
            Shell.Screenshot.prototype,
            'screenshot_stage_to_content',
            originalMethod => {
                const extension = this;
                return function (...args) {
                    extension.miniatureManager?.resumeFromScreenshot();
                    return originalMethod.apply(this, args);
                };
            }
        );

        this._wmEventIds.push(
            global.window_manager.connect('size-change', (wm, win, mode) =>
                this.resizeHandler.onSizeChange(wm, win, mode)
            )
        );
        this._wmEventIds.push(
            global.window_manager.connect('size-changed', (wm, actor) => {
                const target = this.windowHandler.commitSacredExitPosition(actor.meta_window);
                if (target) this.windowHandler.retargetNativeSacredExitAnimation(actor, target);
                this.resizeHandler.onSizeChanged(wm, actor);
            })
        );
        this._displayEventIds.push(
            global.display.connect('window-created', (_, window) =>
                this.windowHandler.onWindowCreated(window)
            )
        );
        this._displayEventIds.push(
            global.display.connect('window-demands-attention', (_, window) =>
                this.windowAttentionManager.onWindowDemandsAttention(window)
            )
        );
        this._displayEventIds.push(
            global.display.connect('window-marked-urgent', (_, window) =>
                this.windowAttentionManager.onWindowDemandsAttention(window)
            )
        );
        this._wmEventIds.push(
            global.window_manager.connect('destroy', (_, win) =>
                this.windowHandler.onWindowDestroyed(win.meta_window)
            )
        );
        this._displayEventIds.push(
            global.display.connect('grab-op-begin', (display, window, grabpo) =>
                this.dragHandler._grabOpBeginHandler(display, window, grabpo)
            )
        );
        this._displayEventIds.push(
            global.display.connect('grab-op-end', (display, window, grabpo) =>
                this.dragHandler._grabOpEndHandler(display, window, grabpo)
            )
        );
        this._displayEventIds.push(
            global.display.connect('window-left-monitor', (_, monitor, window) =>
                this.windowHandler.onWindowLeftMonitor(monitor, window)
            )
        );
        this._displayEventIds.push(
            global.display.connect('window-entered-monitor', (_, monitor, window) =>
                this.windowHandler.onWindowEnteredMonitor(monitor, window)
            )
        );
        this._displayEventIds.push(
            global.display.connect('restacked', () => this.miniatureManager?.syncOverlayStacking())
        );
        this._onOverviewShowingId = Main.overview.connect('showing', () => {
            this.animationsManager.setOverviewActive(true);
            this.miniatureManager?.setOverviewActive(true);
        });
        // Mutter accepts geometry again as Overview starts closing. Flush here so
        // the closing animation already reflects the model instead of stale frames.
        this._onOverviewHidingId = Main.overview.connect('hiding', () => {
            Logger.log('[MODEL] Flushing mosaic as Overview starts hiding');
            this._flushMosaicToWindows();
        });
        this._onOverviewHiddenId = Main.overview.connect('hidden', () => {
            this.animationsManager.setOverviewActive(false);
            this.miniatureManager?.setOverviewActive(false);
            // Catch a final slot computed between the hiding and hidden signals.
            Logger.log('[MODEL] Flushing final mosaic after Overview hidden');
            this._flushMosaicToWindows();
            this.mosaicRenderer?.clearOverviewLayouts();
            this.workspaceOverviewManager.onOverviewHidden();
        });

        this._workspaceManEventIds.push(
            global.workspace_manager.connect('workspace-added', this._workspaceAddSignal)
        );
        this._workspaceManEventIds.push(
            global.workspace_manager.connect('workspace-removed', this._workspaceRemovedSignal)
        );
        this._workspaceManEventIds.push(
            global.workspace_manager.connect('workspace-switched', () =>
                this.workspaceOverviewManager.onWorkspaceSwitched()
            )
        );

        const nWorkspaces = this._workspaceManager.get_n_workspaces();
        for (let i = 0; i < nWorkspaces; i++) {
            const workspace = this._workspaceManager.get_workspace_by_index(i);
            this._connectWorkspaceWindowSignals(workspace);
        }

        for (let i = 0; i < nWorkspaces; i++) {
            const workspace = this._workspaceManager.get_workspace_by_index(i);
            const windows = workspace.list_windows();
            for (const window of windows) {
                if (this.windowingManager.isRelated(window)) {
                    this.tilingManager.savePreferredSize(window);
                }

                // Always connect exclusion signals, even if excluded
                this.windowHandler.connectWindowSignals(window);
            }
        }

        this._setupKeybindings();

        this._tileTimeout = this._timeoutRegistry.add(
            constants.STARTUP_TILE_DELAY_MS,
            () => {
                this._tileAllWorkspaces();
                this._tileTimeout = null;
                return GLib.SOURCE_REMOVE;
            },
            'startupTile'
        );
    }

    _onFocusWindowChanged() {
        const window = global.display.focus_window;
        if (!window) return;

        const prevFocusedId = this._lastFocusedWindowId;
        this._lastFocusedWindowId = window.get_id();

        if (!this.windowingManager.isRelated(window)) return;
        if (this.windowingManager.isExcluded(window)) return;
        if (this.windowingManager.isMaximizedOrFullscreen(window)) return;
        if (!WindowState.get(window, IS_MINIATURE)) return;
        if (WindowState.get(window, 'justMiniaturized')) {
            Logger.log(`[FOCUS] Skip restore ${window.get_id()}: justMiniaturized`);
            return;
        }
        if (this.tilingManager._isSmartResizingBlocked) {
            Logger.log(`[FOCUS] Skip restore ${window.get_id()}: smartResizingBlocked`);
            return;
        }

        const windowId = window.get_id();
        Logger.log(
            `[FOCUS] Miniature focused ${windowId} (prev=${prevFocusedId}) cascade=${this._miniatureCascadeIds?.has(windowId)}`
        );

        if (this._miniatureCascadeIds?.has(windowId)) {
            if (prevFocusedId !== windowId) {
                // User deliberately focused it after focusing something else → allow restore
                Logger.log(`[FOCUS] Allow restore ${windowId} (deliberate, prev=${prevFocusedId})`);
                this._miniatureCascadeIds.delete(windowId);
            } else {
                // Auto-focused during cascade → block; activate a non-miniature window instead
                const ws = window.get_workspace();
                const mon = window.get_monitor();
                const nonMiniature = this.windowingManager
                    .getMonitorWorkspaceWindows(ws, mon)
                    .find(
                        w =>
                            !WindowState.get(w, IS_MINIATURE) &&
                            !this.windowingManager.isExcluded(w)
                    );
                Logger.log(
                    `[FOCUS] Block cascade restore ${windowId} → activating ${nonMiniature?.get_id() ?? 'none'}`
                );
                if (nonMiniature) nonMiniature.activate(global.get_current_time());
                return;
            }
        }

        Logger.log(`[FOCUS] Triggering restore ${windowId}`);
        this._miniatureCascadeIds.clear();
        this.tilingManager._isSmartResizingBlocked = true;
        WindowState.set(window, 'restoringFromMiniature', true);

        this.miniatureManager.restoreMiniature(window, null);
        // 'miniature-restored' signal fires synchronously → _onMiniatureRestored runs next
    }

    _onMiniatureRestored(window) {
        if (this._dndPendingWindowId === window.get_id()) {
            this._dndScheduleRestore?.cancel();
            this._dndPendingWindowId = null;
        }
        Logger.log(
            `[FOCUS] _onMiniatureRestored ${window.get_id()} (${window.get_wm_class?.() ?? '?'}): running smart resize`
        );
        WindowState.remove(window, 'restoringFromMiniature');
        this.tilingManager._isSmartResizingBlocked = false;

        const workspace = window.get_workspace();
        if (!workspace) return;

        // Preview cleanup restores multiple miniatures synchronously. The drag's
        // final retile owns their layout; running this pass for every restore can
        // re-miniaturize them mid-cleanup and cause a retile storm.
        if (this.dragHandler?._suppressRestoreRetile) return;

        const monitor = window.get_monitor();
        const workArea = this.tilingManager.getUsableWorkArea(workspace, monitor);

        const existingWindows = this.windowingManager
            .getMonitorWorkspaceWindows(workspace, monitor)
            .filter(
                w =>
                    isWindowAlive(w) &&
                    w.get_id() !== window.get_id() &&
                    !this.edgeTilingManager.isEdgeTiled(w) &&
                    !WindowState.get(w, 'pendingInQueue') &&
                    !this.windowingManager.isExcluded(w) &&
                    !this.windowingManager.isMaximizedOrFullscreen(w)
            );

        // Treat the restored window as the user-focused one, since Mutter's focus
        // hasn't shifted yet (window.activate runs after the 250ms animation),
        // so the previously-focused sibling would otherwise be excluded from
        // miniaturization candidates and nothing would shrink.
        const resizeResult = this.tilingManager.tryFitWithResize(
            window,
            existingWindows,
            workArea,
            workspace,
            window
        );

        const doTile = () => {
            if (resizeResult?.success) {
                this.tilingManager._isSmartResizingBlocked = true;
                this.tilingManager._restoringWindowId = window.get_id();
                try {
                    this.tilingManager._pendingMiniatureWindows = resizeResult.pendingWindows ?? [];
                    this.tilingManager.tileWorkspaceWindows(workspace, null, monitor, false);
                } finally {
                    this.tilingManager._isSmartResizingBlocked = false;
                    this.tilingManager._restoringWindowId = null;
                }
            } else {
                this.tilingManager.tileWorkspaceWindows(workspace, window, monitor, false);
            }

            // restoreMiniature only undoes the scale, not the frame. If this was last
            // shrunk via Smart Resize's skip-resize miniaturize path, the real frame
            // is still pre-restore size, so give reverse smart resize a chance to grow it back.
            const allWindows = this.windowingManager
                .getMonitorWorkspaceWindows(workspace, monitor)
                .filter(
                    w =>
                        !this.edgeTilingManager.isEdgeTiled(w) &&
                        !this.windowingManager.isExcluded(w)
                );
            const grew = this.tilingManager.tryRestoreWindowSizes(allWindows, workArea);
            if (grew) {
                this._timeoutRegistry.add(
                    constants.RESIZE_SETTLE_DELAY_MS,
                    () => {
                        for (const w of allWindows) {
                            WindowState.remove(w, 'isReverseSmartResizing');
                        }
                        this.tilingManager.tileWorkspaceWindows(workspace, null, monitor, true);
                        return GLib.SOURCE_REMOVE;
                    },
                    'miniatureRestoreGrowSettle'
                );
            }
        };

        // While Overview is open the tile pass updates the model and republishes
        // its clone layout; hide-time flushing applies the same slots to windows.
        doTile();
    }

    _onDndEnter() {
        this._dndActive = true;
    }

    _onDndPositionChange(_dnd, x, y) {
        if (!this._dndActive || !this.miniatureManager) return;
        const window = this.miniatureManager.findMiniatureAtPoint(x, y);
        if (window) {
            if (this._dndPendingWindowId === window.get_id()) return;
            this._dndPendingWindowId = window.get_id();
            this._dndScheduleRestore(window);
        } else {
            this._dndScheduleRestore.cancel();
            this._dndPendingWindowId = null;
        }
    }

    _onDndLeave() {
        this._dndActive = false;
        this._dndScheduleRestore?.cancel();
        this._dndPendingWindowId = null;
    }

    _setupKeybindings() {
        const settings = this.getSettings('org.gnome.shell.extensions.continuum');

        for (const [name, kind, value] of constants.KEYBINDING_ACTIONS) {
            if (kind === 'swap') Logger.log(`Registering ${name} keybinding`);
            const handler =
                kind === 'tile'
                    ? () => this._tileActiveWindow(value)
                    : () => this._swapActiveWindow(value);
            Main.wm.addKeybinding(
                name,
                settings,
                Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.NORMAL,
                handler
            );
        }

        Logger.log('All swap keybindings registered successfully');
        Logger.log('Keyboard shortcuts registered');
    }

    _tileActiveWindow(zone) {
        const window = global.display.focus_window;
        if (!window) {
            Logger.log('No active window to tile');
            return;
        }

        if (this.windowingManager.isExcluded(window)) {
            Logger.log('Window is excluded from tiling');
            return;
        }

        const workspace = window.get_workspace();
        const monitor = window.get_monitor();
        const workArea = workspace.get_work_area_for_monitor(monitor);

        Logger.log(`Keyboard shortcut: tiling window ${window.get_id()} to zone ${zone}`);
        this.edgeTilingManager.applyTile(window, zone, workArea);
    }

    _swapActiveWindow(direction) {
        Logger.log(`*** SWAP SHORTCUT TRIGGERED *** Direction: ${direction}`);
        const focusedWindow = global.display.get_focus_window();

        if (!focusedWindow) {
            Logger.log('SWAP FAILED: No focused window');
            return;
        }

        if (this.windowingManager.isExcluded(focusedWindow)) {
            Logger.log(`SWAP FAILED: Window ${focusedWindow.get_id()} is excluded`);
            return;
        }

        Logger.log(
            `SWAP: Calling swapping.swapWindow for window ${focusedWindow.get_id()} direction: ${direction}`
        );
        this.swappingManager.swapWindow(focusedWindow, direction);
        Logger.log('SWAP: swapWindow call completed');
    }

    disable() {
        Logger.log('Disabling extension');

        if (this.workspaceOverviewManager) {
            this.workspaceOverviewManager.destroy();
            this.workspaceOverviewManager = null;
        }

        if (this._timeoutRegistry) {
            this._timeoutRegistry.clearAll();
        }

        Logger.info('Disabling Mosaic layout manager.');

        if (this._settingsOverrider) {
            this._settingsOverrider.destroy();
            this._settingsOverrider = null;
        }

        if (this._injectionManager) {
            this._injectionManager.clear();
            this._injectionManager = null;
        }

        if (this._origMonitorGroupInit) {
            WorkspaceAnimation.MonitorGroup.prototype._init = this._origMonitorGroupInit;
            this._origMonitorGroupInit = null;
        }

        if (this._origWindowPreviewBoundingBoxDesc) {
            Object.defineProperty(
                WindowPreviewModule.WindowPreview.prototype,
                'boundingBox',
                this._origWindowPreviewBoundingBoxDesc
            );
            this._origWindowPreviewBoundingBoxDesc = null;
        }

        for (const [name] of constants.KEYBINDING_ACTIONS) Main.wm.removeKeybinding(name);
        Logger.log('Keyboard shortcuts removed');

        if (this.edgeTilingManager) this.edgeTilingManager.destroy();
        if (this.drawingManager) this.drawingManager.destroy();
        if (this.animationsManager) this.animationsManager.destroy();

        if (this._focusWindowChangedId) {
            global.display.disconnect(this._focusWindowChangedId);
            this._focusWindowChangedId = 0;
        }

        if (this._dnd) {
            if (this._dndEnterId) this._dnd.disconnect(this._dndEnterId);
            if (this._dndPositionId) this._dnd.disconnect(this._dndPositionId);
            if (this._dndLeaveId) this._dnd.disconnect(this._dndLeaveId);
            this._dndEnterId = 0;
            this._dndPositionId = 0;
            this._dndLeaveId = 0;
            this._dnd = null;
        }
        this._dndScheduleRestore?.cancel();
        this._dndScheduleRestore = null;
        this._dndActive = false;
        this._dndPendingWindowId = null;

        if (this.miniatureManager) {
            // Disconnect listener first, otherwise restoreMiniature re-enters
            // _onMiniatureRestored, scheduling timeouts that fire after windowHandler is nulled.
            if (this._miniatureRestoredId)
                this.miniatureManager.disconnect(this._miniatureRestoredId);
            this._miniatureRestoredId = 0;
            // Restore miniatures to full size, otherwise users see scaled, click-dead windows post-disable.
            this.miniatureManager.restoreAllMiniatures();
            this.miniatureManager.destroy();
            this.miniatureManager = null;
        }

        this._miniatureCascadeIds = null;
        this._lastFocusedWindowId = null;

        if (this._tileTimeout && this._timeoutRegistry) {
            this._timeoutRegistry.remove(this._tileTimeout);
            this._tileTimeout = null;
        }
        for (const eventId of this._wmEventIds) global.window_manager.disconnect(eventId);
        for (const eventId of this._displayEventIds) global.display.disconnect(eventId);
        if (this.windowAttentionManager) {
            this.windowAttentionManager.destroy();
            this.windowAttentionManager = null;
        }
        for (const eventId of this._workspaceManEventIds)
            global.workspace_manager.disconnect(eventId);
        for (const container of this._workspaceEventIds) {
            const workspace = container[0];
            const eventIds = container[1];
            eventIds.forEach(eventId => workspace.disconnect(eventId));
        }

        if (this._onOverviewShowingId) {
            Main.overview.disconnect(this._onOverviewShowingId);
            this._onOverviewShowingId = 0;
        }
        if (this._onOverviewHidingId) {
            Main.overview.disconnect(this._onOverviewHidingId);
            this._onOverviewHidingId = 0;
        }
        if (this._onOverviewHiddenId) {
            Main.overview.disconnect(this._onOverviewHiddenId);
            this._onOverviewHiddenId = 0;
        }

        const allWindows = global.display.get_tab_list(Meta.TabList.NORMAL, null);
        allWindows.forEach(w => {
            if (this.windowHandler) this.windowHandler.disconnectWindowSignals(w);
        });

        this._wmEventIds = [];
        this._displayEventIds = [];
        this._workspaceManEventIds = [];
        this._workspaceEventIds = [];

        // Clean up handler classes before nulling shared refs, since their destroy()
        // reaches the timeout registry through the extension reference.
        if (this.resizeHandler) this.resizeHandler.destroy();
        if (this.dragHandler) this.dragHandler.destroy();
        if (this.windowHandler?.destroy) this.windowHandler.destroy();
        this.windowHandler = null;
        this.dragHandler = null;
        this.resizeHandler = null;

        if (this.tilingManager) this.tilingManager.destroy();
        if (this.reorderingManager) this.reorderingManager.destroy();
        if (this.swappingManager) this.swappingManager.destroy();
        if (this.windowingManager) this.windowingManager.destroy();

        this.tilingManager = null;
        this.edgeTilingManager = null;
        this.reorderingManager = null;
        this.swappingManager = null;
        this.drawingManager = null;
        this.animationsManager = null;
        this.mosaicRenderer?.destroy();
        this.mosaicRenderer = null;
        this.windowingManager = null;
        this._timeoutRegistry = null;
        this._mutterSettings = null;
        this._settingsOverrider = null;
        this._injectionManager = null;
        this._workspaceManager = null;
    }
}
