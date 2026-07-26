// SPDX-License-Identifier: GPL-3.0-or-later

import {
    Main,
    assert,
    assertNonOverlapping,
    createWindows,
    destroyWindows,
    frame,
    hideOverview,
    waitUntil,
} from '../lib.js';

export const METRICS = {};

const UUID = 'continuum@gabrielpalassi.github.io';

function center(rect) {
    return {x: rect.x + rect.width / 2, y: rect.y + rect.height / 2};
}

function directionToward(first, second, horizontal) {
    if (horizontal) return first.x < second.x ? 'right' : 'left';
    return first.y < second.y ? 'down' : 'up';
}

export async function run() {
    await waitUntil(
        () => Main.extensionManager.lookup(UUID)?.state === 1,
        'extension to finish enabling'
    );
    hideOverview();
    await waitUntil(() => !Main.overview.visible, 'Overview to hide before swapping');

    const state = Main.extensionManager.lookup(UUID).stateObj;
    const [first, second] = await createWindows([
        {width: 360, height: 260},
        {width: 340, height: 240},
    ]);
    const firstBefore = center(frame(first));
    const secondBefore = center(frame(second));
    const horizontal =
        Math.abs(firstBefore.x - secondBefore.x) >= Math.abs(firstBefore.y - secondBefore.y);
    const direction = directionToward(firstBefore, secondBefore, horizontal);

    first.activate(global.get_current_time());
    await waitUntil(
        () => global.display.get_focus_window()?.get_id() === first.get_id(),
        'the window to swap to receive focus'
    );
    state._swapActiveWindow(direction);

    await waitUntil(() => {
        const firstAfter = center(frame(first));
        const secondAfter = center(frame(second));
        return horizontal
            ? (firstAfter.x - secondAfter.x) * (firstBefore.x - secondBefore.x) < 0
            : (firstAfter.y - secondAfter.y) * (firstBefore.y - secondBefore.y) < 0;
    }, `the focused window to swap ${direction}`);

    assertNonOverlapping([first, second]);
    assert(
        global.display.get_focus_window()?.get_id() === first.get_id(),
        'Swapping should preserve focus on the moved window'
    );
    await destroyWindows();
}
