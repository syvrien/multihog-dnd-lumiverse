/**
 * Pure helpers for campaign lorebook stack cloning (no SillyTavern I/O).
 */

/**
 * Same matching rule as Lorebook Agent / router: exact prefix, or prefix_SingleToken
 * with no further underscores in the suffix. Comparison is case-insensitive (router parity).
 * @param {string} bookName
 * @param {string} prefix
 */
export function bookBelongsToPrefix(bookName, prefix) {
    if (!prefix) return false;
    const lowerBook = String(bookName || '').toLowerCase();
    const lowerPref = String(prefix || '').toLowerCase();
    if (lowerBook === lowerPref) return true;
    const rest = lowerBook.startsWith(lowerPref + '_') ? lowerBook.slice(lowerPref.length + 1) : null;
    return rest !== null && !rest.includes('_');
}

/**
 * @param {string} currentPrefix
 * @param {string} bookName
 * @param {string} newPrefix
 */
export function renameBookForPrefix(currentPrefix, bookName, newPrefix) {
    const lowerBook = String(bookName || '').toLowerCase();
    const lowerPref = String(currentPrefix || '').toLowerCase();
    if (lowerBook === lowerPref) return newPrefix;
    // Length-stable ASCII prefixes: keep the original suffix casing (e.g. "_NPCs").
    const suffix = String(bookName).slice(String(currentPrefix).length); // includes leading '_'
    return newPrefix + suffix;
}

/**
 * Planned destination names for a prefix clone (pure; no I/O).
 * @param {string[]} sourceBookNames
 * @param {string} currentPrefix
 * @param {string} newPrefix
 * @returns {string[]}
 */
export function plannedCloneDestinations(sourceBookNames, currentPrefix, newPrefix) {
    return (Array.isArray(sourceBookNames) ? sourceBookNames : [])
        .map((name) => renameBookForPrefix(currentPrefix, name, newPrefix));
}

/**
 * Destination names that already exist in the world list (case-insensitive).
 * @param {string[]} destinations
 * @param {string[]} existingNames
 * @returns {string[]} Existing names that collide (original casing from the registry).
 */
export function findCloneDestinationCollisions(destinations, existingNames) {
    const existingByLower = new Map();
    for (const name of Array.isArray(existingNames) ? existingNames : []) {
        const key = String(name || '').toLowerCase();
        if (key && !existingByLower.has(key)) existingByLower.set(key, name);
    }
    const collisions = [];
    const seen = new Set();
    for (const dest of Array.isArray(destinations) ? destinations : []) {
        const hit = existingByLower.get(String(dest || '').toLowerCase());
        if (!hit) continue;
        const k = String(hit).toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        collisions.push(hit);
    }
    return collisions;
}
