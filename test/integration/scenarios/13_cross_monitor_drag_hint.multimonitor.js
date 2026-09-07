// SPDX-License-Identifier: GPL-3.0-or-later

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import {
    Main,
    Scripting,
    assert,
    assertNear,
    createWindows,
    destroyWindows,
    frame,
    waitUntil,
    workArea,
} from '../lib.js';

export const METRICS = {};

const UUID = 'continuum@gabrielpalassi.github.io';
function center(rect) {
    return {x: rect.x + rect.width / 2, y: rect.y + rect.height / 2};
}

function visibleHintIn(drawingManager, area) {
    return drawingManager._boxes.some(box => {
        if (!box.visible) return false;
        const [x, y] = box.get_position();
        const [width, height] = box.get_size();
        const hintCenter = {x: x + width / 2, y: y + height / 2};
        return (
            hintCenter.x >= area.x &&
            hintCenter.x < area.x + area.width &&
            hintCenter.y >= area.y &&
            hintCenter.y < area.y + area.height
        );
    });
}

export async function run() {
    await waitUntil(
        () => Main.extensionManager.lookup(UUID)?.state === 1,
        'extension to finish enabling'
    );
    assert(global.display.get_n_monitors() === 2, 'The scenario requires two monitors');

    const state = Main.extensionManager.lookup(UUID).stateObj;
    const windows = await createWindows([
        {width: 360, height: 260},
        {width: 360, height: 260},
    ]);
    const primaryMonitor = global.display.get_primary_monitor();
    const dragged = windows.find(window => window.get_monitor() !== primaryMonitor);
    const primaryWindow = windows.find(window => window.get_monitor() === primaryMonitor);

    assert(dragged, 'One window should open on the secondary monitor');
    assert(primaryWindow, 'One window should remain on the primary monitor');

    dragged.activate(global.get_current_time());
    await waitUntil(
        () => global.display.get_focus_window()?.get_id() === dragged.get_id(),
        'the secondary-monitor window to receive focus'
    );

    const seat = global.stage.context.get_backend().get_default_seat();
    const pointer = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    const startFrame = frame(dragged);
    const start = {x: startFrame.x + startFrame.width / 2, y: startFrame.y + 12};
    const sourceArea = workArea(dragged.get_workspace(), dragged.get_monitor());
    const primaryArea = workArea(dragged.get_workspace(), primaryMonitor);
    const destination = center(primaryArea);
    const sourceSeam = {x: sourceArea.x + 1, y: sourceArea.y + sourceArea.height / 2};
    const primarySeam = {
        x: primaryArea.x + primaryArea.width - 2,
        y: primaryArea.y + primaryArea.height / 2,
    };

    async function movePointer(position) {
        pointer.notify_absolute_motion(GLib.get_monotonic_time(), position.x, position.y);
        await Scripting.sleep(100);
        state.grabHandler._onDragPositionChanged();
        await Scripting.sleep(100);
    }

    let simulatedGrab = false;
    try {
        pointer.notify_absolute_motion(GLib.get_monotonic_time(), start.x, start.y);
        await Scripting.sleep(100);
        pointer.notify_absolute_motion(GLib.get_monotonic_time(), start.x, start.y);
        await Scripting.sleep(100);
        state.grabHandler.onGrabOpBegin(global.display, dragged, Meta.GrabOp.MOVING);
        simulatedGrab = true;
        // Headless Shell cannot initiate a compositor grab by clicking a window on
        // the second virtual monitor, so inject the real grab callback and then
        // drive the same pointer-position path. Sampling both sides of the seam is
        // essential: a direct jump skips the edge-zone transition that caused the bug.
        await movePointer(sourceSeam);
        assert(
            state.grabHandler._currentZone !== 0,
            'Approaching the seam should enter the source-monitor edge zone'
        );
        await movePointer(primarySeam);
        assert(
            state.grabHandler._currentZone !== 0,
            'Crossing the seam should enter the primary-monitor edge zone'
        );
        await movePointer(destination);

        await waitUntil(
            () => global.display.get_current_monitor() === primaryMonitor,
            'the pointer to enter the primary monitor'
        );
        await waitUntil(
            () => visibleHintIn(state.drawingManager, primaryArea),
            'a visible mosaic hint on the primary monitor while the grab is active'
        );

        const hintedRect = {...state.grabHandler._chosenLayout.draggedRect};
        assert(
            dragged.get_monitor() !== primaryMonitor,
            'The frame should still belong to the source monitor before release'
        );
        state.grabHandler.onGrabOpEnd(global.display, dragged, Meta.GrabOp.MOVING);
        simulatedGrab = false;

        await waitUntil(
            () => dragged.get_monitor() === primaryMonitor,
            'the selected destination hint to own the cross-monitor drop'
        );
        await waitUntil(() => {
            const placed = frame(dragged);
            return (
                Math.abs(placed.x - hintedRect.x) <= 3 &&
                Math.abs(placed.y - hintedRect.y) <= 3 &&
                Math.abs(placed.width - hintedRect.width) <= 3 &&
                Math.abs(placed.height - hintedRect.height) <= 3
            );
        }, 'the released window to take the selected destination geometry');
        const placed = frame(dragged);
        assertNear(placed.x, hintedRect.x, 3, 'Released x should match the hint');
        assertNear(placed.y, hintedRect.y, 3, 'Released y should match the hint');
        assertNear(placed.width, hintedRect.width, 3, 'Released width should match the hint');
        assertNear(placed.height, hintedRect.height, 3, 'Released height should match the hint');
    } finally {
        if (simulatedGrab)
            state.grabHandler.onGrabOpEnd(global.display, dragged, Meta.GrabOp.MOVING);
        await destroyWindows();
    }
}
