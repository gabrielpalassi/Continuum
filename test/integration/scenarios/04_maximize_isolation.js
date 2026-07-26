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

function sharesMonitorAndWorkspace(first, second) {
    return (
        first.get_monitor() === second.get_monitor() &&
        first.get_workspace()?.index() === second.get_workspace()?.index()
    );
}

export async function run() {
    const [first, second] = await createWindows([
        {width: 360, height: 260},
        {width: 340, height: 240},
    ]);
    const originalMonitor = first.get_monitor();

    first.activate(global.get_current_time());
    first.maximize();
    await waitUntil(() => first.is_maximized(), 'the existing window to maximize');
    await settle(1200);

    assertEqual(
        first.get_monitor(),
        originalMonitor,
        'Maximizing an existing window should keep it on its monitor'
    );
    assert(
        !sharesMonitorAndWorkspace(first, second),
        'A maximized window should not share its monitor and workspace with a sibling'
    );

    await destroyWindows();

    await createWindows([{width: 360, height: 260}]);
    await Scripting.createTestWindow({width: 500, height: 400, maximized: true});
    await Scripting.waitTestWindows();
    await waitUntil(() => allNormalWindows().length === 2, 'the born-maximized window to appear');
    await settle(1200);

    const windows = allNormalWindows();
    const bornMaximized = windows.find(window => window.is_maximized());
    const normal = windows.find(window => !window.is_maximized());
    assert(bornMaximized, 'One created window should remain maximized');
    assert(normal, 'One created window should remain normal');
    assert(
        !sharesMonitorAndWorkspace(bornMaximized, normal),
        'Without an empty monitor, a born-maximized window should be isolated'
    );
    await destroyWindows();
}
