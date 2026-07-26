// SPDX-License-Identifier: GPL-3.0-or-later
// Window-management behavior adapted from Mosaic WM
// by Cléo Menezes Jr. and contributors:
// https://github.com/CleoMenezesJr/MosaicWM
// Renders model geometry onto Overview clones or real windows.

import * as Logger from './logger.js';
import * as Workspace from 'resource:///org/gnome/shell/ui/workspace.js';
import {WINDOW_SPACING} from './constants.js';
import {MosaicModel} from './mosaicModel.js';
import {isWindowAlive} from './liveness.js';
import * as WindowState from './windowState.js';
import {IS_MINIATURE} from './windowState.js';

export class MosaicRenderer {
    constructor() {
        // GNOME creates fresh WorkspaceLayout instances for each Overview session.
        this._overviewLayouts = new Map();
    }

    _key(workspace, monitor) {
        return `${workspace.index()}:${monitor}`;
    }

    registerOverviewLayout(workspace, monitor, layout) {
        const key = this._key(workspace, monitor);
        let layouts = this._overviewLayouts.get(key);
        if (!layouts) {
            layouts = new Set();
            this._overviewLayouts.set(key, layouts);
        }
        layouts.add(layout);
    }

    clearOverviewLayouts() {
        this._overviewLayouts.clear();
    }

    // WorkspaceLayout only rebuilds slots when _needsLayout is set; layout_changed
    // alone schedules an allocation that would otherwise reuse stale slots.
    publishToOverview(workspace, monitor) {
        const layouts = this._overviewLayouts.get(this._key(workspace, monitor));
        if (!layouts?.size) return;

        Logger.log(
            `[MODEL] Publishing ${layouts.size} Overview layout(s) for WS-${workspace.index()} monitor ${monitor}`
        );
        for (const layout of layouts) {
            layout._needsLayout = true;
            layout.layout_changed();
        }
    }

    // Apply exactly what the Overview displayed instead of recomputing from stale
    // frames as it closes. Miniatures continue to render through actor transforms.
    flushToWindows(workspace, monitor) {
        const modelEntries = MosaicModel.entriesFor(workspace, monitor);
        if (!modelEntries.length) return;

        Logger.log(
            `[MODEL] Flushing ${modelEntries.length} slot(s) to WS-${workspace.index()} monitor ${monitor}`
        );
        for (const {window, slot} of modelEntries) {
            if (!isWindowAlive(window) || WindowState.get(window, IS_MINIATURE)) continue;
            window.move_resize_frame(false, slot.x, slot.y, slot.width, slot.height);
        }
    }

    destroy() {
        this._overviewLayouts.clear();
    }
}

// Scales down the layout instead of reorganizing windows (preserves spatial memory).
export class MosaicLayoutStrategy extends Workspace.LayoutStrategy {
    constructor(props) {
        super(props);
        this._calculating = false;
    }

    computeLayout(windows, _params) {
        return {windows};
    }

    computeWindowSlots(layout, area) {
        const clones = layout.windows;

        if (!area || clones.length === 0) {
            return [];
        }

        const filteredClones = clones.filter(clone => {
            const metaWindow = clone.metaWindow || clone.source?.metaWindow;
            if (!metaWindow) return true;
            if (metaWindow.is_attached_dialog()) return false;
            if (metaWindow.get_transient_for() !== null) return false;
            return true;
        });

        if (filteredClones.length === 0) return [];

        let workspace = null;
        for (const clone of filteredClones) {
            const metaWindow = clone.metaWindow || clone.source?.metaWindow;
            if (metaWindow) {
                workspace = metaWindow.get_workspace();
                if (workspace) break;
            }
        }

        if (!workspace) return [];

        const monitor = this.monitor || this._monitor;
        const monitorIndex = monitor ? monitor.index : global.display.get_primary_monitor();
        const workArea = workspace.get_work_area_for_monitor(monitorIndex);

        if (!workArea || workArea.width <= 0 || workArea.height <= 0) {
            return [];
        }

        const scale = Math.min(area.width / workArea.width, area.height / workArea.height, 1);
        const offsetX = (area.width - workArea.width * scale) / 2;
        const offsetY = (area.height - workArea.height * scale) / 2;
        const gap = WINDOW_SPACING / 2;

        const slots = [];
        for (const clone of filteredClones) {
            const metaWindow = clone.metaWindow || clone.source?.metaWindow;
            if (!metaWindow) continue;

            const rect = MosaicModel.slotFor(metaWindow) || metaWindow.get_frame_rect();
            if (!rect) continue;

            const x = (rect.x - workArea.x) * scale + area.x + offsetX + gap;
            const y = (rect.y - workArea.y) * scale + area.y + offsetY + gap;
            const width = rect.width * scale - gap * 2;
            const height = rect.height * scale - gap * 2;

            slots.push([x, y, width, height, clone]);
        }

        return slots;
    }
}
