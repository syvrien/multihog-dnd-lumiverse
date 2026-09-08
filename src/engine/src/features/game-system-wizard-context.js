import { DEFAULT_STOCK_PROMPTS, resolveTimePromptKey } from '../../constants.js';

export const DEFAULT_GAME_SYSTEM_WIZARD_LOOKBACK = 10;
export const MAX_GAME_SYSTEM_WIZARD_LOOKBACK = 200;

/** Stock tracker modules the Wizard can cite as formatting examples. */
export const GAME_SYSTEM_WIZARD_STOCK_MODULE_TAGS = [
    'CHARACTER', 'PARTY', 'COMBAT', 'INVENTORY', 'ABILITIES', 'SPELLS', 'XP', 'TIME', 'QUESTS',
];

function escHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/"/g, '&quot;');
}

function isBlankSectionContent(content) {
    const trimmed = String(content || '').trim();
    if (!trimmed) return true;
    return /^<[\w\[\]:_-]+>\s*<\/[\w\[\]:_-]+>$/s.test(trimmed);
}

function stockModuleEnabled(settings, tag) {
    if (tag === 'QUESTS' && settings?.syspromptModules?.quests === false) return false;
    return !settings?.modules || settings.modules[tag] !== false;
}

/** @returns {{ key: string, label: string, group: string }[]} */
export function listGameSystemWizardModuleExampleOptions(settings) {
    const options = [];
    for (const tag of GAME_SYSTEM_WIZARD_STOCK_MODULE_TAGS) {
        if (!stockModuleEnabled(settings, tag)) continue;
        options.push({
            key: `stock:${tag}`,
            label: `[${tag}]`,
            group: 'Stock tracker modules',
        });
    }
    for (const field of settings?.customFields || []) {
        if (!field?.enabled) continue;
        const tag = String(field.tag || '').trim().toUpperCase();
        if (!tag) continue;
        options.push({
            key: `field:${tag}`,
            label: field.label ? `${field.label} [${tag}]` : `[${tag}]`,
            group: 'Custom tracker modules',
        });
    }
    for (const entry of settings?.customSyspromptLibrary || []) {
        if (!entry?.enabled || isBlankSectionContent(entry.content)) continue;
        const id = String(entry.id || '').trim();
        if (!id) continue;
        const tag = String(entry.tag || '').trim();
        const title = String(entry.description || entry.name || tag || id).trim();
        options.push({
            key: `sysprompt:${id}`,
            label: tag ? `<${tag}> — ${title}` : title,
            group: 'Custom GM / narrator sections',
        });
    }
    return options;
}

/** @param {any} settings @param {string[]|null} availableKeys */
export function normalizeGameSystemWizardModuleExampleKeys(settings, availableKeys = null) {
    const allowed = availableKeys ?? listGameSystemWizardModuleExampleOptions(settings).map(option => option.key);
    const allowedSet = new Set(allowed);
    const raw = Array.isArray(settings?.gameSystemWizardModuleExampleKeys)
        ? settings.gameSystemWizardModuleExampleKeys
        : [];
    return [...new Set(raw.map(key => String(key || '').trim()).filter(key => allowedSet.has(key)))];
}

/** @param {any} settings */
export function normalizeGameSystemWizardContextPrefs(settings) {
    let lookback = parseInt(String(settings?.gameSystemWizardLookback ?? DEFAULT_GAME_SYSTEM_WIZARD_LOOKBACK), 10);
    if (!Number.isFinite(lookback) || lookback < 0) lookback = DEFAULT_GAME_SYSTEM_WIZARD_LOOKBACK;
    const moduleExampleKeys = normalizeGameSystemWizardModuleExampleKeys(settings);
    return {
        lookback: Math.min(MAX_GAME_SYSTEM_WIZARD_LOOKBACK, lookback),
        lookbackAll: !!settings?.gameSystemWizardLookbackAll,
        injectLore: !!settings?.gameSystemWizardInjectLore,
        injectMemo: !!settings?.gameSystemWizardInjectMemo,
        injectModulePrompts: !!settings?.gameSystemWizardInjectModulePrompts,
        moduleExampleKeys,
    };
}

/**
 * HTML for the optional module-prompt picker (formatting examples, not live memo).
 * @param {any} settings
 * @param {{ idPrefix: string, injectEnabled: boolean, selectedKeys: string[] }} opts
 */
