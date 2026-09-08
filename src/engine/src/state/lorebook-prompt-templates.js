import { buildDefaultSettings } from './defaults.js';
import {
    LOREBOOK_AGENT_FRAGMENT_KEYS,
    LOREBOOK_BASIC_FRAGMENT_KEYS,
    LOREBOOK_RUNTIME_FRAGMENT_KEYS,
} from './lorebook-runtime-fragments.js';

export const LOREBOOK_PROMPT_TEMPLATE_KEYS = Object.freeze([
    'routerBasicSystemPromptTemplate',
    'routerSystemPromptTemplate',
    'routerModularPromptTemplate',
    'routerAgentSharedContextTemplate',
    ...LOREBOOK_RUNTIME_FRAGMENT_KEYS,
]);

/**
 * Restore factory Lorebook Agent prompt templates without going through the
 * settings migration pipeline. Prompt-content upgrades are owned by the
 * Prompt Defaults Updated fingerprint/dialog flow.
 *
 * @param {Record<string, any>} settings
 * @param {'basic'|'agent'|'all'} [scope]
 * @param {Record<string, any>} [defaults]
 * @returns {Record<string, any>}
 */
export function resetLorebookPromptTemplates(settings, scope = 'all', defaults = buildDefaultSettings()) {
    if (!settings || !defaults) return settings;

    const keys = scope === 'basic'
        ? ['routerBasicSystemPromptTemplate', 'routerModularPromptTemplate', ...LOREBOOK_BASIC_FRAGMENT_KEYS]
        : scope === 'agent'
            ? ['routerSystemPromptTemplate', 'routerAgentSharedContextTemplate', ...LOREBOOK_AGENT_FRAGMENT_KEYS]
            : LOREBOOK_PROMPT_TEMPLATE_KEYS;

    for (const key of keys) {
        settings[key] = String(defaults[key] ?? '');
    }

    return settings;
}

/**
 * Expand the explicitly dynamic portions of a stored Lorebook prompt without
 * mutating the stored template. SillyTavern macros such as {{user}} and
 * {{char}} are intentionally left alone unless supplied in `values`.
 *
 * @param {string} template
 * @param {Record<string, string|number|null|undefined>} values
 * @returns {string}
 */
export function expandLorebookPromptTemplate(template, values = {}) {
    let result = String(template || '');
    for (const [key, value] of Object.entries(values)) {
        result = result.replaceAll(`{{${key}}}`, String(value ?? ''));
    }
    return result;
}
