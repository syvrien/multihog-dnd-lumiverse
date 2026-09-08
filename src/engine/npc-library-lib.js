/**
 * Pure NPC Library helpers — records, name uniqueness, and .mnpc.json packages.
 * Portrait file I/O lives in npc-library.js so this stays unit-testable.
 */

export const NPC_LIBRARY_FORMAT = 'multihog-npc';
export const NPC_LIBRARY_PACK_FORMAT = 'multihog-npc-pack';
export const NPC_LIBRARY_VERSION = 1;
/** Portrait files for library entries use this chat-id segment (not a real chat). */
export const NPC_LIBRARY_CHAT_ID = '_npc_library';

/** @param {object} [settings] */
export function getNpcLibrary(settings) {
    if (!settings || typeof settings !== 'object') return [];
    if (!Array.isArray(settings.npcLibrary)) settings.npcLibrary = [];
    return settings.npcLibrary;
}

export function slugifyNpcName(name) {
    return String(name || 'npc').toLowerCase().trim()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 60) || 'npc';
}

export function uniqueLibraryNpcName(base, settings, excludeId = null) {
    const trimmed = String(base || 'Imported NPC').trim() || 'Imported NPC';
    const taken = new Set(
        getNpcLibrary(settings)
            .filter(n => n && n.id !== excludeId)
            .map(n => String(n.name || '')),
    );
    if (!taken.has(trimmed)) return trimmed;
    let counter = 2;
    let candidate = `${trimmed} (${counter})`;
    while (taken.has(candidate)) {
        counter++;
        candidate = `${trimmed} (${counter})`;
    }
    return candidate;
}

