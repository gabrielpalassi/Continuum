// SPDX-License-Identifier: GPL-3.0-or-later
// Window-management behavior adapted from Mosaic WM
// by Cléo Menezes Jr. and contributors:
// https://github.com/CleoMenezesJr/MosaicWM
// Core mosaic tiling algorithm and layout management

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import * as Logger from './logger.js';
import * as constants from './constants.js';
import {TileZone} from './constants.js';
import * as ShellState from './shellState.js';
import {MosaicModel} from './mosaicModel.js';
import {
    IS_MINIATURE,
    MINIATURE_SCALE,
    MINIATURE_EXT_LEFT,
    MINIATURE_EXT_TOP,
    PENDING_MINIATURE,
} from './shellState.js';
import {getMiniatureSize, placeMiniatureAt} from './miniature.js';
import {isWindowAlive} from './shellState.js';
import {
    enumerateTileSlots,
    generateBoundedLayoutCandidates,
    generateRowCompositions,
    orderWindowsByMru,
    planResizeFit,
    requiresOverflowHandling,
    shouldStopDragLayoutSearch,
} from './layoutPlanning.js';
import {getSlowDownFactor, monotonicNow} from './timing.js';

export class TilingManager {
    constructor() {
        this.masks = new Set();
        this.tmp_swap = [];
        this.isDragging = false;
        // Live for the whole grab, unlike isDragging/masks, which only exist once startDrag runs. The
        // edge tile exit tiles before that point, and the layout can't move what the cursor is holding.
        this._grabbedWindowId = null;
        this.dragRemainingSpace = null;
        this._dragMiniaturizationAllowed = true;
        // During a drag the drag layouts are the single source of truth for geometry: the cursor
        // picks one and the drop pins it, so a tile that places windows on its own fights them.
        this._dragLayoutHint = null;

        this._edgeTilingManager = null;
        this._drawingManager = null;
        this._animationsManager = null;
        this._windowingManager = null;
        this._extension = null;

        // Flag to block overflow decisions during smart resize
        this._isSmartResizingBlocked = false;
        // Window ID being restored from miniature; shields it from the overflow handler
        this._restoringWindowId = null;

        // Composition (windows-per-row shape) a deliberate drag/keyboard action pinned
        // per workspace, so a non-default layout survives the next re-tile. WeakMap since
        // it is keyed by workspace GObjects that come and go (like _workspaceSwaps).
        this._pinnedComposition = new WeakMap();
        this._activePinnedShape = null;

        // Layout cache to avoid redundant O(n!) permutation calculations
        this._lastLayoutHash = null;
        this._cachedTileResult = null;
        // Fit simulations repeatedly probe the same window set at different sizes.
        // Remember an order that fit once so the next binary-search probe can test
        // that likely winner before generating permutations again.
        this._simulationOrderHints = new Map();
        // Workspace -> monitor -> last committed order/grouping. A single global
        // history lets another workspace or monitor overwrite stability state.
        this._layoutHistory = new WeakMap();
        this._positionSnapshot = null;
        this._restoreAnchor = null;
        this._movementIgnoredWindowIds = null;
        this._topologyIgnoredWindowIds = null;
        this._skipStabilityForNextTile = false;

        // Swap/reorder operations live per workspace, keyed by Meta.Workspace via WeakMap
        // to avoid monkey-patching native GObjects (same reason shellState.js exists).
        this._workspaceSwaps = new WeakMap();
    }

    get isSmartResizingBlocked() {
        return this._isSmartResizingBlocked;
    }

    setSmartResizeGuard(blocked) {
        this._isSmartResizingBlocked = blocked;
    }

    queuePendingMiniatures(pendingWindows) {
        this._pendingMiniatureWindows = pendingWindows ?? [];
    }

    runSmartResizeTile(
        workspace,
        {
            monitor,
            pendingWindows = [],
            referenceWindow = null,
            preventOverflow = false,
            restoringWindow = null,
        }
    ) {
        const previousBlocked = this._isSmartResizingBlocked;
        const previousRestoringId = this._restoringWindowId;
        this._isSmartResizingBlocked = true;
        this._restoringWindowId = restoringWindow?.get_id() ?? null;
        this._pendingMiniatureWindows = pendingWindows;
        try {
            return this.tileWorkspaceWindows(workspace, referenceWindow, monitor, preventOverflow);
        } finally {
            this._isSmartResizingBlocked = previousBlocked;
            this._restoringWindowId = previousRestoringId;
        }
    }

    simulateLayout(windows, workArea, relaxed = false) {
        return this._tile(windows, workArea, relaxed);
    }

    setEdgeTilingManager(manager) {
        this._edgeTilingManager = manager;
    }

    setExtension(extension) {
        this._extension = extension;
    }

    setDrawingManager(manager) {
        this._drawingManager = manager;
    }

    setAnimationsManager(manager) {
        this._animationsManager = manager;
    }

    // Smart Resize sites only ever change width/height at the window's current
    // position, so x/y always come from the frame already read at the call site.
    // A first placement window doesn't have a real position yet, only wherever
    // Mutter happened to spawn it, so applying that here would move_resize_frame
    // it to that meaningless spot.
    //
    // deferToRetile: tryFitWithResize and rebalanceSmartResize both call this and
    // then immediately call tileWorkspaceWindows in the same tick, which does its
    // own move_resize_frame combining the same size with the window's real tiled
    // position. Animating here too means two separate Wayland geometry requests
    // for the same window back to back: the first commit shows the resize at the
    // old spot, the second shows the push, reading as two sequential animations
    // instead of one. Skip the actual move+ease here and let that next pass be
    // the only one that touches the frame, since it already has the right size
    // (read from targetSmartResizeSize, set independently of this call).
    _animateResize(window, frame, width, height, deferToRetile = false) {
        if (deferToRetile || ShellState.get(window, 'pendingFirstPlacement')) return;
        this._animationsManager?.animateWindow(window, {x: frame.x, y: frame.y, width, height});
    }

    // Whichever window happens to be "newWindow" for a given tryFitWithResize call
    // isn't necessarily the arriving one (a sibling's miniature-restore runs its
    // own pass with itself as newWindow), so the shield lives on the window itself
    // and drops the moment its arrival evaluation resolves placement.
    _isArrivalPending(window) {
        return ShellState.get(window, 'arrivalPending') === true;
    }

    setWindowingManager(manager) {
        this._windowingManager = manager;
    }

    // Effective size: pending async sizes → model slot → frame rect → saved sizes → fallback
    getEffectiveWindowSize(window) {
        const miniSize = getMiniatureSize(window);
        if (miniSize) return miniSize;

        const smartSize = ShellState.get(window, 'targetSmartResizeSize');
        if (smartSize) {
            return {width: smartSize.width, height: smartSize.height};
        }

        const restoredSize = ShellState.get(window, 'targetRestoredSize');
        if (restoredSize) {
            return {width: restoredSize.width, height: restoredSize.height};
        }

        const modelOrFrameSize = this._getSizeFromModelOrFrame(window);
        if (modelOrFrameSize) return modelOrFrameSize;

        const preferred =
            ShellState.get(window, 'preferredSize') || ShellState.get(window, 'openingSize');
        if (preferred) {
            return {width: preferred.width, height: preferred.height};
        }

        return {
            width: constants.SMART_RESIZE_MIN_WINDOW_WIDTH,
            height: constants.SMART_RESIZE_MIN_WINDOW_HEIGHT,
        };
    }

    // The model is authoritative while Overview is open because Mutter drops
    // move/resize requests and leaves the real frame at its previous geometry.
    _getSizeFromModelOrFrame(window) {
        const slot = MosaicModel.slotFor(window);
        if (slot?.width > 0 && slot?.height > 0) return {width: slot.width, height: slot.height};

        const frame = window.get_frame_rect();
        if (frame.width > 0 && frame.height > 0) return {width: frame.width, height: frame.height};

        return null;
    }

    // Native minimum size via Mutter 50+ get_min_size(), with fallback.
    // Also checks cached actual minimums discovered from client-side clamping
    // (e.g., libadwaita apps report 100px via get_min_size but enforce 360px).
    getWindowMinimumSize(window) {
        let baseW = constants.SMART_RESIZE_MIN_WINDOW_WIDTH;
        let baseH = constants.SMART_RESIZE_MIN_WINDOW_HEIGHT;

        if (window.get_min_size) {
            const [hasHint, minW, minH] = window.get_min_size();
            if (hasHint) {
                baseW = Math.max(minW, baseW);
                baseH = Math.max(minH, baseH);
            }
        }

        const actualMinW = ShellState.get(window, 'actualMinWidth');
        const actualMinH = ShellState.get(window, 'actualMinHeight');
        if (actualMinW) baseW = Math.max(actualMinW, baseW);
        if (actualMinH) baseH = Math.max(actualMinH, baseH);

        return {width: baseW, height: baseH};
    }

    // Stamp when a shrink target is applied so the clamp detector can tell "hasn't shrunk yet"
    // (transient) from "won't shrink" (a real minimum), keyed off the target, not the window's age.
    _setSmartResizeTarget(window, size) {
        ShellState.set(window, 'targetSmartResizeSize', {
            width: size.width,
            height: size.height,
        });
        ShellState.set(window, 'targetSmartResizeSetAt', monotonicNow());
    }

    // Native maximum size via Mutter 50+ get_max_size()
    getWindowMaximumSize(window) {
        if (window.get_max_size) {
            const [hasHint, maxW, maxH] = window.get_max_size();
            if (hasHint && maxW > 0 && maxH > 0) return {width: maxW, height: maxH};
        }
        return null;
    }

    findBestRestorationGain(windows, shrunkWindows, workArea) {
        for (let gainFactor = 1.0; gainFactor >= 0.1; gainFactor -= 0.1) {
            const simulatedWindows = windows.map(w => {
                const shrunk = shrunkWindows.find(sw => sw.id === w.get_id());
                if (!shrunk) {
                    // Miniatures sit at their scaled slot size, so use getMiniatureSize to match WindowDescriptor.
                    const miniSize = getMiniatureSize(w);
                    if (miniSize)
                        return {id: w.get_id(), width: miniSize.width, height: miniSize.height};
                    // Use targetSmartResizeSize when present since WindowDescriptor uses the same
                    // value during actual tiling, and diverging here would make simulations inconsistent.
                    const smartResizeSize = ShellState.get(w, 'targetSmartResizeSize');
                    if (smartResizeSize)
                        return {
                            id: w.get_id(),
                            width: smartResizeSize.width,
                            height: smartResizeSize.height,
                        };
                    const f = w.get_frame_rect();
                    return {id: w.get_id(), width: f.width, height: f.height};
                }

                const f = w.get_frame_rect();
                let nw = Math.floor(f.width + shrunk.widthDeficit * gainFactor);
                let nh = Math.floor(f.height + shrunk.heightDeficit * gainFactor);

                nw = Math.min(nw, shrunk.openingWidth);
                nh = Math.min(nh, shrunk.openingHeight);
                const maxSize = this.getWindowMaximumSize(w);
                if (maxSize) {
                    nw = Math.min(nw, maxSize.width);
                    nh = Math.min(nh, maxSize.height);
                }

                return {id: w.get_id(), width: nw, height: nh};
            });

            const tile_result = this._tile(simulatedWindows, workArea, true);
            if (!tile_result.overflow) {
                Logger.log(
                    `findBestRestorationGain: Found workable factor ${gainFactor.toFixed(1)}`
                );
                return {gain: gainFactor, layout: simulatedWindows};
            }
        }
        return null;
    }

    createMask(window) {
        const id = window.id !== undefined ? window.id : window.get_id ? window.get_id() : null;
        if (id !== null) {
            this.masks.add(id);
        }
    }

    destroyMasks() {
        if (this._drawingManager) {
            this._drawingManager.removeBoxes();
        }
        // Clear logical masks only when not dragging; recycle boxes otherwise.
        if (!this.isDragging) {
            this.masks.clear();
        }
    }

    getMask(window) {
        const id = window.id !== undefined ? window.id : window.get_id ? window.get_id() : null;
        if (id !== null && this.masks.has(id)) return new Mask(window);
        return window;
    }

    enableDragMode(remainingSpace = null) {
        this.isDragging = true;
        this.dragRemainingSpace = remainingSpace;
        this._dragMiniaturizationAllowed = true;
    }

    setDragMiniaturizationAllowed(allowed) {
        this._dragMiniaturizationAllowed = allowed;
    }

    setGrabbedWindow(window) {
        this._grabbedWindowId = window ? window.get_id() : null;
    }

    disableDragMode() {
        this.isDragging = false;
        this.dragRemainingSpace = null;
        this._dragMiniaturizationAllowed = true;
        this._dragLayoutHint = null;
        this.invalidateLayoutCache();
    }

    setDragLayoutHint(layout) {
        this._dragLayoutHint = layout?.permOrder?.length
            ? {order: layout.permOrder, shape: layout.shape}
            : null;
    }

    setDragRemainingSpace(space) {
        this.dragRemainingSpace = space;
    }

    clearDragRemainingSpace() {
        this.dragRemainingSpace = null;
    }

    invalidateLayoutCache() {
        this._lastLayoutHash = null;
        this._cachedTileResult = null;
    }

    _extractLayoutPositions(tile_info, work_area) {
        const positions = [];

        if (!tile_info.vertical) {
            let y = tile_info.y;
            for (const level of tile_info.levels) {
                let x = level.x;
                for (const win of level.windows) {
                    const center_offset = work_area.height / 2 + work_area.y - (y + win.height / 2);
                    let y_offset = 0;
                    if (center_offset > 0)
                        y_offset = Math.min(center_offset, level.height - win.height);

                    positions.push({
                        id: win.id,
                        x: x,
                        y: y + y_offset,
                        width: win.width,
                        height: win.height,
                    });
                    x += win.width + constants.WINDOW_SPACING;
                }
                y += level.height + constants.WINDOW_SPACING;
            }
        } else {
            let x = tile_info.x;
            for (const level of tile_info.levels) {
                let y = level.y;
                for (const win of level.windows) {
                    const drawX = win.targetX !== undefined ? win.targetX : x;
                    const drawY = win.targetY !== undefined ? win.targetY : y;

                    positions.push({
                        id: win.id,
                        x: drawX,
                        y: drawY,
                        width: win.width,
                        height: win.height,
                    });
                    y += win.height + constants.WINDOW_SPACING;
                }
                x += level.width + constants.WINDOW_SPACING;
            }
        }

        return positions;
    }

    computeDragLayouts(windowDescriptors, workArea, draggedId) {
        const spacing = constants.WINDOW_SPACING;
        const startTime = GLib.get_monotonic_time();

        let maxHeight = 0,
            maxWidth = 0;
        for (const w of windowDescriptors) {
            maxHeight = Math.max(maxHeight, w.height);
            maxWidth = Math.max(maxWidth, w.width);
        }
        const isNarrow = workArea.width < workArea.height;
        const tooWide = maxWidth > workArea.width * 0.9;
        const tooTall = maxHeight > workArea.height * 0.65;
        const useVertical = tooTall || isNarrow || tooWide;

        const n = windowDescriptors.length;
        const dragged = windowDescriptors.find(w => w.id === draggedId);
        if (!dragged) {
            Logger.warn(
                `[DRAG] layout-search-missing-dragged id=${draggedId} descriptors=[${windowDescriptors.map(w => w.id).join(',')}]`
            );
            return [];
        }
        const others = windowDescriptors.filter(w => w.id !== draggedId);

        const layouts = [];
        const seenPositions = new Set();
        let shapeCount = 0;

        outer: for (const shape of generateRowCompositions(n)) {
            // Budget check per shape too, since the generator is lazy and stopping here
            // caps generation (2^(n-1)) not just the inner loop.
            const elapsedMs = (GLib.get_monotonic_time() - startTime) / 1000;
            if (
                shouldStopDragLayoutSearch({
                    shapeCount,
                    elapsedMs,
                    budgetMs: constants.DRAG_LAYOUT_TIME_BUDGET_MS,
                })
            )
                break;
            shapeCount++;
            // Put the dragged window in each slot; keep the others in their stable order.
            for (let slot = 0; slot < n; slot++) {
                const ordered = [...others];
                ordered.splice(slot, 0, dragged);

                const result = this._placeByShape(ordered, workArea, spacing, shape, useVertical);
                if (result.overflow) continue;

                const positions = this._extractLayoutPositions(result, workArea);
                const draggedPos = positions.find(p => p.id === draggedId);
                if (!draggedPos) continue;

                const snapKey = `${Math.round(draggedPos.x / 50)},${Math.round(draggedPos.y / 50)}`;
                if (seenPositions.has(snapKey)) continue;
                seenPositions.add(snapKey);

                layouts.push({
                    draggedRect: draggedPos,
                    positions,
                    permOrder: ordered.map(w => w.id),
                    shape,
                });

                if (layouts.length >= constants.MAX_DRAG_LAYOUTS) break outer;
            }
        }

        const elapsedMs = (GLib.get_monotonic_time() - startTime) / 1000;
        const summary = `${shapeCount} shapes, ${layouts.length} unique positions for window ${draggedId} in ${elapsedMs.toFixed(1)}ms`;
        if (layouts.length === 0) {
            Logger.warn(
                `[DRAG] layout-search-empty ${summary} workArea=(${workArea.x},${workArea.y},${workArea.width}x${workArea.height}) descriptors=[${windowDescriptors.map(w => `${w.id}:${w.width}x${w.height}`).join(',')}]`
            );
        } else {
            Logger.log(`computeDragLayouts: ${summary}`);
        }
        return layouts;
    }

