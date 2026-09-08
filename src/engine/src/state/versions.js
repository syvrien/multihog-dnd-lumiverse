/**
 * Version compare helpers used by the settings migration pipeline.
 */

/**
 * Numeric semver-ish compare (segment-wise integers).
 * string comparison would treat '4.10.0' < '4.5.0' because '1' < '5'.
 * @param {string} a
 * @param {string} b
 * @returns {number} negative if a<b, 0 if equal, positive if a>b
 */
export function compareVersions(a, b) {
    const pa = String(a || '0').split('.').map(n => parseInt(n, 10) || 0);
    const pb = String(b || '0').split('.').map(n => parseInt(n, 10) || 0);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
        const diff = (pa[i] || 0) - (pb[i] || 0);
        if (diff !== 0) return diff;
    }
    return 0;
}

/** True when the stored settingsVersion is older than `target` (or unset). */
export function isOlderThan(currentVersion, target) {
    return !currentVersion || compareVersions(currentVersion, target) < 0;
}
