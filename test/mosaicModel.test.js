// SPDX-License-Identifier: GPL-3.0-or-later

import assert from 'node:assert/strict';
import test from 'node:test';
import {MosaicModel} from '../src/mosaicModel.js';

const workspace = index => ({index: () => index});
const windowWith = (id, frame = null, workspaceIndex = 0, monitor = 0) => ({
    get_frame_rect: () => frame,
    get_id: () => id,
    get_monitor: () => monitor,
    get_workspace: () => workspace(workspaceIndex),
});

test.beforeEach(() => MosaicModel.clear());
test.after(() => MosaicModel.clear());

test('stored slots are snapshots rather than aliases of mutable layout objects', () => {
    const window = windowWith(1);
    const slot = {x: 10, y: 20, width: 300, height: 200};

    MosaicModel.setSlot(window, slot, workspace(0), 0);
    slot.x = 999;

    assert.deepEqual(MosaicModel.slotFor(window), {x: 10, y: 20, width: 300, height: 200});
});

test('reading a slot cannot mutate authoritative layout intent', () => {
    const window = windowWith(101);
    MosaicModel.setSlot(window, {x: 10, y: 20, width: 300, height: 200}, workspace(0), 0);

    const exposedSlot = MosaicModel.slotFor(window);
    exposedSlot.x = 999;
    exposedSlot.width = 0;

    assert.deepEqual(
        MosaicModel.slotFor(window),
        {x: 10, y: 20, width: 300, height: 200},
        'Callers must not be able to corrupt model geometry without an explicit write'
    );
});

test('query results cannot mutate authoritative layout intent', () => {
    const window = windowWith(102);
    MosaicModel.setSlot(window, {x: 10, y: 20, width: 300, height: 200}, workspace(0), 0);

    const [entry] = MosaicModel.entriesFor(workspace(0), 0);
    entry.slot.height = -1;

    assert.deepEqual(
        MosaicModel.slotFor(window),
        {x: 10, y: 20, width: 300, height: 200},
        'Renderer-facing query results must not expose mutable model storage'
    );
});

test('layout intent takes precedence over transient frame geometry', () => {
    const window = windowWith(2, {x: 1, y: 2, width: 3, height: 4});
    MosaicModel.setSlot(window, {x: 40, y: 50, width: 600, height: 300}, workspace(0), 0);

    assert.deepEqual(MosaicModel.geometryOf(window), {
        x: 40,
        y: 50,
        width: 600,
        height: 300,
    });
});

test('frame geometry is used when no computed layout exists', () => {
    const frame = {x: 7, y: 8, width: 90, height: 100};

    assert.deepEqual(MosaicModel.geometryOf(windowWith(3, frame)), frame);
    assert.equal(MosaicModel.geometryOf({get_id: () => 4}), null);
});

test('slots survive wrapper replacement because identity is based on window ID', () => {
    const firstWrapper = windowWith(5);
    const replacementWrapper = windowWith(5);

    MosaicModel.setSlot(firstWrapper, {x: 5, y: 6, width: 70, height: 80}, workspace(0), 0);

    assert.deepEqual(MosaicModel.slotFor(replacementWrapper), {
        x: 5,
        y: 6,
        width: 70,
        height: 80,
    });
});

test('workspace and monitor queries return only their own layout entries', () => {
    const first = windowWith(10);
    const second = windowWith(11);
    const third = windowWith(12);
    MosaicModel.setSlot(first, {x: 1, y: 1, width: 10, height: 10}, workspace(0), 0);
    MosaicModel.setSlot(second, {x: 2, y: 2, width: 20, height: 20}, workspace(0), 1);
    MosaicModel.setSlot(third, {x: 3, y: 3, width: 30, height: 30}, workspace(1), 0);

    assert.deepEqual(MosaicModel.entriesFor(workspace(0), 0), [
        {window: first, slot: {x: 1, y: 1, width: 10, height: 10}},
    ]);
});

test('learning a client resize updates the intended geometry', () => {
    const window = windowWith(20);
    MosaicModel.setSlot(window, {x: 0, y: 0, width: 100, height: 100}, workspace(0), 0);

    MosaicModel.learn(window, {x: 25, y: 30, width: 450, height: 250});

    assert.deepEqual(MosaicModel.slotFor(window), {
        x: 25,
        y: 30,
        width: 450,
        height: 250,
    });
});

test('invalid geometry cannot replace the last usable layout intent', () => {
    const window = windowWith(21);
    const valid = {x: 25, y: 30, width: 450, height: 250};
    MosaicModel.setSlot(window, valid, workspace(0), 0);

    const invalidFrames = [
        {x: 25, y: 30, width: 0, height: 250},
        {x: 25, y: 30, width: 450, height: -1},
        {x: Number.NaN, y: 30, width: 450, height: 250},
        {x: 25, y: Number.POSITIVE_INFINITY, width: 450, height: 250},
    ];
    for (const invalid of invalidFrames) {
        MosaicModel.learn(window, invalid);
        assert.deepEqual(
            MosaicModel.slotFor(window),
            valid,
            `Invalid learned geometry must not poison layout intent: ${JSON.stringify(invalid)}`
        );
    }
});

test('invalid computed slots are rejected instead of becoming renderer geometry', () => {
    const window = windowWith(22, {x: 1, y: 2, width: 300, height: 200});

    MosaicModel.setSlot(window, {x: 0, y: 0, width: 0, height: 200}, workspace(0), 0);

    assert.deepEqual(
        MosaicModel.geometryOf(window),
        {x: 1, y: 2, width: 300, height: 200},
        'A non-positive computed slot should fall back to the last usable frame'
    );
});

test('forgetting a window removes stale layout intent', () => {
    const first = windowWith(30);
    MosaicModel.setSlot(first, {x: 0, y: 0, width: 10, height: 10}, workspace(0), 0);

    MosaicModel.forget(first);

    assert.equal(MosaicModel.slotFor(first), null);
});

test('reusing a window ID refreshes its wrapper, workspace, and monitor ownership atomically', () => {
    const oldWrapper = windowWith(50);
    const newWrapper = windowWith(50);
    MosaicModel.setSlot(oldWrapper, {x: 0, y: 0, width: 100, height: 100}, workspace(0), 0);
    MosaicModel.setSlot(newWrapper, {x: 500, y: 0, width: 200, height: 200}, workspace(2), 1);

    assert.deepEqual(MosaicModel.entriesFor(workspace(0), 0), []);
    assert.deepEqual(MosaicModel.entriesFor(workspace(2), 1), [
        {window: newWrapper, slot: {x: 500, y: 0, width: 200, height: 200}},
    ]);
});

test('windows without an ID are ignored safely', () => {
    const invalidWindow = {};

    MosaicModel.setSlot(invalidWindow, {x: 0, y: 0, width: 10, height: 10}, workspace(0), 0);
    MosaicModel.learn(invalidWindow, {x: 1, y: 1, width: 20, height: 20});
    MosaicModel.forget(invalidWindow);

    assert.equal(MosaicModel.slotFor(invalidWindow), null);
});
