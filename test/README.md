# Test strategy

The integration scenarios treat Continuum as a black box. Their expectations
come from the user-facing behavior documented in the project README and schema,
not from internal implementation details.

Run fast policy tests (layout decisions, mosaic state, Shell-object liveness and state,
and shortcut/schema contracts):

```bash
npm test
```

These tests are specification-first. A red test is retained when it exposes a
credible policy or safety defect; the suite is not required to be green during
bug-discovery work.

Run the real GNOME Shell scenarios:

```bash
npm run test:integration
```

Run everything:

```bash
npm run test:all
```

Each integration scenario starts GNOME Shell 50 as an isolated headless Wayland
compositor, installs the freshly built extension, creates real GTK windows, and
asserts observable `Meta.Window` geometry and state. Logs are written under
`test-results/integration/`. A scenario also fails when GNOME Shell, Mutter,
GJS, or Clutter emits a critical log message.

The scenarios cover:

- ordinary mosaic placement, close retiling, and empty-workspace Overview;
- usable first-window geometry on an otherwise empty workspace;
- minimized and always-on-top exclusions;
- direct focus for attention-seeking windows;
- changes while the Overview is open;
- existing and born-maximized isolation;
- media-key-style app activation beside a maximized window, including entrance visibility;
- fullscreen isolation and restoration;
- overflow miniatures, automatic restoration, anti-flapping, and restore anchors;
- configured edge-tiling and swapping keybindings, including one-action cross-edge transitions;
- teardown cleanup and re-enable;
- multi-monitor distribution, close rebalance, maximized placement, and user maximize round trips;
- relative order preservation and idle layout stability;
- direct mosaic swapping below the headless compositor's unsupported global-shortcut layer;
- real GTK client minimum-size constraints under overflow pressure;
- pointer-driven move, cross-monitor drag hints, left/right edge-drop anchoring, multi-window reordering, and resize grab lifecycles;
- complementary half/quarter edge-pair resizing and animation guard behavior;
- interrupted miniature create/restore animation cleanup.

Headless tests exercise real Mutter and Shell state transitions, but they do not
replace final checks in a logged-in Wayland session for global shortcut dispatch,
monitor hotplug, clients that enforce constraints beyond their advertised minimum,
and animation appearance.

GNOME Shell 50's headless virtual keyboard does not dispatch global shortcuts
(including GNOME's own Super+Up binding). The full tiling/swapping shortcut
scenario therefore lives under `test/integration/diagnostics/` for execution in
an interactive nested or logged-in session and is not part of the automated
headless run.
