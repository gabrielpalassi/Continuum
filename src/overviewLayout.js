// SPDX-License-Identifier: GPL-3.0-or-later
// Window-management behavior adapted from Mosaic WM
// by Cléo Menezes Jr. and contributors:
// https://github.com/CleoMenezesJr/MosaicWM
// Custom layout strategy to preserve mosaic geometry in Overview

import * as Workspace from 'resource:///org/gnome/shell/ui/workspace.js';
import {ComputedLayouts} from './tiling.js';
import {WINDOW_SPACING} from './constants.js';

// Scales down the layout instead of reorganizing windows (preserves spatial memory)
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
            const mw = clone.metaWindow || clone.source?.metaWindow;
            if (mw) {
                workspace = mw.get_workspace();
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

        const scale = Math.min(area.width / workArea.width, area.height / workArea.height, 1.0);

        const offsetX = (area.width - workArea.width * scale) / 2;
        const offsetY = (area.height - workArea.height * scale) / 2;

        const slots = [];
        for (const clone of filteredClones) {
            const mw = clone.metaWindow || clone.source?.metaWindow;
            if (!mw) continue;

            const rect = ComputedLayouts.get(mw) || mw.get_frame_rect();
            if (!rect) continue;

            const gap = WINDOW_SPACING / 2;
            const x = (rect.x - workArea.x) * scale + area.x + offsetX + gap;
            const y = (rect.y - workArea.y) * scale + area.y + offsetY + gap;
            const w = rect.width * scale - gap * 2;
            const h = rect.height * scale - gap * 2;

            slots.push([x, y, w, h, clone]);
        }

        return slots;
    }
}
