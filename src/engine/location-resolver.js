import { normalizeLocationPath } from './portraits.js';

/**
 * Tokenize freeform location text for loose matching against lore paths.
 * @param {string} raw
 * @returns {string[]}
 */
export function tokenizeLocationText(raw) {
    if (!raw) return [];
    let text = String(raw).trim();
    if (!text) return [];

    text = text
        .replace(/\s*::\s*/g, ' ')
        .replace(/[,/]/g, ' ')
        .replace(/\s*[—–]\s*/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    return text
        .split(' ')
        .map(t => t.toLowerCase())
        .filter(Boolean);
}

/**
 * @param {string} part
 * @returns {string[]}
 */
function partToTokens(part) {
    return String(part || '')
        .toLowerCase()
        .trim()
        .split(/\s+/)
        .filter(Boolean);
}

/**
 * @param {string[]} parts
 * @returns {string[]}
 */
function pathPartsToTokens(parts) {
    const seq = [];
    for (const part of parts) {
        seq.push(...partToTokens(part));
    }
    return seq;
}

/**
 * @param {string[]} inputTokens
 * @param {string[]} pathTokens
 * @returns {boolean}
 */
function tokensSuffixMatch(inputTokens, pathTokens) {
    if (!pathTokens.length || pathTokens.length > inputTokens.length) return false;
    const start = inputTokens.length - pathTokens.length;
    for (let i = 0; i < pathTokens.length; i++) {
        if (inputTokens[start + i] !== pathTokens[i]) return false;
    }
    return true;
}

/**
 * Loosely resolve freeform location text to a canonical lore path.
 * Deepest suffix match wins (e.g. "Monastery Courtyard" → "Monastery :: Courtyard").
 * @param {string} rawText
 * @param {string[]} allPaths Canonical paths using ` :: ` separators
 * @param {{ activeLocPaths?: string[], preferLeafOnly?: boolean }} [opts]
 * @returns {string|null}
 */
export function resolveCurrentLocationPath(rawText, allPaths, opts = {}) {
    if (!rawText || !Array.isArray(allPaths) || allPaths.length === 0) return null;

    const inputTokens = tokenizeLocationText(rawText);
    if (!inputTokens.length) return null;

    const normalizedPaths = allPaths
        .map(p => normalizeLocationPath(p))
        .filter(Boolean);

    const activeSet = new Set((opts.activeLocPaths || []).map(p => normalizeLocationPath(p)));

    let bestPath = null;
    let bestScore = -1;

    for (const path of normalizedPaths) {
        const parts = path.split(' :: ');
        const pathTokens = pathPartsToTokens(parts);
        if (!pathTokens.length) continue;

        if (!tokensSuffixMatch(inputTokens, pathTokens)) continue;

        let score = parts.length * 1000 + pathTokens.length;
        if (activeSet.has(path)) score += 50;
        if (normalizeLocationPath(rawText) === path) score += 500;

        if (score > bestScore) {
            bestScore = score;
            bestPath = path;
        }
    }

    if (bestPath) return bestPath;

    // Leaf-only fallback: "Courtyard" → "... :: Courtyard"
    const leafToken = inputTokens[inputTokens.length - 1];
    const leafCandidates = normalizedPaths.filter((path) => {
        const parts = path.split(' :: ');
        const leaf = parts[parts.length - 1];
        return partToTokens(leaf).join(' ') === leafToken
            || (partToTokens(leaf).length === 1 && partToTokens(leaf)[0] === leafToken);
    });

    if (leafCandidates.length === 0) return null;

    const activeLeaf = leafCandidates.find(p => activeSet.has(p));
    if (activeLeaf) return activeLeaf;

    if (inputTokens.length > 1) {
        const parentTokens = inputTokens.slice(0, -1);
        const parentHint = parentTokens.join(' ');
        const hinted = resolveCurrentLocationPath(
            `${parentHint} ${leafCandidates[0].split(' :: ').pop()}`,
            leafCandidates,
            { activeLocPaths: opts.activeLocPaths },
        );
        if (hinted) return hinted;
    }

    return leafCandidates.sort((a, b) => b.split(' :: ').length - a.split(' :: ').length)[0];
}

/**
 * @param {string} path
 * @returns {string}
 */
export function formatLocationBreadcrumb(path) {
    if (!path) return '';
    return normalizeLocationPath(path)
        .split(' :: ')
        .map(seg => seg.trim())
        .filter(Boolean)
        .join(' › ');
}
