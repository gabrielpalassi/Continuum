// SPDX-License-Identifier: GPL-3.0-or-later

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

import {
    Scripting,
    assert,
    assertNear,
    createWindows,
    destroyWindows,
    frame,
    settle,
    waitUntil,
    workArea,
} from '../lib.js';

export const METRICS = {};

const seat = global.stage.context.get_backend().get_default_seat();
const keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
const Key = {
    leftControl: 29,
    leftAlt: 56,
    left: 105,
    right: 106,
    leftSuper: 125,
};

async function press(keys) {
    for (const key of keys) {
        keyboard.notify_key(GLib.get_monotonic_time(), key, Clutter.KeyState.PRESSED);
        await Scripting.sleep(25);
    }
    for (const key of [...keys].reverse()) {
        keyboard.notify_key(GLib.get_monotonic_time(), key, Clutter.KeyState.RELEASED);
        await Scripting.sleep(25);
    }
    await settle(500);
}

function centerX(window) {
    const rect = frame(window);
    return rect.x + rect.width / 2;
}

export async function run() {
    const [first, second] = await createWindows([
        {width: 360, height: 260},
        {width: 340, height: 240},
    ]);
    const workspace = first.get_workspace();
    const area = workArea(workspace, first.get_monitor());

    first.activate(global.get_current_time());
    await waitUntil(
        () => global.display.focus_window?.get_id() === first.get_id(),
        'the first window to receive focus'
    );
    await press([Key.leftSuper, Key.left]);

    let firstFrame = frame(first);
    assertNear(firstFrame.x, area.x, 3, 'Super+Left should align to the left edge');
    assertNear(firstFrame.y, area.y, 3, 'Super+Left should align to the top edge');
    assertNear(firstFrame.height, area.height, 3, 'Super+Left should use the full height');
    assertNear(firstFrame.width, Math.floor(area.width / 2), 6, 'Super+Left should use half width');

    second.activate(global.get_current_time());
    await press([Key.leftSuper, Key.right]);
    assert(
        centerX(first) < centerX(second),
        'Left and right edge tiles should occupy opposite sides'
    );

    first.activate(global.get_current_time());
    const oldFirstCenter = centerX(first);
    const oldSecondCenter = centerX(second);
    await press([Key.leftSuper, Key.leftAlt, Key.right]);

    assert(
        centerX(first) > oldFirstCenter && centerX(second) < oldSecondCenter,
        'Swap-right should exchange the two edge-tiled windows'
    );

    first.activate(global.get_current_time());
    await press([Key.leftSuper, Key.leftControl, Key.right]);
    firstFrame = frame(first);
    assertNear(
        firstFrame.x,
        area.x + Math.floor(area.width / 2),
        6,
        'Top-right should align to the right half'
    );
    assertNear(firstFrame.y, area.y, 3, 'Top-right should align to the top');
    assertNear(
        firstFrame.height,
        Math.floor(area.height / 2),
        6,
        'Top-right should use half height'
    );
    await destroyWindows();
}
