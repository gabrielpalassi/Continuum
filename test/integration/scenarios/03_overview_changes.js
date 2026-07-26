// SPDX-License-Identifier: GPL-3.0-or-later

import {
    Main,
    Scripting,
    assert,
    assertEqual,
    assertNonOverlapping,
    createWindows,
    destroyWindows,
    hideOverview,
    normalWindows,
    settle,
    showOverview,
    waitUntil,
} from '../lib.js';

export const METRICS = {};

export async function run() {
    hideOverview();
    await createWindows([
        {width: 320, height: 240},
        {width: 360, height: 260},
    ]);

    showOverview();
    await waitUntil(() => Main.overview.visible, 'Overview to become visible');

    await Scripting.createTestWindow({width: 300, height: 220});
    await Scripting.waitTestWindows();
    await waitUntil(() => normalWindows().length === 3, 'a window created in Overview to appear');
    await settle(1000);
    assert(Main.overview.visible, 'Creating a window should not force the Overview to close');

    hideOverview();
    await waitUntil(() => !Main.overview.visible, 'Overview to hide');
    await settle();
    assertEqual(normalWindows().length, 3, 'All windows should survive the Overview transition');
    assertNonOverlapping(normalWindows());

    showOverview();
    await waitUntil(() => Main.overview.visible, 'manually opened Overview to become visible');
    await destroyWindows();
    assert(
        Main.overview.visible,
        'An Overview that was already open should remain open when the workspace becomes empty'
    );
}
