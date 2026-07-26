// SPDX-License-Identifier: GPL-3.0-or-later

import {
    Scripting,
    allNormalWindows,
    assert,
    assertEqual,
    createWindows,
    destroyWindows,
    settle,
    waitUntil,
} from '../lib.js';

export const METRICS = {};

export async function run() {
    assertEqual(global.display.get_n_monitors(), 2, 'The scenario requires two monitors');

    const [normal] = await createWindows([{width: 360, height: 260}]);
    const occupiedMonitor = normal.get_monitor();
    await Scripting.createTestWindow({width: 500, height: 400, maximized: true});
    await Scripting.waitTestWindows();
    await waitUntil(() => allNormalWindows().length === 2, 'the born-maximized window to appear');
    await settle(1200);

    const bornMaximized = allNormalWindows().find(window => window.is_maximized());
    assert(bornMaximized, 'One window should be born maximized');
    assert(
        bornMaximized.get_monitor() !== occupiedMonitor,
        'A born-maximized window should use the empty monitor'
    );
    assertEqual(
        bornMaximized.get_workspace().index(),
        normal.get_workspace().index(),
        'Using an empty monitor should avoid unnecessary workspace isolation'
    );
    await destroyWindows();
}
