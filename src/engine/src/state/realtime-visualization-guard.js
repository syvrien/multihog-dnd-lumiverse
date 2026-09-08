/**
 * Browser-local safety latch for Real-Time Visualization.
 *
 * SillyTavern settings are saved as whole-document snapshots. A delayed save
 * from stale in-memory state can therefore resurrect a setting that was just
 * turned off. Keep an explicit local kill switch that wins until this browser
 * deliberately enables Real-Time Visualization again.
 */

export const REALTIME_VISUALIZATION_DISABLED_KEY = 'rpg_tracker_realtime_visualization_disabled';

function getStorage(storage) {
    if (storage) return storage;
    try {
        return globalThis.localStorage || null;
    } catch (_) {
        return null;
    }
}

export function isRealtimeVisualizationDisabled(storage = null) {
    try {
        return getStorage(storage)?.getItem(REALTIME_VISUALIZATION_DISABLED_KEY) === 'true';
    } catch (_) {
        return false;
    }
}

export function setRealtimeVisualizationDisabled(disabled, storage = null) {
    try {
        const target = getStorage(storage);
        if (!target) return;
        if (disabled) target.setItem(REALTIME_VISUALIZATION_DISABLED_KEY, 'true');
        else target.removeItem(REALTIME_VISUALIZATION_DISABLED_KEY);
    } catch (_) {
        // Storage can be unavailable in private/restricted browser contexts.
    }
}

/**
 * Apply the local kill switch to a live or freshly restored settings object.
 * @returns {boolean} Whether any live setting was changed.
 */
export function enforceRealtimeVisualizationDisabled(settings, storage = null) {
    if (!settings || !isRealtimeVisualizationDisabled(storage)) return false;
    const changed = settings.portraitAutoGenerateSceneView !== false
        || settings.portraitRegenerateVisitedLocations !== false;
    settings.portraitAutoGenerateSceneView = false;
    settings.portraitRegenerateVisitedLocations = false;
    return changed;
}
