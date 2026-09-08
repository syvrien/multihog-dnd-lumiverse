/**
 * Relationship clamp/tier/style math.
 * When `max` is omitted, falls back to getNpcRelationshipMax() via settings-ref.
 */

import { getSettings } from './settings-ref.js';

/** @param {number} raw */
function normalizeNpcRelationshipMax(raw) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return 150;
    return Math.max(10, Math.min(10000, Math.round(n)));
}

/** Global default for new chats / chats without a saved per-chat value. */
export function getNpcRelationshipMaxDefault(settings) {
    const s = settings || getSettings();
    return normalizeNpcRelationshipMax(s.npcRelationshipMaxDefault ?? 150);
}

/** Effective max for the active chat (live `npcRelationshipMax`, else default). */
export function getNpcRelationshipMax(settings) {
    const s = settings || getSettings();
    if (settings != null && Object.prototype.hasOwnProperty.call(settings, 'npcRelationshipMax') && settings.npcRelationshipMax != null) {
        return normalizeNpcRelationshipMax(settings.npcRelationshipMax);
    }
    return normalizeNpcRelationshipMax(s.npcRelationshipMax ?? s.npcRelationshipMaxDefault ?? 150);
}

/** @param {number} value @param {number} [max] */
export function clampRelationshipValue(value, max) {
    const m = max ?? getNpcRelationshipMax();
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.max(-m, Math.min(m, Math.round(n)));
}

/** Bar fill width in percent (50% of track = full scale). @param {number} value @param {number} [max] */
export function relationshipBarPct(value, max) {
    const m = max ?? getNpcRelationshipMax();
    if (m <= 0) return 0;
    return (Math.abs(clampRelationshipValue(value, m)) / m) * 50;
}

/** @param {number} fraction @param {number} [max] */
export function relPctOfMax(fraction, max) {
    return Math.round((max ?? getNpcRelationshipMax()) * fraction);
}

/**
 * Maps a friendship value to a tier label and behavioral hint (thresholds are % of max).
 * @param {number} value
 * @param {number} [max]
 */
export function getFriendshipTier(value, max) {
    const m = max ?? getNpcRelationshipMax();
    const v = clampRelationshipValue(value, m);
    if (v <= -0.85 * m) return { label: 'HOSTILE',              hint: 'open contempt, refuses cooperation, may sabotage or attack' };
    if (v <= -0.65 * m) return { label: 'ENEMY/HATEFUL',        hint: 'deeply despises you, actively seeks to undermine your goals' };
    if (v <= -0.45 * m) return { label: 'BITTER/RESENTFUL',     hint: 'hostile tone, holds active grudges, quick to anger' };
    if (v <= -0.25 * m) return { label: 'UNFRIENDLY/COLD',      hint: 'curt and guarded, answers with bare minimum, visible irritation' };
    if (v <= -0.10 * m) return { label: 'DISTRUSTFUL/GUARDED',  hint: 'suspicious of your motives, keeps a physical and emotional distance' };
    if (v <= -0.03 * m) return { label: 'WARY/UNEASY',          hint: 'polite but distant, avoids personal topics, second-guesses motives' };
    if (v <=  0.03 * m) return { label: 'NEUTRAL/ACQUAINTANCE', hint: 'civil and transactional, neither warm nor cold' };
    if (v <=  0.10 * m) return { label: 'WARMING/FAVORABLE',    hint: 'small smiles, starting to open up, shows basic goodwill' };
    if (v <=  0.25 * m) return { label: 'AMICABLE',             hint: 'pleasant and chatty, actively engages in conversation, cooperative' };
    if (v <=  0.45 * m) return { label: 'FRIENDLY',             hint: 'genuine warmth, light humor, willing to help when asked' };
    if (v <=  0.65 * m) return { label: 'CLOSE FRIEND',         hint: 'deep trust, confides worries, stands up for you, proactive help' };
    if (v <=  0.85 * m) return { label: 'DEEP BOND/TRUSTED',    hint: 'fiercely protective, emotional bedrock, treats you as inner circle' };
    return                      { label: 'BONDED/FAMILY',       hint: 'unbreakable loyalty, would risk life without hesitation, shares deepest secrets' };
}

/**
 * Maps an affection value to a tier label and behavioral hint (thresholds are % of max).
 * @param {number} value
 * @param {number} [max]
 */
export function getAffectionTier(value, max) {
    const m = max ?? getNpcRelationshipMax();
    const v = clampRelationshipValue(value, m);
    if (v <= -0.85 * m) return { label: 'REVULSION',                hint: 'finds your presence repulsive, recoils from proximity, hostile to advances' };
    if (v <= -0.65 * m) return { label: 'DISGUSTED',                hint: 'active disdain for romantic or physical proximity, harsh rejections' };
    if (v <= -0.45 * m) return { label: 'AVERSION',                 hint: 'clearly uninterested, dismisses flirtation coldly, steers away from intimacy' };
    if (v <= -0.25 * m) return { label: 'AVOIDANT',                 hint: 'uncomfortable with romantic attention, subtly creates physical distance' };
    if (v <= -0.10 * m) return { label: 'UNRECEPTIVE/WITHDRAWN',    hint: 'shuts down romantic undertones, visibly uncomfortable with flirting' };
    if (v <= -0.03 * m) return { label: 'INDIFFERENT/UNINTERESTED', hint: 'no romantic spark, gentle deflection of any advances' };
    if (v <=  0.03 * m) return { label: 'NEUTRAL/NO AFFECTION',     hint: 'no romantic or emotional attachment toward you' };
    if (v <=  0.10 * m) return { label: 'CURIOUS/INTRIGUED',        hint: 'brief lingering looks, testing waters, open to playful banter' };
    if (v <=  0.25 * m) return { label: 'RECEPTIVE/FLIRTATIOUS',    hint: 'actively returns flirting, welcomes light physical touch, playful tension' };
    if (v <=  0.45 * m) return { label: 'INTERESTED',               hint: 'steals glances, responds warmly to compliments, comfortable with proximity' };
    if (v <=  0.65 * m) return { label: 'ATTRACTED',                hint: 'seeks your company, flustered by bold compliments, visible tension' };
    if (v <=  0.85 * m) return { label: 'SMITTEN/INFATUATED',       hint: 'cannot hide feelings, heavily romantic, deeply emotionally invested' };
    return                      { label: 'DEEPLY IN LOVE',          hint: 'emotionally devoted, craves closeness, expresses tenderness openly' };
}

