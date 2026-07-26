// SPDX-License-Identifier: GPL-3.0-or-later

import {
    Main,
    Scripting,
    assert,
    assertNonOverlapping,
    closeWindow,
    createWindows,
    destroyWindows,
    frame,
    hideOverview,
    normalWindows,
    settle,
    waitUntil,
} from '../lib.js';

export const METRICS = {};

function center(rect) {
    return {x: rect.x + rect.width / 2, y: rect.y + rect.height / 2};
}

function spatialOrder(windows) {
    const entries = [...windows]
        .map(window => ({window, rect: frame(window)}))
        .sort((first, second) => center(first.rect).y - center(second.rect).y);
    const rows = [];

    for (const entry of entries) {
        const entryCenter = center(entry.rect);
        const row = rows.at(-1);
        const sameRow =
            row &&
            Math.abs(entryCenter.y - row.centerY) <=
                Math.min(entry.rect.height, row.minimumHeight) / 2;
        if (sameRow) {
            row.entries.push(entry);
            row.centerY =
                row.entries.reduce((sum, item) => sum + center(item.rect).y, 0) /
                row.entries.length;
            row.minimumHeight = Math.min(row.minimumHeight, entry.rect.height);
        } else {
            rows.push({
                centerY: entryCenter.y,
                minimumHeight: entry.rect.height,
                entries: [entry],
            });
        }
    }

    return rows.flatMap(row =>
        row.entries
            .sort((first, second) => center(first.rect).x - center(second.rect).x)
            .map(({window}) => window.get_id())
    );
}

function preservesPairwiseOrder(before, after) {
    const survivors = before.filter(id => after.includes(id));
    for (let i = 0; i < survivors.length; i++) {
        for (let j = i + 1; j < survivors.length; j++) {
            if (after.indexOf(survivors[i]) > after.indexOf(survivors[j])) return false;
        }
    }
    return true;
}

export async function run() {
    hideOverview();
    await waitUntil(() => !Main.overview.visible, 'Overview to hide before geometry checks');

    const windows = await createWindows([
        {width: 260, height: 200},
        {width: 280, height: 210},
        {width: 300, height: 220},
        {width: 240, height: 190},
    ]);
    const initialOrder = spatialOrder(windows);

    await closeWindow(windows[1]);
    await waitUntil(() => {
        assertNonOverlapping(normalWindows());
        return true;
    }, 'the post-close layout to settle without overlap');
    let survivors = normalWindows();
    const afterClose = spatialOrder(survivors);
    const afterCloseFrames = survivors.map(window => [window.get_id(), frame(window)]);
    assert(
        preservesPairwiseOrder(initialOrder, afterClose),
        'Closing a window should preserve the relative order of surviving windows'
    );

    await Scripting.createTestWindow({width: 270, height: 205});
    await Scripting.waitTestWindows();
    await waitUntil(() => normalWindows().length === 4, 'the replacement window to appear');
    await settle(1200);
    survivors = normalWindows();
    const afterOpen = spatialOrder(survivors);
    assert(
        preservesPairwiseOrder(afterClose, afterOpen),
        'Opening a window should preserve the relative order of existing windows: ' +
            `before=${JSON.stringify(afterClose)} after=${JSON.stringify(afterOpen)} ` +
            `beforeFrames=${JSON.stringify(afterCloseFrames)} ` +
            `frames=${JSON.stringify(survivors.map(window => [window.get_id(), frame(window)]))}`
    );

    const stableFrames = new Map(survivors.map(window => [window.get_id(), frame(window)]));
    await settle(1200);
    for (const window of normalWindows()) {
        const before = stableFrames.get(window.get_id());
        const after = frame(window);
        assert(
            Math.abs(before.x - after.x) <= 2 &&
                Math.abs(before.y - after.y) <= 2 &&
                Math.abs(before.width - after.width) <= 2 &&
                Math.abs(before.height - after.height) <= 2,
            `Window ${window.get_id()} should not drift without a new event`
        );
    }
    await destroyWindows();
}
