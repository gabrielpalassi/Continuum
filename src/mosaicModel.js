// SPDX-License-Identifier: GPL-3.0-or-later
// Window-management behavior adapted from Mosaic WM
// by Cléo Menezes Jr. and contributors:
// https://github.com/CleoMenezesJr/MosaicWM
// Authoritative mosaic geometry, independent of what Mutter has applied.

// Keyed by window ID to survive GI wrapper churn. Workspace and monitor are
// recorded with every slot so the renderer can flush every Overview surface.
const entries = new Map();

function idOf(window) {
    return window?.get_id?.();
}

export const MosaicModel = {
    setSlot(window, slot, workspace, monitor) {
        const id = idOf(window);
        if (id === undefined) return;

        entries.set(id, {
            window,
            slot: {x: slot.x, y: slot.y, width: slot.width, height: slot.height},
            workspaceIndex: workspace?.index?.() ?? null,
            monitor: monitor ?? null,
        });
    },

    slotFor(window) {
        const id = idOf(window);
        return id === undefined ? null : (entries.get(id)?.slot ?? null);
    },

    // Layout intent wins over a transient frame during animation and while the
    // Overview is open, where Mutter discards window geometry requests.
    geometryOf(window) {
        const slot = this.slotFor(window);
        if (slot) return slot;

        const frame = window?.get_frame_rect?.();
        return frame ? {x: frame.x, y: frame.y, width: frame.width, height: frame.height} : null;
    },

    entriesFor(workspace, monitor) {
        const workspaceIndex = workspace?.index?.();
        const result = [];

        for (const entry of entries.values()) {
            if (entry.workspaceIndex === workspaceIndex && entry.monitor === monitor)
                result.push({window: entry.window, slot: entry.slot});
        }

        return result;
    },

    // A client- or user-owned resize becomes the new intent instead of being
    // overwritten later by an obsolete model slot.
    learn(window, frame) {
        const id = idOf(window);
        const entry = id === undefined ? undefined : entries.get(id);
        if (!entry) return;

        entry.slot = {x: frame.x, y: frame.y, width: frame.width, height: frame.height};
    },

    forget(window) {
        const id = idOf(window);
        if (id !== undefined) entries.delete(id);
    },

    forgetById(id) {
        entries.delete(id);
    },

    clear() {
        entries.clear();
    },
};

// Preserve the existing API for lifecycle call sites while moving storage into
// the workspace/monitor-aware model.
export const ComputedLayouts = {
    get(window) {
        return MosaicModel.slotFor(window) ?? undefined;
    },
    set(window, layout) {
        MosaicModel.setSlot(window, layout, window?.get_workspace?.(), window?.get_monitor?.());
    },
    delete(window) {
        MosaicModel.forget(window);
    },
    deleteById(id) {
        MosaicModel.forgetById(id);
    },
    clear() {
        MosaicModel.clear();
    },
};
