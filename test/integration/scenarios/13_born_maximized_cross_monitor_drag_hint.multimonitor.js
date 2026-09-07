// SPDX-License-Identifier: GPL-3.0-or-later

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import {
    Main,
    Scripting,
    allNormalWindows,
    assert,
    assertNear,
    destroyWindows,
    frame,
    settle,
    waitUntil,
    workArea,
} from '../lib.js';

export const METRICS = {};

const UUID = 'continuum@gabrielpalassi.github.io';
function center(rect) {
    return {x: rect.x + rect.width / 2, y: rect.y + rect.height / 2};
}

function paintedHintIn(drawingManager, area, requireTopmost) {
    return drawingManager._boxes.some(box => {
        if (!box.visible) return false;
        const [x, y] = box.get_position();
        const [width, height] = box.get_size();
        const hintCenter = {x: x + width / 2, y: y + height / 2};
        const isInArea =
            hintCenter.x >= area.x &&
            hintCenter.x < area.x + area.width &&
            hintCenter.y >= area.y &&
            hintCenter.y < area.y + area.height;
        if (!isInArea) return false;
        if (!requireTopmost) return true;

        const paintedActor = global.stage.get_actor_at_pos(
            Clutter.PickMode.ALL,
            hintCenter.x,
            hintCenter.y
        );
        return paintedActor === box || (paintedActor && box.contains(paintedActor));
    });
}

