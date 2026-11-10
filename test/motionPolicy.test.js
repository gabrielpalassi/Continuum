// SPDX-License-Identifier: GPL-3.0-or-later

import assert from 'node:assert/strict';
import test from 'node:test';
import {allowsMotion, animationDuration} from '../src/motionPolicy.js';

const REDUCE = 1;
const NO_PREFERENCE = 0;

test('Shell 50 keeps motion enabled when the reduced-motion API is absent', () => {
    const settings = {enable_animations: true};
    assert.equal(allowsMotion(settings), true);
    assert.equal(animationDuration(250, settings), 250);
});

test('reduced motion suppresses custom movement even when animations remain enabled', () => {
    const settings = {enable_animations: true, reduced_motion: REDUCE, slow_down_factor: 2};
    assert.equal(allowsMotion(settings, REDUCE), false);
    assert.equal(animationDuration(250, settings, REDUCE), 0);
});

test('disabling animations takes precedence over the reduced-motion preference', () => {
    for (const reducedMotion of [undefined, NO_PREFERENCE, REDUCE]) {
        const settings = {enable_animations: false, reduced_motion: reducedMotion};
        assert.equal(allowsMotion(settings, REDUCE), false);
        assert.equal(animationDuration(250, settings, REDUCE), 0);
    }
});

test('ordinary motion honors the Shell slowdown factor and rounds to milliseconds', () => {
    const settings = {
        enable_animations: true,
        reduced_motion: NO_PREFERENCE,
        slow_down_factor: 1.25,
    };
    assert.equal(allowsMotion(settings, REDUCE), true);
    assert.equal(animationDuration(250, settings, REDUCE), 313);
});

test('a preference change applies to the next animation without cached settings', () => {
    const settings = {enable_animations: true, reduced_motion: NO_PREFERENCE};
    assert.equal(animationDuration(250, settings, REDUCE), 250);
    settings.reduced_motion = REDUCE;
    assert.equal(animationDuration(250, settings, REDUCE), 0);
    settings.reduced_motion = NO_PREFERENCE;
    assert.equal(animationDuration(250, settings, REDUCE), 250);
});
