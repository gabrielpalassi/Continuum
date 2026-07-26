// SPDX-License-Identifier: GPL-3.0-or-later

import {
    allNormalWindows,
    assert,
    assertEqual,
    createWindows,
    destroyWindows,
    settle,
    waitUntil,
} from '../lib.js';

export const METRICS = {};

function monitorCounts(windows) {
    const counts = new Map();
    for (const window of windows)
        counts.set(window.get_monitor(), (counts.get(window.get_monitor()) ?? 0) + 1);
    return counts;
}

export async function run() {
    assertEqual(global.display.get_n_monitors(), 2, 'The scenario requires two monitors');

    const windows = await createWindows([
        {width: 360, height: 260},
        {width: 340, height: 240},
        {width: 320, height: 220},
    ]);
    const counts = monitorCounts(windows);
    const crowdedMonitor = [...counts.entries()].find(([, count]) => count > 1)?.[0];
    assert(crowdedMonitor !== undefined, 'The setup requires two windows on one monitor');

    const maximized = windows.find(window => window.get_monitor() === crowdedMonitor);
    const originalMonitor = maximized.get_monitor();
    maximized.maximize();
    await waitUntil(() => maximized.is_maximized(), 'the existing window to maximize');
    await settle(1200);

    assertEqual(
        maximized.get_monitor(),
        originalMonitor,
        'Maximizing an existing window should preserve its monitor'
    );
    assert(
        allNormalWindows().every(
            window =>
                window.get_id() === maximized.get_id() ||
                window.get_monitor() !== originalMonitor ||
                window.get_workspace().index() !== maximized.get_workspace().index()
        ),
        'Maximizing should evacuate every sibling from that monitor'
    );
    await destroyWindows();
}