/** Drop campaign-owned relationship lines so a library template stays identity-only. */
export function stripCampaignRelationshipLines(content) {
    return String(content || '')
        .replace(/^\s*Friendship\/Rapport:.*$/gim, '')
        .replace(/^\s*Affection\/Interest:.*$/gim, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * Library cards are identity-only: keep the first [CORE] block and drop
 * campaign chronicle / dynamic lore (and anything else outside CORE).
 */
export function extractLibraryIdentityContent(content) {
    const text = String(content || '');
    const coreMatch = text.match(/\[CORE\][\s\S]*?\[\/CORE\]/i);
    if (coreMatch) return stripCampaignRelationshipLines(coreMatch[0]);
    return stripCampaignRelationshipLines(text);
}

/** Rewrite stored library records in place. Returns true if any content changed. */
export function sanitizeNpcLibraryRecords(settings) {
    const library = getNpcLibrary(settings);
    let changed = false;
    for (const rec of library) {
        if (!rec || typeof rec !== 'object') continue;
        const cleaned = extractLibraryIdentityContent(rec.content);
        if (cleaned !== String(rec.content || '')) {
            rec.content = cleaned;
            changed = true;
        }
    }
    return changed;
}

export function findLibraryNpcById(settings, id) {
    if (!id) return null;
    return getNpcLibrary(settings).find(n => n && n.id === id) || null;
}

export function findLibraryNpcByName(settings, name) {
    const needle = String(name || '').toLowerCase().trim();
    if (!needle) return null;
    return getNpcLibrary(settings).find(n => String(n?.name || '').toLowerCase().trim() === needle) || null;
}

function newLibraryId() {
    return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeKeys(keys, name) {
    const list = Array.isArray(keys)
        ? keys.map(k => String(k || '').trim()).filter(Boolean)
        : String(keys || '').split(',').map(k => k.trim()).filter(Boolean);
    const fallback = String(name || '').trim();
    if (fallback && !list.some(k => k.toLowerCase() === fallback.toLowerCase())) {
        list.unshift(fallback);
    }
    return [...new Set(list)];
}

/**
 * @param {{ name: string, content?: string, keys?: string[], portraitPath?: string, notes?: string, id?: string, createdAt?: number }} input
 */
export function createLibraryRecord(input) {
    const name = String(input?.name || 'Unnamed NPC').trim() || 'Unnamed NPC';
    const now = Date.now();
    return {
        id: input?.id || newLibraryId(),
        name,
        keys: normalizeKeys(input?.keys, name),
        content: extractLibraryIdentityContent(input?.content || ''),
        portraitPath: String(input?.portraitPath || ''),
        notes: String(input?.notes || ''),
        createdAt: input?.createdAt || now,
        updatedAt: now,
    };
}

/**
 * Insert or replace a library record. Does not persist settings or portraits.
 * @returns {object} The stored record.
 */
export function upsertLibraryNpc(settings, record, { overwriteId } = {}) {
    const library = getNpcLibrary(settings);
    const targetId = overwriteId || record.id;
    const idx = library.findIndex(n => n && n.id === targetId);
    const stored = {
        ...record,
        id: targetId || record.id || newLibraryId(),
        updatedAt: Date.now(),
        createdAt: idx >= 0 ? (library[idx].createdAt || Date.now()) : (record.createdAt || Date.now()),
    };
    if (idx >= 0) library[idx] = stored;
    else library.push(stored);
    return stored;
}

/** Remove by id and return the removed record (caller may delete its portrait file). */
export function removeLibraryNpcRecord(settings, id) {
    const library = getNpcLibrary(settings);
    const idx = library.findIndex(n => n && n.id === id);
    if (idx < 0) return null;
    const [removed] = library.splice(idx, 1);
    return removed || null;
}

/**
 * Portrait update policy for library saves.
 * - truthy `portraitSrc` → replace (caller persists a new file)
 * - `''` → explicit clear
 * - `undefined` / omitted → keep the existing library portrait
 *
 * @param {string} previousPath
 * @param {string|undefined} portraitSrc
 * @returns {{ kind: 'replace' } | { kind: 'set', path: string }}
 */
export function resolveLibraryPortraitUpdate(previousPath, portraitSrc) {
    if (portraitSrc) return { kind: 'replace' };
    if (portraitSrc === '') return { kind: 'set', path: '' };
    return { kind: 'set', path: String(previousPath || '') };
}

export function portraitPayloadFromDataUrl(dataUrl) {
    const match = String(dataUrl || '').match(/^data:(image\/[\w+.-]+);base64,(.+)$/s);
    if (!match) return null;
    return { mime: match[1].toLowerCase(), data: match[2] };
}

export function dataUrlFromPortraitPayload(payload) {
    if (!payload || typeof payload !== 'object') return '';
    const data = String(payload.data || '').replace(/\s+/g, '');
    if (!data) return '';
    const mime = String(payload.mime || 'image/png').toLowerCase();
    return `data:${mime};base64,${data}`;
}

/**
 * @param {object} record
 * @param {string} [portraitDataUrl]
 */
export function serializeNpcPackage(record, portraitDataUrl = '') {
    return {
        format: NPC_LIBRARY_FORMAT,
        version: NPC_LIBRARY_VERSION,
        name: record?.name || 'Unnamed NPC',
        keys: Array.isArray(record?.keys) ? [...record.keys] : [],
        content: record?.content || '',
        notes: record?.notes || '',
        portrait: portraitPayloadFromDataUrl(portraitDataUrl),
        exportedAt: Date.now(),
    };
}

function validateNpcPackage(parsed) {
    if (!parsed || typeof parsed !== 'object') {
        throw new Error('NPC package is empty.');
    }
    if (parsed.format && parsed.format !== NPC_LIBRARY_FORMAT) {
        throw new Error(`Not a Multihog NPC package (found "${parsed.format}").`);
    }
    const name = String(parsed.name || '').trim();
    const content = String(parsed.content || '').trim();
    if (!name) throw new Error('NPC package is missing a name.');
    if (!content) throw new Error('NPC package is missing NPC content.');
    return {
        name,
        keys: Array.isArray(parsed.keys) ? parsed.keys : [],
        content,
        notes: String(parsed.notes || ''),
        portrait: parsed.portrait && typeof parsed.portrait === 'object' ? parsed.portrait : null,
    };
}

/**
 * Parse a single NPC, a pack, or a raw array of NPC objects.
 * @param {string} text
 * @returns {object[]}
 */
export function parseNpcPackages(text) {
    let parsed;
    try {
        parsed = JSON.parse(String(text || '').trim());
    } catch {
        throw new Error('Could not parse that as JSON.');
    }
    if (Array.isArray(parsed)) {
        if (!parsed.length) throw new Error('NPC pack is empty.');
        return parsed.map(validateNpcPackage);
    }
    if (parsed && parsed.format === NPC_LIBRARY_PACK_FORMAT) {
        const npcs = Array.isArray(parsed.npcs) ? parsed.npcs : [];
        if (!npcs.length) throw new Error('NPC pack is empty.');
        return npcs.map(validateNpcPackage);
    }
    return [validateNpcPackage(parsed)];
}

/**
 * Direct Prompt for the State Tracker: add a library NPC to [PARTY] using the
 * identity card as source of truth. Includes the module join trigger.
 * @param {object} record
 * @returns {string}
 */
export function buildAddLibraryNpcToPartyPrompt(record) {
    const name = String(record?.name || 'Unnamed').trim() || 'Unnamed';
    const keys = Array.isArray(record?.keys) && record.keys.length
        ? record.keys.join(', ')
        : name;
    const content = String(record?.content || '').trim();
    return `Add this NPC to the active [PARTY] roster as a new companion.

This is an explicit party join. Treat the narrative trigger as already given: (${name} joins the party.)

RULES:
- Preserve their name exactly: ${name}
- Use the identity card below as the source of truth for who they are (species, appearance, personality, background, habits, strengths, flaws).
- Generate a complete mechanical [PARTY] member sheet that matches the current campaign's [PARTY] format and the module instructions.
- Fit stats, class, gear, and abilities to the current story and existing party power level.
- Output the entire updated [PARTY] block (all existing members plus this new one).
- Do not rewrite [CHARACTER].
- Do not add quests or output [QUESTS] unless they are already changing for another reason.
- If ${name} is already in [PARTY], do not duplicate them; only fill missing mechanical fields if the existing sheet is incomplete.
- [PARTY] is mechanics only — do not copy identity/biography prose into the party sheet.
- If the active roster is already at the max size (5 + {{user}}), do not add them.

NPC IDENTITY CARD:
Name: ${name}
Keywords: ${keys}

${content}`;
}

/**
 * Direct Prompt for the State Tracker: make a library identity the player
 * character by replacing [CHARACTER] (and related player modules).
 * @param {object} record
 * @returns {string}
 */
export function buildApplyLibraryCardAsPcPrompt(record) {
    const name = String(record?.name || 'Unnamed').trim() || 'Unnamed';
    const keys = Array.isArray(record?.keys) && record.keys.length
        ? record.keys.join(', ')
        : name;
    const content = String(record?.content || '').trim();
    return `Replace the player's [CHARACTER] sheet with this identity. They are now the player character.

This is an explicit character swap, not a rename of the previous PC.

RULES:
- Preserve their name exactly: ${name}
- Use the identity card below as the source of truth for who they are (species, appearance, personality, background, habits, strengths, flaws).
- Output a complete [CHARACTER] block that matches the current campaign's [CHARACTER] format and the module instructions.
- Fit stats, class, gear, and abilities to the current story power level.
- Also output [INVENTORY], [ABILITIES], and/or [SPELLS] when those modules are enabled and the identity implies them; omit modules that do not apply.
- Do not output [PARTY] unless it must change for another reason.
- Do not add quests or output [QUESTS] unless they are already changing for another reason.
- [CHARACTER] is mechanics only — do not copy identity/biography prose into the character sheet.

PLAYER IDENTITY CARD:
Name: ${name}
Keywords: ${keys}

${content}`;
}
