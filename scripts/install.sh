#!/usr/bin/env bash

set -euo pipefail

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
archive="$repo_root/dist/continuum@gabrielpalassi.github.io.shell-extension.zip"

if [[ ! -f "$archive" ]]; then
    printf 'Missing extension archive: %s\nRun npm run build first.\n' "$archive" >&2
    exit 1
fi

gnome-extensions install --force "$archive"

printf '%s\n' \
    'Continuum was installed.' \
    'Reload GNOME Shell, then enable continuum@gabrielpalassi.github.io.'
