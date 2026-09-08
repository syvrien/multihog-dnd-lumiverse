/**
 * display-groups.ts — folding tracker blocks together in the panel.
 *
 * A long campaign renders a lot of cards: character, inventory, party, quests,
 * relationships, plus every Game System the wizard has added. Display Groups let
 * you collapse a run of them into one — "Survival" holding hunger, thirst and
 * temperature — without touching what the narrator is told. Upstream is explicit
 * that they "never alter memo blocks, prompts, module activation, or Game System
 * ownership": this is presentation, nothing more.
 *
 * The port already honours them. `renderer.js` calls
 * `buildDisplayGroupRenderPlan()` on every repaint and has since the panel
 * landed, so a group in settings has always been drawn — there was simply no way
 * to make one. This module is the missing editor, over the ported model.
 *
 * `normalizeDisplayGroups()` is the authority on what a valid set looks like,
 * and it is deliberately the *only* writer here: it caps the counts, drops
 * excluded tags, and resolves a module claimed by two groups to the first one.
 * Re-normalising after every change means the stored shape can never drift from
 * what the renderer expects.
 */

import { saveSettings } from '../compat/settings-store'

interface EngineBits {
  getSettings: () => Record<string, any>
  normalizeDisplayGroups: (input: unknown) => Array<Record<string, any>>
  normalizeDisplayGroupTag: (value: unknown) => string
  DISPLAY_GROUP_EXCLUDED_TAGS: Set<string>
  BLOCK_ORDER: string[]
  BLOCK_ICONS: Record<string, string>
}

let cached: EngineBits | null = null

async function engine(): Promise<EngineBits> {
  if (cached) return cached
  const [stateManager, groups, constants] = await Promise.all([
    import('../engine/state-manager.js'),
    import('../engine/src/features/display-groups.js'),
    import('../engine/constants.js'),
  ]) as any[]

  cached = {
    getSettings: stateManager.getSettings,
    normalizeDisplayGroups: groups.normalizeDisplayGroups,
    normalizeDisplayGroupTag: groups.normalizeDisplayGroupTag,
    DISPLAY_GROUP_EXCLUDED_TAGS: groups.DISPLAY_GROUP_EXCLUDED_TAGS,
    BLOCK_ORDER: constants.BLOCK_ORDER,
    BLOCK_ICONS: constants.BLOCK_ICONS,
  }
  return cached
}

export interface DisplayModule {
  tag: string
  icon: string
  label: string
  /** `Stock`, `Custom` or `Wizard` — where the module came from. */
  kind: string
  /** The group holding it, if any. A module belongs to at most one. */
  groupId: string | null
}

export interface DisplayGroup {
  id: string
  name: string
  icon: string
  enabled: boolean
  members: string[]
}

export interface DisplayGroupsView {
  enabled: boolean
  /** Draw a placeholder where a grouped module has no data yet. */
  showGaps: boolean
  groups: DisplayGroup[]
  modules: DisplayModule[]
}

