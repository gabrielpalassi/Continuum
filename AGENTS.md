# Project guidelines

- Use `README.md` for architecture and development commands; use `test/README.md` for the test strategy.
- Support the GNOME Shell versions listed in `src/metadata.json` and follow the existing GJS ES-module patterns. Do not use Node-only APIs in `src/`.
- Keep extension lifecycle changes symmetric: release signals, timeouts, keybindings, overrides, and settings during disable.
- Prefer general fixes that address the root cause and preserve system invariants over one-off exceptions.
- Add concise logging at meaningful state transitions and failure boundaries when it aids diagnosis; avoid noisy routine logs.
- Prefer fast policy tests when they can cover the observable behavior. Integration tests remain important for behavior that requires a real GNOME Shell environment, but use them selectively because they are slow.
- For a bug fix, first add tests that reproduce the failure. Test observable behavior rather than implementation details.
- Before finishing, run `npm test` and `npm run fmt-lint`. Also run `npm run test:integration` when a Shell behavior change cannot be adequately covered by policy tests and a supported GNOME Shell test environment is available.
- Do not run `npm run all` unless explicitly asked; it uninstalls and reinstalls the user's local extension.
