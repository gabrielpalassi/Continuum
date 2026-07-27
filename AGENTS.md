# Project guidelines

- Use `README.md` for architecture and development commands; use `test/README.md` for the test strategy.
- Support the GNOME Shell versions listed in `src/metadata.json` and follow the existing GJS ES-module patterns. Do not use Node-only APIs in `src/`.
- Keep extension lifecycle changes symmetric: release signals, timeouts, keybindings, overrides, and settings during disable.
- For a bug fix, first add a test that reproduces the failure. Test observable behavior rather than implementation details.
- Before finishing, run `npm test` and `npm run fmt-lint`. Also run `npm run test:integration` for Shell behavior changes when a supported GNOME Shell test environment is available.
- Do not run `npm run all` unless explicitly asked; it uninstalls and reinstalls the user's local extension.
