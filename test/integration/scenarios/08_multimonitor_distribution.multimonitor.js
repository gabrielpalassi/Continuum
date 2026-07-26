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

    let windows = await createWindows([
        {width: 360, height: 260},
        {width: 340, height: 240},
        {width: 320, height: 220},
        {width: 300, height: 200},
    ]);
    let counts = monitorCounts(windows);
    assertEqual(counts.size, 2, 'Normal windows should be distributed across both monitors');
    assert(
        Math.abs((counts.get(0) ?? 0) - (counts.get(1) ?? 0)) <= 1,
        'Normal windows should be balanced across monitors'
    );

    const closed = windows[0];
    closed.delete(global.get_current_time());
    await waitUntil(() => allNormalWindows().length === 3, 'one distributed window to close');
    await settle(1200);
    windows = allNormalWindows();
    counts = monitorCounts(windows);
    assertEqual(counts.size, 2, 'Closing one window should retain use of both monitors');
    assert(
        Math.abs((counts.get(0) ?? 0) - (counts.get(1) ?? 0)) <= 1,
        'Closing one window should rebalance the remaining windows'
    );

    await destroyWindows();
}
