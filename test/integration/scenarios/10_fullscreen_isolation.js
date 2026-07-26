// SPDX-License-Identifier: GPL-3.0-or-later

import {assert, createWindows, destroyWindows, settle, waitUntil} from '../lib.js';

export const METRICS = {};

export async function run() {
    const [fullscreen, sibling] = await createWindows([
        {width: 360, height: 260},
        {width: 340, height: 240},
    ]);
    const originalMonitor = fullscreen.get_monitor();

    fullscreen.make_fullscreen();
    await waitUntil(() => fullscreen.is_fullscreen(), 'the existing window to enter fullscreen');
    await settle(1200);

    assert(
        fullscreen.get_monitor() === originalMonitor,
        'Entering fullscreen should preserve the selected monitor'
    );
    assert(
        fullscreen.get_monitor() !== sibling.get_monitor() ||
            fullscreen.get_workspace().index() !== sibling.get_workspace().index(),
        'A fullscreen window should not share its monitor and workspace with a sibling'
    );
    await destroyWindows();
}
