/**
 * Builds a prompt section from user-selected lorebooks for World Skeleton generation.
 * Skeleton books are deliberately excluded so generated seed data cannot recursively
 * become source canon for a new skeleton.
 *
 * @param {string[]} bookNames
 * @param {(bookName: string) => Promise<any>} loadWorldInfo
 * @param {{ lorebookOnly?: boolean }} [options]
 * @returns {Promise<string>}
 */
export async function buildSkeletonLorebookSourceContext(bookNames, loadWorldInfo, options = {}) {
    const names = [...new Set((bookNames || [])
        .map(name => String(name || '').trim())
        .filter(name => name && !name.toLowerCase().endsWith('_skeleton')))]
        .sort((a, b) => a.localeCompare(b));

    const books = [];
    for (const bookName of names) {
        try {
            const book = await loadWorldInfo(bookName);
            if (book?.entries) books.push([bookName, book]);
        } catch (_) {
            // A deleted or temporarily unavailable selected book should not abort generation.
        }
    }

    const formattedBooks = books.map(([bookName, book]) => {
        const entries = Object.entries(book.entries || {})
            .sort(([uidA], [uidB]) => Number(uidA) - Number(uidB))
            .map(([uid, entry]) => {
                const content = String(entry?.content || '').trim();
                if (!content) return '';
                const firstKey = Array.isArray(entry?.key) ? entry.key.find(Boolean) : '';
                const title = String(entry?.comment || firstKey || `Entry ${uid}`).trim();
                return `#### ${title}\n${content}`;
            })
            .filter(Boolean);
        if (!entries.length) return '';
        return `### LOREBOOK: ${bookName}\n${entries.join('\n\n')}`;
    }).filter(Boolean);

    if (!formattedBooks.length) return '';

    const sourceRule = options.lorebookOnly
        ? 'Create entries only for factions, locations, and conflicts explicitly mentioned in this material. Do not invent, infer, or extrapolate additional premises. Ignore the requested category counts and output the eligible macro premises established by the source material. Named individuals remain source constraints and must never become skeleton entries.'
        : 'Ground the generated factions, locations, and conflicts in it; preserve its facts and tone, and do not contradict it. Named individuals remain source constraints and must never become skeleton entries. You may derive macro premises from the material or create compatible additions.';

    return `## EXISTING LOREBOOK SOURCE MATERIAL
Treat the following material as established world canon. ${sourceRule}

${formattedBooks.join('\n\n')}`;
}