    applyDragLayout(positions, workspace, monitor) {
        const meta_windows = this._windowingManager.getMonitorWorkspaceWindows(workspace, monitor);

        if (this._drawingManager) {
            this._drawingManager.removeBoxes();
        }

        for (const pos of positions) {
            const isMask = this.masks.has(pos.id);

            if (isMask) {
                if (this._drawingManager) {
                    this._drawingManager.rect(pos.x, pos.y, pos.width, pos.height);
                }
            } else {
                const window = meta_windows.find(w => w.get_id() === pos.id);
                if (!window) continue;

                if (ShellState.get(window, IS_MINIATURE)) {
                    placeMiniatureAt(window, pos.x, pos.y, {
                        animate: true,
                        duration: constants.ANIMATION_DURATION_MS,
                    });
                    MosaicModel.setSlot(
                        window,
                        {x: pos.x, y: pos.y, width: pos.width, height: pos.height},
                        workspace,
                        monitor
                    );
                    continue;
                }

                const currentRect = window.get_frame_rect();
                const posChanged =
                    Math.abs(currentRect.x - pos.x) > 5 || Math.abs(currentRect.y - pos.y) > 5;
                const sizeChanged =
                    Math.abs(currentRect.width - pos.width) > 5 ||
                    Math.abs(currentRect.height - pos.height) > 5;

                if (posChanged || sizeChanged) {
                    ShellState.set(window, 'isConstrainedByMosaic', true);
                    // Same actor-measured continuity as WindowDescriptor.draw: start the ease from
                    // where the window really is, and end it where mutter really put it.
                    const actor = window.get_compositor_private();
                    const alive = actor && !actor.is_destroyed();
                    const visualX = alive ? actor.x + actor.translation_x : 0;
                    const visualY = alive ? actor.y + actor.translation_y : 0;
                    Logger.log(
                        `applyDragLayout: id=${pos.id}, target=(${pos.x},${pos.y}), current=(${currentRect.x},${currentRect.y})`
                    );
                    window.move_frame(false, pos.x, pos.y);
                    window.move_resize_frame(false, pos.x, pos.y, pos.width, pos.height);
                    if (actor && !actor.is_destroyed()) {
                        actor.set_translation(visualX - actor.x, visualY - actor.y, 0);
                        actor.ease({
                            translation_x: 0,
                            translation_y: 0,
                            opacity: 255,
                            duration: Math.ceil(
                                constants.ANIMATION_DURATION_MS * getSlowDownFactor()
                            ),
                            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                        });
                    }
                }
            }
        }
    }

    commitDragPlacement(window, rect, workspace, monitor) {
        if (
            !window ||
            !rect ||
            rect.width <= 0 ||
            rect.height <= 0 ||
            !workspace ||
            monitor === null ||
            monitor === undefined
        )
            return false;

        const frame = window.get_frame_rect();
        if (!ShellState.has(window, 'preferredSize')) {
            ShellState.set(window, 'preferredSize', {
                width: frame.width,
                height: frame.height,
            });
        }
        ShellState.set(window, 'originalSize', {
            width: frame.width,
            height: frame.height,
        });
        ShellState.set(window, 'isConstrainedByMosaic', true);
        this._setSmartResizeTarget(window, rect);
        MosaicModel.setSlot(window, rect, workspace, monitor);

        const shouldAnimate = this._animationsManager?.shouldAnimateWindow(window) ?? false;
        if (this._animationsManager) {
            this._animationsManager.animateWindow(window, rect, {
                subtle: true,
            });
        } else {
            window.move_frame(false, rect.x, rect.y);
            window.move_resize_frame(false, rect.x, rect.y, rect.width, rect.height);
        }
        Logger.info(
            `[DRAG] placement-committed id=${window.get_id()} frame=${frame.width}x${frame.height}->${rect.width}x${rect.height} at=(${rect.x},${rect.y}) monitor=${monitor} animated=${shouldAnimate}`
        );
        return true;
    }

    // Stage a pairwise swap to be applied on the next workspace tile.
    // No-op if the same pair was just staged in reverse order (toggle protection).
    setTmpSwap(id1, id2) {
        if (id1 === id2 || (this.tmp_swap[0] === id2 && this.tmp_swap[1] === id1)) return;
        this.tmp_swap = [id1, id2];
    }

    clearTmpSwap() {
        this.tmp_swap = [];
    }

    applyTmpSwap(workspace) {
        if (!this._workspaceSwaps.has(workspace)) this._workspaceSwaps.set(workspace, []);

        if (this.tmp_swap.length !== 0) this._workspaceSwaps.get(workspace).push(this.tmp_swap);
    }

    applySwaps(workspace, array) {
        const swaps = this._workspaceSwaps.get(workspace);
        if (!swaps || swaps.length === 0) return;

        const getId = w => (w.id !== undefined ? w.id : w.get_id());
        for (const op of swaps) {
            if (Array.isArray(op) && op[0] === 'order') {
                const order = op[1];
                array.sort((a, b) => {
                    const idxA = order.indexOf(getId(a));
                    const idxB = order.indexOf(getId(b));
                    return (idxA === -1 ? Infinity : idxA) - (idxB === -1 ? Infinity : idxB);
                });
            } else {
                this._swapElements(array, op[0], op[1]);
            }
        }

        // Compact to a single order op, since replaying all swaps per tile grows unbounded over a session.
        if (swaps.length > constants.SWAP_OPS_COMPACT_THRESHOLD) {
            this._workspaceSwaps.set(workspace, [['order', array.map(getId)]]);
        }
    }

    applyTmp(array) {
        if (this.tmp_swap.length !== 0) {
            this._swapElements(array, this.tmp_swap[0], this.tmp_swap[1]);
        }
    }

    applyOrderOp(workspace, permOrder) {
        if (!this._workspaceSwaps.has(workspace)) this._workspaceSwaps.set(workspace, []);
        const swaps = this._workspaceSwaps.get(workspace);
        const filtered = swaps.filter(op => !(Array.isArray(op) && op[0] === 'order'));
        filtered.push(['order', permOrder]);
        this._workspaceSwaps.set(workspace, filtered);
        // Pre-drag positions still in snapshot next call; stability heuristic would revert this order.
        this._skipStabilityForNextTile = true;
    }

    // Persist a chosen composition for the workspace. Ordering rides the existing order-op
    // path; only the shape is new. Honored by _tile until the window count changes or the
    // shape stops fitting.
    pinComposition(workspace, shape, order) {
        this._pinnedComposition.set(workspace, {count: order.length, shape});
        Logger.log(`pinComposition: pinned shape [${shape.join(',')}] for ${order.length} windows`);
        this.applyOrderOp(workspace, order);
    }

    // Pick the composition that moves the focused window's center farthest in `direction`.
    // Returns { shape, order, displacement } or null if nothing beats the min threshold.
    bestRecomposition(workspace, monitor, focusedWindow, direction) {
        const startTime = GLib.get_monotonic_time();
        let meta_windows = this._windowingManager.getMonitorWorkspaceWindows(workspace, monitor);

        // Only mosaic windows take part; edge-tiled ones keep their fixed slots and would
        // otherwise inflate n and make the real tile's window count mismatch the pin.
        let workArea = workspace.get_work_area_for_monitor(monitor);
        if (this._edgeTilingManager) {
            const edgeTiled = this._edgeTilingManager.getEdgeTiledWindows(workspace, monitor);
            if (edgeTiled.length > 0) {
                const edgeIds = edgeTiled.map(s => s.window.get_id());
                meta_windows = meta_windows.filter(w => !edgeIds.includes(w.get_id()));
                // The mosaic lives in the space left over by the edge tiles, so fit there.
                workArea = this._edgeTilingManager.calculateRemainingSpace(workspace, monitor);
            }
        }

        const descriptors = this.windowsToDescriptors(meta_windows, monitor, focusedWindow);
        const n = descriptors.length;
        if (n < 2) return null;

        const spacing = constants.WINDOW_SPACING;
        const maxH = Math.max(...descriptors.map(w => w.height));
        const maxW = Math.max(...descriptors.map(w => w.width));
        const useVertical =
            maxH > workArea.height * 0.65 ||
            workArea.width < workArea.height ||
            maxW > workArea.width * 0.9;

        const focused = descriptors.find(w => w.id === focusedWindow.get_id());
        if (!focused) return null;
        const others = descriptors.filter(w => w.id !== focusedWindow.get_id());
        const f0 = focusedWindow.get_frame_rect();
        const cur = {cx: f0.x + f0.width / 2, cy: f0.y + f0.height / 2};
        const sign = direction === 'right' || direction === 'down' ? 1 : -1;
        const axis = direction === 'left' || direction === 'right' ? 'x' : 'y';

        let best = null;
        for (const shape of generateRowCompositions(n)) {
            // Same budget as the drag path, since the generator is lazy and n can be large.
            if (
                (GLib.get_monotonic_time() - startTime) / 1000 >
                constants.DRAG_LAYOUT_TIME_BUDGET_MS
            )
                break;
            for (let slot = 0; slot < n; slot++) {
                const ordered = [...others];
                ordered.splice(slot, 0, focused);
                const result = this._placeByShape(ordered, workArea, spacing, shape, useVertical);
                if (result.overflow) continue;
                const positions = this._extractLayoutPositions(result, workArea);
                const fp = positions.find(p => p.id === focusedWindow.get_id());
                if (!fp) continue;
                const center = axis === 'x' ? fp.x + fp.width / 2 : fp.y + fp.height / 2;
                const disp = sign * (center - (axis === 'x' ? cur.cx : cur.cy));
                if (
                    disp >= constants.KEYBOARD_RECOMPOSE_MIN_DISPLACEMENT_PX &&
                    (!best || disp > best.displacement)
                )
                    best = {shape, order: ordered.map(w => w.id), displacement: disp};
            }
        }
        return best;
    }

    _swapElements(array, id1, id2) {
        const index1 = array.findIndex(w => w.id === id1);
        const index2 = array.findIndex(w => w.id === id2);

        if (index1 === -1 || index2 === -1) return;

        const tmp = array[index1];
        array[index1] = array[index2];
        array[index2] = tmp;
    }

    checkValidity(monitor, workspace, window, strict) {
        if (
            monitor !== null &&
            window.wm_class !== null &&
            isWindowAlive(window) &&
            workspace.list_windows().length !== 0 &&
            (strict ? !window.is_hidden() : !window.minimized)
        ) {
            return true;
        } else {
            return false;
        }
    }

    _createDescriptor(
        meta_window,
        monitor,
        index,
        reference_window,
        allowProjectedMonitor = false
    ) {
        if (reference_window)
            if (meta_window.get_id() === reference_window.get_id())
                return new WindowDescriptor(meta_window, index);

        if (
            this._windowingManager.isExcluded(meta_window) ||
            (!allowProjectedMonitor && meta_window.get_monitor() !== monitor) ||
            this._windowingManager.isMaximizedOrFullscreen(meta_window)
        )
            return false;
        return new WindowDescriptor(meta_window, index);
    }

    windowsToDescriptors(meta_windows, monitor, reference_window, allowProjectedMonitor = false) {
        const descriptors = [];
        for (let i = 0; i < meta_windows.length; i++) {
            const descriptor = this._createDescriptor(
                meta_windows[i],
                monitor,
                i,
                reference_window,
                allowProjectedMonitor
            );
            if (descriptor) descriptors.push(descriptor);
        }
        return descriptors;
    }

    *_iteratePermutations(arr, maxPermutations = 120) {
        if (arr.length <= 1) {
            yield arr;
            return;
        }
        if (arr.length === 2) {
            yield arr;
            yield [arr[1], arr[0]];
            return;
        }

        // Fit simulations use a few heuristic orderings for 6+ windows. Real layout
        // selection has a richer bounded candidate pool in _findOptimalOrder.
        if (arr.length >= 6) {
            const byAreaDesc = [...arr].sort((a, b) => b.width * b.height - a.width * a.height);
            const byAreaAsc = [...arr].sort((a, b) => a.width * a.height - b.width * b.height);
            const byWidthDesc = [...arr].sort((a, b) => b.width - a.width);
            const byHeightDesc = [...arr].sort((a, b) => b.height - a.height);
            const candidates = [arr, byAreaDesc, byAreaAsc, byWidthDesc, byHeightDesc];
            if (this._positionSnapshot) {
                const byPosX = [...arr].sort((a, b) => {
                    const sa = this._positionSnapshot.get(a.id);
                    const sb = this._positionSnapshot.get(b.id);
                    return (sa?.cx ?? 0) - (sb?.cx ?? 0);
                });
                candidates.push(byPosX);
            }
            yield* candidates;
            return;
        }

        // Generate all permutations using Heap's algorithm
        const work = [...arr];
        let count = 0;
        function* heap(n) {
            if (count >= maxPermutations) return;
            if (n === 1) {
                count++;
                yield [...work];
                return;
            }
            for (let i = 0; i < n; i++) {
                yield* heap(n - 1);
                if (count >= maxPermutations) return;
                if (n % 2 === 0) {
                    [work[i], work[n - 1]] = [work[n - 1], work[i]];
                } else {
                    [work[0], work[n - 1]] = [work[n - 1], work[0]];
                }
            }
        }
        yield* heap(work.length);
    }

    _generatePermutations(arr, maxPermutations = 120) {
        return [...this._iteratePermutations(arr, maxPermutations)];
    }

    _scoreLayout(tileResult, workArea, history = null) {
        if (!tileResult || tileResult.overflow) {
            return {
                score: -Infinity,
                orderInversions: Infinity,
                groupRelationshipChanges: Infinity,
                movedCount: Infinity,
                displacementBucket: Infinity,
            };
        }

        let minX = Infinity,
            minY = Infinity,
            maxX = 0,
            maxY = 0;
        let totalArea = 0;
        let movedCount = 0;
        let totalDisplacement = 0;
        const candidateOrder = [];
        const candidateGroups = new Map();

        for (let levelIdx = 0; levelIdx < tileResult.levels.length; levelIdx++) {
            const level = tileResult.levels[levelIdx];
            for (const w of level.windows) {
                const x = w.targetX ?? level.x;
                const y = w.targetY ?? level.y;
                candidateOrder.push(w.id);
                candidateGroups.set(w.id, levelIdx);
                minX = Math.min(minX, x);
                minY = Math.min(minY, y);
                maxX = Math.max(maxX, x + w.width);
                maxY = Math.max(maxY, y + w.height);
                totalArea += w.width * w.height;

                const snap = this._positionSnapshot?.get(w.id);
                if (snap && !this._movementIgnoredWindowIds?.has(w.id)) {
                    const displacement = Math.hypot(
                        x + w.width / 2 - snap.cx,
                        y + w.height / 2 - snap.cy
                    );
                    if (displacement > constants.ANIMATION_DIFF_THRESHOLD) {
                        movedCount++;
                        totalDisplacement += displacement;
                    }
                }
            }
        }

        if (minX === Infinity) {
            return {
                score: -Infinity,
                orderInversions: Infinity,
                groupRelationshipChanges: Infinity,
                movedCount: Infinity,
                displacementBucket: Infinity,
            };
        }

        // Compare relationships, not absolute row/column indices. If a whole
        // preceding group disappears, the surviving groups change indices without
        // changing topology; pairwise membership correctly treats that as stable.
        let orderInversions = 0;
        let groupRelationshipChanges = 0;
        if (history) {
            const tracked = candidateOrder.filter(
                id => history.ranks.has(id) && !this._topologyIgnoredWindowIds?.has(id)
            );
            for (let i = 0; i < tracked.length; i++) {
                const first = tracked[i];
                for (let j = i + 1; j < tracked.length; j++) {
                    const second = tracked[j];
                    if (history.ranks.get(first) > history.ranks.get(second)) orderInversions++;

                    const wereGrouped = history.groups.get(first) === history.groups.get(second);
                    const areGrouped = candidateGroups.get(first) === candidateGroups.get(second);
                    if (wereGrouped !== areGrouped) groupRelationshipChanges++;
                }
            }
        }

        const bboxWidth = maxX - minX;
        const bboxHeight = maxY - minY;
        const bboxArea = bboxWidth * bboxHeight;

        const compactness = totalArea / Math.max(bboxArea, 1);

        const bboxCenterX = minX + bboxWidth / 2;
        const bboxCenterY = minY + bboxHeight / 2;
        const workCenterX = workArea.x + workArea.width / 2;
        const workCenterY = workArea.y + workArea.height / 2;
        const centerDist = Math.sqrt(
            Math.pow(bboxCenterX - workCenterX, 2) + Math.pow(bboxCenterY - workCenterY, 2)
        );
        const maxDist = Math.sqrt(Math.pow(workArea.width, 2) + Math.pow(workArea.height, 2)) / 2;
        const centralization = 1 - centerDist / maxDist;

        const sizeEfficiency = 1 - bboxArea / (workArea.width * workArea.height);

        const score = compactness * 50 + centralization * 30 + sizeEfficiency * 20;

        return {
            score,
            orderInversions,
            groupRelationshipChanges,
            movedCount,
            // Small compositor rounding differences should remain aesthetic ties.
            displacementBucket: Math.round(totalDisplacement / constants.ANIMATION_DIFF_THRESHOLD),
        };
    }

    // Distance from the restored window's center to the slot its miniature held (Infinity if absent).
    _restoreDisplacement(tileResult) {
        if (!this._restoreAnchor) return 0;
        for (const level of tileResult.levels) {
            for (const w of level.windows) {
                if (w.id !== this._restoreAnchor.id) continue;
                const px = (w.targetX ?? level.x) + w.width / 2;
                const py = (w.targetY ?? level.y) + w.height / 2;
                return Math.hypot(px - this._restoreAnchor.cx, py - this._restoreAnchor.cy);
            }
        }
        return Infinity;
    }

    _getLayoutHistory(windows) {
        const descriptor = windows.find(w => w.metaWindow);
        const workspace = descriptor?.metaWindow?.get_workspace();
        const monitor = descriptor?.metaWindow?.get_monitor();
        if (!workspace || monitor === null || monitor === undefined) return null;
        return this._layoutHistory.get(workspace)?.get(monitor) ?? null;
    }

    _rememberLayoutHistory(tileInfo) {
        const tiledWindows = tileInfo.levels.flatMap(level => level.windows);
        if (tiledWindows.length === 0) return;

        const descriptor = tiledWindows.find(w => w.metaWindow);
        const workspace = descriptor?.metaWindow?.get_workspace();
        const monitor = descriptor?.metaWindow?.get_monitor();
        if (!workspace || monitor === null || monitor === undefined) return;

        const groups = new Map();
        tileInfo.levels.forEach((level, levelIdx) => {
            for (const w of level.windows) groups.set(w.id, levelIdx);
        });

        let workspaceHistory = this._layoutHistory.get(workspace);
        if (!workspaceHistory) {
            workspaceHistory = new Map();
            this._layoutHistory.set(workspace, workspaceHistory);
        }
        const order = tiledWindows.map(w => w.id);
        workspaceHistory.set(monitor, {
            order,
            ranks: new Map(order.map((id, index) => [id, index])),
            groups,
        });
        Logger.log(
            () =>
                `[TOPOLOGY] Recorded order [${order.join(', ')}], groups ${[...groups].map(([id, idx]) => `${id}->${idx}`).join(', ')}`
        );
    }

