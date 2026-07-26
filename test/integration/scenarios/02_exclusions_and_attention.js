// SPDX-License-Identifier: GPL-3.0-or-later

import {
    Main,
    assert,
    assertNonOverlapping,
    createWindows,
    destroyWindows,
    hideOverview,
    normalWindows,
    settle,
    waitUntil,
} from '../lib.js';

export const METRICS = {};

export async function run() {
    hideOverview();
    await waitUntil(() => !Main.overview.visible, 'Overview to hide before focus checks');

    const windows = await createWindows([
        {width: 300, height: 220},
        {width: 340, height: 240},
        {width: 280, height: 200},
    ]);
    const [first, second, third] = windows;

    first.activate(global.get_current_time());
    await waitUntil(
        () => global.display.focus_window?.get_id() === first.get_id(),
        'the first window to receive focus'
    );

    let attentionSignals = 0;
    const attentionId = global.display.connect('window-demands-attention', () => {
        attentionSignals++;
    });
    global.display.emit('window-demands-attention', second);
    await waitUntil(
        () => attentionSignals === 1,
        'the synthetic attention signal to reach display handlers'
    );
    global.display.disconnect(attentionId);
    await waitUntil(
        () => global.display.focus_window?.get_id() === second.get_id(),
        'an attention-seeking window to be focused'
    );

    third.minimize();
    await waitUntil(() => third.minimized, 'the minimized window to become excluded');
    await settle();
    assertNonOverlapping(normalWindows().filter(window => !window.minimized));

    third.unminimize();
    await waitUntil(() => !third.minimized, 'the minimized window to return');
    await settle();
    assertNonOverlapping(normalWindows());

    first.make_above();
    await waitUntil(() => first.is_above(), 'the always-on-top window to become excluded');
    await settle();
    assertNonOverlapping(normalWindows().filter(window => !window.is_above()));

    first.unmake_above();
    await waitUntil(() => !first.is_above(), 'the always-on-top window to return');
    await settle();
    assertNonOverlapping(normalWindows());
    assert(
        normalWindows().every(window => !window.minimized),
        'No window should remain minimized after returning to the mosaic'
    );
    await destroyWindows();
}