/** @param {number} a @param {number} b @param {number} t */
function lerpTier(a, b, t) {
    return a + (b - a) * t;
}

/**
 * Intensity 0–1 from absolute value vs configured max.
 * @param {number} value
 * @param {number} [max]
 */
export function getRelTierIntensity(value, max) {
    const m = max ?? getNpcRelationshipMax();
    if (m <= 0) return 0;
    const v = clampRelationshipValue(value, m);
    if (v === 0) return 0;
    return Math.abs(v) / m;
}

/**
 * Inline CSS for compact tier pills — color intensity scales with |value|/max.
 * @param {'friendship'|'affection'} type
 * @param {number} value
 * @param {number} [max]
 * @returns {string}
 */
export function getRelTierBadgeStyle(type, value, max) {
    const v = clampRelationshipValue(value, max ?? getNpcRelationshipMax());
    if (v === 0) {
        return 'color:var(--rt-text-muted,rgba(255,255,255,0.45));background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.12);';
    }

    const t = getRelTierIntensity(v, max);
    const pos = v > 0;
    let hue;
    let satLo;
    let satHi;
    let lightLo;
    let lightHi;

    if (type === 'friendship') {
        hue = pos ? 142 : 0;
        satLo = pos ? 38 : 42;
        satHi = pos ? 95 : 92;
        lightLo = pos ? 58 : 58;
        lightHi = pos ? 44 : 46;
    } else {
        hue = pos ? 330 : 275;
        satLo = pos ? 42 : 38;
        satHi = pos ? 96 : 88;
        lightLo = pos ? 62 : 60;
        lightHi = pos ? 50 : 48;
    }

    const sat = lerpTier(satLo, satHi, t);
    const light = lerpTier(lightLo, lightHi, t);
    const bgA = lerpTier(0.07, 0.26, t);
    const borderA = lerpTier(0.20, 0.62, t);
    const glow = t > 0.65 ? `box-shadow:0 0 ${lerpTier(3, 8, (t - 0.65) / 0.35)}px hsla(${hue},${sat}%,${light}%,${lerpTier(0.15, 0.45, (t - 0.65) / 0.35)});` : '';

    return `color:hsl(${hue},${sat}%,${light}%);background:hsla(${hue},${sat}%,${light}%,${bgA});border:1px solid hsla(${hue},${sat}%,${light}%,${borderA});${glow}`;
}

/**
 * Inline CSS for the detailed tier block in the NPC popup (same intensity curve, softer fill).
 * @param {'friendship'|'affection'} type
 * @param {number} value
 * @param {number} [max]
 * @returns {string}
 */
export function getRelTierDetailedStyle(type, value, max) {
    const v = clampRelationshipValue(value, max ?? getNpcRelationshipMax());
    if (v === 0) {
        return 'background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.12);';
    }

    const t = getRelTierIntensity(v, max);
    const pos = v > 0;
    let hue;
    let satLo;
    let satHi;
    let lightLo;
    let lightHi;

    if (type === 'friendship') {
        hue = pos ? 142 : 0;
        satLo = 38; satHi = 95; lightLo = 58; lightHi = 44;
        if (!pos) { satLo = 42; satHi = 92; lightLo = 58; lightHi = 46; }
    } else {
        hue = pos ? 330 : 275;
        satLo = 42; satHi = 96; lightLo = 62; lightHi = 50;
        if (!pos) { satLo = 38; satHi = 88; lightLo = 60; lightHi = 48; }
    }

    const sat = lerpTier(satLo, satHi, t);
    const light = lerpTier(lightLo, lightHi, t);
    const bgA = lerpTier(0.06, 0.18, t);
    const borderA = lerpTier(0.18, 0.45, t);

    return `background:hsla(${hue},${sat}%,${light}%,${bgA});border:1px solid hsla(${hue},${sat}%,${light}%,${borderA});`;
}

/** @returns {string} Label color for detailed tier block (matches pill intensity). */
export function getRelTierDetailedLabelStyle(type, value, max) {
    const v = clampRelationshipValue(value, max ?? getNpcRelationshipMax());
    if (v === 0) return 'color:var(--rt-text-muted,rgba(255,255,255,0.45));';
    const t = getRelTierIntensity(v, max);
    const pos = v > 0;
    const hue = type === 'friendship' ? (pos ? 142 : 0) : (pos ? 330 : 275);
    const sat = type === 'friendship'
        ? lerpTier(pos ? 38 : 42, pos ? 95 : 92, t)
        : lerpTier(pos ? 42 : 38, pos ? 96 : 88, t);
    const light = type === 'friendship'
        ? lerpTier(pos ? 58 : 58, pos ? 44 : 46, t)
        : lerpTier(pos ? 62 : 60, pos ? 50 : 48, t);
    return `color:hsl(${hue},${sat}%,${light}%);`;
}
