// SPDX-License-Identifier: GPL-3.0-or-later

import {
    Main,
    assert,
    assertEqual,
    assertNonOverlapping,
    assertWithin,
    closeWindow,
    createWindows,
    frame,
    hideOverview,
    normalWindows,
    settle,
    waitUntil,
    workArea,
} from '../lib.js';

export const METRICS = {};

export async function run() {
    hideOverview();
    await settle();

    const workspace = global.workspace_manager.get_active_workspace();
    const workspaceIndex = workspace.index();
    const windows = await createWindows([
        {width: 320, height: 240},
        {width: 360, height: 260},
        {width: 300, height: 220},
    ]);

    assertEqual(normalWindows(workspace).length, 3, 'All created windows should be managed');
    assertNonOverlapping(windows);
    for (const window of windows)
        assertWithin(
            frame(window),
            workArea(workspace, window.get_monitor()),
            `Window ${window.get_id()}`
        );

    await closeWindow(windows[2]);
    const remaining = normalWindows(workspace);
    assertEqual(remaining.length, 2, 'Closing one window should retain both siblings');
    assertNonOverlapping(remaining);

    await closeWindow(remaining[1]);
    await closeWindow(remaining[0]);

    assertEqual(
        global.workspace_manager.get_active_workspace().index(),
        workspaceIndex,
        'Closing the last window should not switch workspaces'
    );
    await waitUntil(() => Main.overview.visible, 'Overview to open on the empty workspace');
    assert(Main.overview.visible, 'Overview should be visible after the workspace becomes empty');
}
