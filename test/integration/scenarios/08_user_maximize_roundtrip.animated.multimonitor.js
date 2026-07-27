// SPDX-License-Identifier: GPL-3.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {
    Main,
    Scripting,
    assert,
    assertEqual,
    createWindows,
    destroyWindows,
    frame,
    settle,
    transformedFrame,
    waitUntil,
    workArea,
} from '../lib.js';

export const METRICS = {};

const UUID = 'continuum@gabrielpalassi.github.io';

function center(rect) {
    return {
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
    };
}

function cloneFrame(clone) {
    return {
        x: clone.x + clone.translation_x,
        y: clone.y + clone.translation_y,
        width: clone.width * clone.scale_x,
        height: clone.height * clone.scale_y,
    };
}

async function arrangeMonitorsVertically() {
    const process = Gio.Subprocess.new(
        [
            'gdctl',
            'set',
            '--logical-monitor',
            '--monitor',
            'Meta-0',
            '--primary',
            '--x',
            '0',
            '--y',
            '0',
            '--logical-monitor',
            '--monitor',
            'Meta-1',
            '--below',
            'Meta-0',
        ],
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
    );
    const [, stdout, stderr] = await new Promise((resolve, reject) => {
        process.communicate_utf8_async(null, null, (source, result) => {
            try {
                resolve(source.communicate_utf8_finish(result));
            } catch (error) {
                reject(error);
            }
        });
    });
    assert(
        process.get_successful(),
        `Failed to arrange virtual monitors vertically: ${stderr || stdout}`
    );
    await waitUntil(() => {
        const primary = global.display.get_primary_monitor();
        const secondary = primary === 0 ? 1 : 0;
        const primaryGeometry = global.display.get_monitor_geometry(primary);
        const secondaryGeometry = global.display.get_monitor_geometry(secondary);
        return secondaryGeometry.y >= primaryGeometry.y + primaryGeometry.height;
    }, 'the secondary monitor to be arranged below the primary');
}

