/**
 * Late-bound access to getSettings() so leaf modules (relationship-math, etc.)
 * can call it without importing the state-manager barrel (circular).
 * Bound from state-manager.js once getSettings is defined.
 */

/** @type {null | (() => Record<string, any>)} */
let _getSettings = null;

/** @param {() => Record<string, any>} fn */
export function bindGetSettings(fn) {
    _getSettings = fn;
}

/** @returns {Record<string, any>} */
export function getSettings() {
    if (!_getSettings) {
        throw new Error('getSettings not bound — state-manager failed to initialize');
    }
    return _getSettings();
}
