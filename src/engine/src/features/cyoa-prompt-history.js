const CHOICES_BLOCK_SOURCE = '<choices\\b[^>]*>[\\s\\S]*?<\\/choices\\s*>';

function choicesRegex() {
    return new RegExp(CHOICES_BLOCK_SOURCE, 'gi');
}

function countChoiceBlocks(text) {
    if (typeof text !== 'string' || !text) return 0;
    return Array.from(text.matchAll(choicesRegex())).length;
}

/**
 * Strip T-5 and older choices while retaining the final four matching blocks.
 * During ordinary generation the current user message follows those blocks,
 * making them the four newest completed assistant turns (T-4 through T-1) and fresh
 * formatting examples.
 * Holders point only at disposable prompt copies, never at SillyTavern's stored
 * or rendered chat messages.
 *
 * @param {Array<{get: () => string, set: (value: string) => void}>} holders
 * @returns {number} number of removed blocks
 */
function stripOlderBlocksFromHolders(holders) {
    const total = holders.reduce((sum, holder) => sum + countChoiceBlocks(holder.get()), 0);
    const keepCount = 4;
    if (total <= keepCount) return 0;
    const firstKeptBlock = total - keepCount + 1;

    let seen = 0;
    for (const holder of holders) {
        const original = holder.get();
        holder.set(original.replace(choicesRegex(), (block) => {
            seen += 1;
            return seen >= firstKeptBlock ? block : '';
        }));
    }
    return total - keepCount;
}

/**
 * Clone and filter an OpenAI-style chat prompt. Only assistant content is
 * eligible, which protects CYOA examples in system prompts and user-authored
 * text. String and multimodal text-part content are both supported.
 *
 * @param {any[]} chat
 * @returns {any[]}
 */
export function stripSupersededChoicesFromChatPrompt(chat) {
    if (!Array.isArray(chat)) return chat;

    const holders = [];
    const cloned = chat.map((message) => {
        if (!message || typeof message !== 'object') return message;
        const copy = { ...message };
        if (message.role !== 'assistant') return copy;

        if (typeof message.content === 'string') {
            holders.push({
                get: () => copy.content,
                set: (value) => { copy.content = value; },
            });
        } else if (Array.isArray(message.content)) {
            copy.content = message.content.map((part) => part && typeof part === 'object' ? { ...part } : part);
            copy.content.forEach((part, index) => {
                if (!part || typeof part !== 'object' || typeof part.text !== 'string') return;
                holders.push({
                    get: () => copy.content[index].text,
                    set: (value) => { copy.content[index].text = value; },
                });
            });
        }
        return copy;
    });

    stripOlderBlocksFromHolders(holders);
    return cloned;
}

/**
 * Clone and filter the chat-only portion of a text-completion prompt before
 * SillyTavern combines it with system instructions and examples.
 *
 * @param {any[]} finalMesSend
 * @returns {any[]}
 */
export function stripSupersededChoicesFromTextPromptMessages(finalMesSend) {
    if (!Array.isArray(finalMesSend)) return finalMesSend;

    const holders = [];
    const cloned = finalMesSend.map((item) => {
        if (!item || typeof item !== 'object') return item;
        const copy = {
            ...item,
            ...(Array.isArray(item.extensionPrompts) ? { extensionPrompts: [...item.extensionPrompts] } : {}),
        };
        if (typeof copy.message === 'string') {
            holders.push({
                get: () => copy.message,
                set: (value) => { copy.message = value; },
            });
        }
        return copy;
    });

    stripOlderBlocksFromHolders(holders);
    return cloned;
}

/** Replace a disposable prompt array in place so every SillyTavern caller sees it. */
export function replacePromptArray(target, replacement) {
    if (!Array.isArray(target) || !Array.isArray(replacement)) return false;
    target.splice(0, target.length, ...replacement);
    return true;
}
