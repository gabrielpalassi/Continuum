// SPDX-License-Identifier: GPL-3.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {
    Main,
    Scripting,
    assert,
    assertNonOverlapping,
    assertWithin,
    destroyWindows,
    frame,
    hideOverview,
    normalWindows,
    settle,
    transformedFrame,
    waitUntil,
    workArea,
} from '../lib.js';

export const METRICS = {};

const TITLE = 'Continuum minimum-size test';

export async function run() {
    hideOverview();
    await waitUntil(() => !Main.overview.visible, 'Overview to hide before constraint checks');

    const [scenarioPath] = GLib.filename_from_uri(import.meta.url);
    const clientPath = GLib.build_filenamev([
        GLib.path_get_dirname(scenarioPath),
        '..',
        'clients',
        'minimum_size_window.js',
    ]);
    const client = Gio.Subprocess.new(['gjs', '-m', clientPath], Gio.SubprocessFlags.NONE);

    try {
        await waitUntil(
            () => normalWindows().some(window => window.get_title() === TITLE),
            'the constrained GTK client to appear'
        );
        await settle(1200);
        const constrained = normalWindows().find(window => window.get_title() === TITLE);
        let minWidth;
        let minHeight;
        // Shell exposes the Meta.Window before GTK's first surface commit applies
        // the pending xdg_toplevel size hints, so wait for the observable constraint.
        await waitUntil(() => {
            const [hasHint, width, height] = constrained.get_min_size();
            minWidth = width;
            minHeight = height;
            assert(hasHint, 'The GTK client should publish a minimum-size hint');
            assert(
                minWidth >= 600 && minHeight >= 400,
                `The GTK constraint should reach Mutter, received ${minWidth}x${minHeight}`
            );
            return true;
        }, 'the GTK minimum-size constraint to reach Mutter');

        for (let i = 0; i < 4; i++) {
            await Scripting.createTestWindow({width: 500, height: 360});
            await Scripting.waitTestWindows();
            await settle(500);
        }
        await settle(1200);

        const constrainedFrame = frame(constrained);
        assert(
            constrainedFrame.width >= minWidth && constrainedFrame.height >= minHeight,
            `Continuum must not resize the client below ${minWidth}x${minHeight}; ` +
                `received ${constrainedFrame.width}x${constrainedFrame.height}`
        );
        assertWithin(
            constrainedFrame,
            workArea(constrained.get_workspace(), constrained.get_monitor()),
            'The constrained client should retain usable frame geometry'
        );
        assert(
            normalWindows().some(window => (window.get_compositor_private()?.scale_x ?? 1) < 0.9),
            'Crowding should use overflow instead of violating a client minimum'
        );
        assertNonOverlapping(normalWindows(), transformedFrame);
    } finally {
        client.force_exit();
        await waitUntil(
            () => !normalWindows().some(window => window.get_title() === TITLE),
            'the constrained GTK client to close'
        );
        await destroyWindows();
    }
}
