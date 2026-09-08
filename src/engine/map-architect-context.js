function cardReferenceFields(card) {
    const source = card && typeof card === 'object' ? card : {};
    const fields = [
        ['Description', source.description],
        ['Personality', source.personality],
        ['Scenario', source.scenario],
        ['Example dialogue', source.mes_example ?? source.mesExample],
        ['First message', source.first_mes ?? source.firstMessage],
        ['Creator notes', source.creator_notes ?? source.creatorNotes],
    ].map(([label, value]) => [label, String(value || '').trim()]).filter(([, value]) => value);
    if (!fields.length) return '';
    const name = String(source.name || 'Unnamed character').trim() || 'Unnamed character';
    return `### CHARACTER CARD: ${name}\n${fields.map(([label, value]) => `${label}: ${value}`).join('\n\n')}`;
}

/** Builds optional, explicitly selected reference material for direct map creation. */
export async function buildMapArchitectReferenceContext(ctx, sources = {}) {
    const names = [...new Set((sources?.lorebookNames || [])
        .map(name => String(name || '').trim())
        .filter(Boolean))]
        .sort((a, b) => a.localeCompare(b));
    const sections = [];

    for (const name of names) {
        try {
            const book = await ctx?.loadWorldInfo?.(name);
            const entries = Object.entries(book?.entries || {})
                .sort(([a], [b]) => Number(a) - Number(b))
                .map(([uid, entry]) => {
                    const content = String(entry?.content || '').trim();
                    if (!content) return '';
                    const key = Array.isArray(entry?.key) ? entry.key.find(Boolean) : '';
                    const title = String(entry?.comment || key || `Entry ${uid}`).trim();
                    return `#### ${title}\n${content}`;
                })
                .filter(Boolean);
            if (entries.length) sections.push(`### LOREBOOK: ${name}\n${entries.join('\n\n')}`);
        } catch (error) {
            console.warn(`[RPG Tracker] Could not load selected Map Architect lorebook "${name}":`, error);
        }
    }

    const cards = (sources?.characterCards || []).map(cardReferenceFields).filter(Boolean);
    if (cards.length) sections.push(cards.join('\n\n'));
    if (!sections.length) return '';
    return `USER-SELECTED REFERENCE CONTEXT\nTreat this as established canon for this map. Use it to ground the place, but do not force every referenced person, object, or event into the map.\n\n${sections.join('\n\n')}`;
}
