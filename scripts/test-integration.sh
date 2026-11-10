#!/usr/bin/env bash
set -uo pipefail

repo_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
extension_zip="$repo_dir/dist/continuum@gabrielpalassi.github.io.shell-extension.zip"
results_dir="$repo_dir/test-results/integration"
monitor_wrapper="$repo_dir/test/integration/add-second-monitor.sh"

# Shell's perf background references distribution-dependent wallpaper files.
export SHELL_BACKGROUND_IMAGE="${SHELL_BACKGROUND_IMAGE:-$repo_dir/test/integration/background.svg}"

mkdir -p "$results_dir"
find "$results_dir" -maxdepth 1 -type f -name '*.log' -delete
bun run build || exit 1

restart_document_portal() {
    local command_status=$?

    trap - EXIT
    if ! systemctl --user restart xdg-document-portal.service; then
        echo "WARN Failed to restart xdg-document-portal.service" >&2
    fi
    exit "$command_status"
}
trap restart_document_portal EXIT

passed=0
failed=0

for scenario in "$repo_dir"/test/integration/scenarios/*.js; do
    name=$(basename "$scenario" .js)
    log_file="$results_dir/$name.log"
    command=(
        gnome-shell-test-tool
        --headless
    )
    if [[ "$name" != *.animated && "$name" != *.animated.* ]]; then
        command+=(--disable-animations)
    fi
    command+=(--extension "$extension_zip")

    if [[ "$name" == *.multimonitor ]]; then
        command+=(--wrap "$monitor_wrapper")
    fi
    command+=("$scenario")

    echo "RUN  $name"
    scenario_failed=0
    if GTK_A11Y=none GSETTINGS_BACKEND=memory timeout 60s dbus-run-session -- "${command[@]}" >"$log_file" 2>&1; then
        :
    else
        scenario_failed=1
        sed -n '/Script failed:/,+14p' "$log_file"
        if ! grep -q 'Script failed:' "$log_file"; then
            tail -30 "$log_file"
        fi
    fi

    critical_count=$(grep -Ec '(GNOME Shell|libmutter|Gjs|Clutter|St)-CRITICAL' "$log_file" || true)
    critical_count=${critical_count:-0}
    if [[ "$critical_count" != "0" ]]; then
        scenario_failed=1
        echo "CRIT $name emitted $critical_count critical log message(s); see $log_file"
    fi

    if [[ "$scenario_failed" == "0" ]]; then
        echo "PASS $name"
        passed=$((passed + 1))
    else
        echo "FAIL $name"
        failed=$((failed + 1))
    fi
done

echo
echo "Integration result: $passed passed, $failed failed"
echo "Logs: $results_dir"

if [[ "$failed" != "0" ]]; then
    exit 1
fi
