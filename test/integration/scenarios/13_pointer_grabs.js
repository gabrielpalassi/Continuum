// SPDX-License-Identifier: GPL-3.0-or-later

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import {
    Main,
    Scripting,
    assert,
    assertNear,
    assertNonOverlapping,
    assertWithin,
    createWindows,
    destroyWindows,
    frame,
    settle,
    waitUntil,
    workArea,
} from '../lib.js';

export const METRICS = {};

const UUID = 'continuum@gabrielpalassi.github.io';
const SUPER_KEY = 125;
const MOVE_OPS = new Set([Meta.GrabOp.MOVING, Meta.GrabOp.MOVING_UNCONSTRAINED]);
const RESIZE_OPS = new Set(
    Object.entries(Meta.GrabOp)
        .filter(([name]) => name.startsWith('RESIZING_'))
        .map(([, value]) => value)
);

function isResizeOp(op) {
    return RESIZE_OPS.has(op) || ((op & 0x1) !== 0 && (op & 0x3000) !== 0);
}

function center(rect) {
    return {x: rect.x + rect.width / 2, y: rect.y + rect.height / 2};
}

function centerDistance(first, second) {
    const firstCenter = center(first);
    const secondCenter = center(second);
    return Math.hypot(firstCenter.x - secondCenter.x, firstCenter.y - secondCenter.y);
}

async function pointerGrab({pointer, keyboard, button, start, end}) {
    // The first absolute event initializes the virtual device; the second one
    // reliably positions the compositor cursor.
    pointer.notify_absolute_motion(GLib.get_monotonic_time(), start.x, start.y);
    await Scripting.sleep(100);
    pointer.notify_absolute_motion(GLib.get_monotonic_time(), start.x, start.y);
    await Scripting.sleep(100);
    keyboard.notify_key(GLib.get_monotonic_time(), SUPER_KEY, Clutter.KeyState.PRESSED);
    await Scripting.sleep(100);
    pointer.notify_button(GLib.get_monotonic_time(), button, Clutter.ButtonState.PRESSED);
    await Scripting.sleep(100);
    pointer.notify_absolute_motion(GLib.get_monotonic_time(), end.x, end.y);
    await Scripting.sleep(250);
    pointer.notify_button(GLib.get_monotonic_time(), button, Clutter.ButtonState.RELEASED);
    keyboard.notify_key(GLib.get_monotonic_time(), SUPER_KEY, Clutter.KeyState.RELEASED);
}

export async function run() {
    await waitUntil(
        () => Main.extensionManager.lookup(UUID)?.state === 1,
        'extension to finish enabling'
    );

    const state = Main.extensionManager.lookup(UUID).stateObj;
    let windows = await createWindows([{width: 360, height: 260}]);
    const [window] = windows;
    window.activate(global.get_current_time());
    await waitUntil(
        () => global.display.get_focus_window()?.get_id() === window.get_id(),
        'the pointer target to receive focus'
    );

    const seat = global.stage.context.get_backend().get_default_seat();
    const pointer = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    const keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    const events = [];
    const beginId = global.display.connect('grab-op-begin', (_display, grabbed, op) => {
        events.push({kind: 'begin', id: grabbed.get_id(), op});
    });
    const endId = global.display.connect('grab-op-end', (_display, grabbed, op) => {
        events.push({kind: 'end', id: grabbed.get_id(), op});
    });

    try {
        let rect = frame(window);
        let area = workArea(window.get_workspace(), window.get_monitor());
        await pointerGrab({
            pointer,
            keyboard,
            button: 1,
            start: center(rect),
            end: {x: area.x + 1, y: area.y + area.height / 2},
        });
        await settle(500);
        assertNear(
            frame(window).x,
            area.x,
            4,
            `left-edge drop for window ${window.get_id()} should stay on the left`
        );
        assert(
            state.edgeTilingManager.isEdgeTiled(window),
            'the left-edge drop should remain registered as an edge tile'
        );

        state.edgeTilingManager.removeTile(window);
        await waitUntil(
            () => !state.edgeTilingManager.isEdgeTiled(window),
            'the left edge tile to restore'
        );
        await settle(500);

        area = workArea(window.get_workspace(), window.get_monitor());
        rect = frame(window);
        await pointerGrab({
            pointer,
            keyboard,
            button: 1,
            start: center(rect),
            end: {x: area.x + area.width - 2, y: area.y + area.height / 2},
        });
        await settle(500);
        const rightFrame = frame(window);
        assertNear(
            rightFrame.x + rightFrame.width,
            area.x + area.width,
            4,
            'a right-edge drop should stay on the right'
        );
        assert(
            state.edgeTilingManager.isEdgeTiled(window),
            'the right-edge drop should remain registered as an edge tile'
        );

        state.edgeTilingManager.removeTile(window);
        await waitUntil(
            () => !state.edgeTilingManager.isEdgeTiled(window),
            'the right edge tile to restore'
        );
        await settle(500);

        windows = await createWindows([
            {width: 340, height: 250},
            {width: 320, height: 240},
        ]);
        const targetWindow = windows.find(candidate => candidate.get_id() !== window.get_id());
        rect = frame(window);
        const targetBefore = frame(targetWindow);
        const distanceBefore = centerDistance(rect, targetBefore);
        await pointerGrab({
            pointer,
            keyboard,
            button: 1,
            start: center(rect),
            end: center(targetBefore),
        });
        await waitUntil(
            () =>
                events.some(event => event.kind === 'begin' && MOVE_OPS.has(event.op)) &&
                events.some(event => event.kind === 'end' && MOVE_OPS.has(event.op)),
            'a complete Mutter move grab'
        );
        await settle(700);
        assert(
            centerDistance(frame(window), targetBefore) < distanceBefore,
            'a multi-window drag should move the grabbed window toward the chosen layout slot'
        );

        const wmSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.wm.preferences'});
        const resizeButton = wmSettings.get_boolean('resize-with-right-button') ? 3 : 2;
        rect = frame(window);
        await pointerGrab({
            pointer,
            keyboard,
            button: resizeButton,
            start: {x: rect.x + rect.width - 20, y: rect.y + rect.height - 20},
            end: {x: rect.x + rect.width + 100, y: rect.y + rect.height + 70},
        });
        await waitUntil(
            () =>
                events.some(event => event.kind === 'begin' && isResizeOp(event.op)) &&
                events.some(event => event.kind === 'end' && isResizeOp(event.op)),
            'a complete Mutter resize grab'
        );
        await settle(1000);

        assert(!global.display.is_grabbed(), 'The compositor grab should be released');
        assert(state.grabHandler._draggedWindow === null, 'GrabHandler should release its window');
        assert(
            state.tilingManager._grabbedWindowId === null,
            'TilingManager should clear its grabbed window'
        );
        assertNonOverlapping(windows);
        for (const candidate of windows) {
            assertWithin(
                frame(candidate),
                workArea(candidate.get_workspace(), candidate.get_monitor()),
                `Window ${candidate.get_id()} should remain usable after pointer grabs`
            );
        }
    } finally {
        global.display.disconnect(beginId);
        global.display.disconnect(endId);
        // Keep the virtual cursor off Overview controls while the last window
        // closes. Otherwise Shell can arm a Dash label timeout for an actor its
        // own teardown immediately destroys.
        const [stageWidth, stageHeight] = global.stage.get_size();
        pointer.notify_absolute_motion(GLib.get_monotonic_time(), stageWidth / 2, stageHeight / 3);
        await settle(100);
        await destroyWindows();
    }
}