    _findOptimalOrder(windows, workArea, tilingFn) {
        if (windows.length <= 1) return windows;

        const startTime = monotonicNow();
        const history = this._getLayoutHistory(windows);
        const permutations =
            windows.length < 6
                ? this._generatePermutations(windows)
                : generateBoundedLayoutCandidates(windows, {
                      historyOrder: history?.order,
                      positionSnapshot: this._positionSnapshot,
                      maxCandidates: constants.MAX_LAYOUT_CANDIDATES,
                  });

        let bestOrder = windows;
        let bestRank = null;

        for (const perm of permutations) {
            const result = tilingFn.call(this, perm, workArea, constants.WINDOW_SPACING);
            const metrics = this._scoreLayout(result, workArea, history);
            const fits = metrics.score > -Infinity;

            // Restore proximity is considered only among candidates that preserve
            // the previous logical order and grouping equally well.
            const bucket = this._restoreAnchor
                ? Math.round(
                      this._restoreDisplacement(result) / constants.RESTORE_PROXIMITY_TOLERANCE_PX
                  )
                : 0;

            // Lower is always better. This keeps the comparison explicit and makes
            // it difficult for a later aesthetic term to accidentally overpower a
            // topology or movement decision.
            const rank = [
                fits ? 0 : 1,
                metrics.orderInversions,
                metrics.groupRelationshipChanges,
                bucket,
                metrics.movedCount,
                metrics.displacementBucket,
                -metrics.score,
            ];
            let isBetter = bestRank === null;
            for (let i = 0; !isBetter && i < rank.length; i++) {
                if (rank[i] === bestRank[i]) continue;
                isBetter = rank[i] < bestRank[i];
                break;
            }

            if (isBetter) {
                bestRank = rank;
                bestOrder = perm;
            }
        }

        const elapsed = Math.round(monotonicNow() - startTime);
        Logger.log(
            `_findOptimalOrder: ${windows.length} windows, ${permutations.length} permutations, ${elapsed}ms${this._restoreAnchor ? ` (restore anchor ${this._restoreAnchor.id})` : ''}`
        );

        return bestOrder;
    }

    _simulationOrderKey(windows, workArea, useVerticalShelves) {
        const ids = windows
            .map(w => w.id)
            .sort((a, b) => a - b)
            .join(',');
        return `${workArea.width}x${workArea.height}:${useVerticalShelves ? 'v' : 'h'}:${ids}`;
    }

    _rememberSimulationOrder(key, order) {
        // Small FIFO bound: work areas/window sets are few in practice, but monitor
        // hotplug and long sessions should not let stale hints accumulate forever.
        if (!this._simulationOrderHints.has(key) && this._simulationOrderHints.size >= 32) {
            const oldest = this._simulationOrderHints.keys().next().value;
            this._simulationOrderHints.delete(oldest);
        }
        this._simulationOrderHints.set(
            key,
            order.map(w => w.id)
        );
    }

    _applySimulationOrderHint(windows, key) {
        const hint = this._simulationOrderHints.get(key);
        if (!hint || hint.length !== windows.length) return windows;

        const byId = new Map(windows.map(w => [w.id, w]));
        const ordered = hint.map(id => byId.get(id));
        return ordered.every(Boolean) ? ordered : windows;
    }

    // Fit simulations only need one valid ordering, not the aesthetically best
    // ordering used by a real tile pass. Stop immediately once one fits.
    _findFirstFittingLayout(windows, workArea, tilingFn) {
        for (const permutation of this._iteratePermutations(windows)) {
            const result = tilingFn.call(this, permutation, workArea, constants.WINDOW_SPACING);
            if (!result.overflow) return {result, order: permutation};
        }
        return null;
    }

    // Order-sensitive hash: different input orders must never share a cache entry.
    _getLayoutHash(windows, work_area) {
        // Snap to 8px grid to reduce cache invalidation during resize
        const snap = v => Math.round(v / 8) * 8;
        const parts = windows.map(w => `${w.id}:${snap(w.width)}x${snap(w.height)}`);
        return `${snap(work_area.width)}x${snap(work_area.height)}|${parts.join(',')}`;
    }

    _tile(windows, work_area, isSimulation = false) {
        if (!windows || windows.length === 0) return {levels: [], vertical: false, overflow: false};

        const hash = this._getLayoutHash(windows, work_area);
        // Skip cache during drag (order changes but hash doesn't) and while a pin is
        // active, since the hash ignores shape so a new pin would hit a stale cached
        // layout and revert.
        if (
            this._cachedTileResult &&
            this._lastLayoutHash === hash &&
            !isSimulation &&
            !this.isDragging &&
            !this._activePinnedShape
        ) {
            Logger.log('_tile: Cache hit, reusing layout');
            return this._cachedTileResult;
        }

        const spacing = constants.WINDOW_SPACING;

        let maxHeight = 0;
        let maxWidth = 0;
        for (const w of windows) {
            maxHeight = Math.max(maxHeight, w.height);
            maxWidth = Math.max(maxWidth, w.width);
        }

        const isNarrowWorkspace = work_area.width < work_area.height;
        const windowTooWide = maxWidth > work_area.width * 0.9;
        const windowTooTall = maxHeight > work_area.height * 0.65;
        const useVerticalShelves = windowTooTall || isNarrowWorkspace || windowTooWide;

        const tilingFn = useVerticalShelves ? this._verticalShelves : this._horizontalShelves;

        // A pinned composition wins over the auto-chosen grid, but only for the real
        // apply (not simulations / drag) and only while it still fits. If it overflows,
        // fall through to the normal path so overflow -> miniaturization still runs.
        if (this._activePinnedShape && !isSimulation && !this.isDragging) {
            const pinned = this._placeByShape(
                windows,
                work_area,
                spacing,
                this._activePinnedShape,
                useVerticalShelves
            );
            if (!pinned.overflow) {
                this._lastLayoutHash = hash;
                this._cachedTileResult = pinned;
                Logger.log(
                    `_tile: ${windows.length} windows honoring pinned shape [${this._activePinnedShape.join(',')}]`
                );
                return pinned;
            }
            Logger.log('_tile: pinned shape overflows, dropping to auto-layout');
        }

        // The auto-chosen grid would land these windows somewhere else, and the reordering pass
        // right after would drag them across the screen to fix it.
        if (this._dragLayoutHint?.shape && this.isDragging && !isSimulation) {
            const hinted = this._placeByShape(
                windows,
                work_area,
                spacing,
                this._dragLayoutHint.shape,
                useVerticalShelves
            );
            if (!hinted.overflow) {
                Logger.log(
                    `_tile: ${windows.length} windows honoring drag layout [${this._dragLayoutHint.shape.join(',')}]`
                );
                return hinted;
            }
            Logger.log('_tile: drag layout overflows, dropping to auto-layout');
        }

        const simulationKey = isSimulation
            ? this._simulationOrderKey(windows, work_area, useVerticalShelves)
            : null;
        const initialWindows = isSimulation
            ? this._applySimulationOrderHint(windows, simulationKey)
            : windows;
        const currentResult = tilingFn.call(this, initialWindows, work_area, spacing);
        let result;

        // Simulations (binary-search in tryFitWithResize) skip stability scoring for performance.
        const shouldOptimize = currentResult.overflow || (this._positionSnapshot && !isSimulation);

        if (!shouldOptimize) {
            result = currentResult;
            if (isSimulation) this._rememberSimulationOrder(simulationKey, initialWindows);
            Logger.log(
                `_tile: ${windows.length} windows, vertical=${useVerticalShelves}, stable order`
            );
        } else if (this.isDragging && !isSimulation) {
            result = currentResult;
            Logger.log(
                `_tile: ${windows.length} windows, vertical=${useVerticalShelves}, overflow (drag, no permute)`
            );
        } else if (isSimulation) {
            const fitting = this._findFirstFittingLayout(windows, work_area, tilingFn);
            if (fitting) {
                result = fitting.result;
                this._rememberSimulationOrder(simulationKey, fitting.order);
            } else {
                result = currentResult;
            }
            Logger.log(
                `_tile: ${windows.length} windows, vertical=${useVerticalShelves}, simulation ${fitting ? 'first fit' : 'overflow'}`
            );
        } else {
            const optimalWindows = this._findOptimalOrder(windows, work_area, tilingFn);
            result = tilingFn.call(this, optimalWindows, work_area, spacing);
            Logger.log(
                `_tile: ${windows.length} windows, vertical=${useVerticalShelves}, ${currentResult.overflow ? 'reordered (overflow fallback)' : 'stability-checked'}`
            );
        }

        if (!isSimulation && !this.isDragging) {
            this._lastLayoutHash = hash;
            this._cachedTileResult = result;
        }

        return result;
    }

    _verticalShelves(windows, work_area, spacing) {
        if (windows.length <= 2) {
            return this._simpleCenteredColumn(windows, work_area, spacing);
        }

        // Bin packing without height sorting to preserve swap order
        const columns = [];

        for (const w of windows) {
            let placed = false;

            for (const col of columns) {
                const newHeight = col.height + (col.height > 0 ? spacing : 0) + w.height;
                if (newHeight <= work_area.height) {
                    col.windows.push(w);
                    col.height = newHeight;
                    col.width = Math.max(col.width, w.width);
                    placed = true;
                    break;
                }
            }

            if (!placed) {
                const totalWidth =
                    columns.reduce((s, c) => s + c.width, 0) +
                    (columns.length > 0 ? columns.length * spacing : 0) +
                    w.width;

                if (totalWidth <= work_area.width || columns.length === 0) {
                    columns.push({windows: [w], height: w.height, width: w.width});
                } else {
                    // Force into column with most space (overflow case)
                    let bestCol = columns[0];
                    let minHeight = columns[0].height;
                    for (const col of columns) {
                        if (col.height < minHeight) {
                            minHeight = col.height;
                            bestCol = col;
                        }
                    }
                    bestCol.windows.push(w);
                    bestCol.height += spacing + w.height;
                    bestCol.width = Math.max(bestCol.width, w.width);
                }
            }
        }

        const levels = [];
        let totalWidth = 0;
        let overflow = false;

        for (let c = 0; c < columns.length; c++) {
            const col = columns[c];
            const level = new Level(work_area);

            let colHeight = 0;
            for (const w of col.windows) {
                level.windows.push(w);
                if (colHeight > 0) colHeight += spacing;
                colHeight += w.height;
                level.width = Math.max(level.width, w.width);
            }
            level.height = colHeight;

            if (level.height > work_area.height) {
                overflow = true;
            }

            level.y = (work_area.height - level.height) / 2 + work_area.y;

            if (totalWidth + level.width + spacing > work_area.width && c > 0) {
                overflow = true;
            }

            if (c > 0) totalWidth += spacing;
            totalWidth += level.width;

            levels.push(level);
        }

        const startX = Math.max(work_area.x, (work_area.width - totalWidth) / 2 + work_area.x);
        const levelCount = levels.length;
        const centerColIndex = (levelCount - 1) / 2;

        let xPos = startX;
        for (let colIdx = 0; colIdx < levelCount; colIdx++) {
            const level = levels[colIdx];
            level.x = xPos;

            let alignMode = 'center';
            if (levelCount > 1) {
                if (colIdx < centerColIndex) {
                    alignMode = 'right';
                } else if (colIdx > centerColIndex) {
                    alignMode = 'left';
                }
            }

            let totalColHeight = 0;
            for (const win of level.windows) {
                totalColHeight += win.height;
            }
            totalColHeight += (level.windows.length - 1) * spacing;

            let yPos = Math.max(work_area.y, (work_area.height - totalColHeight) / 2 + work_area.y);

            for (const win of level.windows) {
                if (alignMode === 'left') {
                    win.targetX = xPos;
                } else if (alignMode === 'right') {
                    win.targetX = xPos + level.width - win.width;
                } else {
                    win.targetX = xPos + (level.width - win.width) / 2;
                }
                win.targetY = yPos;
                yPos += win.height + spacing;
            }

            xPos += level.width + spacing;
        }

        return {
            x: startX,
            y: work_area.y,
            overflow: overflow,
            vertical: true,
            levels: levels,
            windows: windows,
        };
    }

    _simpleCenteredColumn(windows, work_area, spacing) {
        let totalHeight = 0;
        let maxWidth = 0;
        for (const w of windows) {
            if (totalHeight > 0) totalHeight += spacing;
            totalHeight += w.height;
            maxWidth = Math.max(maxWidth, w.width);
        }

        if (totalHeight > work_area.height && windows.length === 2) {
            const totalWidth = windows[0].width + spacing + windows[1].width;
            const startX = Math.max(work_area.x, (work_area.width - totalWidth) / 2 + work_area.x);

            const levels = [];
            let xPos = startX;

            for (const w of windows) {
                const level = new Level(work_area);
                level.windows.push(w);
                level.width = w.width;
                level.height = w.height;
                level.x = xPos;
                level.y = Math.max(work_area.y, (work_area.height - w.height) / 2 + work_area.y);

                w.targetX = level.x;
                w.targetY = level.y;

                levels.push(level);
                xPos += w.width + spacing;
            }

            const overflow = totalWidth > work_area.width;

            return {
                x: startX,
                y: work_area.y,
                overflow: overflow,
                vertical: true,
                levels: levels,
                windows: windows,
            };
        }

        const level = new Level(work_area);
        for (const w of windows) {
            level.windows.push(w);
        }

        level.width = maxWidth;
        level.height = totalHeight;
        level.x = Math.max(work_area.x, (work_area.width - maxWidth) / 2 + work_area.x);
        level.y = Math.max(work_area.y, (work_area.height - totalHeight) / 2 + work_area.y);

        let yPos = level.y;
        for (const w of level.windows) {
            w.targetX = level.x + (maxWidth - w.width) / 2;
            w.targetY = yPos;
            yPos += w.height + spacing;
        }

        const overflow = totalHeight > work_area.height || maxWidth > work_area.width;

        return {
            x: level.x,
            y: level.y,
            overflow: overflow,
            vertical: true,
            levels: [level],
            windows: windows,
        };
    }

    _horizontalShelves(windows, work_area, spacing) {
        if (windows.length <= 2) {
            return this._simpleCenteredRow(windows, work_area, spacing);
        }
        const {rows: numRows, windowsPerRow} = this._calculateOptimalGrid(windows, work_area);

        const levels = [];
        let windowIndex = 0;
        let totalHeight = 0;
        let overflow = false;

        for (let r = 0; r < numRows; r++) {
            const level = new Level(work_area);
            const windowsInThisRow = windowsPerRow[r];

            for (let i = 0; i < windowsInThisRow && windowIndex < windows.length; i++) {
                const w = windows[windowIndex++];
                if (level.width + w.width + (level.width > 0 ? spacing : 0) > work_area.width) {
                    overflow = true;
                }

                level.windows.push(w);
                if (level.width > 0) level.width += spacing;
                level.width += w.width;
                level.height = Math.max(level.height, w.height);
            }

            level.x = Math.max(work_area.x, (work_area.width - level.width) / 2 + work_area.x);
            if (totalHeight + level.height + spacing > work_area.height && r > 0) {
                overflow = true;
            }

            if (r > 0) totalHeight += spacing;
            totalHeight += level.height;

            levels.push(level);
        }

        const y = Math.max(work_area.y, (work_area.height - totalHeight) / 2 + work_area.y);

        let levelY = y;
        for (const level of levels) {
            level.y = levelY;
            let xPos = level.x;
            for (const w of level.windows) {
                w.targetX = xPos;
                w.targetY = levelY + (level.height - w.height) / 2;
                xPos += w.width + spacing;
            }
            levelY += level.height + spacing;
        }

        return {
            x: work_area.x,
            y: y,
            overflow: overflow,
            vertical: false,
            levels: levels,
            windows: windows,
        };
    }

    // Force windows into an explicit shape instead of the auto-chosen grid (drag/keyboard/pin).
    _placeByShape(windows, work_area, spacing, shape, vertical) {
        const groups = [];
        let idx = 0;
        for (const count of shape) {
            const g = [];
            for (let i = 0; i < count && idx < windows.length; i++) g.push(windows[idx++]);
            groups.push(g);
        }

        const levels = [];
        let overflow = false;

        if (!vertical) {
            let totalHeight = 0;
            for (let r = 0; r < groups.length; r++) {
                const level = new Level(work_area);
                for (const w of groups[r]) {
                    level.windows.push(w);
                    if (level.width > 0) level.width += spacing;
                    level.width += w.width;
                    level.height = Math.max(level.height, w.height);
                }
                if (level.width > work_area.width) overflow = true;
                level.x = Math.max(work_area.x, (work_area.width - level.width) / 2 + work_area.x);
                if (r > 0) totalHeight += spacing;
                totalHeight += level.height;
                levels.push(level);
            }
            if (totalHeight > work_area.height) overflow = true;

            const y = Math.max(work_area.y, (work_area.height - totalHeight) / 2 + work_area.y);
            let levelY = y;
            for (const level of levels) {
                level.y = levelY;
                let xPos = level.x;
                for (const w of level.windows) {
                    w.targetX = xPos;
                    w.targetY = levelY + (level.height - w.height) / 2;
                    xPos += w.width + spacing;
                }
                levelY += level.height + spacing;
            }
            return {x: work_area.x, y, overflow, vertical: false, levels, windows};
        }

        let totalWidth = 0;
        for (let c = 0; c < groups.length; c++) {
            const level = new Level(work_area);
            for (const w of groups[c]) {
                level.windows.push(w);
                if (level.height > 0) level.height += spacing;
                level.height += w.height;
                level.width = Math.max(level.width, w.width);
            }
            if (level.height > work_area.height) overflow = true;
            if (c > 0) totalWidth += spacing;
            totalWidth += level.width;
            levels.push(level);
        }
        if (totalWidth > work_area.width) overflow = true;

        const x = Math.max(work_area.x, (work_area.width - totalWidth) / 2 + work_area.x);
        let levelX = x;
        for (const level of levels) {
            level.x = levelX;
            const colHeight = level.windows.reduce(
                (s, w, i) => s + w.height + (i > 0 ? spacing : 0),
                0
            );
            let yPos = Math.max(work_area.y, (work_area.height - colHeight) / 2 + work_area.y);
            for (const w of level.windows) {
                w.targetX = levelX + (level.width - w.width) / 2;
                w.targetY = yPos;
                yPos += w.height + spacing;
            }
            levelX += level.width + spacing;
        }
        return {x, y: work_area.y, overflow, vertical: true, levels, windows};
    }

