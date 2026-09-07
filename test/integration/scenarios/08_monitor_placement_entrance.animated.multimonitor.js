// SPDX-License-Identifier: GPL-3.0-or-later

import {
    Main,
    Scripting,
    allNormalWindows,
    assert,
    assertEqual,
    destroyWindows,
    settle,
    waitUntil,
} from '../lib.js';

export const METRICS = {};

const UUID = 'continuum@gabrielpalassi.github.io';

export async function run() {
    assertEqual(global.display.get_n_monitors(), 2, 'The scenario requires two monitors');
    await waitUntil(
        () => Main.extensionManager.lookup(UUID)?.state === 1,
        'extension to finish enabling'
    );

    await Scripting.createTestWindow({width: 900, height: 650, maximized: true});
    await Scripting.waitTestWindows();
    await waitUntil(
        () => allNormalWindows().some(window => window.is_maximized()),
        'the maximized window to appear'
    );
    await settle(1200);

    const maximized = allNormalWindows().find(window => window.is_maximized());
    await Scripting.createTestWindow({width: 700, height: 500});
    await Scripting.waitTestWindows();
    await waitUntil(() => allNormalWindows().length === 2, 'the second window to appear');
    await settle(1200);

    const second = allNormalWindows().find(window => window.get_id() !== maximized.get_id());
    assert(
        second.get_monitor() !== maximized.get_monitor(),
        'The setup requires the second window on the non-sacred monitor'
    );

    const state = Main.extensionManager.lookup(UUID).stateObj;
    const animations = state.animationsManager;
    const animateMonitorPlacementEntrance = animations.animateMonitorPlacementEntrance;
    const samples = [];
    const existingIds = new Set(allNormalWindows().map(window => window.get_id()));
    animations.animateMonitorPlacementEntrance = function (window) {
        animateMonitorPlacementEntrance.call(this, window);
        if (existingIds.has(window.get_id())) return;

        const actor = window.get_compositor_private();
        const [pivotX, pivotY] = actor.get_pivot_point();
        samples.push({
            monitor: window.get_monitor(),
            opacity: actor.opacity,
            pivotX,
            pivotY,
            scaleX: actor.scale_x,
            scaleY: actor.scale_y,
            translationX: actor.translation_x,
            translationY: actor.translation_y,
        });
    };

    try {
        await Scripting.createTestWindow({width: 700, height: 500});
        await Scripting.waitTestWindows();
        await waitUntil(() => allNormalWindows().length === 3, 'the third window to appear');
        await waitUntil(
            () => samples.length > 0,
            'the redirected normal window to start its monitor-placement entrance'
        );

        const [sample] = samples;
        assertEqual(
            sample.monitor,
            second.get_monitor(),
            'The entrance should start only after the window reaches its destination monitor'
        );
        assert(
            sample.opacity === 0 &&
                sample.scaleX <= 0.02 &&
                sample.scaleY <= 0.06 &&
                Math.abs(sample.pivotX - 0.5) < 0.01 &&
                Math.abs(sample.pivotY - 1) < 0.01 &&
                Math.abs(sample.translationX) < 1 &&
                Math.abs(sample.translationY) < 1,
            'A redirected normal window should begin with GNOME’s map-effect geometry; ' +
                `received ${JSON.stringify(sample)}`
        );
    } finally {
        animations.animateMonitorPlacementEntrance = animateMonitorPlacementEntrance;
        await destroyWindows();
    }
}
