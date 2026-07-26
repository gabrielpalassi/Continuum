// SPDX-License-Identifier: GPL-3.0-or-later

import assert from 'node:assert/strict';
import test from 'node:test';
import {
    enumerateTileSlots,
    orderWindowsByMru,
    planResizeFit,
    restoreBeforeRearrange,
} from '../src/layoutPlanning.js';

const windowWithId = id => ({get_id: () => id});

test('restore-first orchestration skips the ordinary rearrangement after a restore', () => {
    let layouts = 0;

    const restored = restoreBeforeRearrange(
        () => {
            // restoreMiniature emits synchronously; its listener owns this layout.
            layouts++;
            return true;
        },
        () => layouts++
    );

    assert.equal(restored, true);
    assert.equal(layouts, 1);
});

test('restore-first orchestration rearranges exactly once when nothing can be restored', () => {
    let rearrangements = 0;

    const restored = restoreBeforeRearrange(
        () => false,
        () => rearrangements++
    );

    assert.equal(restored, false);
    assert.equal(rearrangements, 1);
});

test('restore-first orchestration asks for restoration before attempting a rearrangement', () => {
    const calls = [];

    restoreBeforeRearrange(
        () => {
            calls.push('restore');
            return false;
        },
        () => calls.push('rearrange')
    );

    assert.deepEqual(calls, ['restore', 'rearrange']);
});

test('MRU ordering is deterministic and supports both restoration and sacrifice order', () => {
    const windows = [windowWithId(30), windowWithId(10), windowWithId(20)];
    const mru = new Map([
        [20, 0],
        [10, 1],
    ]);

    assert.deepEqual(
        orderWindowsByMru(windows, mru).map(window => window.get_id()),
        [20, 10, 30]
    );
    assert.deepEqual(
        orderWindowsByMru(windows, mru, {mostRecentFirst: false}).map(window => window.get_id()),
        [30, 10, 20]
    );
});

test('MRU ordering does not mutate the caller-owned window list', () => {
    const windows = [windowWithId(3), windowWithId(1), windowWithId(2)];
    const original = [...windows];

    const ordered = orderWindowsByMru(
        windows,
        new Map([
            [2, 0],
            [1, 1],
        ])
    );

    assert.deepEqual(windows, original);
    assert.notEqual(ordered, windows);
});

test('MRU ordering is deterministic when history is absent or ranks are tied', () => {
    const windows = [windowWithId(8), windowWithId(2), windowWithId(5)];

    assert.deepEqual(
        orderWindowsByMru(windows, null).map(window => window.get_id()),
        [2, 5, 8]
    );
    assert.deepEqual(
        orderWindowsByMru(
            windows,
            new Map([
                [8, 0],
                [2, 0],
                [5, 0],
            ])
        ).map(window => window.get_id()),
        [2, 5, 8]
    );
});

test('least-recent ordering sacrifices windows with no history before known windows', () => {
    const windows = [windowWithId(10), windowWithId(20), windowWithId(30)];
    const mru = new Map([
        [10, 0],
        [20, 1],
    ]);

    assert.deepEqual(
        orderWindowsByMru(windows, mru, {mostRecentFirst: false}).map(window => window.get_id()),
        [30, 20, 10]
    );
});

test('horizontal tile slots preserve shelf order, spacing, and vertical centering', () => {
    const first = {id: 1, width: 100, height: 40};
    const second = {id: 2, width: 80, height: 60};
    const third = {id: 3, width: 70, height: 50};
    const tileInfo = {
        vertical: false,
        y: 20,
        levels: [
            {x: 10, width: 188, height: 80, windows: [first, second]},
            {x: 30, width: 70, height: 50, windows: [third]},
        ],
    };

    assert.deepEqual(enumerateTileSlots(tileInfo, {x: 0, y: 0, width: 400, height: 240}, 8), [
        {
            descriptor: first,
            orientation: 'H',
            rect: {x: 10, y: 60, width: 100, height: 40},
        },
        {
            descriptor: second,
            orientation: 'H',
            rect: {x: 118, y: 40, width: 80, height: 60},
        },
        {
            descriptor: third,
            orientation: 'H',
            rect: {x: 30, y: 108, width: 70, height: 50},
        },
    ]);
});

test('vertical tile slots preserve shelf order and explicit target coordinates', () => {
    const first = {id: 1, width: 100, height: 40};
    const second = {id: 2, width: 80, height: 60, targetX: 175, targetY: 95};
    const third = {id: 3, width: 70, height: 50};
    const tileInfo = {
        vertical: true,
        x: 20,
        levels: [
            {y: 10, width: 120, height: 108, windows: [first, second]},
            {y: 30, width: 70, height: 50, windows: [third]},
        ],
    };

    assert.deepEqual(enumerateTileSlots(tileInfo, {x: 0, y: 0, width: 400, height: 240}, 8), [
        {
            descriptor: first,
            orientation: 'V',
            rect: {x: 20, y: 10, width: 100, height: 40},
        },
        {
            descriptor: second,
            orientation: 'V',
            rect: {x: 175, y: 95, width: 80, height: 60},
        },
        {
            descriptor: third,
            orientation: 'V',
            rect: {x: 148, y: 30, width: 70, height: 50},
        },
    ]);
});

