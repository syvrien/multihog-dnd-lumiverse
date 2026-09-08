/**
 * Pure helpers for location-centric World Progression.
 *
 * World Progression may read entity lore as context for a place, but locations
 * and wider currents are its only simulation subjects. Hidden [MAP] data never
 * crosses this boundary.
 */
import { normalizeDungeonLabel, stripDungeonMapSection } from './dungeon-reality.js';
import { parseInWorldTime } from './memo-processor.js';

export const WORLD_REPORT_METADATA_KEY = 'rpgWorldProgression';

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function bookCategory(bookName, prefix = '') {
    let clean = String(bookName || '');
    if (prefix && clean.toLowerCase().startsWith(`${String(prefix).toLowerCase()}_`)) {
        clean = clean.slice(String(prefix).length + 1);
    }
    return clean.toUpperCase();
}

function isWorldBookName(bookName) {
    const lower = String(bookName || '').toLowerCase();
    return lower === 'world' || lower.endsWith('_world');
}

function isSkeletonBookName(bookName) {
    return String(bookName || '').toLowerCase().endsWith('_skeleton');
}

function entryLabel(entry) {
    return String(entry?.comment || entry?.key?.[0] || '').trim();
}

function entryKeys(entry) {
    return [
        ...(Array.isArray(entry?.key) ? entry.key : []),
        ...(Array.isArray(entry?.keysecondary) ? entry.keysecondary : []),
    ].map(value => String(value || '').trim()).filter(Boolean);
}

function isLocationRecord(bookName, entry, prefix) {
    if (isSkeletonBookName(bookName)) return entry?.extensions?.rpgCategory === 'LOC';
    const category = bookCategory(bookName, prefix);
    const lower = String(bookName || '').toLowerCase();
    return category === 'LOC'
        || category === 'LOCATION'
        || category === 'LOCATIONS'
        || category === 'PLACE'
        || category === 'PLACES'
        || lower.includes('location')
        || lower.includes('place');
}

function isNpcRecord(bookName, entry, prefix) {
    if (isSkeletonBookName(bookName)) return false;
    const category = bookCategory(bookName, prefix);
    return category === 'NPC' || category === 'NPCS' || String(bookName || '').toLowerCase().includes('npc');
}

function isGlobalContextRecord(bookName, entry, prefix) {
    if (isNpcRecord(bookName, entry, prefix)) return false;
    if (isSkeletonBookName(bookName)) {
        return ['FAC', 'EVENT'].includes(String(entry?.extensions?.rpgCategory || '').toUpperCase());
    }
    const category = bookCategory(bookName, prefix);
    const lower = String(bookName || '').toLowerCase();
    return ['FAC', 'FACTION', 'FACTIONS', 'EVENT', 'EVENTS'].includes(category)
        || lower.includes('faction')
        || lower.includes('guild')
        || lower.includes('event')
        || lower.includes('conflict');
}

/** Root of a readable Location hierarchy such as "Morrowfen :: Docks". */
export function worldProgressionLocationRoot(label) {
    return String(label || '').split(/\s*::\s*/)[0]?.trim() || '';
}

function labelIsExcluded(label, keys, excludedTerms) {
    const values = [label, ...(keys || [])].map(normalizeDungeonLabel).filter(Boolean);
    return excludedTerms.some(term => values.some(value => value.includes(term)));
}

function textMentionsAny(text, labels) {
    const haystack = normalizeDungeonLabel(text);
    if (!haystack) return false;
    return labels.some(label => {
        const needle = normalizeDungeonLabel(label);
        if (!needle) return false;
        return haystack === needle
            || haystack.startsWith(`${needle} `)
            || haystack.endsWith(` ${needle}`)
            || haystack.includes(` ${needle} `);
    });
}

function renderRecord(record) {
    return `### ${record.label}\n${record.content}`;
}

/**
 * Build location dossiers from campaign lore. Entity records are included only
 * when their readable lore refers to the location. Maps are stripped before any
 * classification or rendering.
 *
 * @returns {{ dossiers: Array<{name:string, aliases:string[], text:string, hasNarrativeLore:boolean}>, globalContext:string }}
 */