    _simpleCenteredRow(windows, work_area, spacing) {
        const level = new Level(work_area);
        let totalWidth = 0;
        let maxHeight = 0;

        for (const w of windows) {
            if (totalWidth > 0) totalWidth += spacing;
            totalWidth += w.width;
            maxHeight = Math.max(maxHeight, w.height);
            level.windows.push(w);
        }

        level.width = totalWidth;
        level.height = maxHeight;
        level.x = Math.max(work_area.x, (work_area.width - totalWidth) / 2 + work_area.x);

        const y = Math.max(work_area.y, (work_area.height - maxHeight) / 2 + work_area.y);
        level.y = y;

        let xPos = level.x;
        for (const w of level.windows) {
            w.targetX = xPos;
            w.targetY = y + (maxHeight - w.height) / 2;
            xPos += w.width + spacing;
        }

        return {
            x: work_area.x,
            y: y,
            overflow: totalWidth > work_area.width || maxHeight > work_area.height,
            vertical: false,
            levels: [level],
            windows: windows,
        };
    }

    _calculateOptimalGrid(windows, work_area) {
        const windowCount = windows.length;
        if (windowCount <= 0) return {rows: 0, windowsPerRow: []};
        if (windowCount === 1) return {rows: 1, windowsPerRow: [1]};
        if (windowCount === 2) return {rows: 1, windowsPerRow: [2]};

        const spacing = constants.WINDOW_SPACING;
        const workspaceAspect = work_area.width / work_area.height;

        let bestRows = 1;
        let bestScore = Infinity;
        let bestOverflow = true; // Start assuming everything overflows

        for (let rows = 1; rows <= windowCount; rows++) {
            const cols = Math.ceil(windowCount / rows);

            const windowsPerRow = new Array(rows).fill(0);
            const basePerRow = Math.floor(windowCount / rows);
            let remainder = windowCount % rows;

            for (let r = 0; r < rows; r++) windowsPerRow[r] = basePerRow;

            if (remainder > 0) {
                const centerIndex = Math.floor(rows / 2);
                let left = centerIndex;
                let right = centerIndex;

                while (remainder > 0) {
                    if (left >= 0 && left < rows) {
                        windowsPerRow[left]++;
                        remainder--;
                    }
                    if (remainder > 0 && right !== left && right >= 0 && right < rows) {
                        windowsPerRow[right]++;
                        remainder--;
                    }
                    left--;
                    right++;
                }
            }

            let totalHeight = 0;
            let maxRowWidth = 0;
            let windowIndex = 0;
            let currentRowHeight = 0;
            let currentRowWidth = 0;
            let overflow = false;

            for (let r = 0; r < rows; r++) {
                currentRowHeight = 0;
                currentRowWidth = 0;
                const count = windowsPerRow[r];

                for (let i = 0; i < count; i++) {
                    if (windowIndex < windows.length) {
                        const w = windows[windowIndex++];
                        currentRowWidth += w.width + (currentRowWidth > 0 ? spacing : 0);
                        currentRowHeight = Math.max(currentRowHeight, w.height);
                    }
                }

                if (currentRowWidth > work_area.width + 5) overflow = true;
                maxRowWidth = Math.max(maxRowWidth, currentRowWidth);

                totalHeight += currentRowHeight + (r > 0 ? spacing : 0);
            }

            if (totalHeight > work_area.height + 5) overflow = true;

            const layoutWidth = maxRowWidth;
            const layoutHeight = totalHeight;
            const layoutAspect = layoutWidth / layoutHeight;
            const aspectDiff = Math.abs(layoutAspect - workspaceAspect);
            const emptySpaces = rows * cols - windowCount;
            // Heavily penalize overflow
            const score = aspectDiff + emptySpaces * 0.3 + (overflow ? 1000 : 0);

            if (!overflow && bestOverflow) {
                bestScore = score;
                bestRows = rows;
                bestOverflow = false;
            } else if (overflow === bestOverflow) {
                if (score < bestScore) {
                    bestScore = score;
                    bestRows = rows;
                }
            }
        }

        const windowsPerRow = new Array(bestRows).fill(0);
        const basePerRow = Math.floor(windowCount / bestRows);
        let remainder = windowCount % bestRows;

        for (let r = 0; r < bestRows; r++) windowsPerRow[r] = basePerRow;

        if (remainder > 0) {
            const centerIndex = Math.floor(bestRows / 2);
            let left = centerIndex;
            let right = centerIndex;

            while (remainder > 0) {
                if (left >= 0 && left < bestRows) {
                    windowsPerRow[left]++;
                    remainder--;
                }
                if (remainder > 0 && right !== left && right >= 0 && right < bestRows) {
                    windowsPerRow[right]++;
                    remainder--;
                }
                left--;
                right++;
            }
        }

        return {rows: bestRows, windowsPerRow};
    }

    _getWorkingInfo(
        workspace,
        window,
        _monitor,
        excludeFromTiling = false,
        projectedWindows = null
    ) {
        let current_monitor = _monitor;
        if (current_monitor === undefined) current_monitor = window.get_monitor();

        let meta_windows =
            projectedWindows !== null
                ? [...projectedWindows]
                : this._windowingManager.getMonitorWorkspaceWindows(workspace, current_monitor);

        meta_windows = meta_windows.filter(w => !this._windowingManager.isExcluded(w));

        meta_windows = meta_windows.filter(w => !ShellState.get(w, 'pendingInQueue'));

        if (window && excludeFromTiling) {
            const windowId = window.get_id();
            meta_windows = meta_windows.filter(w => w.get_id() !== windowId);
        }

        if (this.isDragging && this.dragRemainingSpace && window) {
            const draggedId = window.get_id();
            meta_windows = meta_windows.filter(w => w.get_id() !== draggedId);
        }

        let edgeTiledWindows = [];
        if (this._edgeTilingManager) {
            edgeTiledWindows = this._edgeTilingManager.getEdgeTiledWindows(
                workspace,
                current_monitor
            );
        }

        const edgeTiledIds = edgeTiledWindows.map(s => s.window.get_id());
        const nonEdgeTiledMetaWindows = meta_windows.filter(
            w => !edgeTiledIds.includes(w.get_id())
        );

        const windowsForSwaps =
            edgeTiledWindows.length > 0 ? nonEdgeTiledMetaWindows : meta_windows;

        for (const win of meta_windows) {
            if (this._windowingManager.isMaximizedOrFullscreen(win)) return false;
        }

        const _windows = this.windowsToDescriptors(
            windowsForSwaps,
            current_monitor,
            window,
            projectedWindows !== null
        );

        this.applySwaps(workspace, _windows);
        this.applyTmp(_windows);

        // Not persisted into the swaps: an aborted drag must not leave a reorder behind.
        if (this._dragLayoutHint) {
            const order = this._dragLayoutHint.order;
            _windows.sort((a, b) => {
                const ia = order.indexOf(a.id);
                const ib = order.indexOf(b.id);
                return (ia === -1 ? Infinity : ia) - (ib === -1 ? Infinity : ib);
            });
        }

        const windows = [];
        for (const w of _windows) windows.push(this.getMask(w));

        const work_area = this._clampedWorkArea(workspace, current_monitor);
        if (!work_area) return false;

        return {
            monitor: current_monitor,
            meta_windows: meta_windows,
            windows: windows,
            work_area: work_area,
        };
    }

    _drawTile(
        workspace,
        monitor,
        tile_info,
        work_area,
        meta_windows,
        dryRun = false,
        slotsOut = null,
        bounds = null
    ) {
        let levelOffset = tile_info.vertical ? tile_info.x : tile_info.y;
        for (const level of tile_info.levels) {
            const orientation = tile_info.vertical ? 'vertical' : 'horizontal';
            const axis = tile_info.vertical ? 'x' : 'y';
            Logger.log(
                `Drawing ${orientation} level at ${axis}=${levelOffset}, width=${level.width}, height=${level.height}`
            );
            levelOffset +=
                (tile_info.vertical ? level.width : level.height) + constants.WINDOW_SPACING;
        }

        const windowsById = new Map(meta_windows.map(window => [window.get_id(), window]));
        const plannedSlots = enumerateTileSlots(
            tile_info,
            work_area,
            constants.WINDOW_SPACING,
            bounds
        );

        for (const {descriptor, rect: slot} of plannedSlots) {
            if (!dryRun) {
                Logger.log(
                    `Window ${descriptor.id} target: ${slot.x},${slot.y} (${slot.width}x${slot.height})`
                );
            }

            const window = descriptor.metaWindow ?? windowsById.get(descriptor.id);
            if (window) {
                MosaicModel.setSlot(window, slot, workspace, monitor);
                if (slotsOut) slotsOut.set(window.get_id(), slot);
            }

            descriptor.draw(
                meta_windows,
                slot.x,
                slot.y,
                this.masks,
                this.isDragging,
                this._drawingManager,
                dryRun
            );
        }
    }

    _animateTileLayout(
        workspace,
        monitor,
        tile_info,
        work_area,
        meta_windows,
        draggedWindow = null,
        slotsOut = null
    ) {
        // Nothing below can place a window without the manager, so let _drawTile do it.
        if (!this._animationsManager) return false;

        const resizingWindowId = this._animationsManager.getResizingWindowId();
        const pendingMiniIds = new Set(
            (this._pendingMiniatureWindows ?? []).map(p => p.window.get_id())
        );

        const windowLayouts = [];
        // Windows this pass places but must not touch: pending miniatures (createMiniature owns
        // their visual animation) and whatever is under the grab (the cursor owns its position).
        // A first placement sibling still needs to know they're there to compute a slide-in
        // direction against, so animateReTiling sees them without animating them.
        const miniLayouts = [];
        const windowsById = new Map(meta_windows.map(window => [window.get_id(), window]));
        const plannedSlots = enumerateTileSlots(tile_info, work_area, constants.WINDOW_SPACING);

        for (const {descriptor, orientation, rect: slot} of plannedSlots) {
            const window = windowsById.get(descriptor.id);
            if (!window) continue;

            const windowId = window.get_id();
            if (ShellState.get(window, IS_MINIATURE)) {
                // Do NOT move_frame for miniatures (Mutter may reject).
                const sc = ShellState.get(window, MINIATURE_SCALE) ?? 1;
                const extL = ShellState.get(window, MINIATURE_EXT_LEFT) ?? 0;
                const extT = ShellState.get(window, MINIATURE_EXT_TOP) ?? 0;
                placeMiniatureAt(window, slot.x, slot.y, {
                    animate: true,
                    duration: constants.ANIMATION_DURATION_MS,
                });
                // MosaicLayoutStrategy reads MosaicModel for the overview slot, so keep it in sync.
                MosaicModel.setSlot(window, slot, workspace, monitor);
                if (slotsOut) slotsOut.set(windowId, slot);
                const sizeLabel = orientation === 'V' ? 'slotSize' : 'size';
                Logger.log(
                    `[MINIATURE] animateTile ${orientation} ${windowId}: target=(${slot.x},${slot.y}) scale=${sc.toFixed(4)} extLeft=${extL} extTop=${extT} ${sizeLabel}=${slot.width}x${slot.height}`
                );
                continue;
            }

            if (descriptor.id === resizingWindowId) {
                window.move_frame(false, slot.x, slot.y);
                continue;
            }

            MosaicModel.setSlot(window, slot, workspace, monitor);
            if (slotsOut) slotsOut.set(windowId, slot);

            const heldKind = pendingMiniIds.has(windowId)
                ? 'pending-mini'
                : windowId === this._grabbedWindowId
                  ? 'grabbed'
                  : null;
            if (heldKind) {
                // Pending miniatures own their visual animation, while Mutter owns a grabbed
                // window's position. Both still participate in entrance-direction planning.
                miniLayouts.push({window, rect: slot});
                Logger.log(
                    `[LAYOUT] ${orientation} ${heldKind} ${windowId}: slot=(${slot.x},${slot.y}) size=${slot.width}x${slot.height}`
                );
            } else {
                Logger.log(
                    `[LAYOUT] ${orientation} window ${windowId}: target=(${slot.x},${slot.y}) size=${slot.width}x${slot.height}`
                );
                windowLayouts.push({window, rect: slot});
            }
        }

        const needsPostMapCommit = windowLayouts.some(({window}) =>
            ShellState.get(window, 'pendingFirstPlacement')
        );
        this._animationsManager.animateReTiling(windowLayouts, draggedWindow, miniLayouts);

        // Release workspace lock after signals from move_resize have likely fired.
        // We use a safe delay matching the animation duration.
        if (this._extension && this._extension.windowHandler) {
            if (this._extension.timeoutRegistry) {
                this._extension.timeoutRegistry.add(
                    constants.ANIMATION_DURATION_MS + 100,
                    () => {
                        // A just-mapped Wayland client can ignore the first placement
                        // request while committing its initial buffer. Reapply the
                        // authoritative model once map/entrance handling has settled.
                        if (needsPostMapCommit)
                            this._extension.mosaicRenderer?.flushToWindows(workspace, monitor);
                        this._extension.windowHandler.unlockWorkspace(workspace);
                    },
                    'unlockWorkspace'
                );
            } else {
                // No registry, so unlock immediately (extension is likely disabling)
                this._extension.windowHandler.unlockWorkspace(workspace);
            }
        }

        return true;
    }

    // Re-apply mosaic from scratch with smart-resize + miniaturization. Used on
    // extension enable, since tileWorkspaceWindows's overflow path needs a
    // "newly added" reference window and can't handle this.
    enforceWorkspaceFit(workspace, monitor) {
        if (!workspace || workspace.index() < 0) return;

        const workArea = this._clampedWorkArea(workspace, monitor);
        if (!workArea || workArea.width <= 0 || workArea.height <= 0) return;

        const allWindows = this._windowingManager
            .getMonitorWorkspaceWindows(workspace, monitor)
            .filter(
                w =>
                    !this._windowingManager.isExcluded(w) &&
                    !this._windowingManager.isMaximizedOrFullscreen(w) &&
                    !this._extension?.edgeTilingManager?.isEdgeTiled?.(w)
            );

        if (allWindows.length === 0) return;

        // Pick the most recently focused as the protected "newcomer". Without one,
        // every window is an equal miniaturization candidate, which is jarring on re-enable.
        const tabList = global.display.get_tab_list(Meta.TabList.NORMAL, workspace);
        const reference =
            tabList.find(w => allWindows.some(aw => aw.get_id() === w.get_id())) ?? allWindows[0];
        const others = allWindows.filter(w => w.get_id() !== reference.get_id());

        const resizeResult = this.tryFitWithResize(
            reference,
            others,
            workArea,
            workspace,
            reference
        );

        if (resizeResult?.success) {
            this.runSmartResizeTile(workspace, {
                monitor,
                pendingWindows: resizeResult.pendingWindows,
            });
        } else {
            // Couldn't smart-resize to fit, so degrade to oversized tiling rather than crash.
            this.tileWorkspaceWindows(workspace, null, monitor, true);
        }
    }

    // Releases a lock acquired by tileWorkspaceWindows for paths that bail out
    // before reaching _animateTileLayout (which normally owns the deferred unlock).
    _unlockWorkspaceEarlyReturn(workspace) {
        if (this._extension && this._extension.windowHandler) {
            this._extension.windowHandler.unlockWorkspace(workspace);
        }
    }

    _clearLayoutSelectionState() {
        this._positionSnapshot = null;
        this._restoreAnchor = null;
        this._movementIgnoredWindowIds = null;
        this._topologyIgnoredWindowIds = null;
    }