export async function run() {
    assertEqual(global.display.get_n_monitors(), 2, 'The scenario requires two monitors');
    await waitUntil(
        () => Main.extensionManager.lookup(UUID)?.state === 1,
        'extension to finish enabling'
    );

    const mutterSettings = new Gio.Settings({schema_id: 'org.gnome.mutter'});
    mutterSettings.set_boolean('workspaces-only-on-primary', false);
    await settle(300);
    await arrangeMonitorsVertically();
    await settle(1500);

    const workspace = global.workspace_manager.append_new_workspace(
        false,
        global.get_current_time()
    );
    workspace.activate(global.get_current_time());
    await waitUntil(
        () => global.workspace_manager.get_active_workspace() === workspace,
        'the non-default workspace to activate'
    );
    assert(
        workspace.index() > 0,
        'The scenario must exercise a non-default workspace where overflow has neighbors'
    );
    const primaryMonitor = global.display.get_primary_monitor();
    const secondaryMonitor = primaryMonitor === 0 ? 1 : 0;
    const allWindows = await createWindows([
        {width: 360, height: 260},
        {width: 340, height: 240},
        {width: 320, height: 220},
    ]);
    // Let all creation-time readiness gates finish so this scenario exercises a
    // later user maximize, never the born-maximized placement path.
    await settle(2500);

    const primaryWindows = allWindows.filter(window => window.get_monitor() === primaryMonitor);
    assert(primaryWindows.length === 2, 'The setup requires both windows on the primary monitor');
    const secondaryWindow = allWindows.find(window => window.get_monitor() === secondaryMonitor);
    assert(secondaryWindow, 'The setup requires one window on the secondary monitor');
    const [maximized, sibling] = primaryWindows;
    const originalWorkspace = maximized.get_workspace().index();

    maximized.activate(global.get_current_time());
    await waitUntil(
        () => global.display.focus_window?.get_id() === maximized.get_id(),
        'the selected window to receive focus'
    );

    // Exclude the setup-only secondary window from Mosaic. This leaves exactly two
    // managed windows on the primary and an available secondary without introducing
    // an unrelated workspace-membership transaction into the race under test.
    secondaryWindow.minimize();
    await waitUntil(() => secondaryWindow.minimized, 'the setup-only window to minimize');
    await settle(500);

    // Mutter can re-enter overflow evaluation from the monitor-change signals
    // emitted during this transfer. Inject that observed stale call synchronously
    // so the regression is deterministic instead of depending on signal timing.
    const extension = Main.extensionManager.lookup(UUID).stateObj;
    const manager = extension.windowingManager;
    const moveWindowToMonitor = manager.moveWindowToMonitor;
    let staleOverflow = null;
    let resolvePlacement;
    const placementSettled = new Promise(resolve => {
        resolvePlacement = resolve;
    });
    manager.moveWindowToMonitor = function (...args) {
        const started = moveWindowToMonitor.call(this, ...args);
        if (started && args[0].get_id() === sibling.get_id()) {
            staleOverflow = this.moveOversizedWindow(sibling, {switchFocus: false});
            moveWindowToMonitor.call(this, ...args.slice(0, 4), resolvePlacement);
        }
        return started;
    };
    try {
        maximized.maximize();
        await waitUntil(() => staleOverflow !== null, 'the sibling monitor transfer to begin');
    } finally {
        manager.moveWindowToMonitor = moveWindowToMonitor;
    }
    await staleOverflow;
    assert(await placementSettled, 'The sibling should settle on the selected monitor');
    await waitUntil(() => maximized.is_maximized(), 'the selected window to maximize');
    await settle(1500);

    assertEqual(
        maximized.get_monitor(),
        primaryMonitor,
        'A user-maximized window should remain on its monitor'
    );
    assert(
        sibling.get_monitor() !== primaryMonitor,
        'Its sibling should use the empty secondary monitor'
    );
    assertEqual(
        sibling.get_workspace().index(),
        originalWorkspace,
        'Moving the sibling to an empty monitor should not create a workspace'
    );
    const siblingCenter = center(frame(sibling));
    const secondaryAreaCenter = center(workArea(workspace, secondaryMonitor));
    assert(
        Math.abs(siblingCenter.x - secondaryAreaCenter.x) <= 4 &&
            Math.abs(siblingCenter.y - secondaryAreaCenter.y) <= 4,
        'The evacuated sibling should be tiled on its destination monitor, not retain source-monitor coordinates; ' +
            `received frame ${JSON.stringify(frame(sibling))} with center ${JSON.stringify(siblingCenter)}, ` +
            `expected center ${JSON.stringify(secondaryAreaCenter)} in ${JSON.stringify(workArea(workspace, secondaryMonitor))}`
    );

    // This scenario intentionally runs with animations enabled. The visual center
    // should travel directly from the maximized frame to the centered solo slot,
    // never visiting the stale pre-maximize position.
    const actor = maximized.get_compositor_private();
    const maximizedVisualFrame = transformedFrame(maximized);
    maximized.unmaximize();
    const actorFrames = [];
    const cloneFrames = [];
    const animationDeadline = GLib.get_monotonic_time() + 700 * 1000;
    while (GLib.get_monotonic_time() < animationDeadline) {
        await Scripting.sleep(20);
        const cloneInfo = actor?.__animationInfo?.clone;
        const clone = cloneInfo?.actor ?? cloneInfo;
        // __animationInfo is prepared before Shell adds the clone to the scene.
        // Geometry in that gap is configure bookkeeping, not a painted frame.
        if (clone?.get_parent?.() && typeof clone.ease === 'function') {
            actorFrames.push({
                ...transformedFrame(maximized),
                sample: 'actor',
                actorX: actor.x,
                actorScaleX: actor.scale_x,
                actorTranslationX: actor.translation_x,
            });
            cloneFrames.push({...cloneFrame(clone), sample: 'clone'});
        }
    }
    await waitUntil(() => !maximized.is_maximized(), 'the selected window to unmaximize');
    await settle(500);

    assertEqual(
        maximized.get_workspace().index(),
        originalWorkspace,
        'Unmaximizing should keep the selected window in its workspace'
    );
    assertEqual(
        maximized.get_monitor(),
        primaryMonitor,
        'Unmaximizing should keep the selected window on its monitor'
    );
    const restoredCenter = center(frame(maximized));
    const areaCenter = center(workArea(workspace, primaryMonitor));
    assert(cloneFrames.length > 2, 'Unmaximize should expose GNOME Shell’s native animation clone');
    const visibleFrames = actorFrames.concat(cloneFrames);
    const farthestVisualFrame = visibleFrames.reduce((farthest, sample) => {
        const sampleCenter = center(sample);
        const farthestCenter = center(farthest);
        return Math.hypot(sampleCenter.x - areaCenter.x, sampleCenter.y - areaCenter.y) >
            Math.hypot(farthestCenter.x - areaCenter.x, farthestCenter.y - areaCenter.y)
            ? sample
            : farthest;
    });
    const farthestCenter = center(farthestVisualFrame);
    const largestVisualDetour = Math.hypot(
        farthestCenter.x - areaCenter.x,
        farthestCenter.y - areaCenter.y
    );
    assert(
        largestVisualDetour <= 80,
        'The restore animation should not visit the stale shared-window position; ' +
            `largest center detour was ${Math.round(largestVisualDetour)}px at ${JSON.stringify(farthestVisualFrame)}, ` +
            `area center ${JSON.stringify(areaCenter)}, final frame=${JSON.stringify(frame(maximized))}`
    );
    assert(
        visibleFrames.some(
            sample =>
                sample.width > frame(maximized).width + 20 &&
                sample.width < maximizedVisualFrame.width - 20
        ),
        'Unmaximize should retain GNOME Shell’s native size animation; ' +
            `sampled widths ${Math.round(Math.min(...visibleFrames.map(sample => sample.width)))}–` +
            `${Math.round(Math.max(...visibleFrames.map(sample => sample.width)))}, expected an intermediate value between ` +
            `${frame(maximized).width + 20} and ${maximizedVisualFrame.width - 20}`
    );
    assert(
        Math.abs(restoredCenter.x - areaCenter.x) <= 4 &&
            Math.abs(restoredCenter.y - areaCenter.y) <= 4,
        'The restored window should be retiled as the only window on its monitor; ' +
            `received center ${JSON.stringify(restoredCenter)}, expected ${JSON.stringify(areaCenter)}`
    );

    await destroyWindows();
}