export async function runScenario({expectAnimation = false} = {}) {
    await waitUntil(
        () => Main.extensionManager.lookup(UUID)?.state === 1,
        'extension to finish enabling'
    );
    assert(global.display.get_n_monitors() === 2, 'The scenario requires two monitors');

    const state = Main.extensionManager.lookup(UUID).stateObj;
    await Scripting.createTestWindow({width: 360, height: 260, maximized: true});
    await Scripting.waitTestWindows();
    await waitUntil(() => allNormalWindows().length === 1, 'the first window to appear');
    await settle(1200);

    await Scripting.createTestWindow({width: 360, height: 260, maximized: true});
    await Scripting.waitTestWindows();
    await waitUntil(() => allNormalWindows().length === 2, 'the second window to appear');
    await settle(1200);
    Main.overview.hide();
    await waitUntil(() => !Main.overview.visible, 'Overview to close before the drag');

    const windows = allNormalWindows();
    const primaryMonitor = global.display.get_primary_monitor();
    const dragged = windows.find(window => window.get_monitor() !== primaryMonitor);
    const primaryWindow = windows.find(window => window.get_monitor() === primaryMonitor);

    assert(
        dragged?.is_maximized(),
        'One born-maximized window should open on the secondary monitor'
    );
    assert(
        primaryWindow?.is_maximized(),
        'One born-maximized window should remain on the primary monitor'
    );

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
        await Scripting.sleep(200);
    }

    let simulatedGrab = false;
    let dragPollingStopped = true;
    try {
        pointer.notify_absolute_motion(GLib.get_monotonic_time(), start.x, start.y);
        await Scripting.sleep(100);
        pointer.notify_absolute_motion(GLib.get_monotonic_time(), start.x, start.y);
        await Scripting.sleep(100);
        state.grabHandler.onGrabOpBegin(global.display, dragged, Meta.GrabOp.MOVING);
        simulatedGrab = true;
        // Mutter restores a maximized window as soon as a headerbar drag starts.
        // The injected grab callback above cannot trigger that compositor behavior,
        // so reproduce it explicitly before driving the pointer path.
        dragged.unmaximize();
        await waitUntil(() => !dragged.is_maximized(), 'the dragged window to restore');
        const restored = frame(dragged);
        dragged.move_resize_frame(
            false,
            restored.x,
            restored.y,
            primaryArea.width + 120,
            primaryArea.height + 120
        );
        await waitUntil(() => {
            const current = frame(dragged);
            return current.width > primaryArea.width || current.height > primaryArea.height;
        }, 'the restored drag frame to exceed the destination work area');
        await movePointer(center(sourceArea));
        await waitUntil(
            () => state.grabHandler._reorderingActive,
            'mosaic reordering to start after the headerbar restore'
        );

        // Sampling both sides of the seam is essential: a direct jump skips the
        // edge-zone transition involved in the original failure.
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
            () => state.grabHandler._dragMonitorId === primaryMonitor,
            'drag previews to follow the pointer onto the primary monitor'
        );
        if (expectAnimation) {
            await waitUntil(
                () => state.grabHandler._chosenLayout !== null,
                'the destination drag layout to be selected'
            );
        } else {
            await waitUntil(
                () => paintedHintIn(state.drawingManager, primaryArea, true),
                'the mosaic hint to be painted above the primary-monitor window'
            );
        }

        // A newer pointer event can arrive before the previous position idle runs.
        // The trailing destination update must win instead of leaving the older
        // source-monitor edge preview painted until the pointer moves again.
        pointer.notify_absolute_motion(GLib.get_monotonic_time(), sourceSeam.x, sourceSeam.y);
        state.grabHandler._onDragPositionChanged();
        pointer.notify_absolute_motion(GLib.get_monotonic_time(), destination.x, destination.y);
        state.grabHandler._onDragPositionChanged();
        await Scripting.sleep(300);
        assert(
            state.grabHandler._currentZone === 0 &&
                !state.drawingManager._tilePreview?.visible &&
                (expectAnimation || paintedHintIn(state.drawingManager, primaryArea, true)),
            'A stale source-monitor position idle must not outlive the destination update'
        );

        // This scenario owns preview visibility and pointer-update ordering. The
        // animated companion below owns release geometry and transition behavior.
        if (!expectAnimation) {
            state.grabHandler.onGrabOpEnd(global.display, dragged, Meta.GrabOp.MOVING);
            simulatedGrab = false;
            await settle(750);
            return;
        }

        const hintedRect = {...state.grabHandler._chosenLayout.draggedRect};
        await waitUntil(() => {
            if (dragged.get_monitor() === primaryMonitor) return true;
            dragged.move_frame(false, primaryArea.x, primaryArea.y);
            return false;
        }, 'the held frame to cross onto the primary monitor');
        Main.overview.hide();
        await waitUntil(() => !Main.overview.visible, 'Overview to stay closed for the drop');
        const draggedActor = dragged.get_compositor_private();
        state.grabHandler.onGrabOpEnd(global.display, dragged, Meta.GrabOp.MOVING);
        simulatedGrab = false;

        await waitUntil(
            () =>
                Math.abs(draggedActor.scale_x - 1) > 0.01 ||
                Math.abs(draggedActor.scale_y - 1) > 0.01,
            'the released window resize animation to start'
        );
        try {
            await waitUntil(() => {
                const placed = frame(dragged);
                return (
                    Math.abs(placed.x - hintedRect.x) <= 3 &&
                    Math.abs(placed.y - hintedRect.y) <= 3 &&
                    Math.abs(placed.width - hintedRect.width) <= 3 &&
                    Math.abs(placed.height - hintedRect.height) <= 3
                );
            }, 'the released window to take the hinted geometry');
        } catch (error) {
            throw new Error(
                `${error.message}; hinted=${JSON.stringify(hintedRect)}, actual=${JSON.stringify(frame(dragged))}`
            );
        }
        const placed = frame(dragged);
        assertNear(placed.x, hintedRect.x, 3, 'Released x should match the hint');
        assertNear(placed.y, hintedRect.y, 3, 'Released y should match the hint');
        assertNear(placed.width, hintedRect.width, 3, 'Released width should match the hint');
        assertNear(placed.height, hintedRect.height, 3, 'Released height should match the hint');
        await waitUntil(
            () => primaryWindow.get_monitor() !== primaryMonitor,
            'the displaced maximized window to settle on the vacated monitor'
        );
        await waitUntil(
            () =>
                Math.abs(draggedActor.scale_x - 1) <= 0.01 &&
                Math.abs(draggedActor.scale_y - 1) <= 0.01,
            'the released window resize animation to finish'
        );
        await settle(500);
    } finally {
        if (simulatedGrab) {
            state.grabHandler.onGrabOpEnd(global.display, dragged, Meta.GrabOp.MOVING);
            dragPollingStopped = state.grabHandler._dragPositionPollId === 0;
        }
        await destroyWindows();
        assert(dragPollingStopped, 'Drag position polling should stop when the grab ends');
    }
}

export async function run() {
    await runScenario();
}
