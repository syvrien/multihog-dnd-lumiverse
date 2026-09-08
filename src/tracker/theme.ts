/**
 * theme.ts — repainting the tracker panel.
 *
 * A theme is a map of `--rt-custom-*` CSS variables. The engine's stylesheet
 * already reads them, so applying one is a matter of getting the values to the
 * frontend and letting it write a style block — no engine change at all.
 *
 * The wizard turns a description ("a haunted crypt, candlelight on wet stone")
 * into a palette. Its system prompt lives inside upstream's dialog function, so
 * `scripts/port.mjs` lifts the literal into `THEME_WIZARD_SYSTEM_PROMPT` rather
 * than the port keeping a second copy to drift from.
 *
 * Undo matters more here than elsewhere: a bad palette can make the panel
 * unreadable, and "put it back" needs to work without reading the thing you
 * just broke.
 */

/** The variables a theme may set. A reply missing more than a few is rejected. */
const THEME_VARS = [
  '--rt-custom-bg', '--rt-custom-blur', '--rt-custom-border',
  '--rt-custom-text', '--rt-custom-text-muted', '--rt-custom-font',
  '--rt-custom-font-mono', '--rt-custom-accent', '--rt-custom-accent-dim',
  '--rt-custom-accent-bg', '--rt-custom-card-border', '--rt-custom-shadow',
  '--rt-custom-header-bg', '--rt-custom-card-bg', '--rt-custom-card-header',
] as const

export type ThemeVars = Record<string, string>

export interface ThemeState {
  /** The palette in force, or null for the shipped look. */
  active: ThemeVars | null
  /** Saved palettes by name. */
  saved: string[]
  /** Whether the last change can be undone. */
  canUndo: boolean
}

interface EngineBits {
  getSettings: () => Record<string, any>
  wizardPrompt: string
  sendStateRequest: (
    settings: unknown,
    systemPrompt: string,
    userPrompt: string,
  ) => Promise<string>
}

let cached: EngineBits | null = null

async function engine(): Promise<EngineBits> {
  if (cached) return cached
  const [stateManager, themeManager, llm] = await Promise.all([
    import('../engine/state-manager.js'),
    import('../engine/theme-manager.js'),
    import('../engine/llm-client.js'),
  ]) as any[]
  cached = {
    getSettings: stateManager.getSettings,
    wizardPrompt: themeManager.THEME_WIZARD_SYSTEM_PROMPT ?? '',
    sendStateRequest: llm.sendStateRequest,
  }
  return cached
}

/**
 * Undo history, in memory.
 *
 * Deliberately not persisted: it exists so a palette you dislike can be undone
 * in the moment. A stack surviving a restart would offer to revert a theme you
 * settled on days ago.
 */
const undoStack: Array<ThemeVars | null> = []

export async function readTheme(): Promise<ThemeState> {
  const bits = await engine()
  const settings = bits.getSettings()
  return {
    active: (settings.customTheme as ThemeVars) ?? null,
    saved: Object.keys(settings.savedThemes ?? {}).sort(),
    canUndo: undoStack.length > 0,
  }
}

/** Keep only the known variables, and only ones that look like values. */
function sanitise(vars: Record<string, unknown>): ThemeVars {
  const clean: ThemeVars = {}
  for (const name of THEME_VARS) {
    const value = vars[name]
    // A theme goes straight into a stylesheet, so a value carrying a brace or a
    // semicolon could close the rule and write arbitrary CSS.
    if (typeof value !== 'string' || !value.trim()) continue
    if (/[{};<>]/.test(value)) continue
    clean[name] = value.trim()
  }
  return clean
}

/** Apply a palette, remembering what it replaced. */
export async function applyTheme(vars: ThemeVars | null): Promise<ThemeState> {
  const bits = await engine()
  const settings = bits.getSettings()
  undoStack.push(settings.customTheme ?? null)
  settings.customTheme = vars ? sanitise(vars) : null
  return readTheme()
}

export async function undoTheme(): Promise<ThemeState> {
  const bits = await engine()
  const settings = bits.getSettings()
  if (undoStack.length) settings.customTheme = undoStack.pop() ?? null
  return readTheme()
}

export async function saveTheme(name: string): Promise<{ ok: boolean; reason?: string }> {
  const label = String(name ?? '').trim()
  if (!label) return { ok: false, reason: 'name the theme' }
  const bits = await engine()
  const settings = bits.getSettings()
  if (!settings.customTheme) return { ok: false, reason: 'there is no custom theme to save' }
  if (!settings.savedThemes || typeof settings.savedThemes !== 'object') {
    settings.savedThemes = {}
  }
  settings.savedThemes[label] = JSON.parse(JSON.stringify(settings.customTheme))
  return { ok: true }
}

export async function loadTheme(name: string): Promise<{ ok: boolean; reason?: string }> {
  const bits = await engine()
  const settings = bits.getSettings()
  const found = settings.savedThemes?.[String(name ?? '')]
  if (!found) return { ok: false, reason: 'no theme by that name' }
  await applyTheme(found as ThemeVars)
  return { ok: true }
}

export async function deleteTheme(name: string): Promise<{ ok: boolean; reason?: string }> {
  const bits = await engine()
  const settings = bits.getSettings()
  if (!settings.savedThemes?.[String(name ?? '')]) {
    return { ok: false, reason: 'no theme by that name' }
  }
  delete settings.savedThemes[String(name)]
  return { ok: true }
}

/**
 * Ask a model for a palette.
 *
 * `refine` passes the current theme along, so "warmer, less green" works on
 * what is on screen rather than starting over.
 */
export async function generateTheme(
  description: string,
  refine = false,
): Promise<{ ok: boolean; vars?: ThemeVars; reason?: string }> {
  const text = String(description ?? '').trim()
  if (!text) return { ok: false, reason: 'describe the look you want' }
  if (!spindle.permissions.has('generation')) {
    return { ok: false, reason: 'generation permission not granted' }
  }

  const bits = await engine()
  const settings = bits.getSettings()
  if (!bits.wizardPrompt) {
    return { ok: false, reason: 'the theme prompt did not come across in the port' }
  }

  const userPrompt = (refine && settings.customTheme)
    ? `\n\nCURRENT THEME STATE (JSON):\n${JSON.stringify(settings.customTheme, null, 2)}`
      + `\n\nUser wants to CHANGE this theme as follows: ${text}`
    : `\n\nUser description: ${text}`

  let raw = ''
  try {
    raw = await bits.sendStateRequest(settings, bits.wizardPrompt, userPrompt)
  } catch (error) {
    return { ok: false, reason: (error as Error).message }
  }

  const json = /\{[\s\S]*\}/.exec(raw ?? '')
  if (!json) return { ok: false, reason: 'the model did not return a palette' }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(json[0])
  } catch {
    return { ok: false, reason: 'the palette it returned was not valid JSON' }
  }

  const vars = sanitise(parsed)
  // Upstream's tolerance: a few missing variables fall back to the defaults,
  // but a reply that is mostly empty is a failed generation, not a subtle theme.
  const missing = THEME_VARS.filter(name => !vars[name])
  if (missing.length > 3) {
    return { ok: false, reason: `the palette is missing ${missing.length} of its colours` }
  }
  return { ok: true, vars }
}
