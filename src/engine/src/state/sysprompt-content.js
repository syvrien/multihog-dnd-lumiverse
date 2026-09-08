function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Removes every copy of a section's application-managed outer tag while
 * preserving its actual instructions. Repeated matching wrappers are always
 * accidental here: the Control Room owns the single root wrapper.
 */
export function unwrapManagedSectionContent(tag, content) {
    const cleanTag = String(tag || '').trim();
    let body = String(content || '').trim();
    if (!cleanTag || !body) return body;

    const escapedTag = escapeRegex(cleanTag);
    const tagToken = `<\\s*\\/?\\s*${escapedTag}(?:\\s+[^>]*)?\\s*>`;
    // Consume tag-only lines with their newline first, avoiding blank-line
    // buildup when repairing content that was wrapped repeatedly.
    body = body.replace(new RegExp(`^[\\t ]*${tagToken}[\\t ]*(?:\\r?\\n|$)`, 'gim'), '');
    body = body.replace(new RegExp(tagToken, 'gi'), '');
    return body.trim();
}

/** Produces exactly one application-managed <tag>...</tag> root wrapper. */
export function normalizeGmContent(tag, content) {
    const cleanTag = String(tag || '').trim();
    const body = unwrapManagedSectionContent(cleanTag, content);
    return `<${cleanTag}>\n${body}\n</${cleanTag}>`;
}
