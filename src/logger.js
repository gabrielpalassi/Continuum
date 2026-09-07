// SPDX-License-Identifier: GPL-3.0-or-later
// Window-management behavior adapted from Mosaic WM
// by Cléo Menezes Jr. and contributors:
// https://github.com/CleoMenezesJr/MosaicWM

const DEBUG = true;

export function log(...args) {
    if (DEBUG) {
        const resolved = args.map(arg => (typeof arg === 'function' ? arg() : arg));
        console.log('[CONTINUUM]', ...resolved);
    }
}

export function info(...args) {
    console.log('[CONTINUUM INFO]', ...args);
}

export function error(...args) {
    console.error('[CONTINUUM ERROR]', ...args);
}

export function warn(...args) {
    console.warn('[CONTINUUM WARN]', ...args);
}
