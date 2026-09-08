/** Pull a JSON object from an otherwise valid fenced/prefaced model response. */
export function parseMapArchitectResponse(response) {
    let source = String(response || '').trim();
    source = source.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    try { return { value: JSON.parse(source), error: null }; } catch (_) {}

    const start = source.indexOf('{');
    if (start < 0) return { value: null, error: 'No JSON object was found.' };
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < source.length; index++) {
        const char = source[index];
        if (inString) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === '"') inString = false;
            continue;
        }
        if (char === '"') { inString = true; continue; }
        if (char === '{') depth++;
        if (char === '}') {
            depth--;
            if (depth === 0) {
                try { return { value: JSON.parse(source.slice(start, index + 1)), error: null }; }
                catch (error) { return { value: null, error: `Invalid JSON: ${error.message}` }; }
            }
        }
    }
    return { value: null, error: 'The JSON object is incomplete or unbalanced.' };
}
