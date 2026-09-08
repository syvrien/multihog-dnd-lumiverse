/**
 * sections.ts — what an NPC or PC card is made of.
 *
 * `npcCoreSections` and `pcCoreSections` are the schema the Lorebook Agent
 * writes character cards against: Species, Body, Worn Equipment, Personality,
 * Brief Background, and so on. Each carries a `description` that is not a label
 * — it is the instruction the model follows, and several of them are a
 * paragraph long, arguing about what belongs in that section and what does not.
 *
 * They reach the model through `buildNpcInstruction()` and `generatePersonaBio()`,
 * both of which the port already calls, so the schema has always been live. It
 * was simply not editable: the prompt-defaults dialog can reset these to the
 * shipped set, and that was the only way to change them at all.
 *
 * Editing them is how you make cards fit a setting the shipped schema does not —
 * a Cyberpunk campaign wanting `Augmentations`, a courtly one wanting `Titles
 * and Obligations` — without waiting for the wizard to invent something close.
 */

import { saveSettings } from '../compat/settings-store'

/** Which card schema. Both have the same shape and different defaults. */
export type SectionTarget = 'npc' | 'pc'

export interface CardSection {
  id: string
  name: string
  /** The instruction the model follows for this section. Often a paragraph. */
  description: string
  icon: string
  color: string
}

export interface SectionsView {
  target: SectionTarget
  sections: CardSection[]
  /** True when this matches the shipped schema, so "reset" can be hidden. */
  isDefault: boolean
}

interface EngineBits {
  getSettings: () => Record<string, any>
  DEFAULT_NPC_SECTIONS: CardSection[]
  DEFAULT_PC_SECTIONS: CardSection[]
  buildNpcInstruction: (
    major: unknown,
    minor: unknown,
    flag: boolean,
    settings: unknown,
  ) => string
}

let cached: EngineBits | null = null

async function engine(): Promise<EngineBits> {
  if (cached) return cached
  const stateManager = await import('../engine/state-manager.js') as any
  cached = {
    getSettings: stateManager.getSettings,
    DEFAULT_NPC_SECTIONS: stateManager.DEFAULT_NPC_SECTIONS,
    DEFAULT_PC_SECTIONS: stateManager.DEFAULT_PC_SECTIONS,
    buildNpcInstruction: stateManager.buildNpcInstruction,
  }
  return cached
}

const keyFor = (target: SectionTarget): string =>
  target === 'npc' ? 'npcCoreSections' : 'pcCoreSections'

const defaultsFor = (target: SectionTarget, bits: EngineBits): CardSection[] =>
  target === 'npc' ? bits.DEFAULT_NPC_SECTIONS : bits.DEFAULT_PC_SECTIONS

