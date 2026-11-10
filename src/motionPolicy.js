// SPDX-License-Identifier: GPL-3.0-or-later

// Shell 50 has no reduced-motion enum or preference. Only compare against an
// available enum value, so two missing properties cannot accidentally disable motion.
export function allowsMotion(settings, reduceValue = undefined) {
    return (
        settings.enable_animations &&
        (reduceValue === undefined || settings.reduced_motion !== reduceValue)
    );
}

export function animationDuration(duration, settings, reduceValue = undefined) {
    return allowsMotion(settings, reduceValue)
        ? Math.ceil(duration * (settings.slow_down_factor ?? 1))
        : 0;
}
