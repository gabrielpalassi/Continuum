// SPDX-License-Identifier: GPL-3.0-or-later
// Window-management behavior adapted from Mosaic WM
// by Cléo Menezes Jr. and contributors:
// https://github.com/CleoMenezesJr/MosaicWM
// GrabHandler - Coordinates move and resize grabs, drag reordering, and ghost effects.

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Clutter from 'gi://Clutter';
import * as Logger from './logger.js';
import {TileZone} from './constants.js';
import * as constants from './constants.js';
import {afterAnimations} from './timing.js';
import {
    fitDragDescriptorToArea,
    monitorContainingPoint,
    selectDragDropMonitor,
} from './layoutPlanning.js';
import * as ShellState from './shellState.js';

export const RESIZE_GRAB_OPS = [
    Meta.GrabOp.RESIZING_NW,
    Meta.GrabOp.RESIZING_N,
    Meta.GrabOp.RESIZING_NE,
    Meta.GrabOp.RESIZING_E,
    Meta.GrabOp.RESIZING_SE,
    Meta.GrabOp.RESIZING_S,
    Meta.GrabOp.RESIZING_SW,
    Meta.GrabOp.RESIZING_W,
    Meta.GrabOp.KEYBOARD_RESIZING_UNKNOWN,
    Meta.GrabOp.KEYBOARD_RESIZING_SE,
];

export function isResizeGrabOp(grabOp) {
    if (RESIZE_GRAB_OPS.includes(grabOp)) return true;
    // Composite resize bitmask: WINDOW_BASE (bit 0) + any directional bit
    return (grabOp & 0x1) !== 0 && (grabOp & 0x3000) !== 0;
}

// A window grab op with no directional bits set is a move (Mutter convention).
export function isMoveGrabOp(grabOp) {
    return (grabOp & 0x1) !== 0 && (grabOp & 0xf000) === 0;
}