function newSectionId(): string {
  return `sec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
}

function liveSections(
  settings: Record<string, any>,
  target: SectionTarget,
  bits: EngineBits,
): CardSection[] {
  const key = keyFor(target)
  const stored = settings[key]
  if (!Array.isArray(stored) || !stored.length) {
    settings[key] = JSON.parse(JSON.stringify(defaultsFor(target, bits)))
  }
  return settings[key] as CardSection[]
}

/**
 * Rebuild the agent's NPC instruction from the sections.
 *
 * The NPC record type's `instruction` is generated from this schema, so editing
 * a section without rebuilding leaves the agent still writing cards to the old
 * shape — the settings would say one thing and the prompt another.
 */
function rebuildNpcInstruction(settings: Record<string, any>, bits: EngineBits): void {
  const module = settings.routerModules?.npc
  if (!module) return
  try {
    module.instruction = bits.buildNpcInstruction(
      settings.npcMajorWords, settings.npcMinorWords, false, settings,
    )
  } catch (error) {
    spindle.log.warn(`[DnD] NPC instruction rebuild failed: ${(error as Error).message}`)
  }
}

async function commit(
  settings: Record<string, any>,
  target: SectionTarget,
  bits: EngineBits,
): Promise<SectionsView> {
  if (target === 'npc') rebuildNpcInstruction(settings, bits)
  await saveSettings()
  return readSections(target)
}

export async function readSections(target: SectionTarget): Promise<SectionsView> {
  const bits = await engine()
  const settings = bits.getSettings()
  const sections = liveSections(settings, target, bits)
  const shipped = defaultsFor(target, bits)

  return {
    target,
    sections: sections.map(section => ({
      id: String(section.id),
      name: String(section.name),
      description: String(section.description ?? ''),
      icon: String(section.icon ?? '📄'),
      color: String(section.color ?? ''),
    })),
    isDefault: JSON.stringify(sections) === JSON.stringify(shipped),
  }
}

export async function addSection(
  target: SectionTarget,
  name: string,
): Promise<{ ok: boolean; reason?: string; view?: SectionsView }> {
  const bits = await engine()
  const settings = bits.getSettings()
  const trimmed = String(name ?? '').trim()
  if (!trimmed) return { ok: false, reason: 'a section needs a name' }

  const sections = liveSections(settings, target, bits)
  // Names are how the model addresses a section and how `card-synopsis` finds
  // one, so two with the same name is a section that cannot be written to.
  if (sections.some(section => section.name.toLowerCase() === trimmed.toLowerCase())) {
    return { ok: false, reason: `there is already a "${trimmed}" section` }
  }

  sections.push({
    id: newSectionId(),
    name: trimmed.slice(0, 60),
    description: '',
    icon: '📄',
    color: '#8b5cf6',
  })
  return { ok: true, view: await commit(settings, target, bits) }
}

export async function updateSection(
  target: SectionTarget,
  id: string,
  patch: { name?: string; description?: string; icon?: string; color?: string },
): Promise<{ ok: boolean; reason?: string; view?: SectionsView }> {
  const bits = await engine()
  const settings = bits.getSettings()
  const sections = liveSections(settings, target, bits)
  const section = sections.find(candidate => String(candidate.id) === id)
  if (!section) return { ok: false, reason: 'that section is gone' }

  if (patch.name !== undefined) {
    const trimmed = String(patch.name).trim()
    if (!trimmed) return { ok: false, reason: 'a section needs a name' }
    const clash = sections.some(other =>
      other !== section && other.name.toLowerCase() === trimmed.toLowerCase())
    if (clash) return { ok: false, reason: `there is already a "${trimmed}" section` }
    section.name = trimmed.slice(0, 60)
  }
  if (patch.description !== undefined) section.description = String(patch.description)
  if (patch.icon !== undefined) section.icon = String(patch.icon).trim().slice(0, 8) || '📄'
  if (patch.color !== undefined) section.color = String(patch.color)

  return { ok: true, view: await commit(settings, target, bits) }
}

export async function moveSection(
  target: SectionTarget,
  id: string,
  direction: 'up' | 'down',
): Promise<{ ok: boolean; reason?: string; view?: SectionsView }> {
  const bits = await engine()
  const settings = bits.getSettings()
  const sections = liveSections(settings, target, bits)
  const index = sections.findIndex(section => String(section.id) === id)
  if (index < 0) return { ok: false, reason: 'that section is gone' }

  const to = direction === 'up' ? index - 1 : index + 1
  if (to < 0 || to >= sections.length) return { ok: true, view: await readSections(target) }

  sections.splice(to, 0, sections.splice(index, 1)[0])
  return { ok: true, view: await commit(settings, target, bits) }
}

export async function deleteSection(
  target: SectionTarget,
  id: string,
): Promise<{ ok: boolean; reason?: string; view?: SectionsView }> {
  const bits = await engine()
  const settings = bits.getSettings()
  const sections = liveSections(settings, target, bits)
  const index = sections.findIndex(section => String(section.id) === id)
  if (index < 0) return { ok: false, reason: 'that section is gone' }
  // An empty schema would have the agent writing cards with nothing in them.
  if (sections.length <= 1) return { ok: false, reason: 'a card needs at least one section' }

  sections.splice(index, 1)
  return { ok: true, view: await commit(settings, target, bits) }
}

/** Put back the shipped schema. */
export async function resetSections(target: SectionTarget): Promise<SectionsView> {
  const bits = await engine()
  const settings = bits.getSettings()
  settings[keyFor(target)] = JSON.parse(JSON.stringify(defaultsFor(target, bits)))
  return commit(settings, target, bits)
}
