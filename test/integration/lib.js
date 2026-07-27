// SPDX-License-Identifier: GPL-3.0-or-later

import Meta from 'gi://Meta';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';

export function assert(condition, message) {
    if (!condition) throw new Error(message);
}

export function assertEqual(actual, expected, message) {
    if (actual !== expected)
        throw new Error(`${message}: expected ${expected}, received ${actual}`);
}

export function assertNear(actual, expected, tolerance, message) {
    if (Math.abs(actual - expected) > tolerance)
        throw new Error(`${message}: expected ${expected}±${tolerance}, received ${actual}`);
}

export function activeWorkspace() {
    return global.workspace_manager.get_active_workspace();
}

export function normalWindows(workspace = null) {
    return global.display.get_tab_list(Meta.TabList.NORMAL, workspace ?? activeWorkspace());
}

export function allNormalWindows() {
    return global.display.get_tab_list(Meta.TabList.NORMAL, null);
}

export function frame(window) {
    const rect = window.get_frame_rect();
    return {x: rect.x, y: rect.y, width: rect.width, height: rect.height};
}

export function transformedFrame(window) {
    const actor = window.get_compositor_private();
    assert(actor && !actor.is_destroyed(), `Window ${window.get_id()} has no live actor`);
    // Full-size windows use Meta's committed frame as their layout geometry.
    // In headless Shell the actor allocation can retain a stale map-effect position
    // after animations are disabled, even though Mutter accepted the frame move.
    if (
        Math.abs(actor.scale_x - 1) < 0.01 &&
        Math.abs(actor.scale_y - 1) < 0.01 &&
        Math.abs(actor.translation_x) < 0.01 &&
        Math.abs(actor.translation_y) < 0.01
    )
        return frame(window);

    const [actorX, actorY] = actor.get_position();
    const [actorWidth, actorHeight] = actor.get_size();
    const [pivotX, pivotY] = actor.get_pivot_point();
    const frameRect = window.get_frame_rect();
    const bufferRect = window.get_buffer_rect();
    const frameOffsetX = frameRect.x - bufferRect.x;
    const frameOffsetY = frameRect.y - bufferRect.y;
    const x =
        actorX +
        pivotX * actorWidth * (1 - actor.scale_x) +
        actor.translation_x +
        frameOffsetX * actor.scale_x;
    const y =
        actorY +
        pivotY * actorHeight * (1 - actor.scale_y) +
        actor.translation_y +
        frameOffsetY * actor.scale_y;
    const width = frameRect.width * actor.scale_x;
    const height = frameRect.height * actor.scale_y;
    return {x, y, width, height};
}

export function workArea(workspace, monitor) {
    const rect = workspace.get_work_area_for_monitor(monitor);
    return {x: rect.x, y: rect.y, width: rect.width, height: rect.height};
}

export function rectsOverlap(a, b, tolerance = 2) {
    return !(
        a.x + a.width <= b.x + tolerance ||
        b.x + b.width <= a.x + tolerance ||
        a.y + a.height <= b.y + tolerance ||
        b.y + b.height <= a.y + tolerance
    );
}

export function assertWithin(rect, bounds, message) {
    const tolerance = 3;
    assert(rect.width > 0 && rect.height > 0, `${message}: non-positive size`);
    assert(
        rect.x >= bounds.x - tolerance &&
            rect.y >= bounds.y - tolerance &&
            rect.x + rect.width <= bounds.x + bounds.width + tolerance &&
            rect.y + rect.height <= bounds.y + bounds.height + tolerance,
        `${message}: ${JSON.stringify(rect)} is outside ${JSON.stringify(bounds)}`
    );
}

export function assertNonOverlapping(windows, geometry = frame) {
    for (let i = 0; i < windows.length; i++) {
        for (let j = i + 1; j < windows.length; j++) {
            const first = geometry(windows[i]);
            const second = geometry(windows[j]);
            assert(
                !rectsOverlap(first, second),
                `Windows ${windows[i].get_id()} and ${windows[j].get_id()} overlap: ` +
                    `${JSON.stringify(first)} vs ${JSON.stringify(second)}`
            );
        }
    }
}

export async function waitUntil(predicate, message, timeoutMs = 5000) {
    const deadline = GLib.get_monotonic_time() + timeoutMs * 1000;
    let lastError = null;

    while (GLib.get_monotonic_time() < deadline) {
        try {
            if (predicate()) return;
        } catch (error) {
            lastError = error;
        }
        await Scripting.sleep(25);
    }

    if (lastError) throw lastError;
    throw new Error(`Timed out: ${message}`);
}

export async function settle(milliseconds = 250) {
    await Scripting.sleep(milliseconds);
    await Scripting.waitLeisure();
}

export async function createWindows(configs) {
    for (const config of configs) await Scripting.createTestWindow(config);
    await Scripting.waitTestWindows();
    await waitUntil(
        () => normalWindows().length >= configs.length,
        `${configs.length} test windows to appear`
    );
    await settle(1200);
    return normalWindows();
}

export async function destroyWindows() {
    await Scripting.destroyTestWindows();
    await waitUntil(() => allNormalWindows().length === 0, 'test windows to close');
    // Let close-animation callbacks (including Continuum's empty-workspace
    // Overview decision) finish before the automation script tears Shell down.
    await settle(500);
}

export async function closeWindow(window) {
    const id = window.get_id();
    const workspace = window.get_workspace();
    window.delete(global.get_current_time());
    await waitUntil(
        () => !normalWindows(workspace).some(candidate => candidate.get_id() === id),
        `window ${id} to close`
    );
    await settle();
}

export function hideOverview() {
    Main.overview.hide();
}

export function showOverview() {
    Main.overview.show();
}

export {Main, Meta, Scripting};
