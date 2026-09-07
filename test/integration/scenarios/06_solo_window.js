// SPDX-License-Identifier: GPL-3.0-or-later

import {
    activeWorkspace,
    assert,
    assertEqual,
    assertWithin,
    createWindows,
    destroyWindows,
    frame,
    waitUntil,
    workArea,
} from '../lib.js';

export const METRICS = {};

export async function run() {
    const [ordinary] = await createWindows([{width: 360, height: 260}]);
    const ordinaryWorkspace = ordinary.get_workspace();
    await waitUntil(() => {
        const current = frame(ordinary);
        return current.width > 0 && current.height > 0;
    }, 'the first lone window to acquire usable geometry');

    assertWithin(
        frame(ordinary),
        workArea(ordinaryWorkspace, ordinary.get_monitor()),
        'A lone first window should have visible geometry'
    );
    await destroyWindows();

    const origin = activeWorkspace();
    const available = workArea(origin, 0);
    const [window] = await createWindows([
        {
            width: Math.max(360, Math.floor(available.width * 0.7)),
            height: available.height + 11,
        },
    ]);

    assert(!window.is_maximized(), 'The oversized regression window should remain normal');
    assertEqual(
        window.get_workspace(),
        origin,
        'An oversized lone window should remain on its originating workspace'
    );
    await destroyWindows();
}
