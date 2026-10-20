/**
 * settings-store.ts — SillyTavern `extensionSettings` emulation.
 *
 * Backed by `spindle.userStorage`, not `spindle.storage`: a campaign's settings
 * and its state memo are one person's game, and an operator-scoped install
 * shares `spindle.storage` across everyone on the instance.
 *
 * `getSettings()` in the ported engine reads `SillyTavern.getContext().extensionSettings`
 * synchronously, mutates it freely, and calls `saveSettingsDebounced()`. Spindle
 * storage is async, so the store loads once at boot into a plain object the
 * engine can mutate, and debounces writes back to `spindle.storage`.
 *
 * Per-chat game state (the state memo, quests, relationships) stays out of this
 * file — that lives in `spindle.variables.chat`, see `chat-state.ts`.
 */

import { userScope } from './user-context'

const SETTINGS_PATH = 'settings.json'
const SAVE_DEBOUNCE_MS = 800

/** The object handed to the engine as `ctx.extensionSettings`. Identity is stable. */
export const extensionSettings: Record<string, unknown> = {}

let saveTimer: ReturnType<typeof setTimeout> | null = null
let loaded = false
let fresh = false
/**
 * The last read of the stored settings failed. `extensionSettings` then holds
 * whatever the engine filled in from its defaults, and writing that back would
 * replace the user's real settings — connections, campaign state, cartridges —
 * with a blank install. Saving stays off until a read succeeds.
 */
let loadFailed = false
let saveSuspendedLogged = false

/**
 * Whether the stored settings had no engine settings in them — a new install,
 * or a user's first visit. Judged from what was *stored*, not from
 * `extensionSettings`, which an early `getSettings()` may already have filled
 * with defaults. See `port-defaults.ts`.
 */
export function freshInstall(): boolean {
  return fresh
}

export function settingsLoaded(): boolean {
  return loaded
}

/** Whether the stored settings could not be read, so saving is suspended. */
export function settingsLoadFailed(): boolean {
  return loadFailed
}

/**
 * Read the stored settings into `extensionSettings`.
 *
 * Throws if the read fails, and leaves the store unloaded so the next call
 * tries again — a transient storage error must not stick for the session.
 */
export async function loadSettings(): Promise<void> {
  if (loaded) return
  let stored: Record<string, unknown> | null
  try {
    stored = await spindle.userStorage.getJson<Record<string, unknown>>(SETTINGS_PATH, {
      fallback: {},
      userId: userScope(),
    })
  } catch (error) {
    // A failed read is not a new install — never apply first-run defaults over
    // settings that exist but could not be read, and never save over them.
    loadFailed = true
    spindle.log.warn(`[DnD] settings load failed: ${(error as Error).message}`)
    throw error
  }
  for (const [key, value] of Object.entries(stored ?? {})) {
    extensionSettings[key] = value
  }
  const { ENGINE_SETTINGS_KEY } = await import('./port-defaults')
  fresh = !(stored && typeof stored === 'object' && ENGINE_SETTINGS_KEY in stored)
  if (loadFailed) spindle.log.info('[DnD] settings read on retry; saving resumed')
  loadFailed = false
  saveSuspendedLogged = false
  loaded = true
}

export async function saveSettings(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  if (loadFailed) {
    if (!saveSuspendedLogged) {
      saveSuspendedLogged = true
      spindle.log.warn('[DnD] settings not saved: the stored settings could not be read, '
        + 'and saving now would overwrite them. Saving is suspended until they load.')
    }
    return
  }
  try {
    await spindle.userStorage.setJson(SETTINGS_PATH, extensionSettings, {
      indent: 2,
      userId: userScope(),
    })
  } catch (error) {
    spindle.log.error(`[DnD] settings save failed: ${(error as Error).message}`)
  }
}

export function saveSettingsDebounced(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    void saveSettings()
  }, SAVE_DEBOUNCE_MS)
}
