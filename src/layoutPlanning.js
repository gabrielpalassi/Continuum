// SPDX-License-Identifier: GPL-3.0-or-later
// Pure layout-policy helpers. Keeping these independent of GNOME APIs makes the
// state-machine decisions testable without a running Shell.

export function requiresOverflowHandling(layoutOverflows, windowCount) {
    return layoutOverflows && windowCount > 1;
}

// Every ordered composition of n into 1..n groups (n=3 gives [3],[1,2],[2,1],[1,1,1]).
// Keep this lazy: the count is 2^(n-1), and callers stop when their time budget expires.
export function* generateRowCompositions(n) {
    if (n <= 0) return;

    function* build(remaining, groupsLeft, acc) {
        if (remaining === 0) {
            yield acc.slice();
            return;
        }
        if (groupsLeft === 0) return;

        const maxFirst = groupsLeft === 1 ? remaining : remaining - (groupsLeft - 1);
        for (let first = 1; first <= maxFirst; first++) {
            acc.push(first);
            yield* build(remaining - first, groupsLeft - 1, acc);
            acc.pop();
        }
    }

    for (let groups = 1; groups <= n; groups++) yield* build(n, groups, []);
}

// Build a richer real-layout search without crossing into factorial work. New-window
// insertion slots are prioritized while the established order stays intact; size/position
// heuristics and small local moves cover resize-driven packing changes. Candidates share
// descriptors intentionally, since evaluation is synchronous and array order is the choice.
export function generateBoundedLayoutCandidates(
    windows,
    {historyOrder = [], positionSnapshot = null, maxCandidates = 24} = {}
) {
    const limit = Math.max(0, Math.floor(maxCandidates));
    if (limit === 0 || windows.length === 0) return [];

    const candidates = [];
    const seen = new Set();
    const idOf = window => window.id;
    const addCandidate = candidate => {
        if (candidates.length >= limit || candidate.length !== windows.length) return;
        const key = JSON.stringify(candidate.map(idOf));
        if (seen.has(key)) return;
        seen.add(key);
        candidates.push(candidate);
    };

    addCandidate([...windows]);

    const byId = new Map(windows.map(window => [idOf(window), window]));
    const historical = [];
    const historicalIds = new Set();
    for (const id of historyOrder) {
        const window = byId.get(id);
        if (!window || historicalIds.has(id)) continue;
        historical.push(window);
        historicalIds.add(id);
    }
    const entrants = windows.filter(window => !historicalIds.has(idOf(window)));
    const stableOrder =
        historical.length > 0 && historical.length + entrants.length === windows.length
            ? [...historical, ...entrants]
            : [...windows];

    if (historical.length > 0 && entrants.length > 0) {
        for (let slot = 0; slot <= historical.length && candidates.length < limit; slot++) {
            addCandidate([...historical.slice(0, slot), ...entrants, ...historical.slice(slot)]);
        }
    } else if (historical.length === windows.length) {
        addCandidate(historical);
    }

    addCandidate([...windows].sort((a, b) => b.width * b.height - a.width * a.height));
    addCandidate([...windows].sort((a, b) => a.width * a.height - b.width * b.height));
    addCandidate([...windows].sort((a, b) => b.width - a.width));
    addCandidate([...windows].sort((a, b) => b.height - a.height));

    if (positionSnapshot) {
        const inputRank = new Map(windows.map((window, index) => [idOf(window), index]));
        addCandidate(
            [...windows].sort((a, b) => {
                const ax = positionSnapshot.get(idOf(a))?.cx;
                const bx = positionSnapshot.get(idOf(b))?.cx;
                if (Number.isFinite(ax) && Number.isFinite(bx) && ax !== bx) return ax - bx;
                if (Number.isFinite(ax)) return -1;
                if (Number.isFinite(bx)) return 1;
                return inputRank.get(idOf(a)) - inputRank.get(idOf(b));
            })
        );
    }

    // A resized large window has the greatest chance of changing shelf packing. Moving only
    // that window through the stable order gives useful alternatives in O(n), not O(n!).
    let largest = stableOrder[0];
    for (const window of stableOrder) {
        if (window.width * window.height > largest.width * largest.height) largest = window;
    }
    const withoutLargest = stableOrder.filter(window => idOf(window) !== idOf(largest));
    for (let slot = 0; slot <= withoutLargest.length && candidates.length < limit; slot++) {
        const candidate = [...withoutLargest];
        candidate.splice(slot, 0, largest);
        addCandidate(candidate);
    }

    // Adjacent swaps cheaply explore local corrections that global size sorts do not represent.
    for (let index = 0; index + 1 < stableOrder.length && candidates.length < limit; index++) {
        const candidate = [...stableOrder];
        [candidate[index], candidate[index + 1]] = [candidate[index + 1], candidate[index]];
        addCandidate(candidate);
    }

    return candidates;
}

export function shouldStopDragLayoutSearch({shapeCount, elapsedMs, budgetMs}) {
    return shapeCount > 0 && elapsedMs > budgetMs;
}

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

export function monitorContainingPoint(monitors, x, y, fallback = null) {
    for (const {index, geometry} of monitors) {
        if (
            x >= geometry.x &&
            x < geometry.x + geometry.width &&
            y >= geometry.y &&
            y < geometry.y + geometry.height
        )
            return index;
    }
    return fallback;
}

export function selectDragDropMonitor({
    windowMonitor,
    pointerMonitor,
    layoutMonitor,
    hasChosenLayout,
}) {
    if (hasChosenLayout && layoutMonitor === pointerMonitor) return pointerMonitor;
    return windowMonitor;
}

export function enumerateTileSlots(tileInfo, workArea, spacing, bounds = null) {
    const slots = [];
    const boundedRect = descriptor => {
        let x = descriptor.x;
        let y = descriptor.y;
        if (bounds) {
            x = Math.max(bounds.x, Math.min(x, bounds.x + bounds.width - descriptor.width));
            y = Math.max(bounds.y, Math.min(y, bounds.y + bounds.height - descriptor.height));
        }
        return {x, y, width: descriptor.width, height: descriptor.height};
    };

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
                    rect: boundedRect({
                        x: descriptor.targetX !== undefined ? descriptor.targetX : x,
                        y: descriptor.targetY !== undefined ? descriptor.targetY : y + yOffset,
                        width: descriptor.width,
                        height: descriptor.height,
                    }),
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
                    rect: boundedRect({
                        x: descriptor.targetX !== undefined ? descriptor.targetX : x,
                        y: descriptor.targetY !== undefined ? descriptor.targetY : y,
                        width: descriptor.width,
                        height: descriptor.height,
                    }),
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

export function fitDragDescriptorToArea(descriptor, minimumSize, workArea, canResize) {
    if (descriptor.width <= workArea.width && descriptor.height <= workArea.height)
        return descriptor;

    const minimum = {
        width: Math.min(minimumSize.width, descriptor.width),
        height: Math.min(minimumSize.height, descriptor.height),
    };
    const plan = planResizeFit({
        buildSizes: scale => [
            {
                width: Math.round(minimum.width + (descriptor.width - minimum.width) * scale),
                height: Math.round(minimum.height + (descriptor.height - minimum.height) * scale),
            },
        ],
        overflows: ([size]) => size.width > workArea.width || size.height > workArea.height,
        allowScaling: canResize,
        iterations: 12,
    });

    if (plan.kind !== 'scaled') return descriptor;
    return {...descriptor, ...plan.sizes[0]};
}
