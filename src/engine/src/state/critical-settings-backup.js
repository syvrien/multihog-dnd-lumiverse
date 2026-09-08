/**
 * Synchronous localStorage WAL for small global prefs that are easy to lose when
 * a ~multi‑MB settings.json save is cancelled by a reload (common when editing
 * extension code and refreshing before ST's async /api/settings/save finishes).
 *
 * Unlike the optional module-schema recovery prompt, this backup auto-applies when
 * its timestamp is newer than settings.criticalSettingsSyncedTs on disk.
 */

export const CRITICAL_SETTINGS_BACKUP_KEY = 'rpg_tracker_critical_settings_backup';

/** @type {readonly string[]} */
export const CRITICAL_SETTINGS_BACKUP_FIELDS = [
    'displayGroups',
    'displayGroupsEnabled',
    'displayGroupsShowGaps',
    'lastResetVersion',
    'lastSeenPromptDefaultsFingerprint',
    'lastSeenPromptDefaultsSnapshot',
    'autoResetPromptsOnUpdate',
];

/**
 * @param {any} value
 * @returns {any}
 */
function cloneJson(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/**
 * @returns {{ ts: number, [key: string]: any }|null}
 */
export function readCriticalSettingsBackup() {
    try {
        const raw = localStorage.getItem(CRITICAL_SETTINGS_BACKUP_KEY);
        if (!raw) return null;
        const backup = JSON.parse(raw);
        if (!backup || typeof backup !== 'object' || !Number.isFinite(backup.ts)) return null;
        return backup;
    } catch (err) {
        console.warn('[RPG Tracker] Critical settings backup read failed:', err);
        return null;
    }
}

/**
 * Mirror the critical fields into localStorage (cannot be cancelled by unload).
 * @param {Record<string, any>} settings
 * @returns {number} backup timestamp
 */
export function writeCriticalSettingsBackup(settings) {
    const s = settings || {};
    const ts = Date.now();
    /** @type {Record<string, any>} */
    const payload = { ts };
    for (const key of CRITICAL_SETTINGS_BACKUP_FIELDS) {
        payload[key] = cloneJson(s[key]);
    }
    try {
        localStorage.setItem(CRITICAL_SETTINGS_BACKUP_KEY, JSON.stringify(payload));
    } catch (err) {
        console.warn('[RPG Tracker] Critical settings backup write failed:', err);
    }
    return ts;
}

/**
 * Stamp the in-memory settings so a successful disk save can prove it's caught up.
 * Call this immediately before awaiting the disk write that includes these fields.
 * @param {Record<string, any>} settings
 * @param {number} [ts]
 * @returns {number}
 */
export function stampCriticalSettingsSynced(settings, ts = Date.now()) {
    if (settings && typeof settings === 'object') {
        settings.criticalSettingsSyncedTs = ts;
    }
    return ts;
}

/**
 * Apply a newer browser-local critical backup over stale disk-loaded settings.
 * @param {Record<string, any>} settings
 * @returns {boolean} true if anything was restored
 */
export function applyCriticalSettingsBackup(settings) {
    if (!settings || typeof settings !== 'object') return false;
    const backup = readCriticalSettingsBackup();
    if (!backup) return false;
    const diskTs = Number(settings.criticalSettingsSyncedTs) || 0;
    if (!(backup.ts > diskTs)) return false;

    let changed = false;
    for (const key of CRITICAL_SETTINGS_BACKUP_FIELDS) {
        if (!Object.prototype.hasOwnProperty.call(backup, key)) continue;
        const next = cloneJson(backup[key]);
        const prev = settings[key];
        if (JSON.stringify(prev) !== JSON.stringify(next)) {
            settings[key] = next;
            changed = true;
        }
    }
    // Match the backup clock so we don't re-apply forever if the heal save is cancelled again.
    settings.criticalSettingsSyncedTs = backup.ts;
    if (changed) {
        console.info('[RPG Tracker] Restored critical settings from browser-local backup (disk save was likely cancelled by reload).');
    }
    return changed;
}
