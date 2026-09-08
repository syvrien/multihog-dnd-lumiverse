export function normalizeWizardTrackerTag(value) {
    return String(value || '').toUpperCase().trim()
        .replace(/[^A-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '') || 'CUSTOM';
}

/** Extract the sample block matching the wizard's tracker tag, or fallback to raw content. */
export function extractGameSystemWizardTemplate(trackerContent, trackerTag) {
    let raw = String(trackerContent || '').trim();
    if (!raw) return '';
    // Strip markdown code fences if present
    raw = raw.replace(/^```[a-zA-Z0-9_-]*\s*\n?/gm, '').replace(/\n?```\s*$/gm, '').trim();

    const tag = normalizeWizardTrackerTag(trackerTag);
    const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // 1. Exact closed [TAG]...[/TAG] block
    const blockPattern = new RegExp(`\\[${escapedTag}\\]([\\s\\S]*?)\\[\\/${escapedTag}\\]`, 'gi');
    const matches = [...raw.matchAll(blockPattern)];
    if (matches.length) {
        return String(matches[matches.length - 1][1] || '').trim();
    }

    // 2. Open [TAG] block without closing tag
    const openTagPattern = new RegExp(`\\[${escapedTag}\\]([\\s\\S]*)$`, 'i');
    const openMatch = raw.match(openTagPattern);
    if (openMatch && openMatch[1].trim()) {
        return openMatch[1].trim();
    }

    // 3. If raw has NO [TAG] tags at all, treat raw text as the template content directly
    const hasAnyTags = /\[[A-Z0-9_-]+\]/i.test(raw);
    if (!hasAnyTags) {
        return raw;
    }

    return '';
}

/** Build the temporary state memo rendered by the wizard UI preview. */
export function buildGameSystemWizardPreviewMemo(trackerContent, trackerTag) {
    const tag = normalizeWizardTrackerTag(trackerTag);
    const template = extractGameSystemWizardTemplate(trackerContent, tag);
    return template ? `[${tag}]\n${template}\n[/${tag}]` : '';
}
