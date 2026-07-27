// SPDX-License-Identifier: GPL-3.0-or-later

import {TileZone} from '../../../src/constants.js';
import {
    Main,
    assertNear,
    createWindows,
    destroyWindows,
    frame,
    settle,
    waitUntil,
    workArea,
} from '../lib.js';

export const METRICS = {};

const UUID = 'continuum@gabrielpalassi.github.io';

export async function run() {
    await waitUntil(
        () => Main.extensionManager.lookup(UUID)?.state === 1,
        'extension to finish enabling'
    );

    const state = Main.extensionManager.lookup(UUID).stateObj;
    const [window] = await createWindows([{width: 360, height: 260}]);
    window.activate(global.get_current_time());
    await waitUntil(
        () => global.display.focus_window?.get_id() === window.get_id(),
        'the keyboard target to receive focus'
    );
    Main.overview.hide();
    await waitUntil(() => !Main.overview.visible, 'the Overview to close before keyboard tiling');
    await settle(250);

    try {
        const area = workArea(window.get_workspace(), window.get_monitor());

        state._tileActiveWindow(TileZone.LEFT_FULL);
        await settle(500);
        assertNear(
            frame(window).x,
            area.x,
            4,
            'Super+Left action should place an untiled window on the left'
        );

        state._tileActiveWindow(TileZone.RIGHT_FULL);
        await settle(500);
        const rightFrame = frame(window);
        assertNear(
            rightFrame.x + rightFrame.width,
            area.x + area.width,
            4,
            'one Super+Right action should move a left-tiled window to the right'
        );
    } finally {
        await destroyWindows();
    }
}
