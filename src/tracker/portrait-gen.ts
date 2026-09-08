/**
 * portrait-gen.ts — drawing a portrait instead of finding one.
 *
 * `src/tracker/portraits.ts` covers pointing an entity at an image you already
 * have — a persona avatar, a file, a URL. This is the other half: describing
 * the character to an image model and keeping what comes back.
 *
 * Upstream reaches four providers directly (Pollinations, AI Horde,
 * SillyTavern's native image extension, an OpenAI-compatible endpoint), each
 * with its own key handling and polling. None of that is needed here:
 * `spindle.imageGen` is the host's own image generation, using the connection
 * profiles the user has already set up, so the port asks the host and lets it
 * deal with providers.
 *
 * The prompt is upstream's. `generatePortraitPrompt` reads the entity out of
 * the CHARACTER, PARTY and COMBAT blocks and, optionally, recent story — so the
 * portrait matches the character the tracker has been describing rather than
 * the name alone.
 *
 * The result is stored as a **Lumiverse image URL**, never a data URL. The
 * engine's `persistPortraitSrc` only uploads when handed base64, and its upload
 * path is SillyTavern's REST API, which does not exist here. Passing the URL
 * short-circuits that entirely.
 */

export interface PortraitGenResult {
  ok: boolean
  reason?: string
  /** What was actually sent to the image model, for the user to judge. */
  prompt?: string
  url?: string
}

interface EngineBits {
  getSettings: () => Record<string, any>
  buildPrompt: (entityName: string) => Promise<string>
  applyPortrait: (
    entityName: string,
    src: string,
    opts?: Record<string, unknown>,
  ) => Promise<unknown>
}

let cached: EngineBits | null = null

async function engine(): Promise<EngineBits> {
  if (cached) return cached
  const [stateManager, portraits] = await Promise.all([
    import('../engine/state-manager.js'),
    import('../engine/portraits.js'),
  ]) as any[]
  cached = {
    getSettings: stateManager.getSettings,
    buildPrompt: portraits.generatePortraitPrompt,
    applyPortrait: portraits.applyPortraitData,
  }
  return cached
}

/** Whether the host has anything to generate with. */
export async function imageGenAvailable(
  userId?: string,
): Promise<{ ok: boolean; reason?: string }> {
  if (!spindle.permissions.has('image_gen')) {
    return { ok: false, reason: 'the image_gen permission is not granted' }
  }
  try {
    // Operator-scoped: every user-scoped call must name a user, and listing
    // connections is one. Falling back to the acting user rather than making
    // every caller thread it through.
    const { userScope } = await import('../compat/user-context')
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

/**
 * Write a prompt for an entity without generating anything.
 *
 * Worth having on its own: an image model is the expensive half, and reading
 * the prompt first is how you find out the tracker thinks your ranger is a
 * dwarf before you pay to see it.
 */
export async function describeForPortrait(
  entityName: string,
): Promise<{ ok: boolean; prompt?: string; reason?: string }> {
  const name = String(entityName ?? '').trim()
  if (!name) return { ok: false, reason: 'no character named' }
  if (!spindle.permissions.has('generation')) {
    return { ok: false, reason: 'generation permission not granted' }
  }
  try {
    const prompt = await (await engine()).buildPrompt(name)
    return prompt?.trim()
      ? { ok: true, prompt: prompt.trim() }
      : { ok: false, reason: 'could not describe that character from the current state' }
  } catch (error) {
    return { ok: false, reason: (error as Error).message }
  }
}

/**
 * Generate a portrait and keep it.
 *
 * `prompt` overrides the generated description, so an edited prompt is what
 * gets drawn — the same rule as every other review step in this port.
 */
export async function generatePortrait(
  entityName: string,
  prompt?: string,
  userId?: string,
): Promise<PortraitGenResult> {
  const name = String(entityName ?? '').trim()
  if (!name) return { ok: false, reason: 'no character named' }

  const available = await imageGenAvailable(userId)
  if (!available.ok) return { ok: false, reason: available.reason }

  let text = String(prompt ?? '').trim()
  if (!text) {
    const described = await describeForPortrait(name)
    if (!described.ok) return { ok: false, reason: described.reason }
    text = described.prompt ?? ''
  }

  let url = ''
  try {
    const { userScope } = await import('../compat/user-context')
    const result = await spindle.imageGen.generate({
      prompt: text,
      userId: userId ?? userScope(),
      // The host persists the image either way; the base64 would only bloat
      // the response, and the URL is what gets stored.
      includeDataUrl: false,
    } as never) as { imageUrl?: string; imageDataUrl?: string }
    url = result?.imageUrl ?? result?.imageDataUrl ?? ''
  } catch (error) {
    return { ok: false, prompt: text, reason: (error as Error).message }
  }
  if (!url) return { ok: false, prompt: text, reason: 'the image model returned nothing' }

  try {
    // The engine handles the chat scoping — which partition the portrait
    // belongs to, and what happens if the chat changes mid-generation.
    await (await engine()).applyPortrait(name, url)
  } catch (error) {
    return { ok: false, prompt: text, url, reason: (error as Error).message }
  }
  return { ok: true, prompt: text, url }
}

/** Entities on the tracker card that could have one. */
export async function portraitTargets(): Promise<string[]> {
  const bits = await engine()
  const memo = String(bits.getSettings().currentMemo ?? '')
  const names = new Set<string>()

  for (const tag of ['CHARACTER', 'PARTY', 'NPC']) {
    const block = new RegExp(`\\[${tag}\\]([\\s\\S]*?)\\[/${tag}\\]`, 'i').exec(memo)?.[1]
    if (!block) continue
    for (const line of block.split('\n')) {
      // Entities lead their paragraph; the name runs to the first separator.
      // A colon straight after means this is a stat line (`HP: 8/8`), not a
      // character — without that check the cast list fills up with "HP".
      const match = /^\s*([A-Z][^—\-:(\n]{1,40})(?![^\n]*?^)/.exec(line)
      const found = match?.[1]?.trim()
      if (!found || found.length < 2) continue
      if (line.slice(match!.index + match![1].length).startsWith(':')) continue
      names.add(found)
    }
  }
  return [...names].sort()
}
