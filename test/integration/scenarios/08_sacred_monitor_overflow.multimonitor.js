// SPDX-License-Identifier: GPL-3.0-or-later

import {
    Scripting,
    allNormalWindows,
    assert,
    assertEqual,
    destroyWindows,
    settle,
    waitUntil,
} from '../lib.js';

export const METRICS = {};

function actorScale(window) {
    return window.get_compositor_private()?.scale_x ?? 1;
}

export async function run() {
    assertEqual(global.display.get_n_monitors(), 2, 'The scenario requires two monitors');

    await Scripting.createTestWindow({width: 900, height: 650, maximized: true});
    await Scripting.waitTestWindows();
    await waitUntil(
        () => allNormalWindows().some(window => window.is_maximized()),
        'the maximized window to appear'
    );
    await settle(1200);

    const maximized = allNormalWindows().find(window => window.is_maximized());
    const workspace = maximized.get_workspace();
    const occupiedMonitor = maximized.get_monitor();

    await Scripting.createTestWindow({width: 700, height: 500});
    await Scripting.waitTestWindows();
    await waitUntil(() => allNormalWindows().length === 2, 'the second window to appear');
    await settle(1200);

    const second = allNormalWindows().find(window => window.get_id() !== maximized.get_id());
    assert(
        second.get_monitor() !== occupiedMonitor,
        'A normal window should avoid the monitor owned by a maximized window'
    );
    assertEqual(
        second.get_workspace().index(),
        workspace.index(),
        'The second monitor should be used before another workspace'
    );

    await Scripting.createTestWindow({width: 700, height: 500});
    await Scripting.waitTestWindows();
    await waitUntil(() => allNormalWindows().length === 3, 'the third window to appear');
    await settle(1200);

    const windows = allNormalWindows();
    const normal = windows.filter(window => !window.is_maximized());
    const third = normal.find(window => window.get_id() !== second.get_id());
    assert(
        windows.every(window => window.get_workspace().index() === workspace.index()),
        'A large third window should stay on the same workspace when the other monitor can miniaturize its occupant'
    );
    assert(
        normal.every(window => window.get_monitor() === second.get_monitor()),
        'Both normal windows should share the monitor not owned by the maximized window'
    );
    assert(
        actorScale(second) < 0.9,
        'The older normal window should be miniaturized to make room for the third window'
    );
    assert(third && actorScale(third) > 0.99, 'The arriving third window should remain full-size');

    await destroyWindows();
}