    tileWorkspaceWindows(
        workspace,
        reference_meta_window,
        _monitor,
        keep_oversized_windows,
        excludeFromTiling = false,
        dryRun = false,
        isRecursive = false
    ) {
        if (!workspace || workspace.index() < 0) {
            Logger.log(
                `tileWorkspaceWindows: Invalid workspace (index=${workspace?.index?.() ?? 'null'}) - skipping`
            );
            return {overflow: false, layout: null};
        }

        // Callers that remember a monitor to retile later can land here after it was
        // unplugged, and mutter asserts on a stale index instead of answering empty.
        const monitorIsGone =
            _monitor !== null &&
            _monitor !== undefined &&
            (_monitor < 0 || _monitor >= global.display.get_n_monitors());
        if (monitorIsGone) {
            Logger.log(
                `tileWorkspaceWindows: Monitor ${_monitor} no longer exists; skipping tiling`
            );
            return {overflow: false, layout: null};
        }

        Logger.log(
            `tileWorkspaceWindows: Starting for workspace ${workspace.index()} (isRecursive=${isRecursive})`
        );

        if (!isRecursive && !dryRun) {
            this.destroyMasks();
        }

        // LOCK: Prevent spurious overflow detection during tiling shifts
        if (this._extension && this._extension.windowHandler) {
            this._extension.windowHandler.lockWorkspace(workspace);
        }

        if (_monitor === null || _monitor === undefined) {
            if (!reference_meta_window) {
                const nMonitors = global.display.get_n_monitors();
                if (nMonitors > 1) {
                    Logger.log(
                        `Auto-tiling workspace ${workspace.index()} across ${nMonitors} monitors`
                    );
                }
                for (let m = 0; m < nMonitors; m++) {
                    this.tileWorkspaceWindows(
                        workspace,
                        null,
                        m,
                        keep_oversized_windows,
                        excludeFromTiling,
                        dryRun,
                        true
                    );
                }

                // UNLOCK: The recursive calls will handle their own monitor-specific locks,
                // but we need to ensure the final state is unlocked after a safe delay.
                if (this._extension && this._extension.windowHandler) {
                    if (this._extension.timeoutRegistry) {
                        this._extension.timeoutRegistry.add(
                            constants.ANIMATION_DURATION_MS + 50,
                            () => {
                                this._extension.windowHandler.unlockWorkspace(workspace);
                            },
                            'unlockWorkspaceRecursive'
                        );
                    } else {
                        // No registry, so unlock immediately (extension is likely disabling)
                        this._extension.windowHandler.unlockWorkspace(workspace);
                    }
                }
                return {overflow: false, layout: null};
            } else {
                _monitor = reference_meta_window.get_monitor();
            }
        }

        if (this._windowingManager) {
            this._windowingManager.invalidateWindowsCache();
        }

        const working_info = this._getWorkingInfo(
            workspace,
            reference_meta_window,
            _monitor,
            excludeFromTiling
        );
        if (!working_info) {
            this._unlockWorkspaceEarlyReturn(workspace);
            return {overflow: false, layout: null};
        }
        let meta_windows = working_info.meta_windows;
        const windows = working_info.windows;
        let work_area = working_info.work_area;
        const monitor = working_info.monitor;

        const workspace_windows = this._windowingManager.getMonitorWorkspaceWindows(
            workspace,
            monitor
        );

        let edgeTiledWindows = [];
        if (this._edgeTilingManager) {
            edgeTiledWindows = this._edgeTilingManager.getEdgeTiledWindows(workspace, monitor);
            Logger.log(`tileWorkspaceWindows: Found ${edgeTiledWindows.length} edge-tiled windows`);
        }

        if (edgeTiledWindows.length > 0) {
            Logger.log(`Found ${edgeTiledWindows.length} edge-tiled window(s)`);

            // Check if we have 2 half-tiles (left + right = fully occupied)
            const zones = edgeTiledWindows.map(w => w.zone);
            Logger.log(`Edge tile zones detected: [${zones.join(', ')}]`);
            const hasLeftFull = zones.includes(TileZone.LEFT_FULL);
            const hasRightFull = zones.includes(TileZone.RIGHT_FULL);
            const hasLeftQuarters = zones.some(
                z => z === TileZone.TOP_LEFT || z === TileZone.BOTTOM_LEFT
            );
            const hasRightQuarters = zones.some(
                z => z === TileZone.TOP_RIGHT || z === TileZone.BOTTOM_RIGHT
            );

            Logger.log(
                `Zone check: leftFull=${hasLeftFull}, rightFull=${hasRightFull}, leftQuarters=${hasLeftQuarters}, rightQuarters=${hasRightQuarters}`
            );

            if ((hasLeftFull || hasLeftQuarters) && (hasRightFull || hasRightQuarters)) {
                // During a drag only the preview may move; touching frames would fight the grab.
                if (this.isDragging) {
                    Logger.log('Both sides edge-tiled - deferring overflow until drag ends');
                    this._unlockWorkspaceEarlyReturn(workspace);
                    return {overflow: false, layout: null}; // Let preview show but don't move windows
                }

                Logger.log('Both sides edge-tiled - workspace fully occupied');

                // GUARD: Only trigger mass expulsion if the change was caused by an edge-tiled window (completing the wall)
                // If a normal window is added to a full workspace, ONLY expel that window.
                const edgeTiledIds = edgeTiledWindows.map(w => w.window.get_id());
                const isReferenceEdgeTiled =
                    reference_meta_window && edgeTiledIds.includes(reference_meta_window.get_id());

                const nonEdgeTiledMeta = this._edgeTilingManager.getNonEdgeTiledWindows(
                    workspace,
                    monitor
                );

                // Move non-edge-tiled windows to new workspace
                for (const window of nonEdgeTiledMeta) {
                    const isRef =
                        reference_meta_window && window.get_id() === reference_meta_window.get_id();

                    // Expel if:
                    // 1. It's the reference window (the newcomer trying to squeeze in)
                    // 2. OR the reference window IS an edge tile (meaning we just closed the wall on existing windows)
                    if (isRef || isReferenceEdgeTiled) {
                        if (
                            !this._windowingManager.isExcluded(window) &&
                            !this._windowingManager.isMaximizedOrFullscreen(window)
                        ) {
                            Logger.log(
                                `Expelling non-edge-tiled window ${window.get_id()} (RefEdgeTiled=${isReferenceEdgeTiled}, IsRef=${isRef})`
                            );
                            this._windowingManager
                                .moveOversizedWindow(window)
                                .catch(e =>
                                    Logger.error(
                                        `Overflow expel failed for ${window.get_id()}: ${e}`
                                    )
                                );
                        }
                    }
                }

                this._unlockWorkspaceEarlyReturn(workspace);
                return {overflow: false, layout: null}; // Don't tile, edge-tiled windows stay in place
            }

            const remainingSpace = this._edgeTilingManager.calculateRemainingSpace(
                workspace,
                monitor
            );
            const edgeTiledIds = edgeTiledWindows.map(s => s.window.get_id());
            const nonEdgeTiledCount = workspace_windows.filter(
                w => !edgeTiledIds.includes(w.get_id())
            ).length;
            if (this.dragRemainingSpace) {
                Logger.log(
                    `Reusing drag remaining space: x=${this.dragRemainingSpace.x}, w=${this.dragRemainingSpace.width}`
                );
                work_area = this.dragRemainingSpace;
            } else {
                Logger.log(
                    `Remaining space: x=${remainingSpace.x}, y=${remainingSpace.y}, w=${remainingSpace.width}, h=${remainingSpace.height}`
                );
                Logger.log(
                    `Total workspace windows: ${workspace_windows.length}, Non-edge-tiled: ${nonEdgeTiledCount}`
                );

                meta_windows = meta_windows.filter(w => !edgeTiledIds.includes(w.get_id()));
                Logger.log(`After filtering edge-tiled: ${meta_windows.length} windows to tile`);

                // Sacred windows (maximized/fullscreen) never get touched by the mosaic.
                const beforeMaxFilter = meta_windows.length;
                meta_windows = meta_windows.filter(
                    w => !this._windowingManager.isMaximizedOrFullscreen(w)
                );
                if (meta_windows.length < beforeMaxFilter) {
                    Logger.log(
                        `Filtered ${beforeMaxFilter - meta_windows.length} maximized/fullscreen (sacred) windows`
                    );
                }

                // Set work_area to remaining space for tiling calculations
                work_area = remainingSpace;

                // If no non-edge-tiled windows, nothing to tile
                if (meta_windows.length === 0) {
                    Logger.log('No non-edge-tiled windows to tile');
                    this._unlockWorkspaceEarlyReturn(workspace);
                    return {overflow: false, layout: null};
                }
            }
        }

        // Only reset if not already populated (to survive recursive calls from tryFitWithResize)
        if (!this._pendingMiniatureWindows) {
            this._pendingMiniatureWindows = [];
        }

        // Pre-apply mini sizes so the initial _tile sees the correct footprint.
        // Without this, pendingMiniature windows still have their full frame size,
        // which causes spurious overflow and fires the no-ref overflow block as a
        // second independent miniaturizer alongside tryFitWithResize.
        for (const pm of this._pendingMiniatureWindows) {
            if (!pm.miniSize) continue;
            const desc = windows.find(d => d.id === pm.window.get_id());
            if (desc) {
                desc.width = pm.miniSize.width;
                desc.height = pm.miniSize.height;
            }
        }

        // Computed slots from this pass, returned to the caller so it can find
        // miniature positions without depending on MosaicModel lookups.
        const computedSlots = new Map();

        const tileArea =
            this.isDragging && this.dragRemainingSpace ? this.dragRemainingSpace : work_area;

        // Pull a just-restored window back toward its old miniature slot. The restore
        // path tiles with a null reference, so find the flagged window among these.
        this._restoreAnchor = null;
        for (const w of meta_windows) {
            const rc = ShellState.get(w, 'restoreAnchorCenter');
            if (rc) {
                this._restoreAnchor = {id: w.get_id(), cx: rc.cx, cy: rc.cy};
                break;
            }
        }

        this._positionSnapshot = new Map();
        this._movementIgnoredWindowIds = new Set();
        this._topologyIgnoredWindowIds = new Set();
        const pendingMiniatureIds = new Set(
            (this._pendingMiniatureWindows ?? []).map(pending => pending.window.get_id())
        );
        for (const w of meta_windows) {
            const id = w.get_id();
            const committedSlot = MosaicModel.slotFor(w);
            let f = committedSlot ?? w.get_frame_rect();

            // Spawn coordinates and a slot committed on another monitor are not
            // user-visible layout choices. Let the entrant find its best slot while
            // measuring movement only for windows already in this mosaic.
            const centerX = f.x + f.width / 2;
            const centerY = f.y + f.height / 2;
            const slotOutsideTileArea =
                committedSlot &&
                (centerX < tileArea.x - constants.ANIMATION_DIFF_THRESHOLD ||
                    centerX > tileArea.x + tileArea.width + constants.ANIMATION_DIFF_THRESHOLD ||
                    centerY < tileArea.y - constants.ANIMATION_DIFF_THRESHOLD ||
                    centerY > tileArea.y + tileArea.height + constants.ANIMATION_DIFF_THRESHOLD);
            const hasStaleTopology =
                this._isArrivalPending(w) ||
                ShellState.get(w, 'pendingFirstPlacement') ||
                ShellState.get(w, 'monitorPlacementTarget') !== undefined ||
                ShellState.get(w, 'monitorRebalanceInProgress') ||
                ShellState.get(w, 'movedByOverflow') ||
                slotOutsideTileArea;
            if (hasStaleTopology) {
                this._movementIgnoredWindowIds.add(id);
                this._topologyIgnoredWindowIds.add(id);
                if (slotOutsideTileArea) f = w.get_frame_rect();
            }

            // Its old and new centers describe different-sized states, not a
            // meaningful move. Keep it in topology comparisons so it remains on
            // the same side of its neighbors, but omit raw displacement.
            if (pendingMiniatureIds.has(id) || ShellState.get(w, PENDING_MINIATURE))
                this._movementIgnoredWindowIds.add(id);

            this._positionSnapshot.set(id, {
                cx: f.x + f.width / 2,
                cy: f.y + f.height / 2,
            });
        }

        // The restore anchor has its own proximity metric after topology, so omit
        // it from ordinary movement scoring and avoid counting the same preference twice.
        if (this._restoreAnchor) this._movementIgnoredWindowIds.add(this._restoreAnchor.id);

        // Zero-displacement bias makes stability scoring revert explicit drag order; suppress once.
        if (this._skipStabilityForNextTile) {
            this._skipStabilityForNextTile = false;
            this._clearLayoutSelectionState();
        }

        // Honor a pinned composition only if it still matches the current window count.
        // A count change (window opened/closed) invalidates it, handing control back to
        // the default auto-layout.
        this._activePinnedShape = null;
        const pin = this._pinnedComposition.get(workspace);
        if (pin) {
            if (pin.count === windows.length) this._activePinnedShape = pin.shape;
            else this._pinnedComposition.delete(workspace);
        }

        let tile_info = this._tile(windows, tileArea, dryRun);
        this._activePinnedShape = null;
        let overflow = requiresOverflowHandling(tile_info.overflow, workspace_windows.length);

        if (workspace_windows.length > 1) {
            for (const window of workspace_windows)
                if (this._windowingManager.isMaximizedOrFullscreen(window)) overflow = true;
        }

        if (dryRun) {
            this._clearLayoutSelectionState();
            this._unlockWorkspaceEarlyReturn(workspace);
            return {overflow, layout: this._cachedTileResult?.windows || null};
        }

        // Block expulsion if edge-tiled (except non-edge ref); defer if dragging.
        const hasEdgeTiledWindows = edgeTiledWindows && edgeTiledWindows.length > 0;
        const referenceIsEdgeTiled =
            reference_meta_window &&
            edgeTiledWindows?.some(s => s.window.get_id() === reference_meta_window.get_id());
        const canOverflow = !hasEdgeTiledWindows || !referenceIsEdgeTiled;

        let referenceOverflowSkipped = false;
        if (
            overflow &&
            !keep_oversized_windows &&
            reference_meta_window &&
            canOverflow &&
            !this.isDragging
        ) {
            // SAFETY: Only overflow windows whose arrival is still being placed.
            // This prevents incorrectly expelling existing windows during resize retiling
            const isNewlyAdded = this._isArrivalPending(reference_meta_window);

            if (!isNewlyAdded && !ShellState.get(reference_meta_window, 'isRestoringSacred')) {
                Logger.log(
                    `Skipping overflow for ${reference_meta_window.get_id()} - not a new window`
                );
                referenceOverflowSkipped = true;
            } else if (
                ShellState.get(reference_meta_window, 'isSmartResizing') ||
                ShellState.get(reference_meta_window, 'isRestoringSacred')
            ) {
                Logger.log(
                    `Skipping overflow for ${reference_meta_window.get_id()} - smart resize/sacred restore in progress`
                );

                // FORCE RESIZE ATTEMPT IF NEEDED
                // If it's a sacred return, we MUST try to fit it, even if it means squishing everyone.
                if (ShellState.get(reference_meta_window, 'isRestoringSacred')) {
                    const workArea = this.getUsableWorkArea(workspace, monitor);
                    // windows here are descriptors; re-fetch MetaWindows for tryFitWithResize
                    const realExisting = this._windowingManager
                        .getMonitorWorkspaceWindows(workspace, monitor)
                        .filter(
                            w =>
                                w.get_id() !== reference_meta_window.get_id() &&
                                !this._windowingManager.isExcluded(w)
                        );

                    // Only try resize if we haven't already (to avoid loops)
                    if (!ShellState.get(reference_meta_window, 'isSmartResizing')) {
                        Logger.log('Triggering Smart Resize for returning sacred window');
                        const resizeResult = this.tryFitWithResize(
                            reference_meta_window,
                            realExisting,
                            workArea,
                            workspace
                        );
                        if (!resizeResult?.success) {
                            Logger.log('Smart resize could not fit sacred window');
                            this._clearLayoutSelectionState();
                            this._unlockWorkspaceEarlyReturn(workspace);
                            return {overflow: true, layout: null};
                        }
                        // Use the tile_info from tryFitWithResize (computed with miniature sizes)
                        tile_info = resizeResult.tileInfo;
                        // Preserve any pending miniatures discovered during this resize pass
                        if (resizeResult.pendingWindows?.length > 0) {
                            this._pendingMiniatureWindows = resizeResult.pendingWindows;
                        }
                    }
                }
            } else {
                // Match by descriptor id, since descriptor.index drifts after edge-tiled/sacred windows are filtered.
                const id = reference_meta_window.get_id();
                const _windows = windows;
                for (let i = 0; i < _windows.length; i++) {
                    if (_windows[i].id === id) {
                        _windows.splice(i, 1);
                        break;
                    }
                }
                this._windowingManager
                    .moveOversizedWindow(reference_meta_window)
                    .catch(e => Logger.error(`Overflow move failed for ref window: ${e}`));
                tile_info = this._tile(_windows, tileArea);
            }
        }

        // An edge preview already knows where the reference is going (the tile), so it can never be
        // the one ejected; miniaturizing the rest is the entire point of the preview. Any other drag
        // has no such destination, so leave the mosaic alone until the drop.
        const canMiniaturize = this.isDragging
            ? !!this.dragRemainingSpace && this._dragMiniaturizationAllowed
            : !reference_meta_window || referenceOverflowSkipped;

        // Nothing to eject (no reference, or its expulsion was skipped), so try
        // miniaturizing candidates to reclaim space instead of painting overflow.
        if (overflow && canMiniaturize && this._extension?.miniatureManager) {
            const focusedId = global.display.focus_window?.get_id();
            const resizingId = this._animationsManager?.getResizingWindowId();
            const mru = this._windowingManager.getMRUOrder(workspace);

            const overflowCandidates = orderWindowsByMru(
                meta_windows.filter(
                    w =>
                        !ShellState.get(w, IS_MINIATURE) &&
                        w.get_id() !== focusedId &&
                        w.get_id() !== resizingId &&
                        w.get_id() !== (this._restoringWindowId ?? null) &&
                        w.get_id() !== (reference_meta_window?.get_id() ?? null) &&
                        !this._windowingManager.isMaximizedOrFullscreen(w)
                ),
                mru,
                {mostRecentFirst: false}
            );

            let overflowResolved = false;

            // Accumulate mini sizes across iterations so multiple windows can stack to resolve overflow.
            const cumulativeSim = new Map(
                meta_windows.map(w => {
                    if (ShellState.get(w, IS_MINIATURE)) {
                        const ms = getMiniatureSize(w);
                        const f = w.get_frame_rect();
                        return [
                            w.get_id(),
                            ms
                                ? {width: ms.width, height: ms.height}
                                : {width: f.width, height: f.height},
                        ];
                    }
                    const f = w.get_frame_rect();
                    return [w.get_id(), {width: f.width, height: f.height}];
                })
            );
            const pendingMinis = [];

            for (const candidate of overflowCandidates) {
                const frame = candidate.get_frame_rect();
                // Scale from current frame so the visual fills the slot.
                const scale =
                    constants.MINIATURE_TARGET_SIZE_PX / Math.max(frame.width, frame.height);
                const miniW = Math.round(frame.width * scale);
                const miniH = Math.round(frame.height * scale);

                cumulativeSim.set(candidate.get_id(), {width: miniW, height: miniH});
                pendingMinis.push({candidate, frame, miniW, miniH});

                const simSizes = [...cumulativeSim.entries()].map(([id, s]) => ({
                    id,
                    width: s.width,
                    height: s.height,
                }));

                if (!this._tile(simSizes, tileArea, true).overflow) {
                    Logger.log(
                        `[OVERFLOW] No-ref overflow resolved by miniaturizing ${pendingMinis.length} window(s)`
                    );
                    if (!this._pendingMiniatureWindows) this._pendingMiniatureWindows = [];
                    for (const {candidate: c, frame: f, miniW: mW, miniH: mH} of pendingMinis) {
                        Logger.log(`[OVERFLOW] Miniaturizing ${c.get_id()} (${mW}x${mH})`);
                        this._pendingMiniatureWindows.push({
                            window: c,
                            preSize: {x: f.x, y: f.y, width: f.width, height: f.height},
                        });
                        ShellState.set(c, PENDING_MINIATURE, true);
                        const desc = windows.find(w => w.id === c.get_id());
                        if (desc) {
                            desc.width = mW;
                            desc.height = mH;
                        }
                    }
                    this.invalidateLayoutCache();
                    tile_info = this._tile(windows, tileArea);
                    overflow = tile_info.overflow;
                    overflowResolved = true;
                    break;
                }
            }

            if (!overflowResolved)
                Logger.log(
                    '[OVERFLOW] No-ref overflow: miniaturizing all candidates still overflows, applying clamped positions'
                );
        }

        this._clearLayoutSelectionState();
        if (tile_info?.levels?.length > 0) this._rememberLayoutHistory(tile_info);
        Logger.log(
            `Drawing tiles - isDragging: ${this.isDragging}, using tileArea: x=${tileArea.x}, y=${tileArea.y}`
        );

        let animationsHandledPositioning = false;
        if (!this.isDragging && tile_info && tile_info.levels && tile_info.levels.length > 0) {
            const draggedWindow = reference_meta_window;

            // Allow animation for windows returning from excluded state
            if (
                reference_meta_window &&
                ShellState.get(reference_meta_window, 'justReturnedFromExclusion')
            ) {
                Logger.log(
                    `Allowing animation for returning excluded window ${reference_meta_window.get_id()}`
                );
                ShellState.remove(reference_meta_window, 'justReturnedFromExclusion');
            }

            animationsHandledPositioning = this._animateTileLayout(
                workspace,
                monitor,
                tile_info,
                tileArea,
                meta_windows,
                draggedWindow,
                computedSlots
            );
        }

        if (!animationsHandledPositioning) {
            Logger.log('Animations did not handle positioning, calling drawTile');
            this._drawTile(
                workspace,
                monitor,
                tile_info,
                tileArea,
                meta_windows,
                false,
                computedSlots,
                work_area
            );
            // _animateTileLayout owns the deferred unlock; since it didn't run,
            // release the lock now that positioning is done synchronously.
            this._unlockWorkspaceEarlyReturn(workspace);
        } else {
            Logger.log('Animations handled positioning, skipping drawTile');
        }

        // Create miniatures for pending windows. Top-level only, not inside recursive tryFitWithResize.
        if (!isRecursive) {
            // Consume any restore anchor so it can't bleed into a later retile.
            for (const w of meta_windows) {
                if (ShellState.get(w, 'restoreAnchorCenter'))
                    ShellState.remove(w, 'restoreAnchorCenter');
            }

            if (this._pendingMiniatureWindows?.length > 0 && this._extension?.miniatureManager) {
                for (const {window: win, preSize} of this._pendingMiniatureWindows) {
                    // Skip if already miniaturized, since an earlier tile call may have created it first.
                    if (ShellState.get(win, IS_MINIATURE)) continue;
                    const slot = computedSlots.get(win.get_id());
                    Logger.log(
                        `[MINIATURE] Creating ${win.get_id()} with stored preSize=${preSize?.width}x${preSize?.height}`
                    );
                    if (slot) {
                        Logger.log(
                            `[MINIATURE] Creating miniature for window ${win.get_id()} at slot (${slot.x},${slot.y}) size (${slot.width}x${slot.height})`
                        );
                        this._extension.miniatureManager.createMiniature(win, slot, preSize);
                    } else {
                        Logger.warn(
                            `[MINIATURE] No computed slot for window ${win.get_id()}, using workArea`
                        );
                        this._extension.miniatureManager.createMiniature(
                            win,
                            {
                                x: tileArea.x,
                                y: tileArea.y,
                                width: tileArea.width,
                                height: tileArea.height,
                            },
                            preSize
                        );
                    }
                }
            }
        }

        const result = {
            overflow,
            layout: this._cachedTileResult?.windows || null,
            computedSlots,
        };
        this._extension?.mosaicRenderer?.publishToOverview(workspace, monitor);

        if (!isRecursive) {
            for (const {window: win} of this._pendingMiniatureWindows ?? [])
                ShellState.remove(win, PENDING_MINIATURE);
            this._pendingMiniatureWindows = [];
        }

        return result;
    }