function newGroupId(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Everything groupable, and where it currently sits.
 *
 * Combat, benched party and quests are excluded by the engine — they render
 * with their own layout rather than as a plain card, so folding them into a
 * group would produce a card that cannot draw itself.
 */
export async function readDisplayGroups(): Promise<DisplayGroupsView> {
  const bits = await engine()
  const settings = bits.getSettings()
  settings.displayGroups = bits.normalizeDisplayGroups(settings.displayGroups)

  const owner = new Map<string, string>()
  for (const group of settings.displayGroups) {
    for (const tag of group.members) owner.set(String(tag), String(group.id))
  }

  const modules: DisplayModule[] = []
  const seen = new Set<string>()

  for (const tag of bits.BLOCK_ORDER) {
    if (bits.DISPLAY_GROUP_EXCLUDED_TAGS.has(tag) || seen.has(tag)) continue
    seen.add(tag)
    modules.push({
      tag,
      icon: bits.BLOCK_ICONS[tag] || '📄',
      label: tag,
      kind: 'Stock',
      groupId: owner.get(tag) ?? null,
    })
  }

  for (const field of (settings.customFields ?? []) as Array<Record<string, any>>) {
    const tag = String(field?.tag ?? '').toUpperCase()
    if (!tag || bits.DISPLAY_GROUP_EXCLUDED_TAGS.has(tag) || seen.has(tag)) continue
    seen.add(tag)
    modules.push({
      tag,
      icon: String(field?.icon || '📄'),
      label: String(field?.label || field?.tag || 'Custom module'),
      kind: field?.origin === 'wizard' ? 'Wizard' : 'Custom',
      groupId: owner.get(tag) ?? null,
    })
  }

  return {
    enabled: settings.displayGroupsEnabled === true,
    showGaps: settings.displayGroupsShowGaps === true,
    groups: settings.displayGroups.map((group: Record<string, any>) => ({
      id: String(group.id),
      name: String(group.name),
      icon: String(group.icon),
      enabled: group.enabled !== false,
      members: [...group.members].map(String),
    })),
    modules,
  }
}

/** Normalise, persist, and hand back the view the editor should now show. */
async function commit(bits: EngineBits): Promise<DisplayGroupsView> {
  const settings = bits.getSettings()
  settings.displayGroups = bits.normalizeDisplayGroups(settings.displayGroups)
  await saveSettings()
  return readDisplayGroups()
}

export async function setDisplayGroupsEnabled(enabled: boolean): Promise<DisplayGroupsView> {
  const bits = await engine()
  bits.getSettings().displayGroupsEnabled = !!enabled
  return commit(bits)
}

export async function setDisplayGroupsShowGaps(showGaps: boolean): Promise<DisplayGroupsView> {
  const bits = await engine()
  bits.getSettings().displayGroupsShowGaps = !!showGaps
  return commit(bits)
}

/**
 * Add a group.
 *
 * It starts with one member because `normalizeDisplayGroups` drops any group
 * with none — creating an empty one and asking the user to fill it would delete
 * it out from under them on the next save.
 */
export async function addDisplayGroup(
  name: string,
  firstMember: string,
  icon = '🗂️',
): Promise<{ ok: boolean; reason?: string; view?: DisplayGroupsView }> {
  const bits = await engine()
  const settings = bits.getSettings()
  const trimmed = String(name ?? '').trim()
  if (!trimmed) return { ok: false, reason: 'give the group a name' }

  const tag = bits.normalizeDisplayGroupTag(firstMember)
  if (!tag) return { ok: false, reason: 'pick a module to start it with' }
  if (bits.DISPLAY_GROUP_EXCLUDED_TAGS.has(tag)) {
    return { ok: false, reason: `${tag} draws its own layout and cannot be grouped` }
  }

  settings.displayGroups = bits.normalizeDisplayGroups(settings.displayGroups)
  // A module belongs to one group. Taking it out of its old one here is what
  // makes the move visible; leaving it would let normalize silently drop it.
  for (const group of settings.displayGroups) {
    group.members = group.members.filter((member: string) => member !== tag)
  }
  settings.displayGroups = settings.displayGroups.filter(
    (group: Record<string, any>) => group.members.length,
  )
  settings.displayGroups.push({
    id: newGroupId(),
    name: trimmed.slice(0, 80),
    icon: String(icon || '🗂️').slice(0, 16),
    enabled: true,
    members: [tag],
  })

  return { ok: true, view: await commit(bits) }
}

export async function renameDisplayGroup(
  id: string,
  name: string,
  icon?: string,
): Promise<{ ok: boolean; reason?: string; view?: DisplayGroupsView }> {
  const bits = await engine()
  const settings = bits.getSettings()
  const group = (settings.displayGroups ?? []).find(
    (candidate: Record<string, any>) => String(candidate.id) === id,
  )
  if (!group) return { ok: false, reason: 'that group is gone' }

  const trimmed = String(name ?? '').trim()
  if (!trimmed) return { ok: false, reason: 'a group needs a name' }
  group.name = trimmed.slice(0, 80)
  if (icon !== undefined) group.icon = String(icon || '🗂️').slice(0, 16)

  return { ok: true, view: await commit(bits) }
}

export async function setDisplayGroupEnabled(
  id: string,
  enabled: boolean,
): Promise<DisplayGroupsView> {
  const bits = await engine()
  const group = (bits.getSettings().displayGroups ?? []).find(
    (candidate: Record<string, any>) => String(candidate.id) === id,
  )
  if (group) group.enabled = !!enabled
  return commit(bits)
}

/** Remove a group. Its modules go back to rendering as their own cards. */
export async function deleteDisplayGroup(id: string): Promise<DisplayGroupsView> {
  const bits = await engine()
  const settings = bits.getSettings()
  settings.displayGroups = (settings.displayGroups ?? []).filter(
    (group: Record<string, any>) => String(group.id) !== id,
  )
  return commit(bits)
}

/**
 * Move a member up or down inside its group.
 *
 * The order is not cosmetic bookkeeping: `buildDisplayGroupRenderPlan` uses it
 * to lay the cards out inside the folded group, and the engine says so in as
 * many words — *"Membership order is deliberately user-configurable in the
 * Display Group editor. Respect it here instead of falling back to the raw
 * module order."* Assigning modules one at a time appends them, so without this
 * a group's internal order is whatever sequence you happened to add them in.
 */
export async function moveDisplayMember(
  groupId: string,
  tag: string,
  direction: 'up' | 'down',
): Promise<{ ok: boolean; reason?: string; view?: DisplayGroupsView }> {
  const bits = await engine()
  const settings = bits.getSettings()
  const group = (settings.displayGroups ?? []).find(
    (candidate: Record<string, any>) => String(candidate.id) === groupId,
  )
  if (!group) return { ok: false, reason: 'that group is gone' }

  const clean = bits.normalizeDisplayGroupTag(tag)
  const members: string[] = group.members.map(String)
  const index = members.indexOf(clean)
  if (index < 0) return { ok: false, reason: `${clean || 'that module'} is not in this group` }

  const target = direction === 'up' ? index - 1 : index + 1
  // Silently succeed at the ends rather than erroring: the button is disabled
  // there anyway, and a "cannot move further" toast for a no-op is noise.
  if (target < 0 || target >= members.length) return { ok: true, view: await commit(bits) }

  members.splice(target, 0, members.splice(index, 1)[0])
  group.members = members
  return { ok: true, view: await commit(bits) }
}

/**
 * Put a module in a group, or take it out with `groupId: null`.
 *
 * Removing the last member deletes the group, because a group with no members
 * is not something `normalizeDisplayGroups` will keep — better to say so by
 * doing it than to leave a row that vanishes on reload.
 */
export async function assignDisplayModule(
  tag: string,
  groupId: string | null,
): Promise<{ ok: boolean; reason?: string; view?: DisplayGroupsView }> {
  const bits = await engine()
  const settings = bits.getSettings()
  const clean = bits.normalizeDisplayGroupTag(tag)
  if (!clean) return { ok: false, reason: 'unknown module' }
  if (bits.DISPLAY_GROUP_EXCLUDED_TAGS.has(clean)) {
    return { ok: false, reason: `${clean} draws its own layout and cannot be grouped` }
  }

  settings.displayGroups = bits.normalizeDisplayGroups(settings.displayGroups)
  for (const group of settings.displayGroups) {
    group.members = group.members.filter((member: string) => member !== clean)
  }

  if (groupId) {
    const target = settings.displayGroups.find(
      (group: Record<string, any>) => String(group.id) === groupId,
    )
    if (!target) return { ok: false, reason: 'that group is gone' }
    target.members.push(clean)
  }

  settings.displayGroups = settings.displayGroups.filter(
    (group: Record<string, any>) => group.members.length,
  )
  return { ok: true, view: await commit(bits) }
}
