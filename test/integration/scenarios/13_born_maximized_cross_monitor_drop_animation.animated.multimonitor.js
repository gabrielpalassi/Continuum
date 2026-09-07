// SPDX-License-Identifier: GPL-3.0-or-later

import {runScenario} from './13_born_maximized_cross_monitor_drag_hint.multimonitor.js';

export const METRICS = {};

export async function run() {
    await runScenario({expectAnimation: true});
}
