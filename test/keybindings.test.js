// SPDX-License-Identifier: GPL-3.0-or-later

import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {URL} from 'node:url';
import {promisify} from 'node:util';

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
