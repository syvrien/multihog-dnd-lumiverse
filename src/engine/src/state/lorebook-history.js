/** Returns true when a lorebook belongs to one campaign prefix. */
export function bookBelongsToCampaignPrefix(bookName, prefix) {
    if (!prefix) return false;
    const lowerBook = String(bookName).toLowerCase();
    const lowerPrefix = String(prefix).toLowerCase();
    if (lowerBook === lowerPrefix) return true;
    const rest = lowerBook.startsWith(`${lowerPrefix}_`)
        ? lowerBook.slice(lowerPrefix.length + 1)
        : null;
    return rest !== null && !rest.includes('_');
}

/** Lorebook names explicitly represented by a history state. */
export function getLorebookSnapshotNames(snapshot = {}) {
    const names = new Set(Array.isArray(snapshot.campaignBookNames) ? snapshot.campaignBookNames : []);
    for (const name of Object.keys(snapshot.bookSnapshots || {})) names.add(name);
    // Ownership list is part of the pre-pass baseline so a temporarily undiscovered
    // owned book is never treated as "created" and deleted on undo.
    for (const name of Array.isArray(snapshot.campaignBooks) ? snapshot.campaignBooks : []) {
        if (name) names.add(name);
    }
    return [...names].filter(Boolean);
}

/**
 * True when a Lorebook Agent history/redo entry belongs to the active chat.
 * Prefer chatId; legacy snapshots without chatId fall back to campaign prefix.
 */
export function isLoreHistoryEntryForChat(entry, { chatId = null, campaignPrefix = '' } = {}) {
    if (!entry || typeof entry !== 'object') return false;
    if (entry.chatId != null && String(entry.chatId).length > 0 && chatId != null && String(chatId).length > 0) {
        return String(entry.chatId) === String(chatId);
    }
    if (!entry.chatId && entry.campaignPrefix && campaignPrefix) {
        return String(entry.campaignPrefix).toLowerCase() === String(campaignPrefix).toLowerCase();
    }
    return false;
}

/** True only when both halves of a redo pair belong to the active chat. */
export function isLoreRedoEntryForChat(entry, scope = {}) {
    return !!entry
        && isLoreHistoryEntryForChat(entry.prePassSnapshot, scope)
        && isLoreHistoryEntryForChat(entry.postPassState, scope);
}

/** Index of the newest history entry that may be undone in the active chat. */
export function findLoreHistoryIndexForChat(history = [], scope = {}) {
    if (!Array.isArray(history)) return -1;
    return history.findIndex(entry => isLoreHistoryEntryForChat(entry, scope));
}

/**
 * Remove the rolled-back entry and any newer entries for the same chat while
 * preserving interleaved history from every other chat.
 */
export function trimLoreHistoryForRollback(history = [], index = -1) {
    if (!Array.isArray(history)) return [];
    if (index < 0 || index >= history.length) return [...history];
    const target = history[index];
    const scope = {
        chatId: target?.chatId ?? null,
        campaignPrefix: target?.campaignPrefix || '',
    };
    return history.filter((entry, entryIndex) =>
        entryIndex > index || !isLoreHistoryEntryForChat(entry, scope));
}

function bookNamesFromLogEntries(entries = []) {
    const names = new Set();
    for (const entry of entries) {
        for (const id of entry?.record || []) {
            const name = String(id || '').split('::')[0];
            if (name) names.add(name);
        }
    }
    return names;
}

/**
 * Identifies books that a pass created without treating every campaign-prefixed
 * book as disposable. New snapshots carry an exact list. Legacy snapshots fall
 * back to the pass's recorded entry IDs, which is deliberately conservative.
 */
export function getCreatedLorebookNames({ snapshot = {}, currentNames = [], currentRouterLog = [], historyIndex = 0, prefix = '' } = {}) {
    const currentSet = new Set(currentNames);
    const prePassSet = new Set(getLorebookSnapshotNames(snapshot));

    if (Array.isArray(snapshot.createdBookNames)) {
        return snapshot.createdBookNames.filter(name =>
            currentSet.has(name)
            && !prePassSet.has(name)
            && bookBelongsToCampaignPrefix(name, prefix));
    }

    let passLogEntries;
    if (Array.isArray(snapshot.routerLog)) {
        const addedCount = Math.max(0, currentRouterLog.length - snapshot.routerLog.length);
        passLogEntries = currentRouterLog.slice(0, addedCount);
    } else {
        // Compatibility for snapshots made before routerLog was captured.
        passLogEntries = currentRouterLog.slice(0, Math.max(1, historyIndex + 1));
    }

    const referenced = bookNamesFromLogEntries(passLogEntries);
    return [...referenced].filter(name =>
        currentSet.has(name)
        && !prePassSet.has(name)
        && bookBelongsToCampaignPrefix(name, prefix));
}
