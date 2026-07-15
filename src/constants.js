// SPDX-License-Identifier: GPL-3.0-or-later
// Window-management behavior adapted from Mosaic WM
// by Cléo Menezes Jr. and contributors:
// https://github.com/CleoMenezesJr/MosaicWM
// Shared constants for the extension

export const WINDOW_SPACING = 8;

// Cap on distinct drag candidates kept after de-duplication so the live nearest search
// stays cheap. A safety net that keeps the current layout, so it never drops a reachable one.
export const MAX_DRAG_LAYOUTS = 48;
// Wall-clock ceiling for composition generation at drag start; a last-resort guard
// against pathological window counts.
export const DRAG_LAYOUT_TIME_BUDGET_MS = 8;
// A Super+Arrow only counts as an action if it moves the focused window's center at
// least this far in the pressed direction; below it the key is a no-op.
export const KEYBOARD_RECOMPOSE_MIN_DISPLACEMENT_PX = 20;

export const WINDOW_VALIDITY_CHECK_INTERVAL_MS = 10;

export const TileZone = Object.freeze({
    NONE: 0,
    LEFT_FULL: 1,
    RIGHT_FULL: 2,
    TOP_LEFT: 3,
    TOP_RIGHT: 4,
    BOTTOM_LEFT: 5,
    BOTTOM_RIGHT: 6,
    FULLSCREEN: 7,
});

export const STARTUP_TILE_DELAY_MS = 300;

export const ANIMATION_DURATION_MS = 250;

export const MIN_WINDOW_WIDTH = 400;
export const MIN_WINDOW_HEIGHT = 100;
export const ABSOLUTE_MIN_HEIGHT = 100;

export const EDGE_TILING_THRESHOLD = 10;

export const POLL_INTERVAL_MS = 50;
export const DEBOUNCE_DELAY_MS = 500;
export const RETILE_DELAY_MS = 100;
// Some fullscreen clients do not commit a requested monitor until their first
// buffer arrives. Keep their actor hidden while waiting, but always fail open.
export const MONITOR_PLACEMENT_TIMEOUT_MS = 3000;
export const GEOMETRY_CHECK_DELAY_MS = 10;
export const SAFETY_TIMEOUT_BUFFER_MS = 100;
export const EDGE_TILE_RESTORE_DELAY_MS = 300; // Delay to prevent false overflow during edge tile restoration
export const GEOMETRY_WAIT_MAX_ATTEMPTS = 100; // Max attempts to wait for window geometry (100 * 10ms = 1s)
export const REVERSE_RESIZE_PROTECTION_MS = 1000; // Protection window for reverse smart resize/unmaximize/overflow
export const RESIZE_SETTLE_DELAY_MS = 150; // Delay to let Mutter apply resize before retiling
export const RESIZE_CLAMP_SETTLE_WINDOW_MS = 1500; // Window age below which a clamp is treated as the client still settling
export const RESIZE_CLAMP_VERIFY_DELAY_MS = 400; // Quiet time after a deferred clamp before the frame is committed as real
export const ISRESIZING_FLAG_RESET_MS = 2;
// Mutter can skip the size-changed confirmation on a fast maximize/unmaximize
// toggle, so force the move after this long instead of leaving the window stuck.
export const SACRED_RESTORE_SAFETY_TIMEOUT_MS = 1500;
// New windows fire both window-created and window-added, which would otherwise
// evaluate them twice. Skip a re-enqueue if we just evaluated this window.
export const DUPLICATE_EVALUATION_WINDOW_MS = 300;
// Wait this long after a maximize before isolating the window, so a quick
// maximize/unmaximize toggle never even starts the move.
export const SACRED_ENTER_DEBOUNCE_MS = 200;

export const ANIMATION_DIFF_THRESHOLD = 10;

// Slack for recognizing a committed size as the ease's own echo; beyond it, the
// size is one the client picked for itself.
export const EASE_TARGET_TOLERANCE_PX = 2;

// Fallback when get_min_size() has no hint
export const SMART_RESIZE_MIN_WINDOW_WIDTH = 100;
export const SMART_RESIZE_MIN_WINDOW_HEIGHT = 100;

export const SLIDE_IN_OFFSET_PX = 100;
export const SLIDE_IN_DURATION_MS = 300;
export const SLIDE_IN_FAILSAFE_MS = 1000; // Re-check interval if a window's entrance never gets claimed
export const QUEUE_PROCESS_DELAY_MS = 100; // Delay between processing window opening queue items (Mutter settling)

export const MINIATURE_TARGET_SIZE_PX = 256; // Longest side of a miniaturized window
export const MINIATURE_ICON_SIZE_PX = 64; // Same size the Overview uses, so the icon can hand off without resizing
export const MINIATURE_ICON_FADE_START = 0.5; // Point in the icon's flight where it starts fading in; a fraction since an interrupted restore shortens the flight
export const MINIATURE_ICON_FADE_OUT_MS = 90; // Window is growing back underneath, so the icon has to clear out fast
export const MINIATURE_ANIM_MS = 250;
export const MINIATURE_FOCUS_GUARD_MS = 500; // Block focus-triggered restore right after miniaturizing
export const MINIATURE_HOVER_REST_MS = 300; // How long the pointer must rest on a miniature before focus-follows-mouse restores it
export const DND_MINIATURE_RESTORE_DELAY_MS = 400; // Dwell time over a miniature before a DnD hover triggers restore

// Restored window's distance to its old slot is the primary layout pick. Keep
// only compositor-scale rounding in the same bucket; larger differences should
// not let aesthetic scoring move the restored window away from its miniature.
export const RESTORE_PROXIMITY_TOLERANCE_PX = 10;

// Compact the per-workspace swap history into a single canonical order op
// once it grows past this many entries (keeps replay cost bounded)
export const SWAP_OPS_COMPACT_THRESHOLD = 8;
