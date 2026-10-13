/**
 * protocol.ts — the backend <-> frontend message contract.
 *
 * In SillyTavern the engine and the UI were the same browser module and called
 * each other synchronously. Spindle splits them, so every crossing is a message
 * on this channel. Keeping the contract in one file shared by both entries is
 * what stops the two halves drifting.
 */

export const CHANNEL = 'multihog_dnd'

/** Backend -> frontend. */
export type ToFrontend =
  | {
      type: 'panel:render'
      html: string
      memoPresent: boolean
      /**
       * Which conversation this markup belongs to.
       *
       * The panel animations compare the numbers on screen with the ones
       * arriving. That is only meaningful within one chat — sliding a bar from
       * another campaign's value is worse than not animating at all.
       */
      chatId?: string | null
    }
  | { type: 'panel:status'; running: boolean; label?: string }
  /**
   * Outcome of the last tracker pass, surfaced in the panel.
   *
   * Without this a pass that declines to run ("empty chat", "tracker disabled",
   * a failed model call) is indistinguishable from one that ran and found
   * nothing: the panel just keeps saying "No campaign state yet". The reason
   * only existed in the server log, which most users never see.
   */
  | { type: 'panel:result'; ran: boolean; changed: boolean; reason?: string; at: number }
  /** Quick Start's running commentary — three model calls take a while. */
  | { type: 'quickstart:step'; label: string }
  | { type: 'quickstart:done'; ok: boolean; name?: string; detail?: string; reason?: string }
  | { type: 'quickstart:name'; name: string }
  | {
      type: 'settings:sync'
      settings: Record<string, unknown>
      /** The user's connection profiles, for the state-model picker. */
      connections: Array<{ id: string; name: string }>
    }
  | { type: 'popup:open'; requestId: string; popupType: number; content: string; inputValue?: string; options?: Record<string, unknown> }
  | { type: 'toast'; level: 'success' | 'warning' | 'error' | 'info'; message: string }
  | { type: 'worldinfo:changed' }
  /**
   * The current memo text, for the raw editor, plus the earlier versions the
   * engine keeps in `settings.memoHistory` so a bad pass can be undone.
   */
  | {
      type: 'memo:content'
      text: string
      history: Array<{ label: string; text: string }>
    }
  /** A generated Player Card, for review before it is stored. */
  | { type: 'pc:preview'; ok: boolean; name: string; bio: string; wordCount: number; reason?: string }
  /** Archetype choices for the roll picker. */
  | {
      type: 'roll:options'
      genre: string
      genres: string[]
      archetypes: string[]
      personas: Array<{ id: string; name: string; hasImage: boolean }>
    }
  /**
   * A rolled character sheet, for review before it replaces the current one.
   *
   * The sheet is carried here rather than held only on the backend because the
   * review box is editable and what the user leaves in it is what gets stored.
   */
  | {
      type: 'roll:draft'
      ok: boolean
      name?: string
      memo?: string
      /** A persona avatar, shown in the review so the portrait is no surprise. */
      portraitUrl?: string
      reason?: string
    }
  /**
   * The Adventure Companion conversation, repainted whole.
   *
   * The transcript lives in the engine's per-chat prefs, so the backend owns it
   * and the panel is a view — sending diffs would mean two copies of the same
   * history disagreeing after a chat switch.
   */
  | {
      type: 'companion:state'
      history: Array<{ role: 'user' | 'assistant'; content: string }>
      prefs: {
        tutorialMode: boolean
        injectLore: boolean
        injectMemo: boolean
        injectMap: boolean
        lookback: number
        lookbackAll: boolean
      }
      busy: boolean
    }
  /**
   * The Lorebook Agent's Modular Repertoire — the record types it may write and
   * the rules it follows for each.
   */
  | {
      type: 'modules:state'
      modules: Array<{
        id: string
        tag: string
        enabled: boolean
        format: string
        instruction: string
        /** False once edited, so the panel can offer to restore the default. */
        isDefault: boolean
      }>
    }
  /** The panel palette in force, and the saved ones. */
  | {
      type: 'theme:state'
      active: Record<string, string> | null
      saved: string[]
      canUndo: boolean
    }
  /** A generated palette, for review before it is applied. */
  | {
      type: 'theme:draft'
      ok: boolean
      reason?: string
      vars?: Record<string, string>
    }
  /** Whether portraits can be generated, and who could have one. */
  | {
      type: 'portrait:gen-state'
      available: boolean
      reason?: string
      targets: string[]
    }
  /** A portrait prompt, or the result of drawing one. */
  | {
      type: 'portrait:gen-result'
      ok: boolean
      reason?: string
      entity: string
      prompt?: string
      url?: string
      /** True when only the prompt was written, not the image. */
      promptOnly: boolean
    }
  /** Saved configurations, and what the current one contains. */
  | {
      type: 'cartridge:state'
      cartridges: Array<{
        id: string
        name: string
        description: string
        icon: string
        updatedAt: number
      }>
      /** Groups of the *current* configuration, flagged where non-stock. */
      current: Array<{ id: string; label: string; description: string; changed: boolean }>
    }
  /** What one cartridge holds, for choosing what to take from it. */
  | {
      type: 'cartridge:detail'
      id: string
      ok: boolean
      reason?: string
      groups?: Array<{ id: string; label: string; description: string; changed: boolean }>
    }
  /** A cartridge as shareable JSON. */
  | { type: 'cartridge:exported'; ok: boolean; text?: string; reason?: string }
  /** Outcome of duplicating a campaign's lorebooks. */
  | { type: 'campaign:cloned'; ok: boolean; cloned: number; errors: string[]; reason?: string }
  /** Reusable NPC cards, kept across campaigns. */
  | {
      type: 'npc:library'
      cards: Array<{
        id: string
        name: string
        keys: string[]
        content: string
        notes: string
        portrait: string
        updatedAt: number
        /** Appearance and personality, pulled out of the card's fields. */
        blurb: string
      }>
    }
  /** One card serialised for sharing. */
  | { type: 'npc:exported'; ok: boolean; text?: string; reason?: string }
  /** Where the party is, who is with them, and the art for it. */
  | {
      type: 'scene:view'
      ok: boolean
      reason?: string
      where?: string
      path?: string
      html?: string
      hasArt?: boolean
      /** Whether scene art can be drawn at all. */
      canDraw: boolean
    }
  /** Maps the Architect has built for this campaign. */
  | {
      type: 'maps:list'
      ok: boolean
      reason?: string
      maps: Array<{ id: string; site: string; kind: string; areas: number; visited: number }>
    }
  /** One rendered map: the graph as SVG, plus the readable write-up. */
  | {
      type: 'maps:render'
      id: string
      ok: boolean
      reason?: string
      site?: string
      svg?: string
      detail?: string
    }
  /** A map opened for hand-editing, plus its restore points. */
  | {
      type: 'maps:draft'
      id: string
      ok: boolean
      reason?: string
      site?: string
      text?: string
      history?: Array<{ at: number; note: string }>
      enums?: Record<string, readonly string[]>
    }
  /** The outcome of a save, restore or import — `errors` names the bad fields. */
  | {
      type: 'maps:saved'
      id: string
      ok: boolean
      reason?: string
      errors?: string[]
      history?: Array<{ at: number; note: string }>
    }
  /** A map as a portable package, for the user to copy out. */
  | {
      type: 'maps:export'
      ok: boolean
      reason?: string
      name?: string
      json?: string
    }
  /**
   * An update changed the shipped prompts. Sent once, on the first load after.
   *
   * `badge` per category answers the question that makes this actionable:
   * whether the copy you are running still matches what shipped before, or you
   * have edited it and taking the update would throw that away.
   */
  | {
      type: 'prompts:changed'
      pending: boolean
      reason?: string
      changed: Array<{
        id: string
        label: string
        badge: string
        blocks: Array<{
          label: string
          additions: number
          deletions: number
          truncated: boolean
          lines: Array<{ type: string; text: string }>
        }>
      }>
    }
  | { type: 'prompts:applied'; ok: boolean; reason?: string; applied: string[] }
  /**
   * Display Groups: which tracker cards are folded together in the panel.
   *
   * Presentation only — the renderer has honoured these since the panel landed;
   * until now there was no way to make one.
   */
  | {
      type: 'groups:state'
      enabled: boolean
      showGaps: boolean
      groups: Array<{
        id: string
        name: string
        icon: string
        enabled: boolean
        members: string[]
      }>
      modules: Array<{
        tag: string
        icon: string
        label: string
        kind: string
        groupId: string | null
      }>
      /** Set when the last change was refused. */
      reason?: string
    }
  /**
   * The tracker's cards: order, which are on, and the custom ones.
   *
   * `renderer.js` has read `blockOrder` and `modules` since the panel landed;
   * nothing wrote either, so the order was the shipped default forever and no
   * card could be switched off.
   */
  | {
      type: 'blocks:state'
      blocks: Array<{
        tag: string
        icon: string
        label: string
        enabled: boolean
        kind: 'stock' | 'custom' | 'wizard'
        pageSize: number
        prompt?: string
        template?: string
        stockPrompt?: string
        stockIsDefault?: boolean
      }>
      reason?: string
    }
  /** The schema an NPC or PC card is written against. */
  | {
      type: 'sections:state'
      target: 'npc' | 'pc'
      sections: Array<{
        id: string
        name: string
        description: string
        icon: string
        color: string
      }>
      isDefault: boolean
      reason?: string
    }
  /**
   * Lumiverse's own memory, beside what Multihog would contribute to it.
   *
   * Shown together because the two overlap by design: the Cortex infers a cast
   * from prose while the tracker already knows one, and the useful question is
   * whether the agent is re-deriving something the host already holds.
   */
  | {
      type: 'cortex:state'
      ok: boolean
      reason?: string
      enabled: boolean
      entities: Array<{
        name: string
        type: string
        status: string
        salience: number
        facts: number
      }>
      relations: Array<{ label: string; type: string; sentiment: number }>
      arcs: Array<{ tier: number; summary: string }>
      candidates: Array<{ name: string; type: string; relation?: string }>
    }
  | {
      type: 'cortex:synced'
      ok: boolean
      reason?: string
      entities: number
      relations: number
      skipped: string[]
    }
  /** Recent agent passes and the entries it is currently injecting. */
  | {
      type: 'agent:view'
      ok: boolean
      reason?: string
      running: boolean
      maxActive: number
      log: Array<{
        time: string
        reason: string
        activated: number
        deactivated: number
        recorded: number
        rewritten: number
        deleted: number
      }>
      keys: Array<{ id: string; book: string; label: string; pinned: boolean }>
    }
  /** The result of one terminal instruction. */
  | { type: 'terminal:result'; target: string; ok: boolean; output: string }
  /** The open chat's Loom summary, for the panel's "Story so far". */
  | { type: 'story:state'; chatId: string | null; summary: string }
  /** What the Lorebook Agent has filed for this campaign. */
  | {
      type: 'records:state'
      ok: boolean
      reason?: string
      /** When the Lorebook Agent files next — for the empty state. */
      agent?: { enabled: boolean; runEvery: number; repliesUntilNext: number | null }
      prefix: string
      totalTokens: number
      groups: Array<{
        id: string
        label: string
        count: number
        tokens: number
        active: number
        entries: Array<{
          id: string
          label: string
          preview: string
          keys: string[]
          active: boolean
          pinned: boolean
          tokens: number
          hasMap: boolean
        }>
      }>
      player: { name: string; bio: string; portrait: string } | null
    }
  /** The full text of one record, once opened. */
  | { type: 'records:entry'; id: string; ok: boolean; content?: string; reason?: string }
  /** Ready-made mechanic descriptions for the Game System Wizard. */
  | { type: 'wizard:examples'; examples: Array<{ label: string; text: string }> }
  /**
   * A drafted Game System, for review. Nothing is saved until it is approved —
   * a system adds rules to every prompt and a field to the tracker card.
   */
  | {
      type: 'wizard:draft'
      ok: boolean
      reason?: string
      draft?: {
        name: string
        icon: string
        description: string
        includeGm: boolean
        gmTag: string
        gmContent: string
        includeTracker: boolean
        trackerTag: string
        trackerLabel: string
        trackerIcon: string
        trackerContent: string
        driverTime: boolean
        driverGmAnnotation: boolean
        driverStatedFact: boolean
        effectOwner: 'tracker' | 'gm'
      }
    }
  /** The narrator ruleset's sections, in render order, for the Control Room. */
  | {
      type: 'sysprompt:sections'
      sections: Array<{
        key: string
        tag: string
        label: string
        enabled: boolean
        kind: string
      }>
      systems: Array<{ id: string; name: string; enabled: boolean; description: string }>
      /** Characters of assembled prompt, so the cost is visible. */
      size: number
    }
  /** Choices for the portrait picker on an entity card. */
  | {
      type: 'portrait:options'
      entity: string
      /** What is showing now, so the picker can offer to remove it. */
      current: string
      personas: Array<{ id: string; name: string; url: string }>
    }

