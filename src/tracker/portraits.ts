/**
 * portraits.ts — setting an entity's portrait by hand.
 *
 * Upstream renders every entity card with a portrait box carrying
 * `title="Drop image here or click to set portrait"`, and upstream wires both
 * gestures. The port rendered the box and wired neither, so the tooltip
 * promised something that never happened.
 *
 * Upstream's own answer is to *generate* the image, which needs an
 * image-generation provider. This is the other half: point at a persona's
 * avatar, upload a file, or paste a URL. No provider involved.
 *
 * Portraits live in `settings.customPortraits`, keyed by entity name, which is
 * what `lookupCustomPortraitSrc` reads when the renderer builds a card — so
 * anything stored here shows up on the tracker card and in the Lorebook Agent.
 */

import { chatMirror } from '../compat/chat-mirror'

/** A data URL bigger than this is refused rather than pushed through the channel. */
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024

export interface PortraitChoice {
  id: string
  name: string
  url: string
}

interface EngineBits {
  getSettings: () => Record<string, any>
  saveChatState: (chatId: string) => unknown
  normalizeEntityName: (name: string) => string
  lookupCustomPortraitSrc: (
    settings: unknown,
    entityName: string,
    map?: Record<string, string>,
  ) => string
}

let cached: EngineBits | null = null

async function engine(): Promise<EngineBits> {
  if (cached) return cached
  const [stateManager, storage, persistence] = await Promise.all([
    import('../engine/state-manager.js'),
    import('../engine/portrait-storage.js'),
    import('../engine/src/state/chat-persistence.js'),
  ]) as any[]
  cached = {
    getSettings: stateManager.getSettings,
    saveChatState: persistence.saveChatState,
    normalizeEntityName: storage.normalizeEntityName,
    lookupCustomPortraitSrc: storage.lookupCustomPortraitSrc,
  }
  return cached
}

/**
 * Persist the portrait map.
 *
 * It is stored per chat, so `saveChatState` is what makes it durable — the
 * caller has already mutated `settings.customPortraits` in place.
 */
async function commit(): Promise<void> {
  const bits = await engine()
  const chatId = chatMirror.getChatId()
  if (!chatId) {
    spindle.log.warn('[DnD] no chat id; the portrait is in memory only')
    return
  }
  try {
    bits.saveChatState(chatId)
  } catch (error) {
    spindle.log.error(`[DnD] saving the portrait failed: ${(error as Error).message}`)
  }
}

/** Personas with an avatar, offered as ready-made portraits. */
export async function listPortraitChoices(userId?: string): Promise<PortraitChoice[]> {
  if (!spindle.permissions.has('personas') || !spindle.permissions.has('images')) return []
  try {
    const { data } = await spindle.personas.list({ limit: 100, userId })
    const withImages = data.filter(persona => persona.image_id)
    const resolved = await Promise.all(withImages.map(async persona => {
      try {
        const image = await spindle.images.get(persona.image_id as string, userId)
        return image?.url ? { id: persona.id, name: persona.name, url: image.url } : null
      } catch {
        return null
      }
    }))
    return resolved.filter((entry): entry is PortraitChoice => entry !== null)
  } catch (error) {
    spindle.log.warn(`[DnD] portrait choices failed: ${(error as Error).message}`)
    return []
  }
}

/** The portrait currently showing for an entity, if any. */
export async function currentPortrait(entity: string): Promise<string> {
  const bits = await engine()
  try {
    return bits.lookupCustomPortraitSrc(bits.getSettings(), entity) || ''
  } catch {
    return ''
  }
}

export interface PortraitSource {
  /** Take a persona's avatar. */
  personaId?: string
  /** An image URL, pasted by the user. */
  url?: string
  /** A file the user dropped or picked, as a data URL. */
  dataUrl?: string
  filename?: string
}

/**
 * Point an entity at an image.
 *
 * A dropped file is uploaded to Lumiverse and the resulting asset URL stored,
 * rather than the data URL itself — settings are written to per-user storage on
 * every commit, and a few base64 portraits would bloat every one of those
 * writes.
 */
export async function setPortrait(
  entity: string,
  source: PortraitSource,
  userId?: string,
): Promise<{ ok: boolean; url?: string; reason?: string }> {
  const name = String(entity ?? '').trim()
  if (!name) return { ok: false, reason: 'no entity to set a portrait for' }

  const bits = await engine()
  const settings = bits.getSettings()

  let url = ''
  if (source.personaId) {
    if (!spindle.permissions.has('personas') || !spindle.permissions.has('images')) {
      return { ok: false, reason: 'the personas and images permissions are not granted' }
    }
    try {
      const persona = await spindle.personas.get(source.personaId, userId)
      if (!persona?.image_id) return { ok: false, reason: 'that persona has no image' }
      const image = await spindle.images.get(persona.image_id, userId)
      url = image?.url ?? ''
    } catch (error) {
      return { ok: false, reason: (error as Error).message }
    }
    if (!url) return { ok: false, reason: 'that persona image could not be read' }
  } else if (source.dataUrl) {
    if (!spindle.permissions.has('images')) {
      return { ok: false, reason: 'the images permission is not granted' }
    }
    if (!/^data:image\//i.test(source.dataUrl)) {
      return { ok: false, reason: 'that file is not an image' }
    }
    // base64 is 4 characters per 3 bytes.
    if (source.dataUrl.length * 3 / 4 > MAX_UPLOAD_BYTES) {
      return { ok: false, reason: 'that image is too large (8 MB max)' }
    }
    try {
      const image = await spindle.images.uploadFromDataUrl(source.dataUrl, {
        originalFilename: source.filename || 'portrait.png',
        userId,
      })
      url = image?.url ?? ''
    } catch (error) {
      return { ok: false, reason: (error as Error).message }
    }
    if (!url) return { ok: false, reason: 'the upload returned no image' }
  } else if (source.url) {
    const trimmed = source.url.trim()
    // A relative Lumiverse asset path is fine; anything else must be http(s),
    // so a `javascript:` string cannot reach an <img src> in the panel.
    if (!/^(https?:\/\/|\/)/i.test(trimmed)) {
      return { ok: false, reason: 'that does not look like an image URL' }
    }
    url = trimmed
  } else {
    return { ok: false, reason: 'nothing to set' }
  }

  if (!settings.customPortraits) settings.customPortraits = {}
  // The renderer looks portraits up by the normalised name, so store the same.
  settings.customPortraits[bits.normalizeEntityName(name) || name] = url
  await commit()
  return { ok: true, url }
}

/** Drop an entity's portrait, falling back to the placeholder icon. */
export async function clearPortrait(entity: string): Promise<{ ok: boolean; reason?: string }> {
  const bits = await engine()
  const settings = bits.getSettings()
  const map = settings.customPortraits
  if (!map) return { ok: true }

  const key = bits.normalizeEntityName(entity) || entity
  // Cards keyed under a raw name from an older write must go too, or the
  // portrait comes back on the next render.
  for (const stored of Object.keys(map)) {
    if (stored === key || bits.normalizeEntityName(stored) === key) delete map[stored]
  }
  await commit()
  return { ok: true }
}
