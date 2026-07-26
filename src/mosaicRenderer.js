// SPDX-License-Identifier: GPL-3.0-or-later
// Window-management behavior adapted from Mosaic WM
// by Cléo Menezes Jr. and contributors:
// https://github.com/CleoMenezesJr/MosaicWM
// Renders model geometry onto Overview clones or real windows.

import * as Logger from './logger.js';
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
