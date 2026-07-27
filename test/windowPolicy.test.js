// SPDX-License-Identifier: GPL-3.0-or-later

import assert from 'node:assert/strict';
import test from 'node:test';
import {isWindowAlive, isWorkspaceAlive} from '../src/shellState.js';
import * as ShellState from '../src/shellState.js';

test('window state supports the complete set/get/has/remove lifecycle', () => {
    const window = {};

    assert.equal(ShellState.get(window, 'flag'), undefined);
    assert.equal(ShellState.has(window, 'flag'), false);

    ShellState.set(window, 'flag', false);
    assert.equal(ShellState.get(window, 'flag'), false);
    assert.equal(ShellState.has(window, 'flag'), true);

    ShellState.remove(window, 'flag');
    assert.equal(ShellState.get(window, 'flag'), undefined);
    assert.equal(ShellState.has(window, 'flag'), false);
});

test('window state remains isolated between windows', () => {
    const first = {};
    const second = {};

    ShellState.set(first, ShellState.IS_MINIATURE, true);
    ShellState.set(second, ShellState.IS_MINIATURE, false);

    assert.equal(ShellState.get(first, ShellState.IS_MINIATURE), true);
    assert.equal(ShellState.get(second, ShellState.IS_MINIATURE), false);
});

test('clearing a window removes all state without affecting another window', () => {
    const first = {};
    const second = {};
    ShellState.set(first, 'one', 1);
    ShellState.set(first, 'two', 2);
    ShellState.set(second, 'one', 3);

    ShellState.clear(first);

    assert.equal(ShellState.get(first, 'one'), undefined);
    assert.equal(ShellState.get(first, 'two'), undefined);
    assert.equal(ShellState.get(second, 'one'), 3);
});

test('window liveness requires a compositor actor that has not been destroyed', () => {
    assert.equal(isWindowAlive(null), false);
    assert.equal(isWindowAlive({get_compositor_private: () => null}), false);
    assert.equal(
        isWindowAlive({get_compositor_private: () => ({is_destroyed: () => true})}),
        false
    );
    assert.equal(
        isWindowAlive({get_compositor_private: () => ({is_destroyed: () => false})}),
        true
    );
});

test('window liveness treats disposal-time native errors as dead windows', () => {
    const disposedWindow = {
        get_compositor_private: () => {
            throw new Error('Object Meta.Window has already been disposed');
        },
    };
    const disposedActor = {
        get_compositor_private: () => ({
            is_destroyed: () => {
                throw new Error('Object Clutter.Actor has already been disposed');
            },
        }),
    };

    assert.doesNotThrow(() => isWindowAlive(disposedWindow));
    assert.equal(isWindowAlive(disposedWindow), false);
    assert.doesNotThrow(() => isWindowAlive(disposedActor));
    assert.equal(isWindowAlive(disposedActor), false);
});

test('workspace liveness uses manager membership and avoids native workspace lookup', () => {
    const first = {};
    const second = {
        index: () => {
            throw new Error('Removed workspaces must not be queried');
        },
    };
    const manager = {
        get_n_workspaces: () => 2,
        get_workspace_by_index: index => [first, second][index],
    };

    assert.equal(isWorkspaceAlive(first, manager), true);
    assert.equal(isWorkspaceAlive(second, manager), true);
    assert.equal(isWorkspaceAlive({}, manager), false);
    assert.equal(isWorkspaceAlive(null, manager), false);
});

test('workspace liveness treats teardown-time manager errors as a removed workspace', () => {
    const workspace = {};
    const disposedManager = {
        get_n_workspaces: () => {
            throw new Error('Workspace manager has already been disposed');
        },
    };

    assert.doesNotThrow(() => isWorkspaceAlive(workspace, disposedManager));
    assert.equal(isWorkspaceAlive(workspace, disposedManager), false);
});
