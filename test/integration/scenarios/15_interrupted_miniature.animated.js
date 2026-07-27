// SPDX-License-Identifier: GPL-3.0-or-later

import {
    Main,
    Scripting,
    assert,
    destroyWindows,
    frame,
    normalWindows,
    settle,
    transformedFrame,
    waitUntil,
} from '../lib.js';

export const METRICS = {};

const UUID = 'continuum@gabrielpalassi.github.io';

function actorScale(window) {
    return window.get_compositor_private()?.scale_x ?? 1;
}

export async function run() {
    await waitUntil(
        () => Main.extensionManager.lookup(UUID)?.state === 1,
        'extension to finish enabling'
    );

    const state = Main.extensionManager.lookup(UUID).stateObj;
    let miniature = null;

    try {
        for (let i = 0; i < 12 && !miniature; i++) {
            await Scripting.createTestWindow({width: 700, height: 500});
            await Scripting.waitTestWindows();
            await settle(450);
            miniature = normalWindows().find(window => actorScale(window) < 0.9) ?? null;
        }
        assert(miniature, 'overflow should create a miniature for interruption testing');

        const id = miniature.get_id();
        const miniatureSlot = transformedFrame(miniature);
        const preSize = frame(miniature);

        // Isolate the animation state machine from the normal restore-triggered
        // retile. The regression under test is create/restore interruption itself.
        state.grabHandler._suppressRestoreRetile = true;
        assert(
            state.miniatureManager.restoreMiniature(miniature, null, {activate: false}),
            'the miniature should begin restoring'
        );
        await Scripting.sleep(60);
        assert(
            state.miniatureManager.createMiniature(miniature, miniatureSlot, preSize),
            'a restore in flight should be interruptible by a new miniature creation'
        );
        await Scripting.sleep(60);
        assert(
            state.miniatureManager.restoreMiniature(miniature, null, {activate: false}),
            'the interrupted creation should be restorable'
        );
        state.grabHandler._suppressRestoreRetile = false;

        await waitUntil(
            () =>
                actorScale(miniature) > 0.999 && !state.miniatureManager._miniatureWindows.has(id),
            'the interrupted miniature to finish at full scale'
        );
        const actor = miniature.get_compositor_private();
        assert(
            Math.abs(actor.translation_x) < 1 && Math.abs(actor.translation_y) < 1,
            'the final restore should clear miniature translations'
        );
    } finally {
        state.grabHandler._suppressRestoreRetile = false;
        await destroyWindows();
    }
}
