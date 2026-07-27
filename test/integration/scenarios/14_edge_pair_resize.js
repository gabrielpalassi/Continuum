// SPDX-License-Identifier: GPL-3.0-or-later

import {TileZone} from '../../../src/constants.js';
import {
    Main,
    assert,
    assertNear,
    createWindows,
    destroyWindows,
    frame,
    settle,
    waitUntil,
    workArea,
} from '../lib.js';

export const METRICS = {};

const UUID = 'continuum@gabrielpalassi.github.io';

function assertHorizontalSplit(first, second, area, message) {
    const firstFrame = frame(first);
    const secondFrame = frame(second);
    assertNear(firstFrame.x, area.x, 4, `${message}: first window should start at the left`);
    assertNear(
        secondFrame.x,
        firstFrame.x + firstFrame.width,
        4,
        `${message}: windows should meet without a horizontal gap`
    );
    assertNear(
        secondFrame.x + secondFrame.width,
        area.x + area.width,
        4,
        `${message}: second window should end at the right`
    );
    assertNear(firstFrame.height, area.height, 4, `${message}: first window height`);
    assertNear(secondFrame.height, area.height, 4, `${message}: second window height`);
}

function assertVerticalSplit(first, second, area, message) {
    const firstFrame = frame(first);
    const secondFrame = frame(second);
    assertNear(firstFrame.y, area.y, 4, `${message}: first window should start at the top`);
    assertNear(
        secondFrame.y,
        firstFrame.y + firstFrame.height,
        4,
        `${message}: windows should meet without a vertical gap`
    );
    assertNear(
        secondFrame.y + secondFrame.height,
        area.y + area.height,
        4,
        `${message}: second window should end at the bottom`
    );
    assertNear(firstFrame.width, secondFrame.width, 4, `${message}: matching quarter widths`);
}

export async function run() {
    await waitUntil(
        () => Main.extensionManager.lookup(UUID)?.state === 1,
        'extension to finish enabling'
    );

    const state = Main.extensionManager.lookup(UUID).stateObj;
    const [first, second] = await createWindows([
        {width: 420, height: 300},
        {width: 420, height: 300},
    ]);
    const workspace = first.get_workspace();
    const monitor = first.get_monitor();
    const area = workArea(workspace, monitor);

    try {
        let retargetError = null;
        try {
            const initialFrame = frame(first);
            state.windowHandler.retargetNativeSacredExitAnimation(first.get_compositor_private(), {
                ...initialFrame,
                source: initialFrame,
            });
        } catch (error) {
            retargetError = error;
        }
        assert(
            retargetError === null,
            `retargeting without a native size animation should be harmless: ${retargetError}`
        );

        assert(
            state.edgeTilingManager.applyTile(first, TileZone.LEFT_FULL, area),
            'the first window should tile left'
        );
        assert(
            state.edgeTilingManager.applyTile(second, TileZone.RIGHT_FULL, area),
            'the second window should tile right'
        );
        await settle(500);

        const requestedWidth = Math.floor(area.width * 0.62);
        first.move_resize_frame(false, area.x, area.y, requestedWidth, area.height);
        await settle(100);
        state.edgeTilingManager.fixTiledPairSizes(first, TileZone.LEFT_FULL);
        await settle(300);
        assertHorizontalSplit(first, second, area, 'resized full-height pair');

        assert(
            state.edgeTilingManager.applyTile(first, TileZone.TOP_LEFT, area, true),
            'the first window should tile top-left'
        );
        assert(
            state.edgeTilingManager.applyTile(second, TileZone.BOTTOM_LEFT, area, true),
            'the second window should tile bottom-left'
        );
        await settle(500);

        const firstFrame = frame(first);
        const requestedHeight = Math.floor(area.height * 0.6);
        first.move_resize_frame(false, firstFrame.x, area.y, firstFrame.width, requestedHeight);
        await settle(100);
        state.edgeTilingManager.fixQuarterPairSizes(first, TileZone.TOP_LEFT);
        await settle(300);
        assertVerticalSplit(first, second, area, 'resized quarter pair');
    } finally {
        await destroyWindows();
    }
}
