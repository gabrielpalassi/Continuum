// SPDX-License-Identifier: GPL-3.0-or-later

import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {URL} from 'node:url';
import {promisify} from 'node:util';
import {KEYBINDING_ACTIONS, TileZone} from '../src/constants.js';

const schemaPath = new URL(
    '../src/schemas/org.gnome.shell.extensions.continuum.gschema.xml',
    import.meta.url
);
const schemaDirectory = new URL('../src/schemas/', import.meta.url);
const execFileAsync = promisify(execFile);

const expectedBindings = new Map([
    ['tile-left', '<Super>Left'],
    ['tile-right', '<Super>Right'],
    ['tile-top-left', '<Super><Ctrl>Left'],
    ['tile-top-right', '<Super><Ctrl>Right'],
    ['tile-bottom-left', '<Super><Shift>Left'],
    ['tile-bottom-right', '<Super><Shift>Right'],
    ['swap-left', '<Super><Alt>Left'],
    ['swap-right', '<Super><Alt>Right'],
    ['swap-up', '<Super><Alt>Up'],
    ['swap-down', '<Super><Alt>Down'],
]);

const expectedActions = new Map([
    ['tile-left', ['tile', TileZone.LEFT_FULL]],
    ['tile-right', ['tile', TileZone.RIGHT_FULL]],
    ['tile-top-left', ['tile', TileZone.TOP_LEFT]],
    ['tile-top-right', ['tile', TileZone.TOP_RIGHT]],
    ['tile-bottom-left', ['tile', TileZone.BOTTOM_LEFT]],
    ['tile-bottom-right', ['tile', TileZone.BOTTOM_RIGHT]],
    ['swap-left', ['swap', 'left']],
    ['swap-right', ['swap', 'right']],
    ['swap-up', ['swap', 'up']],
    ['swap-down', ['swap', 'down']],
]);

function keyDefaults(xml) {
    const defaults = new Map();
    const keyPattern =
        /<key name="([^"]+)"[^>]*>[\s\S]*?<default>\['([^']+)'\]<\/default>[\s\S]*?<\/key>/g;

    for (const match of xml.matchAll(keyPattern))
        defaults.set(match[1], match[2].replaceAll('&lt;', '<').replaceAll('&gt;', '>'));

    return defaults;
}

test('all documented tiling and swapping actions have their intended default shortcut', async () => {
    const defaults = keyDefaults(await readFile(schemaPath, 'utf8'));
    assert.deepEqual(defaults, expectedBindings);
});

test('runtime keybinding actions match the documented schema actions', () => {
    const runtimeActions = new Map(
        KEYBINDING_ACTIONS.map(([name, kind, value]) => [name, [kind, value]])
    );

    assert.deepEqual(runtimeActions, expectedActions);
    assert.deepEqual([...runtimeActions.keys()], [...expectedBindings.keys()]);
});

test('default shortcuts are unique', async () => {
    const defaults = [...keyDefaults(await readFile(schemaPath, 'utf8')).values()];
    assert.equal(new Set(defaults).size, defaults.length);
});

test('every shortcut key has array-of-strings type and user-facing documentation', async () => {
    const xml = await readFile(schemaPath, 'utf8');
    const keys = [...xml.matchAll(/<key name="([^"]+)" type="([^"]+)">([\s\S]*?)<\/key>/g)];

    assert.equal(keys.length, expectedBindings.size);
    for (const [, name, type, body] of keys) {
        assert.equal(type, 'as', `${name} must accept a list of shortcuts`);
        assert.match(body, /<summary>\S[\s\S]*<\/summary>/, `${name} needs a summary`);
        assert.match(body, /<description>\S[\s\S]*<\/description>/, `${name} needs a description`);
    }
});

test('every default shortcut uses Super and a directional arrow', async () => {
    const defaults = keyDefaults(await readFile(schemaPath, 'utf8'));

    for (const [name, shortcut] of defaults) {
        assert.match(shortcut, /^<Super>/, `${name} must be namespaced under Super`);
        assert.match(shortcut, /(Left|Right|Up|Down)$/, `${name} must identify a direction`);
    }
});

test('GSettings accepts the schema in strict mode', async () => {
    await execFileAsync('glib-compile-schemas', [
        '--strict',
        '--dry-run',
        decodeURIComponent(schemaDirectory.pathname),
    ]);
});
