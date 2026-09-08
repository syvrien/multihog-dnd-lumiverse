/** Name-only identity used by SillyTavern's sender header. */
export function buildNameOnlyPersonaIdentity(name) {
    return {
        name: String(name || '').replace(/['"\\]/g, '').trim() || 'My Character',
        description: '',
    };
}

/** Preserve a source Persona description only for Persona-derived onboarding. */
export function resolveActivatedPersonaDescription(existingDescription, preserveExistingDescription = false) {
    return preserveExistingDescription ? String(existingDescription || '') : '';
}

/**
 * Normalize an active ST Persona without requiring a description. A selected
 * name-only Persona is still a real Persona and can seed character creation.
 */
export function normalizeActivePersonaIdentity(name, description) {
    const normalized = {
        name: String(name || '').trim(),
        description: String(description || '').trim(),
    };
    return normalized.name || normalized.description ? normalized : null;
}
