// SPDX-License-Identifier: GPL-3.0-or-later

import {
    Scripting,
    assert,
    assertNonOverlapping,
    assertWithin,
    closeWindow,
    destroyWindows,
    frame,
    normalWindows,
    rectsOverlap,
    settle,
    transformedFrame,
    waitUntil,
    workArea,
} from '../lib.js';

export const METRICS = {};

function actorScale(window) {
    return window.get_compositor_private()?.scale_x ?? 1;
}

export async function run() {
    const maximumWindows = 12;
    let miniature = null;

    for (let i = 0; i < maximumWindows && !miniature; i++) {
        await Scripting.createTestWindow({width: 700, height: 500});
        await Scripting.waitTestWindows();
        await settle(500);
        miniature = normalWindows().find(window => actorScale(window) < 0.9) ?? null;
    }

    assert(miniature, `Overflow should create a miniature within ${maximumWindows} windows`);
    const windows = normalWindows();
    assert(
        windows.some(window => actorScale(window) > 0.99),
        'Overflow should retain at least one full-size window'
    );
    try {
        await waitUntil(() => {
            for (let i = 0; i < windows.length; i++) {
                for (let j = i + 1; j < windows.length; j++) {
                    if (rectsOverlap(transformedFrame(windows[i]), transformedFrame(windows[j])))
                        return false;
                }
            }
            return true;
        }, 'the overflow layout animation to settle without overlap');
    } catch (_error) {
        // Produce the exact conflicting geometry instead of only the wait timeout.
        assertNonOverlapping(windows, transformedFrame);
        throw _error;
    }
    assertNonOverlapping(windows, transformedFrame);

    const miniatureId = miniature.get_id();
    const fullSizeWindows = windows.filter(window => actorScale(window) > 0.99);
    let restored = false;

    for (const window of fullSizeWindows) {
        await closeWindow(window);
        // Restoration is scale-based and can finish just after closeWindow's
        // generic settle delay when animations are enabled.
        await settle(500);
        const candidate = normalWindows().find(item => item.get_id() === miniatureId);
        if (!candidate) break;
        if (actorScale(candidate) > 0.99) {
            miniature = candidate;
            restored = true;
            break;
        }
    }

    assert(restored, 'A miniature should restore after enough space is freed');
    await settle(1000);
    assert(
        actorScale(miniature) > 0.99,
        'A restored miniature should not immediately be miniaturized again'
    );
    assertWithin(
        frame(miniature),
        workArea(miniature.get_workspace(), miniature.get_monitor()),
        'A restored miniature should return to usable workspace geometry'
    );
    assertNonOverlapping(normalWindows(), transformedFrame);
    await waitUntil(
        () => normalWindows().every(window => window.get_compositor_private()),
        'all surviving windows to retain actors'
    );
    await destroyWindows();
}
