/**
 * immersion.ts — the scene the party is standing in.
 *
 * Where they are, who is with them, and the art for it. The tracker cards tell
 * you the numbers; this is the one surface that tells you the *place* — the
 * location resolved down its hierarchy, the NPCs present with their portraits,
 * and a picture of the room.
 *
 * `immersion.js` is DOM-free: `buildImmersionSceneState` reads the memo and the
 * campaign's Locations book, and `renderImmersionViewHtml` returns markup. Both
 * run on the backend beside `renderer.js`, and the frontend injects markup the
 * host sanitises.
 *
 * ## Scene art
 *
 * Upstream generates it through its own provider stack. As with portraits, the
 * port goes to `spindle.imageGen` instead and stores the resulting URL under
 * `settings.customLocationImages[path]`, which is where the renderer looks.
 *
 * Auto-generation on arrival is deliberately **not** wired. Upstream fires it
 * whenever the party enters somewhere new, which on a paid image endpoint is a
 * bill that arrives without anyone asking for it. Drawing a scene stays a thing
 * you choose.
 */

interface EngineBits {
  getSettings: () => Record<string, any>
  buildScene: (memo: string | null, settings: unknown) => Promise<Record<string, any>>
  renderScene: (scene: unknown) => string
  normalizeLocationPath: (path: string) => string
}

let cached: EngineBits | null = null

async function engine(): Promise<EngineBits> {
  if (cached) return cached
  const [stateManager, immersion, portraits] = await Promise.all([
    import('../engine/state-manager.js'),
    import('../engine/immersion.js'),
    import('../engine/portraits.js'),
  ]) as any[]
  cached = {
    getSettings: stateManager.getSettings,
    buildScene: immersion.buildImmersionSceneState,
    renderScene: immersion.renderImmersionViewHtml,
    normalizeLocationPath: portraits.normalizeLocationPath,
  }
  return cached
}

export interface SceneView {
  ok: boolean
  reason?: string
  /** The location as the memo states it. */
  where?: string
  /** The resolved path into the Locations book, and the key art is stored under. */
  path?: string
  /** Rendered markup: the place, its image, and who is present. */
  html?: string
  /** Whether art already exists for this place. */
  hasArt?: boolean
}

/** Build the current scene. */
export async function readScene(): Promise<SceneView> {
  const bits = await engine()
  const settings = bits.getSettings()
  const memo = String(settings.currentMemo ?? '')
  if (!memo.trim()) return { ok: false, reason: 'no campaign state yet' }

  try {
    const scene = await bits.buildScene(memo, settings)
    if (!scene) return { ok: false, reason: 'the scene could not be read' }
    const path = String(scene.storagePath ?? scene.resolvedPath ?? '')
    return {
      ok: true,
      where: String(scene.rawLocationText ?? ''),
      path,
      html: bits.renderScene(scene),
      hasArt: !!scene.locationImage,
    }
  } catch (error) {
    return { ok: false, reason: (error as Error).message }
  }
}

/**
 * Draw the current location.
 *
 * The description comes from the location's own lorebook entry when it has
 * one — the place as the campaign has established it, rather than a name and a
 * guess.
 */
export async function generateSceneArt(
  userId?: string,
): Promise<{ ok: boolean; url?: string; prompt?: string; reason?: string }> {
  const { imageGenAvailable } = await import('./portrait-gen')
  const available = await imageGenAvailable(userId)
  if (!available.ok) return { ok: false, reason: available.reason }

  const bits = await engine()
  const settings = bits.getSettings()
  // Image generation is the slowest call the extension makes, and the write
  // below used to resolve its chat *after* it returned — so art drawn for one
  // campaign was filed under whichever chat the user had moved to.
  const { chatMirror } = await import('../compat/chat-mirror')
  const chatIdAtStart = chatMirror.getChatId()

  let scene: Record<string, any>
  try {
    scene = await bits.buildScene(String(settings.currentMemo ?? ''), settings)
  } catch (error) {
    return { ok: false, reason: (error as Error).message }
  }
  const path = String(scene?.storagePath ?? scene?.resolvedPath ?? '')
  if (!path) return { ok: false, reason: 'there is no location to draw' }

  const described = String(scene.locationContent ?? '').trim()
  const where = String(scene.locationBreadcrumb || scene.rawLocationText || path)
  const prompt = [
    'A wide establishing shot of a location in a fantasy roleplaying campaign.',
    `Location: ${where}.`,
    described ? `Details: ${described}` : '',
    'No people, no text, no captions. Atmospheric, painterly.',
  ].filter(Boolean).join('\n')

  let url = ''
  try {
    const { userScope } = await import('../compat/user-context')
    const result = await spindle.imageGen.generate({
      prompt,
      userId: userId ?? userScope(),
      includeDataUrl: false,
    } as never) as { imageUrl?: string; imageDataUrl?: string }
    url = result?.imageUrl ?? result?.imageDataUrl ?? ''
  } catch (error) {
    return { ok: false, prompt, reason: (error as Error).message }
  }
  if (!url) return { ok: false, prompt, reason: 'the image model returned nothing' }

  const chatId = chatMirror.getChatId()
  if (chatId !== chatIdAtStart) {
    // The image is drawn and paid for, but `customLocationImages` is part of
    // the active chat's snapshot — writing it now would file this campaign's
    // art under another one. Handing back the URL keeps the work visible.
    return { ok: true, url, prompt, reason: 'you switched chats — the art was not saved' }
  }

  // Keyed by the normalised path, which is where the scene renderer looks.
  if (!settings.customLocationImages) settings.customLocationImages = {}
  settings.customLocationImages[bits.normalizeLocationPath(path)] = url

  if (chatId) {
    try {
      const persistence = await import('../engine/src/state/chat-persistence.js') as unknown as {
        saveChatState: (id: string) => unknown
      }
      persistence.saveChatState(chatId)
    } catch (error) {
      spindle.log.warn(`[DnD] saving the scene art failed: ${(error as Error).message}`)
    }
  }
  return { ok: true, url, prompt }
}

/** Forget the art for the current place, so it can be drawn again. */
export async function clearSceneArt(): Promise<{ ok: boolean; reason?: string }> {
  const bits = await engine()
  const settings = bits.getSettings()
  try {
    const scene = await bits.buildScene(String(settings.currentMemo ?? ''), settings)
    const path = String(scene?.storagePath ?? scene?.resolvedPath ?? '')
    if (!path) return { ok: false, reason: 'there is no location' }
    delete settings.customLocationImages?.[bits.normalizeLocationPath(path)]
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: (error as Error).message }
  }
}