export function buildWorldProgressionLocationDossiers(archiveBooks, {
    prefix = '',
    exclusionList = '',
} = {}) {
    const excludedTerms = String(exclusionList || '')
        .split(',')
        .map(normalizeDungeonLabel)
        .filter(Boolean);
    const locationRecords = [];
    const contextualRecords = [];

    for (const [bookName, book] of Object.entries(archiveBooks || {})) {
        if (isWorldBookName(bookName) || !book?.entries) continue;
        const skeleton = isSkeletonBookName(bookName);
        for (const [uid, entry] of Object.entries(book.entries)) {
            // Legacy named-individual seeds belong to the retired entity-level
            // skeleton design. Preserve them on disk, but never expose them to WP.
            if (skeleton && String(entry?.extensions?.rpgCategory || '').toUpperCase() === 'NPC') continue;
            const label = entryLabel(entry);
            const content = stripDungeonMapSection(String(entry?.content || '')).trim();
            if (!label || !content) continue;
            const keys = entryKeys(entry);
            const record = {
                bookName,
                uid,
                label,
                keys,
                content,
                skeleton,
                npc: isNpcRecord(bookName, entry, prefix),
                global: isGlobalContextRecord(bookName, entry, prefix),
            };
            if (isLocationRecord(bookName, entry, prefix)) locationRecords.push(record);
            else contextualRecords.push(record);
        }
    }

    // Skeleton entries are only unrealized seeds. Once normal campaign lore
    // contains the same named subject, the live record is authoritative and
    // the Day-0 seed leaves World Progression's readable context entirely.
    const materializedLabels = new Set(
        [...locationRecords, ...contextualRecords]
            .filter(record => !record.skeleton)
            .map(record => normalizeDungeonLabel(record.label))
            .filter(Boolean),
    );
    const isSupersededSkeleton = record => record.skeleton
        && materializedLabels.has(normalizeDungeonLabel(record.label));

    const byRoot = new Map();
    for (const record of locationRecords.filter(record => !isSupersededSkeleton(record))) {
        const root = worldProgressionLocationRoot(record.label);
        const key = normalizeDungeonLabel(root);
        if (!key || labelIsExcluded(root, record.keys, excludedTerms)) continue;
        if (!byRoot.has(key)) {
            byRoot.set(key, {
                name: root,
                locationRecords: [],
                contextualRecords: [],
                aliases: new Set([root]),
                hasNarrativeLore: false,
            });
        }
        const dossier = byRoot.get(key);
        dossier.locationRecords.push(record);
        dossier.aliases.add(record.label);
        const leaf = String(record.label).split(/\s*::\s*/).at(-1)?.trim();
        if (leaf) dossier.aliases.add(leaf);
        if (!record.skeleton) dossier.hasNarrativeLore = true;
    }

    for (const dossier of byRoot.values()) {
        const aliases = [...dossier.aliases];
        for (const record of contextualRecords.filter(record => !isSupersededSkeleton(record))) {
            const searchable = `${record.label}\n${record.keys.join('\n')}\n${record.content}`;
            if (textMentionsAny(searchable, aliases)) dossier.contextualRecords.push(record);
        }
    }

    const dossiers = [...byRoot.values()]
        .map(dossier => {
            const seen = new Set();
            const unique = records => records.filter(record => {
                const key = `${record.bookName}::${record.uid}`;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });
            const location = unique(dossier.locationRecords);
            // Factions/events are rendered once in wider-world context below;
            // avoid duplicating them inside every location dossier they mention.
            const context = unique(dossier.contextualRecords.filter(record => !record.global));
            const blocks = [
                '## LOCATION LORE',
                location.map(renderRecord).join('\n\n') || '(No readable location lore.)',
            ];
            if (context.length) {
                blocks.push('', '## PERTINENT CONTEXT (READ-ONLY CONSTRAINTS)', context.map(renderRecord).join('\n\n'));
            }
            return {
                name: dossier.name,
                aliases: [...dossier.aliases],
                text: blocks.join('\n'),
                hasNarrativeLore: dossier.hasNarrativeLore,
            };
        })
        .sort((left, right) => left.name.localeCompare(right.name));

    const globalRecords = contextualRecords.filter(record => record.global && !isSupersededSkeleton(record));
    const globalContext = globalRecords.length
        ? globalRecords.map(renderRecord).join('\n\n')
        : '(No separate regional or global lore records.)';

    return { dossiers, globalContext };
}

function firedMinutes(label) {
    const value = parseInWorldTime(String(label || ''));
    return Number.isFinite(value) && value >= 0 ? value : -1;
}

function shuffle(items, random) {
    const out = [...items];
    for (let index = out.length - 1; index > 0; index--) {
        const next = Math.floor(random() * (index + 1));
        [out[index], out[next]] = [out[next], out[index]];
    }
    return out;
}

