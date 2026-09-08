/**
 * blocks.ts — which cards the tracker keeps, in what order, and what they say.
 *
 * `ui-editors.js` came across with the rest of the engine and then sat there:
 * 2,056 lines, called by nothing. Everything it edits was reachable only
 * through a model — the Game System Wizard invents a tracked module for you and
 * that was the whole story. There was no way to reorder the cards, no way to
 * switch one off, and no way to adjust a module after the wizard made it.
 *
 * Three things live here, because upstream's order editor mixes all three and
 * they genuinely are one screen:
 *
 *   1. **Order.** `renderer.js` has read `settings.blockOrder` since the panel
 *      landed. Nothing wrote it, so the order was the shipped default forever.
 *   2. **Enabled.** `settings.modules[tag]` gates both the card *and* what
 *      `buildModulesInstructionText()` tells the tracker to look for — so
 *      switching Spells off stops the model being asked about spells, not just
 *      stops the card drawing. That is worth knowing before you touch it.
 *   3. **Custom modules.** Create, edit, delete by hand.
 *
 * ## The rename cascade
 *
 * A module's tag is a foreign key. It appears in `blockOrder`, in every Display
 * Group's `members`, in `gameSystems[].customFieldTag`, in `modulePageSizes`
 * and in `categoryRenderOptions`, and the deleted-tag tombstones exist to stop
 * a stale key resurrecting. Upstream's save handler updates all six in a fixed
 * order; `renameCascade()` below follows it step for step rather than
 * approximating, because a missed one leaves a module that renders in the wrong
 * place or a group that quietly loses a member.
 */

import { saveSettings } from '../compat/settings-store'

interface EngineBits {
  getSettings: () => Record<string, any>
  BLOCK_ORDER: string[]
  BLOCK_ICONS: Record<string, string>
  PAGE_SIZE: number
  recordDeletedCustomTags: (tag: string) => void
  clearDeletedCustomTagTombstones: (tag: string) => void
  removeChatSetupCatalogEntries: (
    settings: unknown,
    options: { customFieldTags: string[] },
  ) => void
  normalizeDisplayGroups: (input: unknown) => Array<Record<string, any>>
  DEFAULT_STOCK_PROMPTS: Record<string, string>
}

let cached: EngineBits | null = null

async function engine(): Promise<EngineBits> {
  if (cached) return cached
  const [stateManager, constants, groups] = await Promise.all([
    import('../engine/state-manager.js'),
    import('../engine/constants.js'),
    import('../engine/src/features/display-groups.js'),
  ]) as any[]

  cached = {
    getSettings: stateManager.getSettings,
    BLOCK_ORDER: constants.BLOCK_ORDER,
    BLOCK_ICONS: constants.BLOCK_ICONS,
    PAGE_SIZE: constants.PAGE_SIZE,
    recordDeletedCustomTags: stateManager.recordDeletedCustomTags,
    clearDeletedCustomTagTombstones: stateManager.clearDeletedCustomTagTombstones,
    removeChatSetupCatalogEntries: stateManager.removeChatSetupCatalogEntries,
    normalizeDisplayGroups: groups.normalizeDisplayGroups,
    DEFAULT_STOCK_PROMPTS: constants.DEFAULT_STOCK_PROMPTS,
  }
  return cached
}

export interface TrackerBlock {
  tag: string
  icon: string
  label: string
  enabled: boolean
  /** `stock` cannot be deleted or renamed; `custom` and `wizard` can. */
  kind: 'stock' | 'custom' | 'wizard'
  /** Entries shown before pagination kicks in. */
  pageSize: number
  /** Set for custom modules: what the tracker is told to record. */
  prompt?: string
  /** Set for custom modules: the sandbox sample, never sent to the model. */
  template?: string
  /** Set for built-in modules: the shipped instruction, as it stands now. */
  stockPrompt?: string
  /** Whether that instruction is still the shipped text. */
  stockIsDefault?: boolean
}

export interface BlocksView {
  blocks: TrackerBlock[]
  reason?: string
}

const cleanTag = (value: unknown): string =>
  String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9_]/g, '')

/**
 * Bring `blockOrder` into line with the modules that actually exist.
 *
 * Follows `refreshOrderList()`: give custom fields unique tags, append anything
 * missing from the order, then drop entries for modules that are gone. Called
 * before every read and write, so a hand-edited settings file or a cartridge
 * import cannot leave the order describing modules that do not exist.
 */