export function renderGameSystemWizardModuleExamplePickerHtml(settings, {
    idPrefix,
    injectEnabled = false,
    selectedKeys = [],
} = {}) {
    const options = listGameSystemWizardModuleExampleOptions(settings);
    const selectedSet = new Set(selectedKeys);
    const groups = new Map();
    for (const option of options) {
        if (!groups.has(option.group)) groups.set(option.group, []);
        groups.get(option.group).push(option);
    }
    const groupHtml = [...groups.entries()].map(([group, items]) => {
        const rows = items.map(option => `
            <label style="display:flex; align-items:flex-start; gap:6px; font-size:11px; cursor:pointer; margin:2px 0;">
                <input type="checkbox" data-module-example-key="${escHtml(option.key)}" ${selectedSet.has(option.key) ? 'checked' : ''} style="margin-top:2px;">
                <span>${escHtml(option.label)}</span>
            </label>`).join('');
        return `<div style="margin-top:6px;">
            <div style="font-size:10px; font-weight:bold; opacity:0.7; margin-bottom:2px;">${escHtml(group)}</div>
            ${rows}
        </div>`;
    }).join('');
    const emptyNote = options.length
        ? ''
        : '<div style="font-size:10px; opacity:0.55;">No enabled tracker modules or GM sections are available to cite.</div>';
    return `
        <div style="display:flex; flex-direction:column; gap:6px; padding:8px 10px; border:1px solid rgba(255,255,255,0.08); border-radius:6px; background:rgba(0,0,0,0.1);">
            <label style="display:flex; align-items:flex-start; gap:8px; font-size:11px; cursor:pointer;">
                <input type="checkbox" id="${escHtml(idPrefix)}_inject_modules" ${injectEnabled ? 'checked' : ''} style="margin-top:2px;">
                <span><b>Existing module prompts</b> — formatting examples only (not live memo values). Helps the Wizard match your tracker tags, layout, and wording.</span>
            </label>
            <div id="${escHtml(idPrefix)}_module_examples" style="display:${injectEnabled ? 'block' : 'none'};">
                <div style="font-size:10px; opacity:0.55; line-height:1.35; margin-bottom:4px;">
                    Choose which prompt instructions to include. These are the State Tracker / GM section texts your campaign already uses — not current HP, inventory, or other live numbers.
                </div>
                ${options.length ? `
                <div style="display:flex; gap:6px; margin-bottom:4px;">
                    <button type="button" class="menu_button interactable" data-${escHtml(idPrefix)}-module-pick="all" style="font-size:10px; padding:2px 8px;">All</button>
                    <button type="button" class="menu_button interactable" data-${escHtml(idPrefix)}-module-pick="none" style="font-size:10px; padding:2px 8px;">None</button>
                </div>` : ''}
                <div style="max-height:160px; overflow-y:auto; padding-right:4px;">${groupHtml}${emptyNote}</div>
            </div>
        </div>`;
}

/** @param {ParentNode|null} root */
export function readGameSystemWizardModuleExampleKeysFromUi(root) {
    if (!root) return [];
    return [...root.querySelectorAll('input[data-module-example-key]:checked')]
        .map(input => String(input.getAttribute('data-module-example-key') || '').trim())
        .filter(Boolean);
}

/**
 * @param {ParentNode|null} root
 * @param {string} idPrefix
 */
export function bindGameSystemWizardModuleExamplePicker(root, idPrefix) {
    if (!root) return;
    const toggle = root.querySelector(`#${idPrefix}_inject_modules`);
    const panel = root.querySelector(`#${idPrefix}_module_examples`);
    const syncVisibility = () => {
        if (panel) panel.style.display = toggle?.checked ? 'block' : 'none';
    };
    toggle?.addEventListener('change', () => {
        syncVisibility();
        if (toggle.checked && readGameSystemWizardModuleExampleKeysFromUi(root).length === 0) {
            root.querySelectorAll('input[data-module-example-key]').forEach(box => { box.checked = true; });
        }
    });
    syncVisibility();
    root.querySelectorAll(`[data-${idPrefix}-module-pick]`).forEach(button => {
        button.addEventListener('click', () => {
            const mode = button.getAttribute(`data-${idPrefix}-module-pick`);
            const boxes = [...root.querySelectorAll('input[data-module-example-key]')];
            if (mode === 'all') boxes.forEach(box => { box.checked = true; });
            if (mode === 'none') boxes.forEach(box => { box.checked = false; });
        });
    });
}

