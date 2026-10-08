/**
 * image-gen.ts — the one way the port draws anything.
 *
 * Upstream reaches its image providers directly: SillyTavern's own image
 * extension through `/imagine`, AI Horde, Pollinations. None of those exist
 * here. `spindle.imageGen` is the host's image generation, on the connections
 * the user has already set up, so every picture the port makes — a portrait
 * drawn by hand, scene art, or upstream's automatic art through the engine's
 * `/imagine` call — goes through this file and nowhere else.
 *
 * Results are **Lumiverse image URLs**, never data URLs. The engine's
 * `persistPortraitSrc` only uploads when handed base64, and its upload path is
 * SillyTavern's REST API, which does not exist here; a URL short-circuits it.
 */

import { userScope } from './user-context'

/** Whether the host has anything to draw with. */
export async function imageGenAvailable(
  userId?: string,
): Promise<{ ok: boolean; reason?: string }> {
  if (!spindle.permissions.has('image_gen')) {
    return { ok: false, reason: 'the image_gen permission is not granted' }
  }
  try {
    // Operator-scoped: every user-scoped call must name a user, and listing
    // connections is one.
    const connections = await spindle.imageGen.listConnections(userId ?? userScope())
    if (!connections.length) {
      return {
        ok: false,
        reason: 'no image generation connection is set up in Lumiverse',
      }
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: (error as Error).message }
  }
}

function aborted(): Error {
  const error = new Error('Image generation was stopped')
  error.name = 'AbortError'
  return error
}

/**
 * Draw `prompt` and return the image's URL. Throws on any failure.
 *
 * The host call cannot be cancelled once sent, so `signal` is honoured at the
 * edges: a stop before the call skips it, and a stop during it discards the
 * result rather than handing back a picture nobody wants any more.
 */
export async function drawImage(
  prompt: string,
  options: { userId?: string; signal?: AbortSignal } = {},
): Promise<string> {
  const text = String(prompt ?? '').trim()
  if (!text) throw new Error('nothing to draw — the prompt is empty')
  if (options.signal?.aborted) throw aborted()
  const result = await spindle.imageGen.generate({
    prompt: text,
    userId: options.userId ?? userScope(),
    // The host persists the image either way; the base64 would only bloat
    // the response, and the URL is what gets stored.
    includeDataUrl: false,
  } as never) as { imageUrl?: string; imageDataUrl?: string }
  if (options.signal?.aborted) throw aborted()
  const url = result?.imageUrl ?? result?.imageDataUrl ?? ''
  if (!url) throw new Error('the image model returned nothing')
  return url
}