    canFitWindow(
        window,
        workspace,
        monitor,
        relaxed = false,
        overrideSize = null,
        projectedWindows = null
    ) {
        Logger.log(
            `canFitWindow: Checking if window can fit in workspace ${workspace.index()} (relaxed=${relaxed})`
        );

        // Excluded windows (Always on Top, Sticky) coexist with sacred windows and don't participating in tiling.
        if (this._windowingManager.isExcluded(window)) {
            Logger.log('canFitWindow: Window is excluded - always fits (not tiled)');
            return true;
        }

        const isIncomingSacred = this._windowingManager.isMaximizedOrFullscreen(window);
        const currentWindows = (
            projectedWindows ??
            this._windowingManager.getMonitorWorkspaceWindows(workspace, monitor)
        ).filter(w => !ShellState.get(w, 'pendingInQueue'));
        const otherWindows = currentWindows.filter(w => w.get_id() !== window.get_id());
        const hasExistingSacred = otherWindows.some(w =>
            this._windowingManager.isMaximizedOrFullscreen(w)
        );

        // Symmetric Isolation Policy:
        // 1. Sacred windows (Incoming) ONLY fit in workspaces with 0 other windows.
        if (isIncomingSacred) {
            if (otherWindows.length > 0) {
                Logger.log(
                    `canFitWindow: Incoming window is sacred but workspace ${workspace.index()} is occupied - blocked`
                );
                return false;
            }
            Logger.log('canFitWindow: Window is sacred and workspace is empty - fits');
            return true;
        }

        // 2. Normal windows (Incoming) ONLY fit in workspaces with 0 sacred windows.
        if (hasExistingSacred) {
            Logger.log(
                `canFitWindow: Incoming normal window blocked - workspace ${workspace.index()} has a sacred window`
            );
            return false;
        }

        const working_info = this._getWorkingInfo(
            workspace,
            window,
            monitor,
            false,
            projectedWindows
        );
        if (!working_info) {
            Logger.log('canFitWindow: No working info - cannot fit');
            return false;
        }

        for (const existing_window of working_info.meta_windows) {
            if (this._windowingManager.isMaximizedOrFullscreen(existing_window)) {
                Logger.log('canFitWindow: Workspace has maximized window - cannot fit');
                return false;
            }
        }

        let edgeTiledWindows = [];
        if (this._edgeTilingManager) {
            edgeTiledWindows = this._edgeTilingManager.getEdgeTiledWindows(workspace, monitor);
        }

        let availableSpace = working_info.work_area;
        const newWindowId = window.get_id();

        if (edgeTiledWindows.length > 0) {
            const otherEdgeTiles = edgeTiledWindows.filter(
                w => w.window.get_id() !== window.get_id()
            );
            const zones = otherEdgeTiles.map(w => w.zone);
            const hasLeftFull = zones.includes(TileZone.LEFT_FULL);
            const hasRightFull = zones.includes(TileZone.RIGHT_FULL);
            const hasLeftQuarters = zones.some(
                z => z === TileZone.TOP_LEFT || z === TileZone.BOTTOM_LEFT
            );
            const hasRightQuarters = zones.some(
                z => z === TileZone.TOP_RIGHT || z === TileZone.BOTTOM_RIGHT
            );

            if ((hasLeftFull || hasLeftQuarters) && (hasRightFull || hasRightQuarters)) {
                Logger.log('canFitWindow: Workspace fully occupied by edge tiles - cannot fit');
                return false;
            }

            availableSpace = this._edgeTilingManager.calculateRemainingSpace(workspace, monitor);
            Logger.log(
                `canFitWindow: Using remaining space after snap: ${availableSpace.width}x${availableSpace.height}`
            );
        }

        const edgeTiledIds = edgeTiledWindows.map(s => s.window.get_id());

        const windows = working_info.windows.filter(w => !edgeTiledIds.includes(w.id));

        // targetSmartResizeSize takes priority: preferredSize holds the pre-resize original, which would falsely report overflow.
        const workspaceWindows = workspace.list_windows();

        for (const w of windows) {
            const realWindow = workspaceWindows.find(win => win.get_id() === w.id);
            if (realWindow && !ShellState.get(realWindow, IS_MINIATURE)) {
                const restoredSize = ShellState.get(realWindow, 'targetRestoredSize');
                const smartResizeSize = ShellState.get(realWindow, 'targetSmartResizeSize');
                const isConstrained = ShellState.get(realWindow, 'isConstrainedByMosaic');
                const preferredSize =
                    ShellState.get(realWindow, 'preferredSize') ||
                    ShellState.get(realWindow, 'openingSize');

                if (restoredSize) {
                    w.width = restoredSize.width;
                    w.height = restoredSize.height;
                } else if (smartResizeSize) {
                    // Resize still pending, target not reached yet
                    w.width = smartResizeSize.width;
                    w.height = smartResizeSize.height;
                } else if (isConstrained) {
                    // targetSmartResizeSize gets cleared once the frame settles, so use the
                    // actual frame here instead of preferredSize.
                    const realFrame = realWindow.get_frame_rect();
                    w.width = realFrame.width;
                    w.height = realFrame.height;
                } else if (preferredSize) {
                    w.width = preferredSize.width;
                    w.height = preferredSize.height;
                } else {
                    const realFrame = realWindow.get_frame_rect();
                    w.width = realFrame.width;
                    w.height = realFrame.height;
                }
            }
        }

        const windowAlreadyInWorkspace = windows.some(w => w.id === newWindowId);

        if (!windowAlreadyInWorkspace) {
            let realWidth, realHeight;

            if (overrideSize) {
                realWidth = overrideSize.width;
                realHeight = overrideSize.height;
                Logger.log(`canFitWindow: Using overrideSize ${realWidth}x${realHeight}`);
            } else {
                const smartResizeSize = ShellState.get(window, 'targetSmartResizeSize');
                const preferredSize =
                    ShellState.get(window, 'preferredSize') ||
                    ShellState.get(window, 'openingSize');
                const frame = window.get_frame_rect();

                if (smartResizeSize) {
                    realWidth = smartResizeSize.width;
                    realHeight = smartResizeSize.height;
                } else {
                    // Use the actual frame dimensions instead of a hardcoded fallback
                    realWidth = preferredSize ? preferredSize.width : frame.width;
                    realHeight = preferredSize ? preferredSize.height : frame.height;
                }
            }

            Logger.log(
                `canFitWindow: Window not in workspace - adding with size ${realWidth}x${realHeight} (preferred=${!!overrideSize || !!ShellState.get(window, 'preferredSize')})`
            );

            const newWindowDescriptor = new WindowDescriptor(window, windows.length);
            newWindowDescriptor.width = realWidth;
            newWindowDescriptor.height = realHeight;

            windows.push(newWindowDescriptor);
        }

        if (windowAlreadyInWorkspace) {
            Logger.log('canFitWindow: Window already in workspace - checking current layout');
            const existingDescriptor = windows.find(w => w.id === newWindowId);
            if (existingDescriptor) {
                if (overrideSize) {
                    existingDescriptor.width = overrideSize.width;
                    existingDescriptor.height = overrideSize.height;
                } else {
                    // Skip constrained windows since their frame was already set above;
                    // preferredSize is pre-constraint and would wrongly report overflow.
                    const preferred = ShellState.get(window, 'preferredSize');
                    const isConstrained = ShellState.get(window, 'isConstrainedByMosaic');
                    const isMaximized = window.is_maximized();
                    if (preferred && !window.is_fullscreen() && !isMaximized && !isConstrained) {
                        existingDescriptor.width = preferred.width;
                        existingDescriptor.height = preferred.height;
                    }
                }
            }
        }

        const layout = this._tile(windows, availableSpace, relaxed);
        const layoutWindowIds = new Set(working_info.meta_windows.map(w => w.get_id()));
        layoutWindowIds.add(newWindowId);
        const requiresOverflow = requiresOverflowHandling(layout.overflow, layoutWindowIds.size);
        if (layout.overflow && !requiresOverflow) {
            Logger.log(
                `canFitWindow: Ignoring size overflow for solo window ${newWindowId}; no sibling needs another workspace`
            );
        }
        return !requiresOverflow;
    }

    restorePreferredSize(window) {
        if (!window) return;

        const preferredSize =
            ShellState.get(window, 'preferredSize') || ShellState.get(window, 'openingSize');

        if (preferredSize) {
            Logger.log(
                `restorePreferredSize: Restoring window ${window.get_id()} to ${preferredSize.width}x${preferredSize.height}`
            );
            const frame = window.get_frame_rect();
            window.move_resize_frame(
                false,
                frame.x,
                frame.y,
                preferredSize.width,
                preferredSize.height
            );

            ShellState.set(window, 'isSmartResizing', false);
            ShellState.set(window, 'targetSmartResizeSize', null);
        } else {
            Logger.log(`restorePreferredSize: No preferred size found for ${window.get_id()}`);
        }
    }

    saveOriginalSize(window) {
        if (!ShellState.has(window, 'originalSize')) {
            const frame = window.get_frame_rect();
            ShellState.set(window, 'originalSize', {width: frame.width, height: frame.height});
            Logger.log(
                `saveOriginalSize: Saved ${window.get_id()} as ${frame.width}x${frame.height}`
            );
        }
    }

    // TARGET size the window wants to be
    savePreferredSize(window) {
        // Smart resize sets preferredSize itself in commitResizes().
        if (
            ShellState.get(window, 'isSmartResizing') ||
            ShellState.get(window, 'isReverseSmartResizing')
        ) {
            Logger.log(
                `savePreferredSize: Skipping for ${window.get_id()} - during (reverse) smart resize`
            );
            return;
        }

        // Smart resize already set preferredSize; don't override it.
        if (ShellState.get(window, 'isConstrainedByMosaic')) {
            Logger.log(
                `savePreferredSize: Skipping for ${window.get_id()} - already constrained by smart resize`
            );
            return;
        }

        // Sacred windows are managed by maximizedUndoInfo.
        if (this._windowingManager.isMaximizedOrFullscreen(window)) {
            Logger.log(
                `savePreferredSize: Skipping for ${window.get_id()} - sacred window (managed by maximizedUndoInfo)`
            );
            return;
        }

        // Skip windows that opened maximized and haven't settled yet
        if (ShellState.get(window, 'openedMaximized')) {
            Logger.log(
                `savePreferredSize: Skipping for ${window.get_id()} - opened maximized, not yet settled`
            );
            return;
        }

        const frame = window.get_frame_rect();
        const size = {width: frame.width, height: frame.height};
        // Defense-in-depth: reject monitor-sized dimensions during transitions
        const workspace = window.get_workspace();
        const monitor = window.get_monitor();
        if (workspace && monitor !== null && monitor !== undefined) {
            const workArea = this._clampedWorkArea(workspace, monitor);
            if (workArea && size.width >= workArea.width && size.height >= workArea.height) {
                Logger.log(
                    `savePreferredSize: Rejected monitor-sized dimensions ${size.width}x${size.height} for ${window.get_id()}`
                );
                return;
            }
        }

        if (size && size.width > 10 && size.height > 10) {
            if (ShellState.get(window, 'isEnteringSacred')) {
                Logger.log(
                    `savePreferredSize: Save blocked by sacred transition flag for ${window.get_id()}`
                );
                return;
            }

            const current = ShellState.get(window, 'preferredSize');

            if (!current) {
                ShellState.set(window, 'preferredSize', size);
                Logger.log(
                    `savePreferredSize: [INITIAL] Window ${window.get_id()} set to ${size.width}x${size.height}`
                );
            } else {
                const isExpansion =
                    size.width > current.width + 5 || size.height > current.height + 5;
                const isContraction =
                    size.width < current.width - 5 || size.height < current.height - 5;
                const isSmallChange =
                    Math.abs(size.width - current.width) <= 2 &&
                    Math.abs(size.height - current.height) <= 2;

                if (isExpansion || isContraction) {
                    ShellState.set(window, 'preferredSize', size);
                    const label = isExpansion ? 'EXPANSION' : 'CONTRACTION';
                    Logger.log(
                        `savePreferredSize: [${label}] Window ${window.get_id()} updated ${current.width}x${current.height} -> ${size.width}x${size.height}`
                    );
                } else if (!isSmallChange) {
                    Logger.log(
                        `savePreferredSize: [SKIP] Window ${window.get_id()} size ${size.width}x${size.height} within threshold of ${current.width}x${current.height}`
                    );
                }
            }
        } else {
            Logger.log(
                `savePreferredSize: Could not determine valid preferred size for ${window.get_id()}`
            );
        }
    }

    clearPreferredSize(window) {
        if (ShellState.has(window, 'preferredSize')) {
            ShellState.remove(window, 'preferredSize');
            Logger.log(`clearPreferredSize: Removed ${window.get_id()}`);
        }
    }

    getPreferredSize(window) {
        return ShellState.get(window, 'preferredSize') || null;
    }

    // Mirrors tryFitWithResize's binary search + miniature-threshold heuristic. A plain
    // "fits at minimum size" check isn't enough, since Smart Resize's real pass also
    // re-miniaturizes anything landing below half its min/max range even if it
    // geometrically fits. A looser gate here just restores it and watches Smart Resize
    // mini it right back (visible as a blink).
    canRestoreMiniature(candidateMini, remainingWindows, workArea) {
        // A shrink request can't win against the pointer, so simulate the grabbed window as fixed
        const resizingWindowId = this._animationsManager?.getResizingWindowId();
        const isResizable = w =>
            w.get_id() !== resizingWindowId && w.allows_resize && w.allows_resize();
        const currentSizeOf = w => {
            if (w !== candidateMini && ShellState.get(w, IS_MINIATURE)) {
                const ms = getMiniatureSize(w);
                if (ms) return ms;
            }
            const pref = ShellState.get(w, 'preferredSize') || ShellState.get(w, 'openingSize');
            if (pref) return {width: pref.width, height: pref.height};
            const frame = w.get_frame_rect();
            return {width: frame.width, height: frame.height};
        };

        const descriptors = remainingWindows.map(w => {
            const current = currentSizeOf(w);
            const fixed = w !== candidateMini && ShellState.get(w, IS_MINIATURE);
            const resizable = !fixed && isResizable(w);
            const rawMin = resizable ? this.getWindowMinimumSize(w) : current;
            const min = {
                width: Math.min(rawMin.width, current.width),
                height: Math.min(rawMin.height, current.height),
            };
            return {window: w, current, min, resizable};
        });

        const sizeAt = (d, t) =>
            d.resizable
                ? {
                      width: Math.round(d.min.width + (d.current.width - d.min.width) * t),
                      height: Math.round(d.min.height + (d.current.height - d.min.height) * t),
                  }
                : d.current;

        const buildSim = t =>
            descriptors.map(d => {
                const size = sizeAt(d, t);
                return {id: d.window.get_id(), width: size.width, height: size.height};
            });

        const resizeGrabActive =
            resizingWindowId !== null &&
            remainingWindows.some(w => w.get_id() === resizingWindowId);
        const plan = planResizeFit({
            buildSizes: buildSim,
            overflows: simulated => this._tile(simulated, workArea, true).overflow,
            allowScaling: !resizeGrabActive,
            iterations: 12,
        });
        Logger.log(
            () =>
                `canRestoreMiniature: candidate=${candidateMini.get_id()}, sim=${buildSim(1.0)
                    .map(s => `${s.id}:${s.width}x${s.height}`)
                    .join(', ')}, plan=${plan.kind}`
        );
        if (plan.kind === 'natural') return true;

        // Mid-grab a shrink-assisted fit flaps: the next drag event overflows it
        // again and re-minis the window we just restored, so require a full-size fit
        if (plan.kind === 'scaling-blocked') {
            Logger.log(
                `canRestoreMiniature: resize grab active, keeping mini ${candidateMini.get_id()} until it fits at full size`
            );
            return false;
        }

        if (plan.kind === 'impossible') {
            Logger.log(
                `canRestoreMiniature: candidate=${candidateMini.get_id()} doesn't fit even at minimum sizes`
            );
            return false;
        }

        const candidateDesc = descriptors.find(d => d.window === candidateMini);
        const simAtLo = sizeAt(candidateDesc, plan.scale);
        const maxSize = this.getWindowMaximumSize(candidateMini);
        const thresholdW = (candidateDesc.min.width + (maxSize?.width || workArea.width)) / 2;
        const thresholdH = (candidateDesc.min.height + (maxSize?.height || workArea.height)) / 2;
        const wouldStayMini = simAtLo.width < thresholdW || simAtLo.height < thresholdH;

        Logger.log(
            `canRestoreMiniature: candidate=${candidateMini.get_id()} doesn't fit at preferred size, optimal scale=${plan.scale.toFixed(4)} → ${simAtLo.width}x${simAtLo.height} (threshold ${Math.round(thresholdW)}x${Math.round(thresholdH)}), wouldStayMini=${wouldStayMini}`
        );
        return !wouldStayMini;
    }