/** Oldest-unadvanced locations first; randomization only breaks equal-time cohorts. */
export function selectWorldProgressionLocations(dossiers, {
    count = 3,
    lastAdvanced = {},
    randomize = true,
    random = Math.random,
} = {}) {
    const limit = Math.max(1, Math.min(12, Number(count) || 3));
    const rows = (Array.isArray(dossiers) ? dossiers : []).map(dossier => ({
        dossier,
        last: firedMinutes(lastAdvanced?.[normalizeDungeonLabel(dossier.name)]),
    }));
    const cohorts = new Map();
    for (const row of rows) {
        if (!cohorts.has(row.last)) cohorts.set(row.last, []);
        cohorts.get(row.last).push(row.dossier);
    }
    const ordered = [];
    for (const minute of [...cohorts.keys()].sort((a, b) => a - b)) {
        const cohort = cohorts.get(minute);
        ordered.push(...(randomize ? shuffle(cohort, typeof random === 'function' ? random : Math.random) : cohort));
    }
    return ordered.slice(0, limit);
}

function cleanHeading(line) {
    return String(line || '')
        .trim()
        .replace(/^#{1,6}\s*/, '')
        .replace(/^\*\*(.*?)\*\*$/, '$1')
        .replace(/:\s*$/, '')
        .trim();
}

function isWiderCurrentsHeading(label) {
    const key = normalizeDungeonLabel(label);
    return ['wider currents', 'global currents', 'regional currents', 'wider world', 'global'].includes(key);
}

/**
 * Extract one location section plus Wider Currents from a prose World Report.
 * Legacy unsectioned reports fall back to the full report only when they name
 * the site. No entity/map matching is performed.
 */
export function extractWorldReportForLocation(reportText, siteRoot, coverage = []) {
    const report = String(reportText || '').trim();
    const siteKey = normalizeDungeonLabel(siteRoot);
    if (!report || !siteKey) return '';
    const headings = [...new Set([siteRoot, ...(Array.isArray(coverage) ? coverage : [])].map(String).filter(Boolean))];
    const headingKeys = new Map(headings.map(label => [normalizeDungeonLabel(label), label]));
    const lines = report.split(/\r?\n/);
    const sections = [];
    let current = null;
    for (const line of lines) {
        const cleaned = cleanHeading(line);
        const key = normalizeDungeonLabel(cleaned);
        const markdownHeading = /^\s*#{1,6}\s+/.test(line);
        const recognized = headingKeys.has(key) || isWiderCurrentsHeading(cleaned);
        if (recognized && (markdownHeading || String(line).trim() === cleaned || /^\*\*/.test(String(line).trim()))) {
            if (current) sections.push(current);
            current = { label: cleaned, key, lines: [] };
            continue;
        }
        if (current) current.lines.push(line);
    }
    if (current) sections.push(current);

    const selected = sections.filter(section => section.key === siteKey || isWiderCurrentsHeading(section.label));
    if (selected.length) {
        return selected
            .map(section => `## ${section.label}\n${section.lines.join('\n').trim()}`.trim())
            .filter(Boolean)
            .join('\n\n');
    }
    return textMentionsAny(report, [siteRoot]) ? report : '';
}

/**
 * Select recent global pressure plus the latest reports explicitly targeted at
 * this location. Targeted reports remain discoverable even in very large map
 * stacks where they have fallen outside the global lookback.
 */
export function selectPendingWorldReportsForLocation(reports, siteRoot, {
    lookback = 5,
    applied = {},
} = {}) {
    const limit = Math.max(1, Math.min(20, Number(lookback) || 5));
    const siteKey = normalizeDungeonLabel(siteRoot);
    const rows = Array.isArray(reports) ? reports : [];
    const recent = rows.slice(-limit);
    const targeted = rows.filter(report => (report.selectedLocations || [])
        .some(location => normalizeDungeonLabel(location) === siteKey))
        .slice(-limit);
    const candidateIds = new Set([...recent, ...targeted].map(report => report.reportId));
    return rows.filter(report => candidateIds.has(report.reportId)).map(report => {
        if (!report.reportId || applied?.[report.reportId]) return null;
        const excerpt = extractWorldReportForLocation(
            report.content,
            siteRoot,
            report.selectedLocations,
        );
        return excerpt ? { ...report, excerpt } : null;
    }).filter(Boolean);
}

export function normalizeWorldReportMetadata(entry, bookName = '', uid = '') {
    const raw = entry?.extensions?.[WORLD_REPORT_METADATA_KEY];
    const coverage = Array.isArray(raw?.selectedLocations)
        ? raw.selectedLocations.map(value => String(value || '').trim()).filter(Boolean)
        : [];
    return {
        reportId: String(raw?.reportId || `${bookName}::${uid}`).trim(),
        periodLabel: String(raw?.periodLabel || entry?.comment || '').trim(),
        selectedLocations: coverage,
    };
}

export function stampLocationAdvancement(lastAdvanced, locations, periodLabel) {
    const next = clone(lastAdvanced && typeof lastAdvanced === 'object' ? lastAdvanced : {});
    for (const location of locations || []) {
        const key = normalizeDungeonLabel(location);
        if (key) next[key] = String(periodLabel || '').trim();
    }
    return next;
}
