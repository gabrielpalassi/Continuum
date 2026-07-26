// SPDX-License-Identifier: GPL-3.0-or-later
// Pure layout-policy helpers. Keeping these independent of GNOME APIs makes the
// state-machine decisions testable without a running Shell.

export function orderWindowsByMru(windows, mru, {mostRecentFirst = true} = {}) {
    const unknownRank = Number.MAX_SAFE_INTEGER;
    const rank = window => {
        const cachedRank = mru?.get(window.get_id());
        return Number.isFinite(cachedRank) && cachedRank >= 0 ? cachedRank : unknownRank;
    };

    return [...windows].sort((a, b) => {
        const rankDifference = rank(a) - rank(b);
        if (rankDifference !== 0) return mostRecentFirst ? rankDifference : -rankDifference;
        return a.get_id() - b.get_id();
    });
}

export function restoreBeforeRearrange(tryRestore, rearrange) {
    if (tryRestore()) return true;
    rearrange();
    return false;
}

export function enumerateTileSlots(tileInfo, workArea, spacing) {
    const slots = [];

    if (!tileInfo.vertical) {
        let y = tileInfo.y;
        for (const level of tileInfo.levels) {
            let x = level.x;
            for (const descriptor of level.windows) {
                const centerOffset = workArea.height / 2 + workArea.y - (y + descriptor.height / 2);
                const yOffset =
                    centerOffset > 0 ? Math.min(centerOffset, level.height - descriptor.height) : 0;

                slots.push({
                    descriptor,
                    orientation: 'H',
                    rect: {x, y: y + yOffset, width: descriptor.width, height: descriptor.height},
                });
                x += descriptor.width + spacing;
            }
            y += level.height + spacing;
        }
    } else {
        let x = tileInfo.x;
        for (const level of tileInfo.levels) {
            let y = level.y;
            for (const descriptor of level.windows) {
                slots.push({
                    descriptor,
                    orientation: 'V',
                    rect: {
                        x: descriptor.targetX !== undefined ? descriptor.targetX : x,
                        y: descriptor.targetY !== undefined ? descriptor.targetY : y,
                        width: descriptor.width,
                        height: descriptor.height,
                    },
                });
                y += descriptor.height + spacing;
            }
            x += level.width + spacing;
        }
    }

    return slots;
}

export function planResizeFit({buildSizes, overflows, allowScaling = true, iterations = 15}) {
    const preferredSizes = buildSizes(1);
    if (!overflows(preferredSizes)) return {kind: 'natural', scale: 1, sizes: preferredSizes};

    if (!allowScaling) return {kind: 'scaling-blocked', scale: null, sizes: preferredSizes};

    const minimumSizes = buildSizes(0);
    if (overflows(minimumSizes)) return {kind: 'impossible', scale: null, sizes: minimumSizes};

    let low = 0;
    let high = 1;
    for (let i = 0; i < iterations; i++) {
        const middle = (low + high) / 2;
        if (overflows(buildSizes(middle))) high = middle;
        else low = middle;
    }

    return {kind: 'scaled', scale: low, sizes: buildSizes(low)};
}
