export const DIRECT_PROMPT_SYSTEM_MODES = Object.freeze({
    STATE_EXTRACTOR: 'state_extractor',
    MODULES_ONLY: 'modules_only',
});

/**
 * Character creation needs module schemas, not the State Extractor's
 * narrative-diff, persistence, and prior-memo operating rules.
 * @param {object} settings
 * @param {string} modulesText
 * @param {string} mode
 */
export function buildDirectPromptSystemPrompt(settings, modulesText, mode) {
    if (mode === DIRECT_PROMPT_SYSTEM_MODES.MODULES_ONLY) {
        return modulesText;
    }
    return String(settings.systemPromptTemplate || '{{modulesText}}')
        .replace('{{modulesText}}', modulesText);
}