function normalizeOrder(settings: Record<string, any>, bits: EngineBits): string[] {
  if (!Array.isArray(settings.blockOrder)) settings.blockOrder = [...bits.BLOCK_ORDER]

  // Custom tags must be unique against the stock set and each other; upstream
  // renames a collision rather than dropping it, so a clash never loses data.
  const seen = new Set(bits.BLOCK_ORDER)
  for (const field of (settings.customFields ?? []) as Array<Record<string, any>>) {
    const base = cleanTag(field.tag) || 'CUSTOM'
    let unique = base
    let counter = 1
    while (seen.has(unique)) unique = `${base}_${counter++}`
    if (field.tag !== unique) field.tag = unique
    seen.add(unique)
  }

  const customTags = ((settings.customFields ?? []) as Array<Record<string, any>>)
    .map(field => cleanTag(field.tag))
  for (const tag of [...bits.BLOCK_ORDER, ...customTags]) {
    if (!settings.blockOrder.includes(tag)) settings.blockOrder.push(tag)
  }

  const valid = new Set(customTags)
  settings.blockOrder = settings.blockOrder.filter((tag: string) => {
    if (bits.BLOCK_ORDER.includes(tag)) {
      // Quests is owned by the narrator ruleset toggle, not by this list.
      return !(tag === 'QUESTS' && settings.syspromptModules?.quests === false)
    }
    return valid.has(tag)
  })
  return settings.blockOrder
}

function isEnabled(settings: Record<string, any>, tag: string, bits: EngineBits): boolean {
  if (bits.BLOCK_ORDER.includes(tag)) return settings.modules?.[tag.toLowerCase()] ?? false
  const field = (settings.customFields ?? []).find(
    (candidate: Record<string, any>) => cleanTag(candidate.tag) === tag,
  )
  return field?.enabled ?? false
}

/**
 * The instruction a built-in module gives the tracker.
 *
 * `settings.stockPrompts` is keyed by the lowercased tag, and
 * `buildModulesInstructionText()` reads it in preference to the shipped
 * defaults — so this is genuinely what the model is told, not a copy of it.
 */
function stockPromptFields(
  settings: Record<string, any>,
  tag: string,
  bits: EngineBits,
): { stockPrompt: string; stockIsDefault: boolean } {
  const key = tag.toLowerCase()
  const shipped = String(bits.DEFAULT_STOCK_PROMPTS[key] ?? '')
  const live = String(settings.stockPrompts?.[key] ?? shipped)
  return { stockPrompt: live, stockIsDefault: live === shipped }
}

/**
 * Rewrite what a built-in module asks the tracker for.
 *
 * **The quests prompt is derived, not authored.** `refreshQuestPrompt()`
 * regenerates it from the shipped text whenever the deadline or frustration
 * toggles change, so an edit there survives only until the next toggle. That is
 * upstream's design; the editor says so rather than pretending otherwise.
 */
export async function saveStockPrompt(
  tag: string,
  text: string,
): Promise<{ ok: boolean; reason?: string; view?: BlocksView }> {
  const bits = await engine()
  const settings = bits.getSettings()
  const clean = cleanTag(tag)
  if (!bits.BLOCK_ORDER.includes(clean)) {
    return { ok: false, reason: `${clean || 'that module'} is not a built-in module` }
  }
  const body = String(text ?? '').trim()
  // An empty instruction would drop the module from the tracker's prompt while
  // leaving its card switched on — switching it off is the way to do that.
  if (!body) return { ok: false, reason: 'an empty instruction would silently disable the module' }

  if (!settings.stockPrompts || typeof settings.stockPrompts !== 'object') {
    settings.stockPrompts = {}
  }
  settings.stockPrompts[clean.toLowerCase()] = body
  return { ok: true, view: await commit(bits) }
}

/** Put back the shipped instruction for one built-in module. */
export async function resetStockPrompt(
  tag: string,
): Promise<{ ok: boolean; reason?: string; view?: BlocksView }> {
  const bits = await engine()
  const settings = bits.getSettings()
  const clean = cleanTag(tag)
  const key = clean.toLowerCase()
  const shipped = bits.DEFAULT_STOCK_PROMPTS[key]
  if (shipped === undefined) {
    return { ok: false, reason: `${clean || 'that module'} has no shipped instruction` }
  }
  if (!settings.stockPrompts || typeof settings.stockPrompts !== 'object') {
    settings.stockPrompts = {}
  }
  settings.stockPrompts[key] = shipped
  return { ok: true, view: await commit(bits) }
}

