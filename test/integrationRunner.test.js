// SPDX-License-Identifier: GPL-3.0-or-later

import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {cp, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import process from 'node:process';
import test from 'node:test';
import {URL} from 'node:url';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);

test('integration runner enables animated scenarios and supplies an available background', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'continuum-runner-'));
    try {
        const scripts = join(directory, 'scripts');
        const integration = join(directory, 'test/integration');
        const bin = join(directory, 'bin');
        await Promise.all([
            mkdir(scripts, {recursive: true}),
            mkdir(join(integration, 'scenarios'), {recursive: true}),
            mkdir(bin),
        ]);
        await cp(
            new URL('../scripts/test-integration.sh', import.meta.url),
            join(scripts, 'test-integration.sh')
        );
        await cp(
            new URL('./integration/background.svg', import.meta.url),
            join(integration, 'background.svg')
        );
        const scenarios = ['ordinary', 'entrance.animated', 'entrance.animated.multimonitor'];
        for (const name of scenarios)
            await writeFile(join(integration, 'scenarios', `${name}.js`), '');

        const commands = {
            bun: 'exit "$BUILD_STATUS"',
            systemctl: 'exit 0',
            timeout: 'shift; exec "$@"',
            'dbus-run-session': 'shift; exec "$@"',
            'gnome-shell-test-tool': `
name=$(basename "\${!#}" .js)
printf '%s\\n' "$@" > "$CAPTURE_DIR/$name.args"
printf '%s\\n' "\${SHELL_BACKGROUND_IMAGE:-}" > "$CAPTURE_DIR/background"
if [[ -n "$CRITICAL_DOMAIN" ]]; then
    printf '%s-CRITICAL: test diagnostic\\n' "$CRITICAL_DOMAIN"
fi
`,
        };
        for (const [name, body] of Object.entries(commands))
            await writeFile(join(bin, name), `#!/usr/bin/env bash\n${body}\n`, {mode: 0o755});

        const env = {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            CAPTURE_DIR: directory,
            BUILD_STATUS: '0',
        };
        delete env.SHELL_BACKGROUND_IMAGE;
        await assert.rejects(
            execFileAsync('bash', [join(scripts, 'test-integration.sh')], {
                env: {...env, BUILD_STATUS: '1'},
            }),
            'a failed build must stop the runner'
        );
        await assert.rejects(readFile(join(directory, 'ordinary.args')), {code: 'ENOENT'});
        await execFileAsync('bash', [join(scripts, 'test-integration.sh')], {env});

        for (const name of scenarios) {
            const args = (await readFile(join(directory, `${name}.args`), 'utf8')).split('\n');
            assert.equal(args.includes('--disable-animations'), name === 'ordinary', name);
        }
        const background = (await readFile(join(directory, 'background'), 'utf8')).trim();
        assert.ok(background, 'the runner must supply its own background');
        assert.match(await readFile(background, 'utf8'), /<svg/);
        for (const domain of ['St', 'GNOME Shell', 'libmutter', 'Gjs', 'Clutter']) {
            await assert.rejects(
                execFileAsync('bash', [join(scripts, 'test-integration.sh')], {
                    env: {...env, CRITICAL_DOMAIN: domain},
                }),
                `${domain} criticals must fail the integration run`
            );
        }
    } finally {
        await rm(directory, {recursive: true, force: true});
    }
});
