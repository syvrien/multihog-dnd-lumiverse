import { stFetch } from '../../../../compat/st-core.js';
import { getRequestHeaders } from '../../../../compat/st-core.js';
import {
    bookBelongsToPrefix,
    findCloneDestinationCollisions,
    plannedCloneDestinations,
    renameBookForPrefix,
} from './clone-campaign-stack-utils.js';

export {
    bookBelongsToPrefix,
    findCloneDestinationCollisions,
    plannedCloneDestinations,
    renameBookForPrefix,
};

/**
 * @param {any} ctx
 * @returns {Promise<string[]>}
 */
async function listWorldNames(ctx) {
    const namesSet = new Set();

    if (typeof ctx?.updateWorldInfoList === 'function') {
        try { await ctx.updateWorldInfoList(); } catch (_) { /* non-fatal */ }
    }

    // Frontend registry (may be stale — always await; ST commonly returns a Promise).
    if (typeof ctx?.getWorldInfoNames === 'function') {
        try {
            const n = await ctx.getWorldInfoNames();
            if (Array.isArray(n)) n.forEach((name) => namesSet.add(name));
        } catch (_) { /* fall through */ }
    } else if (typeof ctx?.getLorebookList === 'function') {
        try {
            const n = await ctx.getLorebookList();
            if (Array.isArray(n)) n.forEach((name) => namesSet.add(name));
        } catch (_) { /* fall through */ }
    }

    // Backend ground truth — same defense as router getWorldInfoNamesSafe.
    try {
        const r = await stFetch('/api/settings/get', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({}),
        });
        if (r.ok) {
            const j = await r.json();
            if (Array.isArray(j?.world_names)) {
                j.world_names.forEach((name) => namesSet.add(name));
            }
        }
    } catch (_) { /* non-fatal */ }

    try {
        const r = await stFetch('/api/worldinfo/list', {
            method: 'POST',
            headers: getRequestHeaders(),
        });
        if (r.ok) {
            const j = await r.json();
            if (Array.isArray(j)) {
                j.forEach((entry) => { if (entry?.file_id) namesSet.add(entry.file_id); });
            }
        }
    } catch (_) { /* non-fatal */ }

    return [...namesSet];
}

/**
 * Best-effort delete of lorebooks created during a failed clone.
 * Only safe for names that this clone actually created (never pre-existing destinations).
 * @param {any} ctx
 * @param {string[]} bookNames
 */
export async function deleteWorldInfoBooks(ctx, bookNames) {
    for (const name of bookNames || []) {
        try {
            await stFetch('/api/worldinfo/delete', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ name }),
            });
        } catch (_) { /* best-effort */ }
    }
    if (typeof ctx?.updateWorldInfoList === 'function') {
        try { await ctx.updateWorldInfoList(); } catch (_) { /* non-fatal */ }
    }
}

/**
 * Duplicates every lorebook under currentPrefix to newPrefix.
 * Aborts before any write when a destination name already exists — `/api/worldinfo/edit`
 * replaces entire books, so collisions are data-loss without a preflight guard.
 * @param {string} currentPrefix
 * @param {string} newPrefix
 * @returns {Promise<{
 *   ok: boolean,
 *   cloned: number,
 *   matchingCount: number,
 *   bookRenameMap: Record<string, string>,
 *   createdBookNames: string[],
 *   errors: string[],
 *   collisions?: string[],
 * }>}
 */
export async function cloneCampaignStackToPrefix(currentPrefix, newPrefix) {
    const ctx = SillyTavern.getContext();
    const bookRenameMap = /** @type {Record<string, string>} */ ({});
    const createdBookNames = [];
    const errors = [];

    if (!currentPrefix || !newPrefix) {
        return {
            ok: false,
            cloned: 0,
            matchingCount: 0,
            bookRenameMap,
            createdBookNames,
            errors: ['Missing current or new campaign prefix.'],
        };
    }
    if (String(currentPrefix).toLowerCase() === String(newPrefix).toLowerCase()) {
        return {
            ok: false,
            cloned: 0,
            matchingCount: 0,
            bookRenameMap,
            createdBookNames,
            errors: ['New prefix is the same as the current prefix.'],
        };
    }

    const allNames = await listWorldNames(ctx);
    const matchingBooks = allNames.filter((n) => bookBelongsToPrefix(n, currentPrefix));

    if (matchingBooks.length === 0) {
        return {
            ok: true,
            cloned: 0,
            matchingCount: 0,
            bookRenameMap,
            createdBookNames,
            errors: [],
        };
    }

    const destinations = plannedCloneDestinations(matchingBooks, currentPrefix, newPrefix);
    const collisions = findCloneDestinationCollisions(destinations, allNames);
    if (collisions.length) {
        return {
            ok: false,
            cloned: 0,
            matchingCount: matchingBooks.length,
            bookRenameMap,
            createdBookNames,
            collisions,
            errors: [
                `Aborted: destination lorebook(s) already exist — cloning would overwrite them: ${collisions.join(', ')}. `
                + 'Choose a different prefix (or delete/rename the conflicting books first).',
            ],
        };
    }

    let cloned = 0;
    for (const bookName of matchingBooks) {
        const newBookName = renameBookForPrefix(currentPrefix, bookName, newPrefix);
        let bookData = null;
        try {
            bookData = await ctx.loadWorldInfo(bookName);
        } catch (e) {
            errors.push(`Failed to load "${bookName}": ${e?.message || e}`);
            continue;
        }
        if (!bookData) {
            errors.push(`Could not read "${bookName}" — skipping.`);
            continue;
        }

        const cloneData = JSON.parse(JSON.stringify(bookData));
        cloneData.name = newBookName;

        try {
            const res = await stFetch('/api/worldinfo/edit', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ name: newBookName, data: cloneData }),
            });
            if (!res.ok) {
                errors.push(`HTTP ${res.status} saving "${newBookName}"`);
                continue;
            }
            if (typeof ctx.saveWorldInfo === 'function') {
                try { await ctx.saveWorldInfo(newBookName, cloneData); } catch (_) { /* non-fatal */ }
            }
            bookRenameMap[bookName] = newBookName;
            createdBookNames.push(newBookName);
            cloned++;
        } catch (e) {
            errors.push(`Failed to write "${newBookName}": ${e?.message || e}`);
        }
    }

    if (typeof ctx.updateWorldInfoList === 'function') {
        try { await ctx.updateWorldInfoList(); } catch (_) { /* non-fatal */ }
    }

    const ok = errors.length === 0 && cloned === matchingBooks.length;
    return {
        ok,
        cloned,
        matchingCount: matchingBooks.length,
        bookRenameMap,
        createdBookNames,
        errors,
    };
}