export class GrabHandler {
    constructor(extension) {
        this._ext = extension;

        this._draggedWindow = null;
        this._edgeTileGhostWindows = [];
        this._previewMiniaturizedWindows = [];
        this._miniatureCreatedId = 0;
        this._dragMonitorId = null;
        this._currentZone = TileZone.NONE;
        this._dragPositionChangedId = 0;
        this._dragPositionPollId = 0;
        this._lastPolledDragState = null;
        this._lastObservedPointerMonitor = null;
        this._isPositionProcessing = false;
        this._positionUpdatePending = false;
        this._currentGrabOp = null;
        this._restoringFromEdgeTile = false;
        this._suppressRestoreRetile = false;
        this._skipNextTiling = null;
        this._lastReorderMonitor = null;
        this._awaitingUnmaximizeDrag = false;
        this._reorderingActive = false;
        this._dragLayouts = null;
        this._chosenLayout = null;
        this._lastTileState = null;
        this._dragContext = null;
        this._reorderingPaused = false;
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
    get drawingManager() {
        return this._ext.drawingManager;
    }
    get animationsManager() {
        return this._ext.animationsManager;
    }
    get swappingManager() {
        return this._ext.swappingManager;
    }
    get _timeoutRegistry() {
        return this._ext.timeoutRegistry;
    }
    get draggedWindow() {
        return this._draggedWindow;
    }
    get currentGrabOp() {
        return this._currentGrabOp;
    }
    get skipNextTiling() {
        return this._skipNextTiling;
    }
    set skipNextTiling(value) {
        this._skipNextTiling = value;
    }
    get isRestoringFromEdgeTile() {
        return this._restoringFromEdgeTile;
    }
    get isRestoreRetileSuppressed() {
        return this._suppressRestoreRetile;
    }

    _cursorDistance(cursor, rect) {
        const x = cursor.x - (rect.x + rect.width / 2);
        const y = cursor.y - (rect.y + rect.height / 2);
        return Math.sqrt(Math.pow(x, 2) + Math.pow(y, 2));
    }

    _pointerMonitor(x = null, y = null) {
        if (x === null || y === null) [x, y] = global.get_pointer();

        const monitors = Array.from({length: global.display.get_n_monitors()}, (_, index) => ({
            index,
            geometry: global.display.get_monitor_geometry(index),
        }));
        return monitorContainingPoint(monitors, x, y, global.display.get_current_monitor());
    }

    _logDragState(label, level = 'info') {
        if (!this._draggedWindow) return;

        const [x, y] = global.get_pointer();
        const frame = this._draggedWindow.get_frame_rect();
        const pointerMonitor = this._pointerMonitor(x, y);
        Logger[level](
            `[DRAG] ${label} id=${this._draggedWindow.get_id()} pointer=(${x},${y}) pointerMonitor=${pointerMonitor} reportedMonitor=${global.display.get_current_monitor()} windowMonitor=${this._draggedWindow.get_monitor()} frame=(${frame.x},${frame.y},${frame.width}x${frame.height}) sacred=${this.windowingManager.isMaximizedOrFullscreen(this._draggedWindow)} awaitingRestore=${this._awaitingUnmaximizeDrag} reordering=${this._reorderingActive} layoutMonitor=${this._dragMonitorId ?? 'none'} layouts=${this._dragLayouts?.length ?? 0} zone=${this._currentZone} boxes=${this.drawingManager._boxes.length}`
        );
    }

    _onReorderingPositionChanged() {
        if (!this._reorderingActive || !this._dragContext || this._reorderingPaused) return;

        const {metaWindow} = this._dragContext;
        const workspace = metaWindow.get_workspace();
        const [x, y] = global.get_pointer();
        const monitor = this._pointerMonitor(x, y);
        // Layout coordinates belong to the monitor where they were computed.
        // The position idle rebuilds them after a monitor crossing; applying them
        // before that would either draw the hint on the source monitor or suppress
        // the destination hint as an apparently unchanged layout.
        if (monitor !== this._dragMonitorId) return;

        const workArea = workspace.get_work_area_for_monitor(monitor);
        const cursor = {x, y};

        const zone = this.edgeTilingManager.detectZone(x, y, workArea, workspace);
        if (zone !== TileZone.NONE) {
            this._lastTileState = 'edge-zone';
            return;
        }

        const closest = this._closestDragLayout(cursor);
        if (!closest) return;
        const {layout, distance} = closest;

        if (this._chosenLayout && layout !== this._chosenLayout) {
            const currentDistance = this._cursorDistance(cursor, this._chosenLayout.draggedRect);
            if (distance > currentDistance * 0.5) return;
        }

        const newState = this._tileStateFor(layout);
        if (this._lastTileState === newState) return;
        this.tilingManager.applyDragLayout(layout.positions, workspace, monitor);
        this._lastTileState = newState;
        this._chosenLayout = layout;
    }

    _closestDragLayout(cursor) {
        if (!this._dragLayouts || this._dragLayouts.length === 0) return null;

        let closestLayout = null;
        let minimumDistance = Infinity;
        for (const layout of this._dragLayouts) {
            const distance = this._cursorDistance(cursor, layout.draggedRect);
            if (distance < minimumDistance) {
                minimumDistance = distance;
                closestLayout = layout;
            }
        }

        return closestLayout ? {layout: closestLayout, distance: minimumDistance} : null;
    }

    _tileStateFor(layout) {
        return `layout-${Math.round(layout.draggedRect.x)}-${Math.round(layout.draggedRect.y)}`;
    }

    _layoutForZoneExit() {
        if (!this._reorderingActive || !this._dragContext) return null;

        const [x, y] = global.get_pointer();
        const closest = this._closestDragLayout({x, y});
        if (!closest) return null;

        this._chosenLayout = closest.layout;
        this._lastTileState = this._tileStateFor(closest.layout);
        return closest.layout;
    }

    _startReordering(metaWindow) {
        Logger.log(`startDrag called for window ${metaWindow.get_id()}`);
        const workspace = metaWindow.get_workspace();
        const monitor = this._pointerMonitor();
        let metaWindows = this.windowingManager.getMonitorWorkspaceWindows(workspace, monitor);

        if (!metaWindows.find(window => window.get_id() === metaWindow.get_id()))
            metaWindows = [metaWindow, ...metaWindows];

        this.animationsManager.setDragging(true);

        const edgeTiledWindows = this.edgeTilingManager.getEdgeTiledWindows(workspace, monitor);
        const edgeTiledIds = new Set(edgeTiledWindows.map(({window}) => window.get_id()));
        // Sacred occupants will be displaced on drop and never participate in the mosaic.
        // Including their monitor-sized descriptors would make every drag preview overflow.
        const mosaicWindows = metaWindows.filter(
            window =>
                !edgeTiledIds.has(window.get_id()) &&
                (window.get_id() === metaWindow.get_id() ||
                    !this.windowingManager.isMaximizedOrFullscreen(window))
        );
        Logger.log(
            `startDrag: Total: ${metaWindows.length}, Edge-tiled: ${edgeTiledWindows.length}, Mosaic: ${mosaicWindows.length}`
        );

        this.tilingManager.applySwaps(workspace, mosaicWindows);
        const descriptors = this.tilingManager.windowsToDescriptors(
            mosaicWindows,
            monitor,
            metaWindow
        );

        const remainingSpace =
            edgeTiledWindows.length > 0
                ? this.edgeTilingManager.calculateRemainingSpace(workspace, monitor)
                : null;
        if (remainingSpace) {
            Logger.log(
                `startDrag: Remaining space: x=${remainingSpace.x}, y=${remainingSpace.y}, w=${remainingSpace.width}, h=${remainingSpace.height}`
            );
        }

        this.tilingManager.createMask(metaWindow);
        this.tilingManager.clearTmpSwap();
        this.tilingManager.enableDragMode(remainingSpace);
        this._reorderingActive = true;

        const descriptorsCopy = descriptors.map(descriptor => ({
            id: descriptor.id,
            index: descriptor.index,
            x: descriptor.x,
            y: descriptor.y,
            width: descriptor.width,
            height: descriptor.height,
        }));
        const workArea = remainingSpace || workspace.get_work_area_for_monitor(monitor);
        const draggedDescriptorIndex = descriptorsCopy.findIndex(
            descriptor => descriptor.id === metaWindow.get_id()
        );
        if (draggedDescriptorIndex >= 0) {
            const descriptor = descriptorsCopy[draggedDescriptorIndex];
            const fitted = fitDragDescriptorToArea(
                descriptor,
                this.tilingManager.getWindowMinimumSize(metaWindow),
                workArea,
                Boolean(metaWindow.allows_resize?.())
            );
            if (fitted !== descriptor) {
                descriptorsCopy[draggedDescriptorIndex] = fitted;
                Logger.info(
                    `[DRAG] preview-fit id=${metaWindow.get_id()} ${descriptor.width}x${descriptor.height}->${fitted.width}x${fitted.height} workArea=${workArea.width}x${workArea.height}`
                );
            }
        }

        this._dragContext = {metaWindow, id: metaWindow.get_id(), windows: descriptorsCopy};
        this._dragMonitorId = monitor;
        this._dragLayouts = this.tilingManager.computeDragLayouts(
            descriptorsCopy,
            workArea,
            metaWindow.get_id()
        );
        this._chosenLayout = null;
        this._lastTileState = null;
        Logger.log(`Pre-computed ${this._dragLayouts.length} valid drag positions`);
        this._logDragState(
            this._dragLayouts.length > 0 ? 'previews-built' : 'no-preview-layouts',
            this._dragLayouts.length > 0 ? 'info' : 'warn'
        );

        this._reorderingPaused = false;
        this._onReorderingPositionChanged();
    }

    _stopReordering(metaWindow, skipApply, skipTiling = false) {
        Logger.log(
            `stopDrag called for window ${metaWindow.get_id()}, dragStart was: ${this._reorderingActive}`
        );
        const workspace = metaWindow.get_workspace();
        this._reorderingActive = false;

        if (!skipApply && this._chosenLayout) {
            this.tilingManager.pinComposition(
                workspace,
                this._chosenLayout.shape,
                this._chosenLayout.permOrder
            );
        }

        this._dragLayouts = null;
        this._chosenLayout = null;
        this._lastTileState = null;
        this._dragContext = null;
        this._dragMonitorId = null;
        this.animationsManager.setDragging(false);
        this.tilingManager.disableDragMode();
        this.tilingManager.destroyMasks();

        if (!skipTiling) {
            this.tilingManager.tileWorkspaceWindows(workspace, null, metaWindow.get_monitor());
        } else {
            Logger.log('stopDrag: Skipping workspace tiling (requested)');
        }
    }

    clearGhostWindows() {
        for (const win of this._edgeTileGhostWindows) {
            const actor = win.get_compositor_private();
            if (actor) actor.opacity = 255;
        }
        this._edgeTileGhostWindows = [];
    }

    _disconnectMiniatureCreated() {
        if (!this._miniatureCreatedId) return;
        this._ext.miniatureManager?.disconnect(this._miniatureCreatedId);
        this._miniatureCreatedId = 0;
    }

    _startDragPositionPolling() {
        if (this._dragPositionPollId) return;

        this._lastPolledDragState = null;
        this._lastObservedPointerMonitor = this._pointerMonitor();
        this._dragPositionPollId = this._timeoutRegistry.add(
            constants.POLL_INTERVAL_MS,
            () => {
                if (!this._draggedWindow || this._currentGrabOp === null) {
                    this._dragPositionPollId = 0;
                    this._lastPolledDragState = null;
                    return GLib.SOURCE_REMOVE;
                }

                const [x, y] = global.get_pointer();
                const frame = this._draggedWindow.get_frame_rect();
                const pointerMonitor = this._pointerMonitor(x, y);
                const state = [
                    x,
                    y,
                    pointerMonitor,
                    this.windowingManager.isMaximizedOrFullscreen(this._draggedWindow),
                    frame.x,
                    frame.y,
                    frame.width,
                    frame.height,
                ].join(':');
                if (state === this._lastPolledDragState) return GLib.SOURCE_CONTINUE;

                this._lastPolledDragState = state;
                this._onDragPositionChanged();
                if (pointerMonitor !== this._lastObservedPointerMonitor) {
                    this._lastObservedPointerMonitor = pointerMonitor;
                    this._logDragState('pointer-monitor-changed');
                }
                return GLib.SOURCE_CONTINUE;
            },
            'grabHandler_dragPositionPoll'
        );
    }

    _stopDragPositionPolling() {
        if (this._dragPositionPollId) {
            this._timeoutRegistry.remove(this._dragPositionPollId);
            this._dragPositionPollId = 0;
        }
        this._lastPolledDragState = null;
        this._lastObservedPointerMonitor = null;
    }

    // The preview miniaturizes for real, and nothing in the mosaic un-miniaturizes on its own, so
    // leaving the zone (or dropping outside it) is the only thing that can hand these back.
    _restorePreviewMiniatures() {
        const miniatureManager = this._ext.miniatureManager;
        // restoreMiniature emits synchronously. Retiling after each restore can
        // re-miniaturize the same window while the drag is still active and turn
        // preview cleanup into an unbounded restore/retile loop. The drop owns the
        // authoritative retile, so suppress the per-restore pass here.
        this._suppressRestoreRetile = true;
        try {
            for (const win of this._previewMiniaturizedWindows) {
                if (!miniatureManager || !ShellState.get(win, ShellState.IS_MINIATURE)) continue;
                Logger.log(`Edge preview cancelled - restoring miniature ${win.get_id()}`);
                miniatureManager.restoreMiniature(win, null, {activate: false});
            }
        } finally {
            this._suppressRestoreRetile = false;
        }
        this._previewMiniaturizedWindows = [];
    }

    onGrabOpBegin = (_display, window, grabpo) => {
        // Keyboard-driven grabs (Alt+F8 resize, Alt+Tab+move) bypass the click overlay
        // entirely, so a miniature would otherwise be manipulable without ever restoring.
        if (ShellState.get(window, ShellState.IS_MINIATURE)) {
            this._ext.miniatureManager?.restoreMiniature(window, null);
        }

        this._currentGrabOp = grabpo;
        const isResizeOp = isResizeGrabOp(grabpo);
        if (isResizeOp) {
            this._ext.resizeHandler.onResizeBegin(window, grabpo);
        }

        if (isMoveGrabOp(grabpo) && !this.windowingManager.isExcluded(window)) {
            Logger.log('Edge tiling: grab begin');
            this._draggedWindow = window;
            this._positionUpdatePending = false;
            this.tilingManager.setGrabbedWindow(window);
            this._awaitingUnmaximizeDrag = this.windowingManager.isMaximizedOrFullscreen(window);
            this._startDragPositionPolling();
            this._logDragState('begin');

            const originWorkspace =
                window.get_workspace() ?? global.workspace_manager.get_active_workspace();
            ShellState.set(window, 'userMoveOrigin', {
                workspace: originWorkspace,
                monitor: window.get_monitor(),
            });

            // Only monitor crossings from this drag should retile a source at the drop.
            ShellState.remove(window, 'leftMonitor');

            // The edge preview is the only thing that miniaturizes mid-drag, so whatever gets
            // created while the grab is live is ours to hand back if the drop never happens.
            if (!this._miniatureCreatedId && this._ext.miniatureManager) {
                this._miniatureCreatedId = this._ext.miniatureManager.connect(
                    'miniature-created',
                    (_mgr, win) => {
                        if (!this._previewMiniaturizedWindows.includes(win))
                            this._previewMiniaturizedWindows.push(win);
                    }
                );
            }

            const windowState = this.edgeTilingManager.getWindowState(window);

            if (windowState && windowState.zone !== TileZone.NONE) {
                this._currentZone = windowState.zone;
                Logger.log(
                    `Edge tiling: window was in zone ${windowState.zone}, initializing _currentZone`
                );

                this._skipNextTiling = window.get_id();
                this._restoringFromEdgeTile = true;

                this.edgeTilingManager.removeTile(
                    window,
                    () => {
                        // Delay clearing the flag to cover the debounce period for overflow detection
                        this._timeoutRegistry.add(
                            constants.EDGE_TILE_RESTORE_DELAY_MS,
                            () => {
                                this._restoringFromEdgeTile = false;
                                return GLib.SOURCE_REMOVE;
                            },
                            'grabHandler_edgeTileRestoreDelay'
                        );

                        Logger.log(
                            'Edge tiling: restoration complete, checking if drag still active'
                        );
                        this._skipNextTiling = null;
                        this._currentZone = TileZone.NONE; // Reset so window doesn't get re-tiled on release

                        const [_x, _y, mods] = global.get_pointer();
                        const isButtonPressed = (mods & Clutter.ModifierType.BUTTON1_MASK) !== 0;

                        if (!isButtonPressed) {
                            Logger.log(
                                'Edge tiling: button released during restoration, skipping startDrag'
                            );
                            this._draggedWindow = null;
                            // The retile below can only move the window once nothing claims the cursor holds it.
                            this.tilingManager.setGrabbedWindow(null);

                            const workspace = window.get_workspace();
                            const monitor = window.get_monitor();
                            if (workspace && monitor !== null) {
                                Logger.log('Edge tiling: triggering retile after quick release');
                                this.tilingManager.tileWorkspaceWindows(
                                    workspace,
                                    window,
                                    monitor,
                                    false
                                );
                            }
                            return;
                        }

                        if (
                            (isMoveGrabOp(grabpo) || grabpo === Meta.GrabOp.KEYBOARD_MOVING) &&
                            window &&
                            !this.windowingManager.isMaximizedOrFullscreen(window)
                        ) {
                            // Build the mosaic before drag mode starts, since once isDragging is set the
                            // mosaic stops miniaturizing and could never form around the window we hold.
                            Logger.log(
                                'Edge tiling: building mosaic for the windows that left the tile'
                            );
                            this.tilingManager.tileWorkspaceWindows(
                                window.get_workspace(),
                                window,
                                window.get_monitor(),
                                false
                            );

                            Logger.log(
                                `_grabOpBeginHandler: calling startDrag for window ${window.get_id()}`
                            );
                            this._startReordering(window);
                            this._lastReorderMonitor = this._pointerMonitor();

                            // The grab is still live, so this drag needs the position listener a normal one
                            // gets; without it there is no live mosaic and no zone to snap back into.
                            if (!this._dragPositionChangedId) {
                                Logger.log(
                                    'Connecting signal-based edge tiling listeners (edge tile exit)'
                                );
                                this._dragPositionChangedId = window.connect(
                                    'position-changed',
                                    this._onDragPositionChanged.bind(this)
                                );
                            }
                        }
                    },
                    true
                );
                return;
            } else {
                this._currentZone = TileZone.NONE;
            }

            Logger.log('Connecting signal-based edge tiling listeners');
            this._dragPositionChangedId = this._draggedWindow.connect(
                'position-changed',
                this._onDragPositionChanged.bind(this)
            );
        }

        // For keyboard/menu move: set up position tracking for reordering (no edge tiling).
        // KEYBOARD_MOVING also matches isMoveGrabOp, so guard against the block
        // above having already connected (a second connect would leak the first id).
        if (
            grabpo === Meta.GrabOp.KEYBOARD_MOVING &&
            !this._dragPositionChangedId &&
            !this.windowingManager.isExcluded(window)
        ) {
            this._draggedWindow = window;
            this._dragPositionChangedId = this._draggedWindow.connect(
                'position-changed',
                this._onDragPositionChanged.bind(this)
            );
        }

        if (
            !this.windowingManager.isExcluded(window) &&
            (isMoveGrabOp(grabpo) || grabpo === Meta.GrabOp.KEYBOARD_MOVING) &&
            !this.windowingManager.isMaximizedOrFullscreen(window)
        ) {
            Logger.log(`_grabOpBeginHandler: calling startDrag for window ${window.get_id()}`);
            this._startReordering(window);
            this._lastReorderMonitor = this._pointerMonitor();
        }
    };

    onGrabOpEnd = (_display, window, grabpo) => {
        this._logDragState('end');
        this._currentGrabOp = null;
        this._positionUpdatePending = false;
        this._awaitingUnmaximizeDrag = false;
        this._stopDragPositionPolling();
        // Unconditional: a leftover id would freeze that window out of every later layout.
        this.tilingManager.setGrabbedWindow(null);

        const isMove = isMoveGrabOp(grabpo) || grabpo === Meta.GrabOp.KEYBOARD_MOVING;
        const destinationWorkspace =
            window.get_workspace() ?? global.workspace_manager.get_active_workspace();
        const windowMonitor = window.get_monitor();
        const pointerMonitor = this._pointerMonitor();
        const hasChosenLayout =
            this._chosenLayout !== null && this._lastTileState?.startsWith('layout-');
        const destinationMonitor = selectDragDropMonitor({
            windowMonitor,
            pointerMonitor,
            layoutMonitor: this._dragMonitorId,
            hasChosenLayout,
        });
        const hasSacredDestinationConflict = Boolean(
            destinationWorkspace &&
            this.windowingManager.getSacredOccupant(
                window,
                destinationWorkspace,
                destinationMonitor
            )
        );
        const placementRect =
            this._chosenLayout && this._dragMonitorId === destinationMonitor
                ? {...this._chosenLayout.draggedRect}
                : null;
        const hasCrossMonitorHintDrop =
            isMove && placementRect !== null && destinationMonitor !== windowMonitor;
        if (hasCrossMonitorHintDrop) {
            Logger.info(
                `[DRAG] drop-monitor-selected id=${window.get_id()} windowMonitor=${windowMonitor} pointerMonitor=${pointerMonitor} layoutMonitor=${this._dragMonitorId} destinationMonitor=${destinationMonitor}`
            );
        }

        if (
            (isMoveGrabOp(grabpo) || grabpo === Meta.GrabOp.KEYBOARD_MOVING) &&
            window === this._draggedWindow
        ) {
            if (this._dragPositionChangedId && window) {
                try {
                    window.disconnect(this._dragPositionChangedId);
                } catch (e) {
                    Logger.log(`Failed to disconnect signal on drag end: ${e.message}`);
                }
                this._dragPositionChangedId = 0;
            }

            if (isMoveGrabOp(grabpo) && this._currentZone !== TileZone.NONE) {
                const workspace = window.get_workspace();
                const [curX, curY] = global.get_pointer();
                const monitor = this._pointerMonitor(curX, curY);
                const workArea = workspace.get_work_area_for_monitor(monitor);

                // Re-verify the mouse is actually in the zone at release time.
                // _currentZone is updated via an idle so it can lag behind the real pointer
                // position: if the user exits the zone and releases before the idle fires,
                // _currentZone is still non-NONE and applyTile would fire incorrectly.
                const actualZone = this.edgeTilingManager.detectZone(
                    curX,
                    curY,
                    workArea,
                    workspace
                );
                if (actualZone === TileZone.NONE) {
                    Logger.log(
                        `Edge tiling: grab released outside zone (pointer at ${curX},${curY}), cancelling`
                    );
                    this.clearGhostWindows();
                    this._restorePreviewMiniatures();
                } else {
                    Logger.log(`Edge tiling: applying zone ${this._currentZone}`);
                    const occupiedWindow = this.edgeTilingManager.getWindowInZone(
                        this._currentZone,
                        workspace,
                        monitor
                    );

                    if (occupiedWindow && occupiedWindow.get_id() !== window.get_id()) {
                        Logger.log(
                            `DnD: zone ${this._currentZone} occupied by ${occupiedWindow.get_id()}, swapping`
                        );

                        this._skipNextTiling = window.get_id();

                        const success = this.swappingManager.swapWindows(
                            window,
                            occupiedWindow,
                            this._currentZone,
                            workspace,
                            monitor
                        );
                        Logger.log(`DnD swap result = ${success}`);

                        if (success) {
                            this._timeoutRegistry.add(
                                constants.RETILE_DELAY_MS,
                                () => {
                                    this._skipNextTiling = null;
                                    return GLib.SOURCE_REMOVE;
                                },
                                'grabHandler_skipTilingSwap'
                            );
                            this._previewMiniaturizedWindows = [];
                        } else {
                            this._restorePreviewMiniatures();
                            this._skipNextTiling = null;
                        }
                    } else {
                        Logger.log(`DnD: zone ${this._currentZone} empty, applying tile`);

                        this._skipNextTiling = window.get_id();

                        const success = this.edgeTilingManager.applyTile(
                            window,
                            this._currentZone,
                            workArea
                        );
                        Logger.log(`Edge tiling: apply result = ${success}`);

                        if (success) {
                            // The preview's miniatures are the real thing already, so the tile just keeps them.
                            Logger.log(
                                `Edge tile confirmed - keeping ${this._previewMiniaturizedWindows.length} miniatures`
                            );
                            this._previewMiniaturizedWindows = [];

                            this._timeoutRegistry.add(
                                constants.RETILE_DELAY_MS,
                                () => {
                                    this._skipNextTiling = null;
                                    return GLib.SOURCE_REMOVE;
                                },
                                'grabHandler_skipTilingApply'
                            );
                        } else {
                            this.clearGhostWindows();
                            this._restorePreviewMiniatures();
                            this._skipNextTiling = null;
                        }
                    }
                }
            }

            this.drawingManager.hideTilePreview();
            this._draggedWindow = null;
            this._currentZone = TileZone.NONE;
            this._lastReorderMonitor = null;

            this.tilingManager.clearDragRemainingSpace();

            this.clearGhostWindows();
            // Anything still listed here belongs to a preview that never reached a tile.
            this._restorePreviewMiniatures();
            this._disconnectMiniatureCreated();
        }

        if (!this.windowingManager.isExcluded(window)) {
            const skipTiling = this._skipNextTiling === window.get_id();
            const isResizeEnd = isResizeGrabOp(grabpo);

            // Resize-end retiling is handled by resizeHandler.onResizeEnd below, which
            // keeps resizingWindowId set through the final retile to avoid animation
            // jiggle. Skip stopDrag's own retile here to avoid two overlapping tiling passes.
            this._stopReordering(
                window,
                false,
                skipTiling || isResizeEnd || hasSacredDestinationConflict || hasCrossMonitorHintDrop
            );

            if (isResizeEnd) {
                this._ext.resizeHandler.onResizeEnd(window, grabpo, skipTiling);
            }

            if (
                isMove &&
                (hasSacredDestinationConflict ||
                    (!this.windowingManager.isMaximizedOrFullscreen(window) && !skipTiling))
            ) {
                afterAnimations(
                    this.animationsManager,
                    () => {
                        // A window on a secondary monitor under workspaces-only-on-primary has
                        // no workspace of its own, but it sits in every workspace's list.
                        const workspace =
                            window.get_workspace() ??
                            global.workspace_manager.get_active_workspace();
                        const monitor = destinationMonitor;
                        const origin = ShellState.get(window, 'userMoveOrigin');

                        this.windowingManager
                            .makeRoomForUserPlacement(
                                window,
                                workspace,
                                monitor,
                                origin,
                                placementRect
                            )
                            .then(handledConflict => {
                                ShellState.remove(window, 'userMoveOrigin');

                                const committedPlacement =
                                    !handledConflict &&
                                    placementRect &&
                                    this.tilingManager.commitDragPlacement(
                                        window,
                                        placementRect,
                                        workspace,
                                        monitor
                                    );
                                if (
                                    !handledConflict &&
                                    !committedPlacement &&
                                    !this.windowingManager.isMaximizedOrFullscreen(window) &&
                                    !skipTiling
                                ) {
                                    this.tilingManager.tileWorkspaceWindows(
                                        workspace,
                                        window,
                                        monitor,
                                        false
                                    );
                                }

                                // The drag crossed monitors; the siblings it left behind still hold its
                                // slot open. onWindowLeftMonitor leaves the source here instead of
                                // retiling mid-grab, which would fight the drag passes above.
                                const sourceMonitor = ShellState.get(window, 'leftMonitor');
                                if (sourceMonitor !== undefined && sourceMonitor !== monitor) {
                                    ShellState.remove(window, 'leftMonitor');
                                    this._ext.windowHandler.retileSourceAfterUserMove(
                                        window,
                                        origin?.workspace ?? workspace,
                                        sourceMonitor
                                    );
                                }
                            })
                            .catch(e => {
                                ShellState.remove(window, 'userMoveOrigin');
                                Logger.error(`User placement conflict resolution failed: ${e}`);
                            });
                    },
                    this._timeoutRegistry
                );
            } else if (isMove) {
                ShellState.remove(window, 'userMoveOrigin');
            }
        } else {
            this._stopReordering(window, true);
        }

        this.clearGhostWindows();
        this.drawingManager.hideTilePreview();
    };

    _startUnmaximizedHeaderbarDrag() {
        if (
            !this._awaitingUnmaximizeDrag ||
            !this._draggedWindow ||
            this._reorderingActive ||
            this.windowingManager.isMaximizedOrFullscreen(this._draggedWindow)
        )
            return;

        const workspace =
            this._draggedWindow.get_workspace() ?? global.workspace_manager.get_active_workspace();
        const monitor = this._draggedWindow.get_monitor();
        if (!workspace || monitor === null || monitor === undefined) return;

        // The maximize property flips before Mutter restores the old frame. Waiting
        // for that frame avoids caching a set of drag layouts built around a
        // monitor-sized descriptor that will disappear on the next configure.
        const frame = this._draggedWindow.get_frame_rect();
        const workArea = workspace.get_work_area_for_monitor(monitor);
        const preferredSize =
            ShellState.get(this._draggedWindow, 'preferredSize') ||
            ShellState.get(this._draggedWindow, 'openingSize');
        const hasSmallerPreferredFrame =
            preferredSize &&
            (preferredSize.width < workArea.width - constants.ANIMATION_DIFF_THRESHOLD ||
                preferredSize.height < workArea.height - constants.ANIMATION_DIFF_THRESHOLD);
        const frameIsStillMonitorSized =
            frame.width >= workArea.width - constants.ANIMATION_DIFF_THRESHOLD &&
            frame.height >= workArea.height - constants.ANIMATION_DIFF_THRESHOLD;
        if (hasSmallerPreferredFrame && frameIsStillMonitorSized) return;

        Logger.log(
            `Headerbar drag: window ${this._draggedWindow.get_id()} restored; starting mosaic previews`
        );
        this._awaitingUnmaximizeDrag = false;
        this._startReordering(this._draggedWindow);
        this._lastReorderMonitor = this._pointerMonitor();
    }

    _restartReorderingOnMonitor(workspace, monitor) {
        if (!this._draggedWindow || monitor === this._dragMonitorId) return;

        const layoutMonitor = this._dragMonitorId;
        Logger.log(
            `Drag layout monitor changed from ${layoutMonitor ?? 'none'} to ${monitor}; rebuilding previews`
        );

        this.tilingManager.setDragRemainingSpace(null);
        if (layoutMonitor !== null) {
            this.tilingManager.tileWorkspaceWindows(
                workspace,
                this._draggedWindow,
                layoutMonitor,
                false,
                true
            );
        }

        this._startReordering(this._draggedWindow);
        this._lastReorderMonitor = monitor;
    }

    _onDragPositionChanged() {
        if (!this._draggedWindow) return;

        this._startUnmaximizedHeaderbarDrag();
        if (this._awaitingUnmaximizeDrag) return;

        const [x, y] = global.get_pointer();
        const monitor = this._pointerMonitor(x, y);
        const workspace = this._draggedWindow.get_workspace();
        const workArea = workspace.get_work_area_for_monitor(monitor);

        const zone = this.edgeTilingManager.detectZone(x, y, workArea, workspace);
        const isInZone = zone !== TileZone.NONE;

        // _currentZone is updated one idle after zone detection; without the guard the synchronous
        // path would draw a reordering rect over the tile-preview overlay on zone entry.
        this._reorderingPaused = isInZone;
        if (!isInZone && this._currentZone === TileZone.NONE) this._onReorderingPositionChanged();

        if (this._isPositionProcessing) {
            this._positionUpdatePending = true;
            return;
        }
        this._isPositionProcessing = true;

        this._timeoutRegistry.addIdle(() => {
            // finally, not a trailing assignment: anything throwing below would leave the flag set
            // and every later position idle would bail at the guard, killing the drag for good.
            try {
                if (!this._draggedWindow) return GLib.SOURCE_REMOVE;

                if (zone !== TileZone.NONE && zone !== this._currentZone) {
                    Logger.log(`Edge tiling: detected zone ${zone}`);
                    this._currentZone = zone;

                    if (this._lastReorderMonitor !== null && monitor !== this._lastReorderMonitor) {
                        this.tilingManager.setDragRemainingSpace(null);
                        this.tilingManager.tileWorkspaceWindows(
                            workspace,
                            this._draggedWindow,
                            this._lastReorderMonitor,
                            false,
                            true
                        );
                    }
                    this._lastReorderMonitor = monitor;
                    this.drawingManager.showTilePreview(zone, workArea, this._draggedWindow);

                    const remainingSpace = this.edgeTilingManager.calculateRemainingSpaceForZone(
                        zone,
                        workArea
                    );
                    this.tilingManager.setDragRemainingSpace(remainingSpace);

                    this.clearGhostWindows();

                    const mosaicWindows = this.windowingManager
                        .getMonitorWorkspaceWindows(workspace, monitor)
                        .filter(
                            w =>
                                w.get_id() !== this._draggedWindow.get_id() &&
                                !this.edgeTilingManager.isEdgeTiled(w)
                        );

                    // A lone window that can fill the opposite half gets auto-tiled there on drop, so it
                    // gets its own tile preview. Miniaturizing it here would preview something that won't happen.
                    const pairsIntoOppositeHalf =
                        mosaicWindows.length === 1 &&
                        (zone === TileZone.LEFT_FULL || zone === TileZone.RIGHT_FULL) &&
                        this.edgeTilingManager.isEdgeTileable(mosaicWindows[0], remainingSpace);

                    // Decided before tiling, since the tile pass is what miniaturizes now.
                    this.tilingManager.setDragMiniaturizationAllowed(!pairsIntoOppositeHalf);
                    this.tilingManager.tileWorkspaceWindows(
                        workspace,
                        this._draggedWindow,
                        monitor,
                        false
                    );

                    this.drawingManager.hideCompanionTilePreview();

                    if (pairsIntoOppositeHalf) {
                        Logger.log(
                            `Edge tiling: previewing ${mosaicWindows[0].get_id()} as opposite half ${remainingSpace.width}x${remainingSpace.height}`
                        );
                        this.drawingManager.showCompanionTilePreview(remainingSpace);
                    }
                } else if (zone === TileZone.NONE && this._currentZone !== TileZone.NONE) {
                    Logger.log('Edge tiling: exiting zone');
                    this._currentZone = TileZone.NONE;
                    this.drawingManager.hideTilePreview();
                    this.tilingManager.setDragRemainingSpace(null);
                    this.tilingManager.setDragMiniaturizationAllowed(true);

                    this.clearGhostWindows();
                    // Ahead of the tile pass, so the layout sees them back at full size.
                    this._restorePreviewMiniatures();

                    // Go straight to the layout the cursor is over, the one the drop will pin. Restoring
                    // the pre-zone layout here instead means the reordering pass on the next pointer
                    // move immediately hauls every window somewhere else.
                    if (monitor !== this._dragMonitorId) {
                        this._restartReorderingOnMonitor(workspace, monitor);
                    } else {
                        const layout = this._layoutForZoneExit();
                        this.tilingManager.setDragLayoutHint(layout);
                        this.tilingManager.tileWorkspaceWindows(
                            workspace,
                            this._draggedWindow,
                            monitor
                        );
                        this.tilingManager.setDragLayoutHint(null);

                        this._lastReorderMonitor = monitor;
                    }
                } else if (zone === TileZone.NONE && monitor !== this._lastReorderMonitor) {
                    Logger.log(
                        `Drag monitor changed to ${monitor} (fast drag skipped edge zone), restarting reorder`
                    );
                    this._restartReorderingOnMonitor(workspace, monitor);
                }

                return GLib.SOURCE_REMOVE;
            } finally {
                this._isPositionProcessing = false;
                if (this._positionUpdatePending) {
                    this._positionUpdatePending = false;
                    this._onDragPositionChanged();
                }
            }
        });
    }

    destroy() {
        this._stopDragPositionPolling();

        if (this._dragPositionChangedId && this._draggedWindow) {
            try {
                this._draggedWindow.disconnect(this._dragPositionChangedId);
            } catch (e) {
                Logger.log(`GrabHandler cleanup failed: ${e.message}`);
            }
            this._dragPositionChangedId = 0;
        }

        for (const win of this._previewMiniaturizedWindows) {
            const actor = win.get_compositor_private();
            if (actor && !actor.is_destroyed()) {
                actor.remove_all_transitions();
                actor.set_scale(1, 1);
                actor.set_translation(0, 0, 0);
            }
        }
        this.clearGhostWindows();
        this._skipNextTiling = null;
        this._draggedWindow = null;
        this._currentZone = null;
        this._restoringFromEdgeTile = false;
        this._suppressRestoreRetile = false;
        this._isPositionProcessing = false;
        this._positionUpdatePending = false;
        this._currentGrabOp = null;
        this._awaitingUnmaximizeDrag = false;
        this._reorderingActive = false;
        this._dragLayouts = null;
        this._chosenLayout = null;
        this._lastTileState = null;
        this._dragContext = null;
        this._dragMonitorId = null;
        this._reorderingPaused = false;
    }
}