    tryRestoreWindowSizes(windows, workArea) {
        const shrunkWindows = [];
        for (const window of windows) {
            if (ShellState.get(window, IS_MINIATURE)) continue;
            const preferredSize = ShellState.get(window, 'preferredSize');
            if (!preferredSize) continue;

            const frame = window.get_frame_rect();
            const widthDiff = preferredSize.width - frame.width;
            const heightDiff = preferredSize.height - frame.height;

            Logger.log(
                `tryRestoreWindowSizes: Check ${window.get_id()}: frame=${frame.width}x${frame.height}, pref=${preferredSize.width}x${preferredSize.height}, diff=${widthDiff}x${heightDiff}`
            );

            // Window was shrunk if it's smaller than opening size (2px threshold for rounding)
            if (widthDiff > 2 || heightDiff > 2) {
                shrunkWindows.push({
                    window,
                    id: window.get_id(),
                    currentWidth: frame.width,
                    currentHeight: frame.height,
                    openingWidth: preferredSize.width,
                    openingHeight: preferredSize.height,
                    widthDeficit: Math.max(0, widthDiff),
                    heightDeficit: Math.max(0, heightDiff),
                });
            }
        }

        if (shrunkWindows.length === 0) {
            Logger.log(
                `tryRestoreWindowSizes: No shrunk windows to restore (0/${windows.length} windows had deficits > 2px)`
            );
            return false;
        }

        Logger.log(`tryRestoreWindowSizes: Found ${shrunkWindows.length} shrunk windows`);

        const totalWidthDeficit = shrunkWindows.reduce((sum, w) => sum + w.widthDeficit, 0);
        const totalHeightDeficit = shrunkWindows.reduce((sum, w) => sum + w.heightDeficit, 0);

        Logger.log(
            `tryRestoreWindowSizes: Total deficits: W=${totalWidthDeficit}px, H=${totalHeightDeficit}px`
        );

        if (totalWidthDeficit <= 0 && totalHeightDeficit <= 0) {
            Logger.log('tryRestoreWindowSizes: No deficit to fill');
            return false;
        }

        const result = this.findBestRestorationGain(windows, shrunkWindows, workArea);

        if (result) {
            const {gain: bestGain, layout: bestLayout} = result;
            // Success! Apply the restoration.
            Logger.log(
                `tryRestoreWindowSizes: Applying ${Math.round(bestGain * 100)}% restoration`
            );

            for (const sim of bestLayout) {
                const w = windows.find(win => win.get_id() === sim.id);
                if (w) {
                    if (ShellState.get(w, IS_MINIATURE)) continue;
                    ShellState.set(w, 'isReverseSmartResizing', true);

                    const frame = w.get_frame_rect();
                    this._animateResize(w, frame, sim.width, sim.height);
                    // Wayland hasn't acked the resize yet when the settle retile runs, so stash the target here.
                    ShellState.set(w, 'targetRestoredSize', {
                        width: sim.width,
                        height: sim.height,
                    });

                    const shrunk = shrunkWindows.find(sw => sw.id === w.get_id());
                    if (shrunk) {
                        // If fully restored (allow for small pixel rounding errors), remove constraint
                        if (
                            sim.width >= shrunk.openingWidth - 2 &&
                            sim.height >= shrunk.openingHeight - 2
                        ) {
                            Logger.log(`tryRestoreWindowSizes: Window ${sim.id} fully restored!`);
                            ShellState.set(w, 'isConstrainedByMosaic', false);
                            ShellState.set(w, 'targetSmartResizeSize', null);
                        } else {
                            // Still constrained, but update mask
                            this._setSmartResizeTarget(w, sim);
                        }
                    }
                }
            }
            return true;
        } else {
            Logger.log(
                'tryRestoreWindowSizes: Restoration would cause overflow even at 10% - waiting'
            );
            for (const w of windows) {
                ShellState.remove(w, 'isReverseSmartResizing');
            }
            return false;
        }
    }
    // get_work_area_for_monitor can overshoot physical bounds in some display setups.
    _clampedWorkArea(workspace, monitor) {
        const area = workspace.get_work_area_for_monitor(monitor);
        if (!area) return null;
        const geom = global.display.get_monitor_geometry(monitor);
        const maxW = geom.x + geom.width - area.x;
        const maxH = geom.y + geom.height - area.y;
        if (area.width <= maxW && area.height <= maxH) return area;
        return {
            x: area.x,
            y: area.y,
            width: Math.min(area.width, maxW),
            height: Math.min(area.height, maxH),
        };
    }

    getUsableWorkArea(workspace, monitor) {
        if (this._edgeTilingManager) {
            const edgeTiledWindows = this._edgeTilingManager.getEdgeTiledWindows(
                workspace,
                monitor
            );
            if (edgeTiledWindows.length > 0) {
                // If the workspace is fully occupied (left + right), return zero/empty rect
                const zones = edgeTiledWindows.map(w => w.zone);
                const hasLeft = zones.some(z =>
                    [TileZone.LEFT_FULL, TileZone.TOP_LEFT, TileZone.BOTTOM_LEFT].includes(z)
                );
                const hasRight = zones.some(z =>
                    [TileZone.RIGHT_FULL, TileZone.TOP_RIGHT, TileZone.BOTTOM_RIGHT].includes(z)
                );

                if (hasLeft && hasRight) {
                    return {x: 0, y: 0, width: 0, height: 0};
                }

                return this._edgeTilingManager.calculateRemainingSpace(workspace, monitor);
            }
        }
        return this._clampedWorkArea(workspace, monitor);
    }

    tryFitWithResize(newWindow, windows, workArea, workspace, focusedWindowOverride = null) {
        if (this._isSmartResizingBlocked) {
            Logger.log('[SMART RESIZE] tryFitWithResize BLOCKED by _isSmartResizingBlocked');
            return {success: false};
        }
        this._isSmartResizingBlocked = true;

        this._extension?.resizeHandler?.resetConstraintRebalanceCount();

        // Also exclude the window under an active manual resize grab, since focusedWindowOverride can point elsewhere.
        const resizingWindowId = this._animationsManager?.getResizingWindowId();

        try {
            const allResizable = [];
            const allWindows = [];
            const windowData = new Map();

            for (const w of [...windows, newWindow]) {
                if (allWindows.some(aw => aw.get_id() === w.get_id())) continue;

                // Skip destroyed windows, since get_frame_rect on a disposed MetaWindow segfaults libmutter.
                if (!isWindowAlive(w)) {
                    Logger.log(`[SMART RESIZE] Skipping destroyed window ${w?.get_id?.() ?? '?'}`);
                    continue;
                }

                // Already-miniaturized: include as non-resizable fixed participants so the simulation
                // accounts for the space they occupy. Must come before the uninitialized check, since
                // minis never get isConstrainedByMosaic (they skip that branch in drawTile) and
                // may lack preferredSize, so they'd otherwise get filtered out as uninitialized.
                if (ShellState.get(w, IS_MINIATURE)) {
                    const ms = getMiniatureSize(w);
                    if (ms) {
                        allWindows.push(w);
                        windowData.set(w.get_id(), {
                            window: w,
                            current: ms,
                            min: ms,
                            isResizable: false,
                        });
                    }
                    continue;
                }

                // Skip uninitialized windows, since unreliable geometry corrupts the binary search
                if (
                    w.get_id() !== newWindow.get_id() &&
                    !ShellState.get(w, 'preferredSize') &&
                    !ShellState.get(w, 'openingSize') &&
                    !ShellState.get(w, 'isConstrainedByMosaic')
                ) {
                    Logger.log(`[SMART RESIZE] Skipping uninitialized window ${w.get_id()}`);
                    continue;
                }

                allWindows.push(w);

                // Use preferred size as ceiling for deterministic binary search
                const preferred =
                    ShellState.get(w, 'preferredSize') || ShellState.get(w, 'openingSize');
                const current = preferred || this.getEffectiveWindowSize(w);
                const min = this.getWindowMinimumSize(w);
                const isResizable =
                    w.get_id() !== resizingWindowId && w.allows_resize && w.allows_resize();

                windowData.set(w.get_id(), {window: w, current, preferred, min, isResizable});
                if (isResizable) allResizable.push(w);
            }

            if (allResizable.length === 0) return {success: false};

            Logger.log(
                `[SMART RESIZE] tryFitWithResize: ${allWindows.length} windows (${allResizable.length} resizable), workArea: ${workArea.width}×${workArea.height}`
            );
            const mruForDiagnostics = this._windowingManager.getMRUOrder(workspace);
            for (const [id, d] of windowData) {
                Logger.log(
                    `[SMART RESIZE]   ${id}(${d.window.get_wm_class()}): current=${d.current.width}×${d.current.height}, min=${d.min.width}×${d.min.height}, resizable=${d.isResizable}, mruRank=${mruForDiagnostics.get(id) ?? '∞'}`
                );
            }

            // Interpolate between min and current sizes at factor t (1=current, 0=min)
            // If window is marked pendingMiniature, use its miniature size instead of current
            const buildSimulated = t =>
                allWindows.map(w => {
                    const d = windowData.get(w.get_id());
                    if (!d.isResizable)
                        return {
                            id: w.get_id(),
                            width: d.current.width,
                            height: d.current.height,
                        };

                    // If this window is pending miniature, use miniature size (not interpolated)
                    if (d.pendingMiniature && d.miniSize) {
                        Logger.log(
                            `[SMART RESIZE] buildSimulated: ${w.get_id()} using MINI SIZE ${d.miniSize.width}x${d.miniSize.height}`
                        );
                        return {
                            id: w.get_id(),
                            width: d.miniSize.width,
                            height: d.miniSize.height,
                        };
                    }

                    const effMinW = Math.min(d.min.width, d.current.width);
                    const effMinH = Math.min(d.min.height, d.current.height);
                    return {
                        id: w.get_id(),
                        width: Math.round(effMinW + (d.current.width - effMinW) * t),
                        height: Math.round(effMinH + (d.current.height - effMinH) * t),
                    };
                });

            const planCurrentFit = () =>
                planResizeFit({
                    buildSizes: buildSimulated,
                    overflows: simulated => this._tile(simulated, workArea, true).overflow,
                });

            let fitPlan = planCurrentFit();
            if (fitPlan.kind === 'natural') {
                Logger.log('[SMART RESIZE] Natural fit, no resize needed');
                return {success: true, tileInfo: null, pendingWindows: []};
            }

            if (fitPlan.kind === 'impossible') {
                Logger.log(
                    "[SMART RESIZE] Overflow inevitable, windows don't fit even at minimums"
                );

                const ext0 = this._extension;
                if (ext0?.miniatureManager) {
                    const focusedId0 = (
                        focusedWindowOverride ?? global.display.focus_window
                    )?.get_id();

                    // Higher MRU indexes are less recent, so sacrifice the window
                    // the user has ignored longest.
                    const mru = this._windowingManager.getMRUOrder(workspace);
                    const orderedWindows0 = orderWindowsByMru(allWindows, mru, {
                        mostRecentFirst: false,
                    });

                    for (const w of orderedWindows0) {
                        const d = windowData.get(w.get_id());
                        if (!d || d.pendingMiniature) continue;
                        if (
                            w.get_id() === focusedId0 ||
                            w.get_id() === resizingWindowId ||
                            this._isArrivalPending(w)
                        )
                            continue;
                        if (ShellState.get(w, IS_MINIATURE)) continue;
                        if (this._windowingManager.isMaximizedOrFullscreen(w)) continue;
                        if (!d.isResizable) continue;

                        const nonMiniCount = allWindows.filter(
                            aw =>
                                !ShellState.get(aw, IS_MINIATURE) &&
                                !windowData.get(aw.get_id())?.pendingMiniature
                        ).length;
                        if (nonMiniCount <= 1) break;

                        const frame = w.get_frame_rect();
                        // Scale from current frame so the visual fills the slot.
                        const scale =
                            constants.MINIATURE_TARGET_SIZE_PX /
                            Math.max(frame.width, frame.height);
                        d.pendingMiniature = true;
                        d.miniSize = {
                            width: Math.round(frame.width * scale),
                            height: Math.round(frame.height * scale),
                        };
                        d.pendingPreSize = {
                            x: frame.x,
                            y: frame.y,
                            width: frame.width,
                            height: frame.height,
                        };
                        Logger.log(
                            `[SMART RESIZE] ${w.get_id()}: miniaturizing to make room (${d.miniSize.width}x${d.miniSize.height})`
                        );

                        if (!this._tile(buildSimulated(0.0), workArea, true).overflow) break;
                    }
                }

                fitPlan = planCurrentFit();
                if (fitPlan.kind === 'impossible') {
                    Logger.log(
                        '[SMART RESIZE] Still overflow after miniaturization, applying overflow logic'
                    );
                    return {success: false, tileInfo: null, pendingWindows: []};
                }
            }

            let lo = fitPlan.scale;

            Logger.log(`[SMART RESIZE] Optimal scale factor: ${lo.toFixed(4)}`);

            const ext = this._extension;
            if (ext?.miniatureManager) {
                // focusedWindowOverride lets callers (e.g. mini-restore) treat a
                // specific window as the user-active one when Mutter's focus hasn't
                // shifted yet. Without it, restoring a miniature while focus sits on
                // the other window would exclude both, leaving no miniaturization candidate.
                const focusedId = (focusedWindowOverride ?? global.display.focus_window)?.get_id();

                const getMiniatureThreshold = w => {
                    const min = this.getWindowMinimumSize(w);
                    const maxSize = this.getWindowMaximumSize(w);
                    const effectiveMaxW = maxSize?.width || workArea.width;
                    const effectiveMaxH = maxSize?.height || workArea.height;
                    return {
                        thresholdW: (min.width + effectiveMaxW) / 2,
                        thresholdH: (min.height + effectiveMaxH) / 2,
                    };
                };

                const mru = this._windowingManager.getMRUOrder(workspace);

                for (let iter = 0; iter < allWindows.length; iter++) {
                    const candidates = buildSimulated(lo).filter(sim => {
                        const d = windowData.get(sim.id);
                        if (!d) return false;
                        if (d.pendingMiniature) return false;
                        if (
                            sim.id === focusedId ||
                            sim.id === resizingWindowId ||
                            this._isArrivalPending(d.window)
                        )
                            return false;
                        if (ShellState.get(d.window, IS_MINIATURE)) return false;
                        if (this._windowingManager.isMaximizedOrFullscreen(d.window)) return false;
                        const {thresholdW, thresholdH} = getMiniatureThreshold(d.window);
                        return sim.width < thresholdW || sim.height < thresholdH;
                    });

                    if (candidates.length === 0) break;

                    const [candidateWindow] = orderWindowsByMru(
                        candidates.map(sim => windowData.get(sim.id).window),
                        mru,
                        {mostRecentFirst: false}
                    );
                    const candidateData = windowData.get(candidateWindow.get_id());
                    const candidateSim = candidates.find(
                        sim => sim.id === candidateData.window.get_id()
                    );

                    // Guard 1: never miniaturize the last visible (non-miniature, non-pending) window
                    const nonMiniatureCount = allWindows.filter(
                        w =>
                            !ShellState.get(w, IS_MINIATURE) &&
                            !windowData.get(w.get_id())?.pendingMiniature
                    ).length;
                    if (nonMiniatureCount <= 1) {
                        Logger.log(
                            `[MINIATURE] Guard 1: refusing to miniaturize last non-miniature window ${candidateSim.id}`
                        );
                        break;
                    }

                    candidateData.pendingMiniature = true;
                    candidateData.miniatureTargetSlot = null;
                    Logger.log(
                        `[MINIATURE] Marking ${candidateSim.id}(${candidateData.window.get_wm_class()}) as PENDING miniature (will be created after layout)`
                    );

                    const frame4a = candidateData.window.get_frame_rect();
                    // Scale from current frame so the visual fills the slot.
                    const natural4a = candidateData.preferred || candidateData.current;
                    const scale =
                        constants.MINIATURE_TARGET_SIZE_PX /
                        Math.max(frame4a.width, frame4a.height);
                    const miniSize = {
                        width: Math.round(frame4a.width * scale),
                        height: Math.round(frame4a.height * scale),
                    };
                    candidateData.miniSize = miniSize;
                    candidateData.pendingPreSize = {
                        x: frame4a.x,
                        y: frame4a.y,
                        width: frame4a.width,
                        height: frame4a.height,
                    };
                    Logger.log(
                        `[MINIATURE] ${candidateSim.id} PENDING at frame=${frame4a.width}x${frame4a.height} restore=${natural4a.width}x${natural4a.height} → miniSize: ${miniSize.width}x${miniSize.height} scale: ${scale}`
                    );

                    // Do NOT remove from allWindows/allResizable yet, keep it for layout computation
                    // (the window will be treated as miniature-sized in buildSimulated)

                    if (allResizable.length === 0) break;

                    // Re-plan after changing a participant to miniature size.
                    // A natural fit locks lo at 1.0 so Step 4 applies preferred
                    // sizes and the non-mini siblings reclaim the freed space.
                    fitPlan = planCurrentFit();
                    if (fitPlan.kind === 'natural') {
                        lo = 1.0;
                        break;
                    }

                    if (fitPlan.kind === 'impossible') {
                        // Miniaturizing cannot make a previously feasible minimum
                        // layout worse. Preserve the old fallback (minimum scale)
                        // if a client changed constraints during the calculation.
                        Logger.warn(
                            '[SMART RESIZE] Constraints changed while planning; falling back to minimum sizes'
                        );
                        lo = 0;
                        break;
                    }
                    lo = fitPlan.scale;
                }
            }

            const finalSizes = buildSimulated(lo);
            const pendingWindows = [];
            const grownWindows = [];
            for (const sim of finalSizes) {
                const d = windowData.get(sim.id);
                if (!d.isResizable) continue;

                const w = d.window;
                const frame = w.get_frame_rect();

                // sim ≥ preferred means the algorithm decided this window can sit at
                // (or above) its preferred size. If the actual frame is smaller
                // (left over from a previous smart-resize we now have space to undo),
                // grow it back so siblings reclaim the freed space.
                if (sim.width >= d.current.width && sim.height >= d.current.height) {
                    if (frame.width < d.current.width - 2 || frame.height < d.current.height - 2) {
                        ShellState.set(w, 'isConstrainedByMosaic', false);
                        ShellState.set(w, 'targetSmartResizeSize', null);
                        ShellState.set(w, 'targetRestoredSize', {
                            width: d.current.width,
                            height: d.current.height,
                        });
                        this._animateResize(w, frame, d.current.width, d.current.height, true);
                        grownWindows.push(w);
                        Logger.log(
                            `[SMART RESIZE] ${sim.id}: grow back ${frame.width}×${frame.height} → ${d.current.width}×${d.current.height}`
                        );
                    }
                    continue;
                }

                if (!ShellState.has(w, 'preferredSize'))
                    ShellState.set(w, 'preferredSize', {
                        width: d.current.width,
                        height: d.current.height,
                    });
                ShellState.set(w, 'originalSize', {
                    width: d.current.width,
                    height: d.current.height,
                });
                ShellState.set(w, 'isConstrainedByMosaic', true);
                this._setSmartResizeTarget(w, sim);

                if (d.pendingMiniature) {
                    const storedPreSize = d.pendingPreSize || d.current;
                    pendingWindows.push({
                        window: w,
                        miniSize: d.miniSize,
                        preSize: storedPreSize,
                    });
                    Logger.log(
                        `[MINIATURE] ${w.get_id()} stored in pendingWindows: preSize=${storedPreSize.width}x${storedPreSize.height}, SKIPPING move_resize_frame (will be miniaturized)`
                    );
                    continue;
                }
                this._animateResize(w, frame, sim.width, sim.height, true);
                Logger.log(
                    `[SMART RESIZE] ${sim.id}: ${d.current.width}×${d.current.height} → ${sim.width}×${sim.height}`
                );
            }

            // Clear targetRestoredSize bridge after Wayland frame settles. Until
            // then WindowDescriptor reads this value instead of the stale frame.
            if (grownWindows.length > 0 && this._extension?._timeoutRegistry) {
                this._extension.timeoutRegistry.add(
                    constants.RESIZE_SETTLE_DELAY_MS,
                    () => {
                        for (const gw of grownWindows) {
                            ShellState.remove(gw, 'targetRestoredSize');
                        }
                        return false;
                    },
                    'tryFitWithResize_growSettle'
                );
            }

            const finalTileInfo = this._tile(windows, workArea);

            Logger.log(`[TRYFIT] Returning pendingWindows len=${pendingWindows.length}`);
            return {success: true, tileInfo: finalTileInfo, pendingWindows};
        } finally {
            this._isSmartResizingBlocked = false;
        }
    }

