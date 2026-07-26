// SPDX-License-Identifier: GPL-3.0-or-later

import {assertWithin, createWindows, destroyWindows, frame, waitUntil, workArea} from '../lib.js';

export const METRICS = {};

export async function run() {
    const [window] = await createWindows([{width: 360, height: 260}]);
    const workspace = window.get_workspace();
    await waitUntil(() => {
        const current = frame(window);
        return current.width > 0 && current.height > 0;
    }, 'the first lone window to acquire usable geometry');

    assertWithin(
        frame(window),
        workArea(workspace, window.get_monitor()),
        'A lone first window should have visible geometry'
    );
    await destroyWindows();
}
