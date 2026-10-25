// SPDX-License-Identifier: GPL-3.0-or-later

import Shell from 'gi://Shell';

import {
    Main,
    allNormalWindows,
    assert,
    createWindows,
    destroyWindows,
    settle,
    waitUntil,
} from '../lib.js';

export const METRICS = {};

function assertWindowPainted(window) {
    const actor = window.get_compositor_private();
    assert(actor && !actor.is_destroyed(), 'Calculator should have a live compositor actor');
    assert(
        actor.mapped && actor.visible,
        `Calculator actor should be mapped and visible; received mapped=${actor.mapped}, ` +
            `visible=${actor.visible}, minimized=${window.minimized}, ` +
            `showing=${window.showing_on_its_workspace()}, ` +
            `activeWorkspace=${global.workspace_manager.get_active_workspace().index()}, ` +
            `windowWorkspace=${window.get_workspace()?.index()}`
    );
    assert(window.showing_on_its_workspace(), 'Calculator should show on its active workspace');
    assert(
        actor.get_paint_opacity() > 0,
        `Calculator should have nonzero paint opacity; received actorOpacity=${actor.opacity}, ` +
            `paintOpacity=${actor.get_paint_opacity()}`
    );
    assert(
        actor.scale_x > 0.9 && actor.scale_y > 0.9,
        `Calculator should be full-sized, received ${actor.scale_x}x${actor.scale_y}`
    );
}

export async function run() {
    const [maximized] = await createWindows([{width: 500, height: 400}]);
    const originalWorkspace = maximized.get_workspace();

    maximized.activate(global.get_current_time());
    maximized.maximize();
    await waitUntil(() => maximized.is_maximized(), 'the existing window to maximize');
    Main.overview.hide();
    await waitUntil(() => !Main.overview.visible, 'Overview to close before launching Calculator');
    await settle(1200);

    const calculatorApp = Shell.AppSystem.get_default().lookup_app('org.gnome.Calculator.desktop');
    assert(calculatorApp, 'GNOME Calculator should be installed');
    calculatorApp.activate();

    await waitUntil(() => allNormalWindows().length === 2, 'Calculator to appear');
    const calculator = allNormalWindows().find(window => window !== maximized);
    assert(calculator, 'Calculator window should exist');
    await waitUntil(
        () => calculator.get_workspace() !== originalWorkspace,
        'Calculator to move away from the maximized window'
    );
    const destinationWorkspace = calculator.get_workspace();
    await waitUntil(
        () => global.workspace_manager.get_active_workspace() === destinationWorkspace,
        'Calculator workspace to become active'
    );
    await settle(1200);
    assertWindowPainted(calculator);

    Main.overview.show();
    await waitUntil(() => Main.overview.visible, 'Overview to open');
    Main.overview.hide();
    await waitUntil(() => !Main.overview.visible, 'Overview to close');
    await settle(1200);
    assertWindowPainted(calculator);

    calculator.delete(global.get_current_time());
    await waitUntil(() => allNormalWindows().length === 1, 'Calculator to close');
    await destroyWindows();
    // Calculator starts desktop services that may still be updating the status menu.
    // Let those callbacks drain before the automation harness tears Shell down.
    await settle(1500);
}
