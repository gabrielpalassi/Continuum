// SPDX-License-Identifier: GPL-3.0-or-later

import Gio from 'gi://Gio';

import {Main, Scripting, assert, destroyWindows, normalWindows, settle, waitUntil} from '../lib.js';

export const METRICS = {};

const UUID = 'continuum@gabrielpalassi.github.io';

function allActorsAtFullScale() {
    return normalWindows().every(window => {
        const actor = window.get_compositor_private();
        return actor && Math.abs(actor.scale_x - 1) < 0.01 && Math.abs(actor.scale_y - 1) < 0.01;
    });
}

export async function run() {
    for (let i = 0; i < 10; i++) {
        await Scripting.createTestWindow({width: 700, height: 500});
        await Scripting.waitTestWindows();
        await settle(350);
        if (normalWindows().some(window => window.get_compositor_private()?.scale_x < 0.9)) break;
    }

    assert(
        normalWindows().some(window => window.get_compositor_private()?.scale_x < 0.9),
        'The cleanup test requires at least one miniature'
    );

    const mutterSettings = new Gio.Settings({schema_id: 'org.gnome.mutter'});
    const defaultEdgeTiling = mutterSettings.get_default_value('edge-tiling').get_boolean();

    await Main.extensionManager.disableExtension(UUID);
    await waitUntil(allActorsAtFullScale, 'all miniatures to return to full scale on disable');
    assert(
        mutterSettings.get_boolean('edge-tiling') === defaultEdgeTiling,
        'Disabling should restore Mutter edge-tiling settings'
    );

    await Main.extensionManager.enableExtension(UUID);
    await settle(1000);
    assert(
        Main.extensionManager.lookup(UUID)?.state === 1,
        'The extension should enable again after a clean teardown'
    );
    await destroyWindows();
}