/** Frontend -> backend. */
/**
 * Every frontend message also carries `viewChatId`: the chat the sending tab
 * shows, from `ctx.getActiveChat()`. See `followViewedChat` in the backend.
 */
export type ToBackend = (
  | { type: 'panel:ready' }
  | { type: 'chat:viewing' }
  | { type: 'panel:refresh' }
  | { type: 'settings:get' }
  | { type: 'settings:patch'; patch: Record<string, unknown> }
  /** A button in the settings pane, named by its field key. */
  | { type: 'settings:action'; action: string }
  | { type: 'popup:result'; requestId: string; result: unknown }
  | { type: 'tracker:run' }
  /** Rebuild the memo from the whole chat, in chunks. One model call each. */
  | { type: 'tracker:full-audit' }
  | { type: 'tracker:stop' }
  /** Instant Action: roll a character for this genre and start the story. */
  | {
      type: 'quickstart:run'
      genre: string
      name?: string
      instructions?: string
      randomLevel?: boolean
      sendStarter?: boolean
    }
  /** A name from the genre's own pool, for the reroll button. */
  | { type: 'quickstart:roll-name'; genre: string }
  /** Open the raw memo editor. */
  | { type: 'memo:read' }
  /** Commit hand-edited memo text. */
  | { type: 'memo:write'; text: string }
  /** Ask the state model to correct something. */
  | { type: 'tracker:ask'; instruction: string }
  /** Generate a Lorebook Agent Player Card from the CHARACTER sheet. */
  | { type: 'pc:generate' }
  /** Store the approved card as this chat's player character. */
  | { type: 'pc:add'; name: string; bio: string; wordCount: number }
  /** Open the roll picker: asks for the archetypes available in a genre. */
  | { type: 'roll:open'; genre?: string }
  /** Roll a character sheet for review. Nothing is replaced until `roll:commit`. */
  | {
      type: 'roll:go'
      className: string
      /** Free text, when className is the custom sentinel. */
      classOther?: string
      genre: string
      level: number | null
      gearTier: string
      name?: string
      /** Seed from a Lumiverse persona, taking its description and image. */
      personaId?: string
    }
  /**
   * Approve a rolled sheet, replacing the current character.
   *
   * `memo` is what the user left in the review box; the portrait comes from the
   * draft the backend is still holding, so a URL cannot be injected from here.
   */
  | { type: 'roll:commit'; memo: string }
  /** Repaint the companion panel (on open, and after a chat switch). */
  | { type: 'companion:read' }
  /** Say something to the Adventure Companion. */
  | { type: 'companion:ask'; text: string }
  /** Stop a turn that is taking too long. */
  | { type: 'companion:cancel' }
  /** Forget this chat's companion conversation. */
  | { type: 'companion:clear' }
  /** Change what the companion is allowed to see. */
  | {
      type: 'companion:prefs'
      patch: Partial<{
        tutorialMode: boolean
        injectLore: boolean
        injectMemo: boolean
        injectMap: boolean
        lookback: number
        lookbackAll: boolean
      }>
    }
  /** Read the panel palette and the saved ones. */
  | { type: 'theme:read' }
  /** Ask a model for a palette. `refine` works from the current one. */
  | { type: 'theme:generate'; description: string; refine: boolean }
  /** Apply a palette, or `null` for the shipped look. */
  | { type: 'theme:apply'; vars: Record<string, string> | null }
  | { type: 'theme:undo' }
  | { type: 'theme:save'; name: string }
  | { type: 'theme:load'; name: string }
  | { type: 'theme:delete'; name: string }
  /** Read whether portraits can be generated, and for whom. */
  | { type: 'portrait:gen-read' }
  /** Write a portrait prompt without drawing anything. */
  | { type: 'portrait:describe'; entity: string }
  /** Draw one. An empty `prompt` means describe it first. */
  | { type: 'portrait:generate'; entity: string; prompt: string }
  /** Read saved configurations. */
  | { type: 'cartridge:read' }
  /** Look inside one before loading it. */
  | { type: 'cartridge:inspect'; id: string }
  /** Save the current configuration as a new cartridge. */
  | { type: 'cartridge:save'; name: string; description: string; icon: string }
  /** Load some or all of one. An empty `groups` means everything. */
  | { type: 'cartridge:load'; id: string; groups: string[] }
  | { type: 'cartridge:delete'; id: string }
  | { type: 'cartridge:export'; id: string }
  | { type: 'cartridge:import'; text: string }
  /** Duplicate this campaign's lorebooks under a new name. */
  | { type: 'campaign:clone'; prefix: string }
  /** Read the NPC library. */
  | { type: 'npc:read' }
  /** Create or update a card. */
  | { type: 'npc:save'; id?: string; name: string; content: string; notes: string }
  /** Keep an NPC the current campaign already knows. */
  | { type: 'npc:capture'; name: string }
  | { type: 'npc:delete'; id: string }
  | { type: 'npc:export'; id: string }
  | { type: 'npc:import'; text: string }
  /** Put a card into the current game. */
  | { type: 'npc:use'; id: string; as: 'party' | 'pc' }
  /** Read the current scene. */
  | { type: 'scene:read' }
  /** Draw the current location. */
  | { type: 'scene:draw' }
  /** Forget the art for the current location. */
  | { type: 'scene:clear' }
  /** List the maps built for this campaign. */
  | { type: 'maps:list' }
  /** Render one. `revealAll` drops the player-facing filter. */
  | { type: 'maps:render'; id: string; revealAll: boolean }
  /** Open a map for editing. Snapshots what is stored first. */
  | { type: 'maps:edit'; id: string }
  /** Validate and store edited map JSON. */
  | { type: 'maps:save'; id: string; text: string }
  /** Put back a restore point by its index in the list. */
  | { type: 'maps:restore'; id: string; index: number }
  | { type: 'maps:export'; id: string }
  | { type: 'maps:import'; id: string; json: string }
  /** Ask whether the shipped prompts changed since this install last looked. */
  | { type: 'prompts:check' }
  /** Take the new defaults for these categories. An empty list keeps yours. */
  | { type: 'prompts:apply'; categories: string[] }
  | { type: 'groups:read' }
  | { type: 'groups:enable'; enabled: boolean }
  | { type: 'groups:gaps'; showGaps: boolean }
  | { type: 'groups:add'; name: string; member: string; icon?: string }
  | { type: 'groups:rename'; id: string; name: string; icon?: string }
  | { type: 'groups:toggle'; id: string; enabled: boolean }
  | { type: 'groups:delete'; id: string }
  /** Move a module into a group, or out of one with `groupId: null`. */
  | { type: 'groups:assign'; tag: string; groupId: string | null }
  /** Reorder a member inside its group. The order is what the panel draws. */
  | { type: 'groups:move'; id: string; tag: string; direction: 'up' | 'down' }
  | { type: 'blocks:read' }
  | { type: 'blocks:move'; tag: string; direction: 'up' | 'down' }
  /** Switching a card off also stops the tracker being asked to track it. */
  | { type: 'blocks:enable'; tag: string; enabled: boolean }
  | {
      type: 'blocks:save'
      originalTag?: string
      tag: string
      icon?: string
      label?: string
      prompt?: string
      template?: string
      pageSize?: number
    }
  | { type: 'blocks:delete'; tag: string }
  /** Rewrite what a built-in module asks the tracker for. */
  | { type: 'blocks:prompt'; tag: string; text: string }
  | { type: 'blocks:prompt-reset'; tag: string }
  | { type: 'sections:read'; target: 'npc' | 'pc' }
  | { type: 'sections:add'; target: 'npc' | 'pc'; name: string }
  | {
      type: 'sections:update'
      target: 'npc' | 'pc'
      id: string
      name?: string
      description?: string
      icon?: string
      color?: string
    }
  | { type: 'sections:move'; target: 'npc' | 'pc'; id: string; direction: 'up' | 'down' }
  | { type: 'sections:delete'; target: 'npc' | 'pc'; id: string }
  | { type: 'sections:reset'; target: 'npc' | 'pc' }
  | { type: 'cortex:read' }
  /** Write the tracker's ground truth into the host's memory graph. */
  | { type: 'cortex:sync' }
  | { type: 'cortex:enable'; enabled: boolean }
  /** Read the agent's recent passes and active entries. */
  | { type: 'agent:read' }
  /** Take one entry out of the prompt. */
  | { type: 'agent:deactivate'; id: string }
  /** Send an instruction to one subsystem. */
  | {
      type: 'terminal:run'
      target: string
      instruction: string
      lookback: number | null
    }
  /** Read what the agent has filed. */
  | { type: 'records:read' }
  /** Open one record in full. */
  | { type: 'records:entry'; id: string }
  /** Ask for the wizard's example mechanics. */
  | { type: 'wizard:open' }
  /** Draft a Game System from a description. */
  | { type: 'wizard:draft'; description: string; effectOwner: 'tracker' | 'gm' }
  /** Save an approved draft, optionally switching it on straight away. */
  | {
      type: 'wizard:save'
      enable: boolean
      draft: Extract<ToFrontend, { type: 'wizard:draft' }>['draft']
    }
  /** Delete a system, with the prompt section and field it owns. */
  | { type: 'wizard:delete'; id: string }
  /** Read the agent's record types. */
  | { type: 'modules:read' }
  /** Change one record type. Omitted fields are left alone. */
  | {
      type: 'modules:patch'
      id: string
      enabled?: boolean
      format?: string
      instruction?: string
    }
  /** Restore one record type's shipped rule. */
  | { type: 'modules:reset'; id: string }
  /** Read the narrator ruleset's sections. */
  | { type: 'sysprompt:read' }
  /** Turn one ruleset section on or off. */
  | { type: 'sysprompt:toggle'; tag: string; enabled: boolean }
  /** Turn a whole Game System on or off. */
  | { type: 'sysprompt:system'; id: string; enabled: boolean }
  /** Open the portrait picker for one entity card. */
  | { type: 'portrait:open'; entity: string }
  /**
   * Give an entity a portrait, from a persona avatar, an uploaded file, or a
   * pasted URL. Exactly one source is used, in that order.
   */
  | {
      type: 'portrait:set'
      entity: string
      personaId?: string
      url?: string
      /** A dropped or picked file, read in the browser as a data URL. */
      dataUrl?: string
      filename?: string
    }
  /** Remove an entity's portrait. */
  | { type: 'portrait:clear'; entity: string }
  /** Collapse or expand a rendered section. */
  | { type: 'panel:toggle-section'; tag: string }
  /** Switch a section between paged and full-list rendering. */
  | { type: 'panel:toggle-fullview'; tag: string }
  /** A CYOA choice the user clicked in a narrator message. */
  | { type: 'cyoa:choose'; text: string; messageId: string }
) & { viewChatId?: string | null }

/** Mirrors SillyTavern's POPUP_TYPE so ported call sites keep their arguments. */
export const POPUP_TYPE = {
  TEXT: 1,
  CONFIRM: 2,
  INPUT: 3,
  DISPLAY: 4,
  CROP: 5,
} as const

/** Mirrors SillyTavern's POPUP_RESULT. */
export const POPUP_RESULT = {
  AFFIRMATIVE: 1,
  NEGATIVE: 0,
  CANCELLED: null,
} as const