test('tile slot enumeration does not mutate layout descriptors', () => {
    const descriptor = {id: 1, width: 100, height: 40, targetX: 25};
    const tileInfo = {
        vertical: true,
        x: 20,
        levels: [{y: 10, width: 100, height: 40, windows: [descriptor]}],
    };
    const original = JSON.parse(JSON.stringify(tileInfo));

    enumerateTileSlots(tileInfo, {x: 0, y: 0, width: 400, height: 240}, 8);

    assert.deepEqual(tileInfo, original);
});

test('MRU ordering remains deterministic when cached ranks are stale or non-finite', () => {
    const ids = [13, 2, 8, 5];
    const staleMru = new Map([
        [13, Number.NaN],
        [2, Number.POSITIVE_INFINITY],
        [8, Number.NEGATIVE_INFINITY],
    ]);
    const permutations = [ids, [...ids].reverse(), [8, 13, 5, 2], [5, 2, 13, 8]];

    for (const permutation of permutations) {
        const ordered = orderWindowsByMru(permutation.map(windowWithId), staleMru).map(window =>
            window.get_id()
        );
        assert.deepEqual(
            ordered,
            [2, 5, 8, 13],
            'Invalid cached ranks should be treated as unknown rather than destabilizing layout order'
        );
    }
});

test('fit planning returns the preferred sizes without probing smaller scales when they fit', () => {
    const probes = [];
    const plan = planResizeFit({
        buildSizes: scale => [{width: 100 * scale}],
        overflows: sizes => {
            probes.push(sizes[0].width);
            return sizes[0].width > 100;
        },
    });

    assert.equal(plan.kind, 'natural');
    assert.equal(plan.scale, 1);
    assert.deepEqual(probes, [100]);
});

test('fit planning does not shrink windows while a resize grab forbids scaling', () => {
    const probes = [];
    const plan = planResizeFit({
        buildSizes: scale => [{width: 50 + 100 * scale}],
        overflows: sizes => {
            probes.push(sizes[0].width);
            return sizes[0].width > 100;
        },
        allowScaling: false,
    });

    assert.equal(plan.kind, 'scaling-blocked');
    assert.deepEqual(probes, [150]);
});

test('fit planning distinguishes impossible layouts from layouts that fit after scaling', () => {
    const impossible = planResizeFit({
        buildSizes: scale => [{width: 120 + 80 * scale}],
        overflows: sizes => sizes[0].width > 100,
    });
    assert.equal(impossible.kind, 'impossible');

    const scaled = planResizeFit({
        buildSizes: scale => [{width: 50 + 100 * scale}],
        overflows: sizes => sizes[0].width > 100,
        iterations: 16,
    });
    assert.equal(scaled.kind, 'scaled');
    assert.ok(Math.abs(scaled.scale - 0.5) < 0.001);
    assert.ok(scaled.sizes[0].width <= 100);
});

test('fit planning treats an exact work-area boundary as a natural fit', () => {
    const plan = planResizeFit({
        buildSizes: scale => [{width: 400 * scale, height: 100 * scale}],
        overflows: ([size]) => size.width > 400 || size.height > 100,
    });

    assert.deepEqual(plan, {
        kind: 'natural',
        scale: 1,
        sizes: [{width: 400, height: 100}],
    });
});

test('fit planning returns the largest non-overflowing scale to configured precision', () => {
    const iterations = 20;
    const plan = planResizeFit({
        buildSizes: scale => [{width: 25 + 200 * scale}],
        overflows: ([size]) => size.width > 125,
        iterations,
    });

    assert.equal(plan.kind, 'scaled');
    assert.ok(plan.scale <= 0.5);
    assert.ok(0.5 - plan.scale <= 2 ** -iterations);
    assert.ok(plan.sizes[0].width <= 125);
});

test('fit planning reports the minimum attempted sizes when no scale can fit', () => {
    const minimum = [{width: 401, height: 101}];
    const plan = planResizeFit({
        buildSizes: scale => {
            return scale === 0 ? minimum : [{width: 500, height: 200}];
        },
        overflows: ([size]) => size.width > 400 || size.height > 100,
    });

    assert.equal(plan.kind, 'impossible');
    assert.equal(plan.scale, null);
    assert.equal(plan.sizes, minimum);
});

test('fit planning preserves its safety invariants across many size thresholds', () => {
    let seed = 0x5eed1234;
    const random = () => {
        seed = (1664525 * seed + 1013904223) >>> 0;
        return seed / 2 ** 32;
    };

    for (let sample = 0; sample < 250; sample++) {
        const minimum = 1 + Math.floor(random() * 200);
        const growth = 1 + Math.floor(random() * 800);
        const expectedScale = 0.01 + random() * 0.98;
        const capacity = minimum + growth * expectedScale;
        const probes = [];
        const plan = planResizeFit({
            buildSizes: scale => {
                probes.push(scale);
                return [{width: minimum + growth * scale}];
            },
            overflows: ([size]) => size.width > capacity,
            iterations: 24,
        });

        assert.equal(plan.kind, 'scaled');
        assert.ok(plan.scale >= 0 && plan.scale <= 1, 'Scale must remain normalized');
        assert.ok(plan.sizes[0].width <= capacity, 'Chosen sizes must fit');
        assert.ok(
            expectedScale - plan.scale <= 2 ** -24,
            'Binary search must return the largest safe scale to its configured precision'
        );
        assert.ok(
            probes.every(scale => scale >= 0 && scale <= 1),
            'Probes must remain normalized'
        );
    }
});
