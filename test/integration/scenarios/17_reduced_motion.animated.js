// SPDX-License-Identifier: GPL-3.0-or-later

import Gio from 'gi://Gio';
import St from 'gi://St';

import {
    Main,
    assert,
    createWindows,
    destroyWindows,
    frame,
    hideOverview,
    waitUntil,
} from '../lib.js';

export const METRICS = {};
const UUID = 'continuum@gabrielpalassi.github.io';

function assertNoMotion(actor, message) {
    for (const property of ['scale-x', 'scale-y', 'translation-x', 'translation-y', 'x', 'y'])
        assert(!actor.get_transition(property), `${message}: unexpected ${property} transition`);
}

export async function run() {
    // Shell 50 has no reduced-motion setting; its ordinary animation paths are
    // covered by the other animated scenarios and the fast compatibility policy.
    if (!St.ReducedMotion) return;

    const settings = new Gio.Settings({schema_id: 'org.gnome.desktop.a11y.interface'});
    const previous = settings.get_value('reduced-motion');
    const state = Main.extensionManager.lookup(UUID).stateObj;
    try {
        settings.set_string('reduced-motion', 'reduce');
        await waitUntil(
            () => St.Settings.get().reduced_motion === St.ReducedMotion.REDUCE,
            'Shell to observe the reduced-motion preference'
        );
        hideOverview();
        const [window] = await createWindows([{width: 360, height: 260}]);
        const actor = window.get_compositor_private();
        const rect = frame(window);
        state.animationsManager.animateWindow(window, {...rect, x: rect.x + 20}, {duration: 5000});
        assertNoMotion(actor, 'Ordinary placement should be immediate');

        state.miniatureManager.createMiniature(window, {x: 40, y: 100}, rect);
        assert(actor.scale_x < 1, 'The miniature must still acquire its final scale');
        assertNoMotion(actor, 'Miniature creation should be immediate');
        const overlay = global.window_group.get_children().find(child => child._window === window);
        assert(overlay, 'The miniature should remain interactive');
        assertNoMotion(overlay, 'The miniature overlay should not fly');
        let overlayDestroyed = false;
        overlay.connect('destroy', () => {
            overlayDestroyed = true;
        });
        state.grabHandler._suppressRestoreRetile = true;
        state.miniatureManager.restoreMiniature(window, null, {activate: false});
        assert(actor.scale_x === 1 && actor.scale_y === 1, 'Restore should finish at full scale');
        assertNoMotion(actor, 'Miniature restore should be immediate');
        assert(overlayDestroyed, 'The interaction overlay should be removed on restore');
    } finally {
        state.grabHandler._suppressRestoreRetile = false;
        await destroyWindows();
        settings.set_value('reduced-motion', previous);
    }
}
