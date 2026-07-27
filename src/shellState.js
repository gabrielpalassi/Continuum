// SPDX-License-Identifier: GPL-3.0-or-later
// Window-management behavior adapted from Mosaic WM
// by Cléo Menezes Jr. and contributors:
// https://github.com/CleoMenezesJr/MosaicWM
// Safe access and JavaScript-owned state for Shell-native objects

// WeakMap to store state associated with Meta.Window objects
// This avoids polluting native objects with custom properties
const windowStates = new WeakMap();

// get_compositor_private() can return a non-null actor that is already destroyed during
// signal delivery — calling get_frame_rect/move_resize_frame on it segfaults libmutter.
export function isWindowAlive(window) {
    if (!window) return false;
    try {
        const actor = window.get_compositor_private();
        return !!actor && !actor.is_destroyed();
    } catch (_error) {
        return false;
    }
}

// workspace.index() crashes if GNOME already removed this workspace, so check
// it's still in the manager's list instead of calling the native lookup.
export function isWorkspaceAlive(workspace, workspaceManager = global.workspace_manager) {
    if (!workspace) return false;
    try {
        for (let i = 0; i < workspaceManager.get_n_workspaces(); i++) {
            if (workspaceManager.get_workspace_by_index(i) === workspace) return true;
        }
    } catch (_error) {
        return false;
    }
    return false;
}

export function get(window, property) {
    const state = windowStates.get(window);
    return state ? state[property] : undefined;
}

export function set(window, property, value) {
    let state = windowStates.get(window);
    if (!state) {
        state = {};
        windowStates.set(window, state);
    }
    state[property] = value;
}

export function has(window, property) {
    const state = windowStates.get(window);
    return state ? property in state : false;
}

export function remove(window, property) {
    const state = windowStates.get(window);
    if (state) {
        delete state[property];
    }
}

export function clear(window) {
    windowStates.delete(window);
}

export const IS_MINIATURE = 'isMiniature';
export const MINIATURE_SCALE = 'miniatureScale';
export const PRE_MINIATURE_SIZE = 'preMiniatureSize';
export const MINIATURE_TARGET_POS = 'miniatureTargetPos';
export const MINIATURE_EXT_LEFT = 'miniatureExtLeft';
export const MINIATURE_EXT_TOP = 'miniatureExtTop';
export const MINIATURE_SCREENSHOT_PAUSE = 'miniatureScreenshotPause';
export const ANIMATING_MINIATURE = 'animatingMiniature';
export const MINIATURE_OVERLAY = 'miniatureOverlay';
export const MINIATURE_ANIM_KIND = 'miniatureAnimKind';
// Set between the layout shrinking a descriptor and createMiniature claiming the window. Anything
// that positions windows has to leave these alone: their descriptor already carries the mini's size,
// so a move_resize_frame would shrink the real frame and the scale would compound on top of it.
export const PENDING_MINIATURE = 'pendingMiniature';
