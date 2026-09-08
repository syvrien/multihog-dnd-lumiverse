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

export function settingsLoaded(): boolean {
  return loaded
}

export async function loadSettings(): Promise<void> {
  if (loaded) return
  try {
    const stored = await spindle.userStorage.getJson<Record<string, unknown>>(SETTINGS_PATH, {
      fallback: {},
      userId: userScope(),
    })
    for (const [key, value] of Object.entries(stored ?? {})) {
      extensionSettings[key] = value
    }
  } catch (error) {
    spindle.log.warn(`[DnD] settings load failed, starting empty: ${(error as Error).message}`)
  }
  loaded = true
}

export async function saveSettings(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
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
