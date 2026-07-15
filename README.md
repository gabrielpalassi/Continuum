# 🌊 Continuum

Continuum is a GNOME Shell extension that combines automatic mosaic window
arrangement, proactive workspace management, and immediate focus for windows
that demand attention.
It brings together the window-management behavior of
[Mosaic WM](https://github.com/CleoMenezesJr/MosaicWM) and the empty-workspace
behavior of
[Foresight Reborn](https://github.com/gabrielpalassi/ForesightReborn), with
window-attention behavior inspired by
[NoAnnoyance v2](https://github.com/bdaase/noannoyance).

> [!WARNING]
> Continuum is a personal, experimental project and is not intended for official
> publication. It changes window placement, overrides some GNOME keybindings and
> Shell internals, and may be unstable. Build and run it at your own risk.

## Requirements

- GNOME Shell 50
- `gnome-extensions` for packaging and local installation
- Node.js and npm for the development checks

Continuum currently inherits Mosaic WM's Wayland focus and its requirement that
multi-monitor users enable **Workspaces on all displays**.

## Development

Install the formatting and linting tools from the lockfile:

```bash
npm ci
```

### Checks

Run the same formatting and linting checks expected before committing:

```bash
npm run fmt-lint
```

Use `npm run fmt-lint:fix` to apply automatic fixes. The individual commands
`npm run fmt`, `npm run fmt:fix`, `npm run lint`, and `npm run lint:fix` are also
available.

### Build and install

Package `src/` into
`dist/continuum@gabrielpalassi.github.io.shell-extension.zip`:

```bash
npm run build
```

Install the resulting archive in the current user's extension directory:

```bash
npm run setup
```

For the usual edit-build-install cycle, run:

```bash
npm run all
```

This uninstalls any currently installed copy of Continuum, rebuilds it, and
installs the new archive. GNOME Shell must then reload the extension code. On
Wayland, log out and back in before enabling it:

```bash
gnome-extensions enable continuum@gabrielpalassi.github.io
```

Useful commands while testing:

| Command                      | Purpose                                        |
| ---------------------------- | ---------------------------------------------- |
| `npm start`                  | Start a nested Shell with one virtual monitor  |
| `npm run start:multimonitor` | Start a nested Shell with two virtual monitors |
| `npm run remove`             | Uninstall the local Continuum extension        |

Nested sessions are useful for quick interaction checks, but final testing
should also be done in a real Wayland session because Continuum integrates with
window placement, workspace switching, drag operations, and Shell animations.

## Architecture

Continuum is a GNOME Shell 50 extension written as GJS ES modules. Its runtime
entry point is `src/extension.js`. `enable()` constructs the managers, wires
their dependencies, connects Shell signals and keybindings, and installs the
required Shell overrides. `disable()` reverses those changes and releases
signals, timeouts, actors, settings overrides, and manager state.

### Runtime structure

| Area                | Main modules                                                       | Responsibility                                                                                                |
| ------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Extension lifecycle | `extension.js`, `settingsOverrider.js`, `timing.js`, `liveness.js` | Own shared services, Shell integration, temporary settings changes, and asynchronous cleanup.                 |
| Window lifecycle    | `windowHandler.js`, `windowing.js`, `windowState.js`               | Classify windows, track per-window state, queue placement, and handle creation, removal, and monitor changes. |
| Mosaic layout       | `tiling.js`, `reordering.js`, `swapping.js`, `edgeTiling.js`       | Compute layouts, keep windows fitted, reorder or swap tiles, and manage edge-tile zones.                      |
| User interaction    | `dragHandler.js`, `resizeHandler.js`, `grabOps.js`, `drawing.js`   | Coordinate move/resize grabs, previews, smart resizing, and visual guides.                                    |
| Visual behavior     | `animations.js`, `miniature.js`, `overviewLayout.js`               | Animate placement, represent overflow windows as miniatures, and preserve the mosaic in the overview.         |
| Workspace behavior  | `workspaceOverview.js`                                             | Show the overview when the active workspace becomes empty and hide only an overview it opened.                |
| Attention behavior  | `windowAttention.js`                                               | Replace "Window is ready" notifications with direct activation for attention-seeking windows.                 |

`ContinuumExtension` is the composition root. Shell window and workspace events
enter through it and are delegated to focused handlers. In particular,
`window-added` and `window-removed` events go to both `WindowHandler`, for mosaic
placement, and `WorkspaceOverviewManager`, for empty-workspace behavior. Managers
share capabilities through explicit references configured during `enable()`;
`windowState.js` holds transient state associated with individual `Meta.Window`
objects.

The tiling path separates policy from effects: the tiling and edge-tiling
managers decide the target arrangement, while the windowing, drawing, miniature,
and animation managers apply geometry and visual changes. Drag, resize, and
keyboard handlers coordinate these services rather than implementing another
layout path.

### GNOME Shell integration

Continuum listens to Mutter and Shell signals for window creation and removal,
workspace changes, grabs, resize transitions, monitor crossings, focus, urgency,
and overview visibility. A shared timeout registry owns deferred work so pending
callbacks can be cancelled safely when the extension is disabled.

Some visual behavior cannot be implemented through GNOME Shell's public
extension API. `extension.js` therefore patches selected workspace-animation,
window-preview, overview-layout, and screenshot methods so miniature windows are
rendered consistently. These overrides are deliberately centralized and
restored during `disable()`; they are the areas most likely to require review
when updating the supported GNOME Shell version.

Settings changed at runtime—including Mutter edge tiling and conflicting stock
keybindings—are tracked by `SettingsOverrider` and restored when Continuum is
disabled. Likewise, `WindowAttentionManager` temporarily disconnects Shell's
native attention handler and reconnects it during teardown. Keeping ownership of
signals, overrides, settings, and asynchronous work in the extension lifecycle
is essential: GNOME may enable and disable an extension repeatedly in the same
Shell process.

## Credits and licensing

Continuum incorporates and adapts source code from:

- [Foresight Reborn](https://github.com/gabrielpalassi/ForesightReborn) by
  Gabriel Palassi, itself based on
  [Foresight](https://github.com/pesader/gnome-shell-extension-foresight) by
  pesader and Show Application View When Workspace Empty by fawtytoo.
- [Mosaic WM](https://github.com/CleoMenezesJr/MosaicWM) by Cléo Menezes Jr. and
  its contributors. Mosaic WM credits
  [window-mosaic-mode](https://gitlab.gnome.org/heikkiket/window-mosaic-mode) by
  heikkiket for the original concept and implementation.
- [NoAnnoyance v2](https://github.com/bdaase/noannoyance) by Björn Daase, a fork of
  [No Annoyance](https://github.com/sindex/no-annoyance) by Alex.

Continuum is distributed under the GNU Affero General Public License v3.0.
