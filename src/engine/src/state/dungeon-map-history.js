/**
 * Keep dungeon-map occupancy snapshots aligned with State Tracker memoHistory.
 * Viewing a previous [ LIVE ] stone overlays that occupancy; restoring it as
 * LIVE writes the matching [MAP] section back to the Locations lorebook.
 */

export function ensureDungeonMapHistory(settings) {
    if (!settings || typeof settings !== 'object') return [];
    if (!Array.isArray(settings.dungeonMapHistory)) settings.dungeonMapHistory = [];
    const memoLen = Array.isArray(settings.memoHistory) ? settings.memoHistory.length : 0;
    while (settings.dungeonMapHistory.length < memoLen) settings.dungeonMapHistory.push(null);
    if (settings.dungeonMapHistory.length > memoLen) settings.dungeonMapHistory.length = memoLen;
    return settings.dungeonMapHistory;
}

export function sliceMemoAndMapHistory(settings, fromIndex) {
    const start = Math.max(0, Number(fromIndex) || 0);
    ensureDungeonMapHistory(settings);
    settings.memoHistory = (settings.memoHistory || []).slice(start);
    settings.dungeonMapHistory = (settings.dungeonMapHistory || []).slice(start);
}

export function unshiftMemoAndMapHistory(settings, memo, mapSnapshot, { max = 1000 } = {}) {
    if (!Array.isArray(settings.memoHistory)) settings.memoHistory = [];
    ensureDungeonMapHistory(settings);
    settings.memoHistory.unshift(memo);
    settings.dungeonMapHistory.unshift(mapSnapshot ?? null);
    if (settings.memoHistory.length > max) {
        settings.memoHistory.length = max;
        settings.dungeonMapHistory.length = max;
    }
}

export function shiftMemoAndMapHistory(settings) {
    if (!Array.isArray(settings.memoHistory)) settings.memoHistory = [];
    ensureDungeonMapHistory(settings);
    settings.memoHistory.shift();
    settings.dungeonMapHistory.shift();
}

export function clearMemoAndMapHistory(settings) {
    settings.memoHistory = [];
    settings.dungeonMapHistory = [];
}

export function getDungeonMapHistoryEntry(settings, index) {
    ensureDungeonMapHistory(settings);
    if (index == null || index < 0) return null;
    return settings.dungeonMapHistory[index] ?? null;
}

/** After a live [MAP] mutation, keep the current LIVE history slot in sync. */
export function recordLiveDungeonMapSnapshot(settings, mapSnapshot) {
    if (!settings || mapSnapshot == null) return;
    ensureDungeonMapHistory(settings);
    if (settings.historyIndex === 0 && settings.dungeonMapHistory.length) {
        settings.dungeonMapHistory[0] = mapSnapshot;
    }
}
