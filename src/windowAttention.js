// SPDX-License-Identifier: AGPL-3.0-only
// Behavior inspired by NoAnnoyance v2 by Björn Daase:
// https://github.com/bdaase/noannoyance

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Logger from './logger.js';

export class WindowAttentionManager {
    constructor(shellAttentionHandler) {
        this._shellAttentionHandler = shellAttentionHandler;
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

        Main.activateWindow(window);
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
    }
}
