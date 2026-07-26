// SPDX-License-Identifier: GPL-3.0-or-later
// Window-management behavior adapted from Mosaic WM
// by Cléo Menezes Jr. and contributors:
// https://github.com/CleoMenezesJr/MosaicWM

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
