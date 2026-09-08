/**
 * Card-list synopsis helpers for PC / NPC cards in the Lorebook Agent panel.
 */

const NEXT_HEADER =
    'Species|Body|Worn Equipment|Equipment|Appearance\\/Species|Appearance|Personality|Brief Background|Background|Habits(?:\\/|\\s*&\\s*|\\s+and\\s+)Behaviors|Habits|Behaviors|Strengths|Flaws|Combat Profile|Relationship with|Friendship\\/Rapport|Affection\\/Interest';

function extractField(cleanContent, name) {
    const re = new RegExp(
        `(?:^|\\n)\\s*${name}\\s*:\\s*([\\s\\S]*?)(?=\\s*(?:${NEXT_HEADER})\\s*:|$)`,
        'i',
    );
    const m = cleanContent.match(re);
    return m?.[1]?.trim() || '';
}

function extractCoreFields(content) {
    const cleanContent = String(content || '').replace(/\[\/?CORE\]/gi, '');
    const species = extractField(cleanContent, 'Species');
    const body = extractField(cleanContent, 'Body');
    const legacy = extractField(cleanContent, 'Appearance\\/Species') || extractField(cleanContent, 'Appearance');
    const personality = extractField(cleanContent, 'Personality');
    const lines = cleanContent.split('\n').map(l => l.trim())
        .filter(l => l
            && !/^\[ID:/i.test(l)
            && !/^Friendship\/Rapport:/i.test(l)
            && !/^Affection\/Interest:/i.test(l)
            && !/^(?:Species|Body|Worn Equipment|Equipment|Appearance(?:\/Species)?)\s*:?\s*$/i.test(l));
    const fallback = lines.slice(0, 2).join(' ');
    return { species, body, legacy, personality, fallback };
}

function appearanceLine(fields) {
    const parts = [];
    if (fields.species) parts.push(fields.species);
    if (fields.body) parts.push(fields.body);
    if (parts.length) return parts.join(' — ');
    return fields.legacy || fields.fallback || '';
}

/**
 * Brief synopsis for the card list: Species + Body (new split), else legacy
 * Appearance/Species, else the first couple of meaningful lines.
 * @param {string} content
 * @param {(text: string) => string} [substitute] display-macro substitution
 * @param {number} [maxLen]
 * @returns {string}
 */
export function getCardAppearanceSynopsis(content, substitute = (s) => s, maxLen = 260) {
    if (!content) return '';
    const text = substitute(appearanceLine(extractCoreFields(content)));
    return maxLen > 0 ? text.substring(0, maxLen) : text;
}

/**
 * First sentence of a blurb. Falls back to the clause before an em dash
 * when there is no `.` / `!` / `?` terminator.
 * @param {string} text
 * @returns {string}
 */
export function firstSentence(text) {
    const raw = String(text || '').replace(/\s+/g, ' ').trim();
    if (!raw) return '';
    const lead = raw.split(/\s+[—–]\s+/)[0].trim() || raw;
    const m = lead.match(/^(.+?(?:[.!?]|\.\.\.))(?:\s|$)/);
    if (m) return m[1].trim();
    return lead;
}

/**
 * Compact library/list line: first sentence of the appearance synopsis.
 * @param {string} content
 * @param {(text: string) => string} [substitute]
 * @returns {string}
 */
export function getCardListFirstSentence(content, substitute) {
    return firstSentence(getCardAppearanceSynopsis(content, substitute, 0));
}

/**
 * Library-row blurb: full appearance plus personality, so the tall action
 * stack can sit beside more than a single sentence.
 * @param {string} content
 * @param {(text: string) => string} [substitute]
 * @returns {string}
 */
export function getCardLibraryBlurb(content, substitute = (s) => s) {
    if (!content) return '';
    const fields = extractCoreFields(content);
    const chunks = [];
    const appearance = appearanceLine(fields);
    if (appearance) chunks.push(appearance);
    if (fields.personality) chunks.push(fields.personality);
    return substitute(chunks.join('\n\n').trim());
}