/**
 * Builds the optional "existing systems" context block for wizard user prompts.
 * @param {any} settings
 */
export function buildGameSystemWizardModuleExamplesContext(settings) {
    const prefs = normalizeGameSystemWizardContextPrefs(settings);
    if (!prefs.injectModulePrompts || !prefs.moduleExampleKeys.length) return '';

    const selected = new Set(prefs.moduleExampleKeys);
    let context = '=== EXISTING MODULE PROMPTS (FORMATTING EXAMPLES ONLY) ===\n';
    context += 'The blocks below are instruction prompts for other tracker/GM systems. Use them only to match tag vocabulary, layout, and tone — not as live state and not as content to duplicate.\n\n';

    for (const tag of GAME_SYSTEM_WIZARD_STOCK_MODULE_TAGS) {
        const key = `stock:${tag}`;
        if (!selected.has(key) || !stockModuleEnabled(settings, tag)) continue;
        const modLower = tag === 'TIME' ? resolveTimePromptKey(settings) : tag.toLowerCase();
        const promptContent = settings?.stockPrompts?.[modLower]
            || DEFAULT_STOCK_PROMPTS[modLower]
            || '';
        context += `[${tag}] (Stock Module)\nPrompt:\n${promptContent}\n\n`;
    }

    for (const field of settings?.customFields || []) {
        if (!field?.enabled) continue;
        const tag = String(field.tag || '').trim().toUpperCase();
        if (!tag || !selected.has(`field:${tag}`)) continue;
        context += `[${tag}] (Custom Tracker Module: ${field.label || tag})\nPrompt:\n${field.prompt}\nTemplate:\n${field.template}\n\n`;
    }

    for (const entry of settings?.customSyspromptLibrary || []) {
        if (!entry?.enabled || isBlankSectionContent(entry.content)) continue;
        const id = String(entry.id || '').trim();
        if (!id || !selected.has(`sysprompt:${id}`)) continue;
        const tag = String(entry.tag || '').trim();
        context += `<${tag}> (Custom GM/Narrator Section)\nInstructions:\n${entry.content}\n\n`;
    }

    return context.trim();
}

/**
 * Builds optional story context from ordinary user/assistant chat messages.
 * @param {any[]} chat
 * @param {any} settings
 */
export function buildGameSystemWizardStoryContext(chat, settings) {
    const { lookback, lookbackAll } = normalizeGameSystemWizardContextPrefs(settings);
    if (!lookbackAll && lookback === 0) return '';

    const eligible = (Array.isArray(chat) ? chat : []).filter(message =>
        !message?.is_system && typeof message?.mes === 'string' && message.mes.trim(),
    );
    const selected = lookbackAll ? eligible : eligible.slice(-lookback);
    if (!selected.length) return '';

    return selected.map(message => {
        const role = message.is_user ? 'USER' : 'ASSISTANT';
        const name = String(message.name || '').trim();
        return `${role}${name ? ` (${name})` : ''}:\n${message.mes.trim()}`;
    }).join('\n\n');
}

/**
 * Loads the entries currently active through Lorebook Agent state.
 * @param {any} settings
 * @param {any} ctx
 */
export async function buildGameSystemWizardLoreContext(settings, ctx) {
    if (!settings?.gameSystemWizardInjectLore || typeof ctx?.loadWorldInfo !== 'function') return '';
    const ids = [...new Set([
        ...(settings.activeRouterKeys || []),
        ...(settings.keywordActivatedKeys || []),
        ...(settings.activeWorldKeys || []),
    ])];
    if (!ids.length) return '';

    const books = {};
    const blocks = [];
    for (const id of ids) {
        const [bookName, uid] = String(id).split('::');
        if (!bookName || !uid) continue;
        if (!(bookName in books)) {
            try {
                books[bookName] = await ctx.loadWorldInfo(bookName);
            } catch {
                books[bookName] = null;
            }
        }
        const entry = books[bookName]?.entries?.[uid];
        if (!entry?.content) continue;
        const title = String(entry.comment || uid).replace(/^\[.*?\]\s*/i, '').trim();
        blocks.push(`### ${title}\n${String(entry.content).trim()}`);
    }
    return blocks.join('\n\n');
}