/** Every tracker card, in the order the panel draws them. */
export async function readBlocks(): Promise<BlocksView> {
  const bits = await engine()
  const settings = bits.getSettings()
  const order = normalizeOrder(settings, bits)

  const customByTag = new Map<string, Record<string, any>>(
    ((settings.customFields ?? []) as Array<Record<string, any>>)
      .map(field => [cleanTag(field.tag), field]),
  )

  const blocks: TrackerBlock[] = order.map(tag => {
    const custom = customByTag.get(tag)
    return {
      tag,
      icon: String(custom?.icon || bits.BLOCK_ICONS[tag] || '📄'),
      label: String(custom?.label || tag),
      enabled: isEnabled(settings, tag, bits),
      kind: !custom ? 'stock' : (custom.origin === 'wizard' ? 'wizard' : 'custom'),
      pageSize: Number(settings.modulePageSizes?.[tag] ?? bits.PAGE_SIZE),
      ...(custom
        ? { prompt: String(custom.prompt ?? ''), template: String(custom.template ?? '') }
        : stockPromptFields(settings, tag, bits)),
    }
  })

  return { blocks }
}

async function commit(bits: EngineBits): Promise<BlocksView> {
  normalizeOrder(bits.getSettings(), bits)
  await saveSettings()
  return readBlocks()
}

/** Move a card one position earlier or later in the panel. */
export async function moveBlock(
  tag: string,
  direction: 'up' | 'down',
): Promise<{ ok: boolean; reason?: string; view?: BlocksView }> {
  const bits = await engine()
  const settings = bits.getSettings()
  const order = normalizeOrder(settings, bits)

  const clean = cleanTag(tag)
  const index = order.indexOf(clean)
  if (index < 0) return { ok: false, reason: `${clean || 'that module'} is not in the order` }

  const target = direction === 'up' ? index - 1 : index + 1
  // The ends are a no-op, not an error: the buttons are disabled there anyway.
  if (target < 0 || target >= order.length) return { ok: true, view: await commit(bits) }

  order.splice(target, 0, order.splice(index, 1)[0])
  settings.blockOrder = order
  return { ok: true, view: await commit(bits) }
}

/**
 * Switch a card on or off.
 *
 * Not cosmetic: `buildModulesInstructionText()` builds the tracker's
 * instruction from the enabled set, so switching one off also stops the model
 * being asked to track it. That is upstream's behaviour and the right one — a
 * card you are not looking at is not worth paying for on every turn.
 */
export async function setBlockEnabled(
  tag: string,
  enabled: boolean,
): Promise<{ ok: boolean; reason?: string; view?: BlocksView }> {
  const bits = await engine()
  const settings = bits.getSettings()
  const clean = cleanTag(tag)

  if (bits.BLOCK_ORDER.includes(clean)) {
    if (!settings.modules || typeof settings.modules !== 'object') settings.modules = {}
    settings.modules[clean.toLowerCase()] = !!enabled
    return { ok: true, view: await commit(bits) }
  }

  const field = (settings.customFields ?? []).find(
    (candidate: Record<string, any>) => cleanTag(candidate.tag) === clean,
  )
  if (!field) return { ok: false, reason: 'that module is gone' }
  field.enabled = !!enabled
  return { ok: true, view: await commit(bits) }
}

/**
 * Follow a tag rename through everything that keys off it.
 *
 * Upstream's order, kept: catalog prune, Game System back-references,
 * tombstones, block order, Display Group members, page sizes, render options.
 */
function renameCascade(
  settings: Record<string, any>,
  oldTag: string,
  newTag: string,
  bits: EngineBits,
): void {
  if (oldTag === newTag) return

  bits.removeChatSetupCatalogEntries(settings, { customFieldTags: [oldTag] })

  for (const system of (settings.gameSystems ?? []) as Array<Record<string, any>>) {
    if (cleanTag(system.customFieldTag) === oldTag) system.customFieldTag = newTag
  }

  bits.recordDeletedCustomTags(oldTag)
  bits.clearDeletedCustomTagTombstones(newTag)

  if (Array.isArray(settings.blockOrder)) {
    const index = settings.blockOrder.indexOf(oldTag)
    if (index !== -1) settings.blockOrder[index] = newTag
  }

  // Display Groups are render metadata keyed by tag: a rename updates the
  // reference without changing what the group does.
  for (const group of (settings.displayGroups ?? []) as Array<Record<string, any>>) {
    if (!Array.isArray(group.members)) continue
    group.members = group.members.map((member: string) =>
      cleanTag(member) === oldTag ? newTag : member)
  }

  if (settings.modulePageSizes?.[oldTag] !== undefined) {
    settings.modulePageSizes[newTag] = settings.modulePageSizes[oldTag]
    delete settings.modulePageSizes[oldTag]
  }
  if (settings.categoryRenderOptions?.[oldTag] !== undefined) {
    settings.categoryRenderOptions[newTag] = settings.categoryRenderOptions[oldTag]
    delete settings.categoryRenderOptions[oldTag]
  }
}

