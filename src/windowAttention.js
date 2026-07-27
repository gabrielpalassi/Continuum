// SPDX-License-Identifier: AGPL-3.0-only
// Behavior inspired by NoAnnoyance v2 by Björn Daase:
// https://github.com/bdaase/noannoyance

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Logger from './logger.js';
import GLib from 'gi://GLib';
import {isWindowAlive} from './shellState.js';

export class WindowAttentionManager {
    constructor(shellAttentionHandler, timeoutRegistry) {
        this._shellAttentionHandler = shellAttentionHandler;
        this._timeoutRegistry = timeoutRegistry;
        this._shellHandlerSuspended = false;
    }

    enable() {
        if (
            !this._shellAttentionHandler ||
            typeof this._shellAttentionHandler._onWindowDemandsAttention !== 'function'
        )
            throw new Error('GNOME Shell window-attention handler is unavailable');

        // Shell 50 registers both signals with connectObject(). Disconnecting
        // that owner suppresses notifications without trying to replace Main's
        // read-only ESM export, and destroy() can restore the same handler.
        global.display.disconnectObject(this._shellAttentionHandler);
        this._shellHandlerSuspended = true;
        Logger.info('Automatically focusing windows that demand attention.');
    }

    onWindowDemandsAttention(window) {
        if (!window || window.has_focus() || window.is_skip_taskbar()) return;

        const previousFocusId = global.display.focus_window?.get_id() ?? null;
        const activate = () => Main.activateWindow(window, global.get_current_time());
        activate();

        // Mutter can reject activation in the same dispatch turn that changes the
        // attention flag or maps a window. Retry briefly while focus remains on the
        // original window; if the user focuses anything else, their choice wins.
        let attempts = 0;
        this._timeoutRegistry?.add(
            50,
            () => {
                if (!isWindowAlive(window) || window.has_focus()) return GLib.SOURCE_REMOVE;
                const focusedId = global.display.focus_window?.get_id() ?? null;
                if (focusedId !== previousFocusId || ++attempts > 3) return GLib.SOURCE_REMOVE;
                activate();
                return GLib.SOURCE_CONTINUE;
            },
            'windowAttention_activationRetry'
        );
    }

    destroy() {
        if (this._shellHandlerSuspended) {
            const handler = this._shellAttentionHandler;
            global.display.connectObject(
                'window-demands-attention',
                handler._onWindowDemandsAttention.bind(handler),
                'window-marked-urgent',
                handler._onWindowDemandsAttention.bind(handler),
                handler
            );
        }

        this._shellHandlerSuspended = false;
        this._shellAttentionHandler = null;
        this._timeoutRegistry = null;
    }
}
