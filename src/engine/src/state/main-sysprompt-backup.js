/**
 * Durable backup of SillyTavern Quick Prompt Main.
 *
 * The framework overwrites Main with its narrator prompt while the tracker is on.
 * That snapshot must be taken *before* the overwrite, and it must survive:
 * cancelled settings.json saves, tracker ⏻ disable, extension disable/reload,
 * and empty-textarea races while Prompt Manager is still hydrating.
 *
 * Storage is dual-write: extension settings (disk) + a sync localStorage WAL.
 * localStorage cannot be cancelled by a reload, so it is the copy that is
 * never discarded once a non-empty user prompt has been captured.
 */

import { saveSettings } from '../app/runtime-bridge.js';

export const MAIN_SYSPROMPT_BACKUP_KEY = 'rpg_tracker_main_sysprompt_backup';

const MAIN_TEXTAREA_ID = 'main_prompt_quick_edit_textarea';

/** Markers present in every shipped Multihog narrator prompt (normal + legacy). */
const FRAMEWORK_SYSPROMPT_MARKERS = [
    'DM/World Simulator for a D&D-style TTRPG',
    '<rng_system>',
];

/**
 * @param {Record<string, any>|null|undefined} settings
 * @returns {boolean}
 */
export function isMainSyspromptBackupEnabled(settings) {
    return !settings || settings.mainSyspromptBackupEnabled !== false;
}

/**
 * @returns {HTMLTextAreaElement|null}
 */
export function getMainSyspromptTextarea() {
    if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return null;
    return /** @type {HTMLTextAreaElement|null} */ (document.getElementById(MAIN_TEXTAREA_ID));
}

/**
 * @returns {Record<string, any>|null}
 */
export function getChatCompletionSettings() {
    try {
        const ctx = globalThis.SillyTavern?.getContext?.();
        if (ctx?.chatCompletionSettings && typeof ctx.chatCompletionSettings === 'object') {
            return ctx.chatCompletionSettings;
        }
    } catch {
        /* host not ready */
    }
    const fallback = globalThis.oai_settings;
    return fallback && typeof fallback === 'object' ? fallback : null;
}

/**
 * True when we can read the live Main prompt from the textarea or Prompt Manager store.
 * An empty value on a ready source means the user really has an empty Main.
 * @returns {boolean}
 */
export function isMainSyspromptSourceReady() {
    if (getMainSyspromptTextarea()) return true;
    const oai = getChatCompletionSettings();
    if (!oai) return false;
    if (Array.isArray(oai.prompts)) return true;
    return typeof oai.main_prompt === 'string';
}

/**
 * @param {Record<string, any>|null} oai
 * @returns {string}
 */
function readPromptManagerMain(oai) {
    if (!oai || typeof oai !== 'object') return '';
    if (Array.isArray(oai.prompts)) {
        const main = oai.prompts.find((item) => item && item.identifier === 'main');
        if (main && typeof main.content === 'string') return main.content;
    }
    if (typeof oai.main_prompt === 'string') return oai.main_prompt;
    return '';
}

/**
 * Live Quick Prompt Main: prefer a non-empty textarea (user may be editing),
 * otherwise Prompt Manager / oai_settings so we do not snapshot an unhydrated empty box.
 * @returns {string}
 */
export function getLiveMainSyspromptText() {
    const ta = getMainSyspromptTextarea();
    const fromTa = ta ? String(ta.value ?? '') : '';
    const fromPm = readPromptManagerMain(getChatCompletionSettings());
    if (fromTa.trim()) return fromTa;
    if (fromPm.trim()) return fromPm;
    return fromTa || fromPm || '';
}

/**
 * Write Main both to the Quick Edit textarea (when present) and to Prompt Manager
 * so restore works even if the Quick Prompts drawer is not in the DOM.
 * @param {string} text
 * @returns {boolean} true if any store accepted the write
 */
export function setLiveMainSyspromptText(text) {
    const value = String(text ?? '');
    let wrote = false;
    const oai = getChatCompletionSettings();
    if (oai) {
        if (Array.isArray(oai.prompts)) {
            const main = oai.prompts.find((item) => item && item.identifier === 'main');
            if (main && typeof main === 'object') {
                main.content = value;
                wrote = true;
            }
        }
        if (Object.prototype.hasOwnProperty.call(oai, 'main_prompt') || !wrote) {
            oai.main_prompt = value;
            wrote = true;
        }
    }
    const ta = getMainSyspromptTextarea();
    if (ta) {
        ta.value = value;
        try {
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            ta.dispatchEvent(new Event('blur', { bubbles: true }));
        } catch {
            /* jsdom/event stubs */
        }
        wrote = true;
    }
    try {
        void saveSettings();
    } catch {
        /* non-fatal */
    }
    return wrote;
}

