# GNOME Shell 51 compatibility

Reviewed on November 10, 2026. Continuum declares support for Shell 50 and 51.

The [GNOME 51 release notes](https://release.gnome.org/51/),
[Shell release history through 51.1](https://github.com/GNOME/gnome-shell/blob/51.1/NEWS),
and [extension porting guide](https://gjs.guide/extensions/upgrading/gnome-shell-51.html)
were checked against Continuum's runtime integrations.

## API compatibility

The porting guide's removals do not require runtime changes here: Continuum does
not use St widget `vertical`, `Shell.GLSLEffect`, `Clutter.get_default_backend()`,
or `ui/pointerWatcher.js`. Its `disable()` is synchronous. It also does not use
the changed popup-menu arguments or D-Bus proxy wrapper construction.

Comparing Shell 50.0 and 51.1 source confirmed that the contracts used by the
overrides remain intact:

- [Workspace animation](https://github.com/GNOME/gnome-shell/blob/51.1/js/ui/workspaceAnimation.js):
  `MonitorGroup._init()`, workspace groups, and window clone records.
- [Window previews](https://github.com/GNOME/gnome-shell/blob/51.1/js/ui/windowPreview.js):
  `boundingBox`, `_adjustOverlayOffsets()`, `_updateIconScale()`, and icon geometry.
- [Overview layout](https://github.com/GNOME/gnome-shell/blob/51.1/js/ui/workspace.js):
  `WorkspaceLayout._createBestLayout()` and its window inputs.
- [Screenshots](https://github.com/GNOME/gnome-shell/blob/51.1/js/ui/screenshot.js):
  window captures still precede the stage capture inside `ScreenshotUI.open()`.
- [Attention handling](https://github.com/GNOME/gnome-shell/blob/51.1/js/ui/windowAttentionHandler.js):
  both attention signals still use the same `connectObject()` owner.

Mutter's changes to window configuration and monitor tracking warrant real Shell
tests rather than policy tests alone; see its
[51.0](https://download.gnome.org/sources/mutter/51/mutter-51.0.news) and
[51.1](https://download.gnome.org/sources/mutter/51/mutter-51.1.news) notes.

## Follow-up work

Actor event signals still work in 51 but are deprecated. Miniature pointer and
touch handlers should eventually migrate to Clutter controllers while retaining
Shell 50 support.

Shell 51 introduces a separate reduced-motion preference. Continuum currently
honors `enable-animations`; adapting its custom motion to the new preference is
an accessibility improvement still to do. The two preferences are independent.

## Validation

On Shell/Mutter 51.1, `bun run test` passed all 57 fast tests,
`bun run fmt-lint` passed, and `bun run test:integration` reported 25 passed,
0 failed. The St diagnostic below remains outside that runner's failure check.

The headless suite runs against the installed Shell. The runner now supplies a
bundled background, enables animations for both `.animated.js` and
`.animated.multimonitor.js` scenarios, and stops if the build fails. A fast runner
regression test covers these behaviors.

Headless tests do not establish appearance or global-shortcut dispatch in a
logged-in session. Shell 50 must be tested separately when its environment is
available; the local environment for this review is Shell 51.1.

The multi-monitor distribution scenario also reproducibly emits an `St-CRITICAL`
shadow-allocation assertion during window cleanup, while its behavior assertions
pass. The runner's existing critical-log check covers Shell, Mutter, GJS, and
Clutter, not St. The origin of this diagnostic is unresolved; it should not be
treated as a clean graphics-log validation or assumed to be an upstream bug.