export interface CustomModuleDraft {
  /** Blank to create; otherwise the tag as it stands now. */
  originalTag?: string
  tag: string
  icon?: string
  label?: string
  prompt?: string
  template?: string
  pageSize?: number
}

/**
 * Create or update a custom module.
 *
 * The wizard writes these too, so this is the path for adjusting one after the
 * fact — changing what it tracks, what it is called, how many rows it shows —
 * which is the thing that was impossible.
 */
export async function saveCustomModule(
  draft: CustomModuleDraft,
): Promise<{ ok: boolean; reason?: string; view?: BlocksView }> {
  const bits = await engine()
  const settings = bits.getSettings()

  const tag = cleanTag(draft?.tag)
  if (!tag) return { ok: false, reason: 'a module needs a tag' }
  if (bits.BLOCK_ORDER.includes(tag)) {
    return { ok: false, reason: `${tag} is a built-in module; pick another tag` }
  }

  if (!Array.isArray(settings.customFields)) settings.customFields = []
  const fields = settings.customFields as Array<Record<string, any>>

  const originalTag = cleanTag(draft?.originalTag)
  const index = originalTag
    ? fields.findIndex(field => cleanTag(field.tag) === originalTag)
    : -1
  if (originalTag && index < 0) {
    return { ok: false, reason: 'that module is no longer in settings — reopen the editor' }
  }

  const clash = fields.some((field, position) =>
    position !== index && cleanTag(field.tag) === tag)
  if (clash) return { ok: false, reason: `a module tagged ${tag} already exists` }

  const label = String(draft.label ?? '').trim() || tag
  const icon = String(draft.icon ?? '').trim() || '📄'

  if (index < 0) {
    fields.push({
      tag,
      icon,
      label,
      prompt: String(draft.prompt ?? ''),
      template: String(draft.template ?? ''),
      // New modules start on, because a module you just wrote and cannot see
      // reads as the editor having failed.
      enabled: true,
      origin: 'custom',
    })
  } else {
    const field = fields[index]
    const previous = cleanTag(field.tag)
    field.icon = icon
    field.tag = tag
    field.label = label
    field.prompt = String(draft.prompt ?? '')
    field.template = String(draft.template ?? '')
    renameCascade(settings, previous, tag, bits)
  }

  const pageSize = Number(draft.pageSize)
  if (Number.isFinite(pageSize) && pageSize >= 1) {
    if (!settings.modulePageSizes || typeof settings.modulePageSizes !== 'object') {
      settings.modulePageSizes = {}
    }
    settings.modulePageSizes[tag] = Math.floor(pageSize)
  }

  return { ok: true, view: await commit(bits) }
}

/**
 * Remove a custom module.
 *
 * The tombstone matters: without it a stale copy in a chat's saved state can
 * reappear on the next load, and a module you deleted coming back is worse than
 * one you could not delete.
 */
export async function deleteCustomModule(
  tag: string,
): Promise<{ ok: boolean; reason?: string; view?: BlocksView }> {
  const bits = await engine()
  const settings = bits.getSettings()
  const clean = cleanTag(tag)

  if (bits.BLOCK_ORDER.includes(clean)) {
    return { ok: false, reason: `${clean} is built in — switch it off instead` }
  }

  const fields = (settings.customFields ?? []) as Array<Record<string, any>>
  const index = fields.findIndex(field => cleanTag(field.tag) === clean)
  if (index < 0) return { ok: false, reason: 'that module is already gone' }

  fields.splice(index, 1)
  bits.removeChatSetupCatalogEntries(settings, { customFieldTags: [clean] })
  bits.recordDeletedCustomTags(clean)

  // Leave no dangling references behind, the same set the rename walks.
  for (const group of (settings.displayGroups ?? []) as Array<Record<string, any>>) {
    if (!Array.isArray(group.members)) continue
    group.members = group.members.filter((member: string) => cleanTag(member) !== clean)
  }
  settings.displayGroups = bits.normalizeDisplayGroups(settings.displayGroups)
  delete settings.modulePageSizes?.[clean]
  delete settings.categoryRenderOptions?.[clean]

  return { ok: true, view: await commit(bits) }
}