    // Re-run binary search with corrected minimums after client-side clamping detection.
    // Uses preferredSize (original pre-smart-resize) as ceiling for full interpolation range.
    rebalanceSmartResize(workspace, monitor) {
        if (this._isSmartResizingBlocked) {
            Logger.log('[SMART RESIZE] Rebalance blocked');
            return;
        }
        this._isSmartResizingBlocked = true;

        try {
            const workArea = this.getUsableWorkArea(workspace, monitor);
            const resizingWindowId = this._animationsManager?.getResizingWindowId();
            const allWindows = this._windowingManager
                .getMonitorWorkspaceWindows(workspace, monitor)
                .filter(
                    w =>
                        !ShellState.get(w, 'pendingInQueue') &&
                        !this._edgeTilingManager?.isEdgeTiled(w) &&
                        !this._windowingManager.isMaximizedOrFullscreen(w)
                );

            if (allWindows.length === 0) return;

            const windowData = new Map();
            const allResizable = [];

            for (const w of allWindows) {
                const preferred =
                    ShellState.get(w, 'preferredSize') || ShellState.get(w, 'originalSize');
                const current = preferred || this.getEffectiveWindowSize(w);
                const min = this.getWindowMinimumSize(w);
                // A shrink request can't win against the pointer, so the grabbed window is fixed
                const isResizable = w.get_id() !== resizingWindowId && w.allows_resize?.();

                windowData.set(w.get_id(), {window: w, current, min, isResizable});
                if (isResizable) allResizable.push(w);
            }

            if (allResizable.length === 0) return;

            Logger.log(
                `[SMART RESIZE] Rebalancing ${allWindows.length} windows, workArea: ${workArea.width}×${workArea.height}`
            );
            for (const [id, d] of windowData) {
                Logger.log(
                    `[SMART RESIZE]   Rebal ${id}: ceiling=${d.current.width}×${d.current.height}, min=${d.min.width}×${d.min.height}`
                );
            }

            const buildSimulated = t =>
                allWindows.map(w => {
                    const d = windowData.get(w.get_id());
                    if (!d.isResizable)
                        return {
                            id: w.get_id(),
                            width: d.current.width,
                            height: d.current.height,
                        };
                    const effMinW = Math.min(d.min.width, d.current.width);
                    const effMinH = Math.min(d.min.height, d.current.height);
                    return {
                        id: w.get_id(),
                        width: Math.round(effMinW + (d.current.width - effMinW) * t),
                        height: Math.round(effMinH + (d.current.height - effMinH) * t),
                    };
                });

            if (!this._tile(buildSimulated(1.0), workArea, true).overflow) {
                Logger.log('[SMART RESIZE] Rebalance: natural fit, restoring preferred sizes');
                for (const w of allWindows) {
                    const d = windowData.get(w.get_id());
                    if (!d.isResizable) continue;
                    const frame = w.get_frame_rect();
                    ShellState.set(w, 'isSmartResizing', true);
                    this._animateResize(w, frame, d.current.width, d.current.height, true);
                    ShellState.set(w, 'isSmartResizing', false);
                    ShellState.set(w, 'targetSmartResizeSize', null);
                    ShellState.set(w, 'isConstrainedByMosaic', false);
                }
                this.invalidateLayoutCache();
                this.tileWorkspaceWindows(workspace, null, monitor, true);
                return;
            }

            if (this._tile(buildSimulated(0.0), workArea, true).overflow) {
                Logger.log('[SMART RESIZE] Rebalance: overflow inevitable at corrected minimums');

                // Ghost mode already flags this during a live grab; the release path decides
                if (allWindows.some(w => w.get_id() === resizingWindowId)) {
                    Logger.log(
                        '[SMART RESIZE] Rebalance: resize grab active, deferring overflow to release'
                    );
                    return;
                }

                for (const w of allWindows) {
                    ShellState.set(w, 'targetSmartResizeSize', null);
                    ShellState.set(w, 'isConstrainedByMosaic', false);
                }

                const newest = allWindows.reduce((n, w) => {
                    const t1 = ShellState.get(w, 'addedTime') || 0;
                    const t2 = ShellState.get(n, 'addedTime') || 0;
                    return t1 > t2 ? w : n;
                }, allWindows[0]);

                Logger.log(`[SMART RESIZE] Overflowing newest window ${newest.get_id()}`);
                this._windowingManager
                    .moveOversizedWindow(newest)
                    .then(() => {
                        this.invalidateLayoutCache();
                        this.tileWorkspaceWindows(workspace, null, monitor, true);
                    })
                    .catch(e => Logger.error(`Rebalance overflow failed: ${e}`));
                return;
            }

            let lo = 0.0,
                hi = 1.0;
            for (let i = 0; i < 15; i++) {
                const mid = (lo + hi) / 2;
                if (!this._tile(buildSimulated(mid), workArea, true).overflow) lo = mid;
                else hi = mid;
            }

            Logger.log(`[SMART RESIZE] Rebalance scale factor: ${lo.toFixed(4)}`);

            const finalSizes = buildSimulated(lo);
            for (const sim of finalSizes) {
                const d = windowData.get(sim.id);
                if (!d.isResizable) continue;
                if (sim.width >= d.current.width && sim.height >= d.current.height) continue;

                const w = d.window;
                const frame = w.get_frame_rect();
                this._setSmartResizeTarget(w, sim);
                ShellState.set(w, 'isConstrainedByMosaic', true);

                this._animateResize(w, frame, sim.width, sim.height, true);
                Logger.log(`[SMART RESIZE] Rebal ${sim.id}: → ${sim.width}×${sim.height}`);
            }

            this.invalidateLayoutCache();
            // Save pending miniatures before recursive call (which resets the array)
            const savedPending = this._pendingMiniatureWindows;
            this.tileWorkspaceWindows(workspace, null, monitor, true);
            // Restore after recursive tiling completes
            this._pendingMiniatureWindows = savedPending;
        } finally {
            this._isSmartResizingBlocked = false;
        }
    }

    destroy() {
        this.destroyMasks();
        MosaicModel.clear();
        this._isSmartResizingBlocked = false;
        this._restoringWindowId = null;
        this._layoutHistory = null;
        this._clearLayoutSelectionState();
        this._lastLayoutHash = null;
        this._cachedTileResult = null;
        this._simulationOrderHints.clear();
        this._pendingMiniatureWindows = null;
        this._workspaceSwaps = null;
        this._pinnedComposition = null;
        this._activePinnedShape = null;
        this._edgeTilingManager = null;
        this._drawingManager = null;
        this._animationsManager = null;
        this._windowingManager = null;
        this._extension = null;
    }
}

class WindowDescriptor {
    constructor(meta_window, index) {
        const frame = meta_window.get_frame_rect();

        this.index = index;
        this.x = frame.x;
        this.y = frame.y;
        this.metaWindow = meta_window;

        // Miniature size takes first priority
        const miniSize = getMiniatureSize(meta_window);
        this.isMiniature = !!miniSize;
        if (miniSize) {
            this.width = miniSize.width;
            this.height = miniSize.height;
            Logger.log(
                `WindowDescriptor: Using miniatureSize ${this.width}x${this.height} for ${meta_window.get_id()}`
            );
        } else {
            // Use target dimensions if unmaximizing, as physical frame might still be maximized.
            const targetSize = ShellState.get(meta_window, 'targetRestoredSize');
            // Use smart resize target dims if move_resize_frame hasn't completed yet.
            const smartResizeSize = ShellState.get(meta_window, 'targetSmartResizeSize');

            if (targetSize) {
                this.width = targetSize.width;
                this.height = targetSize.height;
                Logger.log(
                    `WindowDescriptor: Using targetRestoredSize ${this.width}x${this.height} for ${meta_window.get_id()}`
                );
            } else if (smartResizeSize) {
                this.width = smartResizeSize.width;
                this.height = smartResizeSize.height;
                Logger.log(
                    `WindowDescriptor: Using targetSmartResizeSize ${this.width}x${this.height} for ${meta_window.get_id()}`
                );
            } else {
                // Use the actual frame dimensions instead of a hardcoded fallback
                this.width = frame.width > 0 ? frame.width : 1;
                this.height = frame.height > 0 ? frame.height : 1;
            }
        }

        this.id = meta_window.get_id();
    }

    draw(meta_windows, x, y, masks, isDragging, drawingManager, dryRun = false) {
        const window = meta_windows.find(w => w.get_id() === this.id);
        if (window) {
            // The layout cache was already updated in the caller.
            if (dryRun) return;

            const isMask = masks.has(this.id);

            // This descriptor already carries the mini's size, so moving the frame to it would
            // shrink the real window and createMiniature's scale would land on top of that.
            if (ShellState.get(window, PENDING_MINIATURE)) return;

            if (isDragging) {
                if (isMask) {
                    if (drawingManager) {
                        drawingManager.rect(x, y, this.width, this.height);
                    }
                } else {
                    const isMiniature = ShellState.get(window, IS_MINIATURE);
                    if (isMiniature) {
                        // Miniatures use actor transforms, since move_resize_frame would shrink the frame and compound the scale.
                        placeMiniatureAt(window, x, y, {
                            animate: true,
                            duration: constants.ANIMATION_DURATION_MS,
                        });
                    } else {
                        const currentRect = window.get_frame_rect();
                        const windowActor = window.get_compositor_private();
                        const currentScale =
                            windowActor && !windowActor.is_destroyed() ? windowActor.scale_x : 1;
                        const hasPreviewTransforms = Math.abs(currentScale - 1.0) > 0.01;

                        Logger.log(
                            `draw (drag): id=${this.id}, target=(${x},${y}), current=(${currentRect.x},${currentRect.y}), scale=${currentScale.toFixed(3)}`
                        );

                        if (hasPreviewTransforms && windowActor && !windowActor.is_destroyed()) {
                            // actor.x changes after move_resize_frame; read all state first.
                            const extLeft = currentRect.x - windowActor.x;
                            const extTop = currentRect.y - windowActor.y;
                            const [actorW, actorH] = windowActor.get_size();
                            const [cpx, cpy] = windowActor.get_pivot_point();
                            const visualX =
                                windowActor.x +
                                cpx * actorW * (1 - currentScale) +
                                windowActor.translation_x +
                                extLeft * currentScale;
                            const visualY =
                                windowActor.y +
                                cpy * actorH * (1 - currentScale) +
                                windowActor.translation_y +
                                extTop * currentScale;
                            ShellState.set(window, 'isConstrainedByMosaic', true);
                            window.move_resize_frame(false, x, y, this.width, this.height);
                            const actor_x_new = x - extLeft;
                            const actor_y_new = y - extTop;
                            const dw = actorW * (1 - currentScale);
                            const dh = actorH * (1 - currentScale);
                            const px =
                                dw > 0
                                    ? Math.max(
                                          0,
                                          Math.min(
                                              1,
                                              (visualX - actor_x_new - extLeft * currentScale) / dw
                                          )
                                      )
                                    : 0;
                            const py =
                                dh > 0
                                    ? Math.max(
                                          0,
                                          Math.min(
                                              1,
                                              (visualY - actor_y_new - extTop * currentScale) / dh
                                          )
                                      )
                                    : 0;
                            const startTx =
                                visualX - actor_x_new - px * dw - extLeft * currentScale;
                            const startTy = visualY - actor_y_new - py * dh - extTop * currentScale;
                            windowActor.set_pivot_point(px, py);
                            windowActor.remove_all_transitions();
                            windowActor.set_scale(currentScale, currentScale);
                            windowActor.set_translation(startTx, startTy, 0);
                            windowActor.ease({
                                scale_x: 1,
                                scale_y: 1,
                                translation_x: 0,
                                translation_y: 0,
                                opacity: 255,
                                duration: Math.ceil(
                                    constants.ANIMATION_DURATION_MS * getSlowDownFactor()
                                ),
                                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                            });
                        } else {
                            const positionChanged =
                                Math.abs(currentRect.x - x) > 5 || Math.abs(currentRect.y - y) > 5;
                            const sizeChanged =
                                Math.abs(currentRect.width - this.width) > 5 ||
                                Math.abs(currentRect.height - this.height) > 5;
                            if (positionChanged || sizeChanged) {
                                ShellState.set(window, 'isConstrainedByMosaic', true);
                                // Where the window really is, straight off the actor, since a
                                // half-finished ease leaves the frame at the previous target.
                                const visualX =
                                    windowActor && !windowActor.is_destroyed()
                                        ? windowActor.x + windowActor.translation_x
                                        : 0;
                                const visualY =
                                    windowActor && !windowActor.is_destroyed()
                                        ? windowActor.y + windowActor.translation_y
                                        : 0;
                                // A pure move lands on the actor synchronously (a resize doesn't), so
                                // after this the actor carries the position the window really got,
                                // which is not x,y when the target doesn't fit and mutter clamps it.
                                window.move_frame(false, x, y);
                                window.move_resize_frame(false, x, y, this.width, this.height);
                                if (windowActor && !windowActor.is_destroyed()) {
                                    const translateX = visualX - windowActor.x;
                                    const translateY = visualY - windowActor.y;
                                    windowActor.set_translation(translateX, translateY, 0);
                                    windowActor.ease({
                                        translation_x: 0,
                                        translation_y: 0,
                                        opacity: 255,
                                        duration: Math.ceil(
                                            constants.ANIMATION_DURATION_MS * getSlowDownFactor()
                                        ),
                                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                                    });
                                }
                            }
                        }
                    }
                }
            } else {
                const isMiniature = ShellState.get(window, IS_MINIATURE);
                if (isMiniature) {
                    // Do NOT move_frame for miniatures (Mutter may reject)
                    placeMiniatureAt(window, x, y);
                    Logger.log(
                        `[MINIATURE] draw ${window.get_id()}: target=(${x},${y}) size=${this.width}x${this.height}`
                    );
                } else {
                    ShellState.set(window, 'isConstrainedByMosaic', true);
                    window.move_resize_frame(false, x, y, this.width, this.height);
                    Logger.log(
                        `[LAYOUT] draw ${window.get_id()}: target=(${x},${y}) size=${this.width}x${this.height}`
                    );
                }
            }
        } else {
            Logger.warn(`Could not find window with ID ${this.id} for drawing`);
        }
    }
}

class Level {
    constructor(work_area) {
        this.x = 0;
        this.y = 0;
        this.width = 0;
        this.height = 0;
        this.windows = [];
        this.work_area = work_area;
    }
}

class Mask {
    constructor(window) {
        // window can be a MetaWindow or a WindowDescriptor
        this.id = window.id !== undefined ? `mask_${window.id}` : `mask_${window.get_id()}`;
        this.x = window.x;
        this.y = window.y;
        this.width = window.width;
        this.height = window.height;
    }
    draw(_, x, y, _masks, _isDragging, drawingManager) {
        if (drawingManager) {
            // Don't clear boxes here; destroyMasks() already did it once at the start of tiling.
            drawingManager.rect(x, y, this.width, this.height);
        }
    }
}
