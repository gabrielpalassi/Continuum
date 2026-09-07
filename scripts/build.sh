#!/usr/bin/env bash

set -euo pipefail

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
source_dir="$repo_root/src"
output_dir="$repo_root/dist"

rm -rf -- "$output_dir"
mkdir -p -- "$output_dir"

mapfile -t modules < <(
    find "$source_dir" -maxdepth 1 -type f -name '*.js' ! -name 'extension.js' -printf '%f\n' |
        sort
)

extra_sources=(
    '--extra-source=../LICENSE'
)

for module in "${modules[@]}"; do
    extra_sources+=("--extra-source=$module")
done

gnome-extensions pack --force "$source_dir" --out-dir "$output_dir" "${extra_sources[@]}"

printf 'Extension archive built: %s\n' "$output_dir/continuum@gabrielpalassi.github.io.shell-extension.zip"
