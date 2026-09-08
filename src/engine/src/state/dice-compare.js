/**
 * Pure helpers for unified RollTheDice compare semantics (gte DC vs lte %).
 */

/**
 * True when a formula is a pure d100 / percentage roll (not e.g. 1d20+1d100).
 * @param {string|undefined|null} formula
 * @returns {boolean}
 */
export function isPercentFormula(formula) {
    const f = String(formula || '').trim().toLowerCase().replace(/\s+/g, '');
    if (!f) return false;
    // Pure 1d100 / d100, optionally +/− flat mods only (no other die groups).
    return /^(?:\d*)d100(?:[+-]\d+)*$/.test(f);
}

/**
 * Resolve compare mode: explicit gte|lte wins; else d100 → lte, otherwise gte.
 * @param {string|undefined|null} compare
 * @param {string} formula
 * @returns {'gte'|'lte'}
 */
export function resolveDiceCompare(compare, formula) {
    const c = String(compare || '').trim().toLowerCase();
    if (c === 'lte' || c === 'gte') return c;
    return isPercentFormula(formula) ? 'lte' : 'gte';
}