/**
 * @param {string} text
 * @param {string} [builtFrameworkText]
 * @returns {boolean}
 */
export function looksLikeFrameworkSysprompt(text, builtFrameworkText = '') {
    const t = String(text ?? '').trim();
    if (!t) return false;
    const built = String(builtFrameworkText ?? '').trim();
    if (built && t === built) return true;
    return FRAMEWORK_SYSPROMPT_MARKERS.every((marker) => t.includes(marker));
}

/**
 * @returns {{ ts: number, text: string }|null}
 */
export function readDurableMainSyspromptBackup() {
    try {
        const raw = localStorage.getItem(MAIN_SYSPROMPT_BACKUP_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;
        if (typeof parsed.text !== 'string') return null;
        const ts = Number(parsed.ts);
        return { ts: Number.isFinite(ts) ? ts : 0, text: parsed.text };
    } catch (err) {
        console.warn('[RPG Tracker] Main sysprompt backup read failed:', err);
        return null;
    }
}

/**
 * Mirror the backup into localStorage. Never replaces a non-empty copy with empty.
 * @param {string} text
 * @returns {number} backup timestamp
 */
export function writeDurableMainSyspromptBackup(text) {
    const next = String(text ?? '');
    const existing = readDurableMainSyspromptBackup();
    if (!next.trim()) {
        if (existing?.text?.trim()) {
            console.warn('[RPG Tracker] Refusing to erase a non-empty Main prompt backup from localStorage.');
            return existing.ts || Date.now();
        }
        return existing?.ts || 0;
    }
    const ts = Date.now();
    try {
        localStorage.setItem(MAIN_SYSPROMPT_BACKUP_KEY, JSON.stringify({ ts, text: next }));
    } catch (err) {
        console.warn('[RPG Tracker] Main sysprompt backup write failed:', err);
    }
    return ts;
}

/**
 * Prefer a real user prompt over an empty or framework-shaped copy.
 * When both copies are real user prompts, prefer the newer timestamp.
 * @param {string} settingsText
 * @param {{ ts?: number, text?: string }|null} durable
 * @param {number} [settingsTs]
 * @returns {string}
 */
export function pickPreferredBackupText(settingsText, durable, settingsTs = 0) {
    const fromSettings = String(settingsText ?? '');
    const fromDurable = durable && typeof durable.text === 'string' ? durable.text : '';
    if (fromSettings.trim() && !fromDurable.trim()) return fromSettings;
    if (fromDurable.trim() && !fromSettings.trim()) return fromDurable;
    if (!fromSettings.trim() && !fromDurable.trim()) return '';
    if (fromSettings === fromDurable) return fromSettings;

    const settingsIsFw = looksLikeFrameworkSysprompt(fromSettings);
    const durableIsFw = looksLikeFrameworkSysprompt(fromDurable);
    if (settingsIsFw && !durableIsFw) return fromDurable;
    if (durableIsFw && !settingsIsFw) return fromSettings;
    const aTs = Number(settingsTs) || 0;
    const bTs = Number(durable?.ts) || 0;
    if (aTs !== bTs) return bTs > aTs ? fromDurable : fromSettings;
    if (fromSettings.length !== fromDurable.length) {
        return fromSettings.length >= fromDurable.length ? fromSettings : fromDurable;
    }
    return fromDurable || fromSettings;
}

/**
 * Heal settings from localStorage (or vice versa) and return the kept text.
 * @param {Record<string, any>|null|undefined} settings
 * @returns {string}
 */
export function getEffectiveBackupText(settings) {
    const durable = readDurableMainSyspromptBackup();
    const picked = pickPreferredBackupText(
        settings?.stashedMainSysprompt,
        durable,
        settings?.mainSyspromptBackupTs,
    );
    if (settings && picked !== String(settings.stashedMainSysprompt ?? '')) {
        settings.stashedMainSysprompt = picked;
        settings.syspromptStashArmed = !!picked.trim();
    }
    if (picked.trim() && durable?.text !== picked) {
        writeDurableMainSyspromptBackup(picked);
    }
    return picked;
}

/**
 * @param {Record<string, any>} settings
 * @returns {boolean} true if settings were healed from localStorage
 */
export function hydrateMainSyspromptBackup(settings) {
    if (!settings || typeof settings !== 'object') return false;
    const before = String(settings.stashedMainSysprompt ?? '');
    const after = getEffectiveBackupText(settings);
    if (after.trim() && !before.trim()) {
        settings.syspromptStashArmed = true;
        return true;
    }
    if (after && after !== before) {
        settings.syspromptStashArmed = !!after.trim();
        return true;
    }
    return false;
}

/**
 * @param {string} existingText
 * @param {string} candidateText
 * @param {{ manual?: boolean, builtFrameworkText?: string }} [opts]
 * @returns {boolean}
 */
export function shouldReplaceBackup(existingText, candidateText, opts = {}) {
    const existing = String(existingText ?? '');
    const candidate = String(candidateText ?? '');
    if (!candidate.trim()) return false;
    if (candidate === existing) return false;

    const candidateIsFramework = looksLikeFrameworkSysprompt(candidate, opts.builtFrameworkText);
    // Never store the framework narrator prompt as the user's original Main —
    // including an explicit Save click while the tracker is already managing Main.
    if (candidateIsFramework) return false;

    if (opts.manual) return true;
    if (!existing.trim()) return true;
    if (looksLikeFrameworkSysprompt(existing, opts.builtFrameworkText)) return true;
    return true;
}

/**
 * Snapshot live Main into the durable backup *before* the framework overwrites it.
 * @param {Record<string, any>} settings
 * @param {{ force?: boolean, manual?: boolean, builtFrameworkText?: string }} [opts]
 * @returns {{ ok: boolean, shouldDefer: boolean, changed: boolean, reason: string }}
 */
export function captureMainSyspromptBackup(settings, opts = {}) {
    const manual = !!opts.manual;
    if (!settings || !isMainSyspromptBackupEnabled(settings)) {
        return { ok: true, shouldDefer: false, changed: false, reason: 'disabled' };
    }
    if (!manual && (settings.customSysprompt || !settings.enabled)) {
        return { ok: true, shouldDefer: false, changed: false, reason: 'skipped' };
    }

    hydrateMainSyspromptBackup(settings);
    const existing = String(settings.stashedMainSysprompt ?? '');
    const sourceReady = isMainSyspromptSourceReady();
    const live = getLiveMainSyspromptText();

    if (manual && !live.trim()) {
        return { ok: false, shouldDefer: false, changed: false, reason: 'empty' };
    }

    if (!sourceReady && !existing.trim() && !manual) {
        return { ok: false, shouldDefer: true, changed: false, reason: 'source-not-ready' };
    }

    if (!live.trim()) {
        // Ready empty Main: nothing to capture. Keep any existing backup.
        return { ok: true, shouldDefer: false, changed: false, reason: existing.trim() ? 'kept' : 'nothing-to-capture' };
    }

    if (!shouldReplaceBackup(existing, live, opts)) {
        const haveBackup = !!existing.trim();
        const liveIsFramework = looksLikeFrameworkSysprompt(live, opts.builtFrameworkText);
        if (haveBackup) settings.syspromptStashArmed = true;
        if (liveIsFramework) {
            return { ok: true, shouldDefer: false, changed: false, reason: 'already-framework' };
        }
        if (haveBackup) {
            return { ok: true, shouldDefer: false, changed: false, reason: 'kept' };
        }
        return { ok: false, shouldDefer: !sourceReady, changed: false, reason: 'rejected' };
    }

    settings.stashedMainSysprompt = live;
    settings.syspromptStashArmed = true;
    settings.mainSyspromptBackupTs = writeDurableMainSyspromptBackup(live);
    return { ok: true, shouldDefer: false, changed: true, reason: 'captured' };
}

/**
 * Restore the durable backup into live Main. The backup itself is never disarmed.
 * @param {Record<string, any>} settings
 * @param {{ manual?: boolean }} [opts]
 * @returns {boolean}
 */
export function restoreMainSyspromptStash(settings, opts = {}) {
    const manual = !!opts.manual;
    if (!settings || !isMainSyspromptBackupEnabled(settings)) return false;
    if (!manual && settings.customSysprompt) return false;
    hydrateMainSyspromptBackup(settings);
    const text = String(settings.stashedMainSysprompt ?? '');
    if (!text.trim()) return false;
    settings.syspromptStashArmed = true;
    return setLiveMainSyspromptText(text);
}

/**
 * If the tracker is off but Main still holds the framework prompt (restore missed
 * the textarea on disable, or the extension was disabled mid-session), put the
 * user's backup back.
 * @param {Record<string, any>} settings
 * @returns {boolean}
 */
export function maybeRestoreMainIfTrackerDisabled(settings) {
    if (!settings || settings.enabled || settings.customSysprompt) return false;
    if (!isMainSyspromptBackupEnabled(settings)) return false;
    if (!isMainSyspromptSourceReady()) return false;
    hydrateMainSyspromptBackup(settings);
    const backup = String(settings.stashedMainSysprompt ?? '');
    if (!backup.trim()) return false;
    const live = getLiveMainSyspromptText();
    if (live.trim() && !looksLikeFrameworkSysprompt(live) && live !== backup) return false;
    if (live === backup) return false;
    return restoreMainSyspromptStash(settings);
}
