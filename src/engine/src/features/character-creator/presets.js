/** @param {unknown} name */
export function normalizeCharacterCreatorPresetName(name) {
    return String(name || '').trim().toLocaleLowerCase();
}

/**
 * Finds a preset by its user-visible name, ignoring surrounding whitespace and case.
 * @param {Array<{id: string, name: string, data: any}>} presets
 * @param {unknown} name
 */
export function findCharacterCreatorPresetByName(presets, name) {
    const normalized = normalizeCharacterCreatorPresetName(name);
    if (!normalized) return null;
    return (presets || []).find(preset => normalizeCharacterCreatorPresetName(preset?.name) === normalized) || null;
}

/**
 * Inserts a new preset or replaces the data of an existing same-name preset.
 * Existing IDs are retained so the selected preset remains stable after overwrite.
 * @param {Array<{id: string, name: string, data: any}>} presets
 * @param {string} name
 * @param {any} data
 * @param {() => string} createId
 */
export function upsertCharacterCreatorPreset(presets, name, data, createId) {
    const trimmedName = String(name || '').trim();
    const existing = findCharacterCreatorPresetByName(presets, trimmedName);
    const preset = {
        id: existing?.id || createId(),
        name: trimmedName,
        data,
    };
    if (!existing) {
        return { presets: [...(presets || []), preset], preset, overwritten: false };
    }
    return {
        presets: (presets || []).map(item => item.id === existing.id ? preset : item),
        preset,
        overwritten: true,
    };
}
