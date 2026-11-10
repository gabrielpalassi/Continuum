// SPDX-License-Identifier: GPL-3.0-or-later

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {
    Main,
    Scripting,
    assert,
    createWindows,
    destroyWindows,
    frame,
    hideOverview,
    settle,
    waitUntil,
} from '../lib.js';

export const METRICS = {};
const UUID = 'continuum@gabrielpalassi.github.io';

export async function run() {
    hideOverview();
    const [window] = await createWindows([{width: 360, height: 260}]);
    hideOverview();
    await waitUntil(() => !Main.overview.visible, 'Overview to close before pointer input');
    const state = Main.extensionManager.lookup(UUID).stateObj;
    const actor = window.get_compositor_private();
    window.activate(global.get_current_time());
    await waitUntil(() => actor.mapped, 'the miniature input window to map');
    await settle(500);
    const seat = global.stage.context.get_backend().get_default_seat();
    const pointer = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    const touch = seat.create_virtual_device(Clutter.InputDeviceType.TOUCHSCREEN_DEVICE);
    const preferences = new Gio.Settings({schema_id: 'org.gnome.desktop.wm.preferences'});
    const mutter = new Gio.Settings({schema_id: 'org.gnome.mutter'});
    const focusMode = preferences.get_value('focus-mode');
    const pointerRest = mutter.get_value('focus-change-on-pointer-rest');
    const rect = frame(window);
    const target = {x: 200, y: 150};
    const point = {x: target.x + 40, y: target.y + 40};
    const move = async (x, y) => {
        pointer.notify_absolute_motion(GLib.get_monotonic_time(), x, y);
        await Scripting.sleep(50);
        pointer.notify_absolute_motion(GLib.get_monotonic_time(), x, y);
        await Scripting.sleep(50);
    };
    const miniaturize = async () => {
        await move(1000, 600);
        // The virtual pointer's first event can enter Shell's hot corner before
        // its second absolute motion establishes the requested position.
        hideOverview();
        await waitUntil(
            () => !Main.overview.visible && actor.visible,
            'the desktop to accept input'
        );
        assert(
            state.miniatureManager.createMiniature(window, target, rect, {animate: false}),
            'Miniature creation should succeed'
        );
        await settle(50);
        assert(actor.scale_x < 1, 'The input target should be a miniature');
        assert(
            !Main.overview.visible && actor.visible,
            'The miniature must be visible on the desktop'
        );
    };
    const waitForRestore = () =>
        waitUntil(
            () => actor.scale_x === 1 && actor.scale_y === 1,
            'input to restore the miniature'
        );

    state.grabHandler._suppressRestoreRetile = true;
    try {
        preferences.set_string('focus-mode', 'click');
        await miniaturize();
        await move(point.x, point.y);
        const overlay = global.window_group.get_children().find(child => child._window === window);
        const [pointerX, pointerY] = global.get_pointer();
        assert(
            pointerX === point.x && pointerY === point.y,
            'The virtual pointer must reach the overlay'
        );
        const picked = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, point.x, point.y);
        assert(
            overlay?.contains(picked),
            `The miniature overlay must receive input (picked ${picked})`
        );
        pointer.notify_button(GLib.get_monotonic_time(), 1, Clutter.ButtonState.PRESSED);
        await Scripting.sleep(50);
        pointer.notify_button(GLib.get_monotonic_time(), 1, Clutter.ButtonState.RELEASED);
        await waitForRestore();

        await miniaturize();
        touch.notify_touch_down(GLib.get_monotonic_time(), 0, point.x, point.y);
        await Scripting.sleep(50);
        touch.notify_touch_up(GLib.get_monotonic_time(), 0);
        await waitForRestore();

        preferences.set_string('focus-mode', 'sloppy');
        mutter.set_boolean('focus-change-on-pointer-rest', true);
        await miniaturize();
        await Scripting.sleep(600);
        await move(point.x, point.y);
        await move(1000, 600);
        await Scripting.sleep(300);
        assert(actor.scale_x < 1, 'Leaving the overlay must cancel pending hover restoration');
        await move(point.x, point.y);
        await waitForRestore();
    } finally {
        state.grabHandler._suppressRestoreRetile = false;
        preferences.set_value('focus-mode', focusMode);
        mutter.set_value('focus-change-on-pointer-rest', pointerRest);
        await destroyWindows();
    }
}
