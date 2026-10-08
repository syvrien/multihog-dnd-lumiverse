/**
 * settings-schema.ts — which settings the panel exposes, and how.
 *
 * The engine carries 404 settings keys. Upstream surfaced them through 2,309
 * lines of hand-written markup in `settings.html`; reproducing that is neither
 * possible nor desirable here. Instead the port declares a small schema that
 * both halves share: the backend reads and writes values through it, the
 * frontend renders controls from it, and adding a setting means adding one
 * entry rather than editing two files.
 *
 * Only settings a player actually reaches for are listed. Everything else keeps
 * its engine default and stays reachable through the raw settings file.
 *
 * `key` is a dotted path so grouped settings (`syspromptModules.loot`) can be
 * addressed without special cases.
 */

export type SettingField =
  | { key: string; kind: 'toggle'; label: string; help?: string; fallback: boolean }
  | {
      key: string; kind: 'number'; label: string; help?: string
      fallback: number; min?: number; max?: number; step?: number
    }
  | { key: string; kind: 'text'; label: string; help?: string; fallback: string }
  | { key: string; kind: 'textarea'; label: string; help?: string; fallback: string; rows?: number }
  | {
      key: string; kind: 'select'; label: string; help?: string
      fallback: string; options: Array<{ value: string; label: string }>
    }
  /** Options are filled at runtime from the user's connection profiles. */
  | { key: string; kind: 'connection'; label: string; help?: string; fallback: string }

/**
 * A collapsible group of related fields.
 *
 * Upstream organises its settings window as a left nav of areas, each holding
 * collapsible groups. Lumiverse gives an extension a single pane inside the
 * host's own nav, so the areas become headings and the groups stay collapsible
 * — same organisation, one level flatter, rather than a nav inside a nav.
 */
export interface SettingGroup {
  title: string
  description?: string
  /** Groups start closed unless they hold something most people change. */
  open?: boolean
  fields: SettingField[]
}

export interface SettingSection {
  id: string
  title: string
  description?: string
  /** Fields shown directly under the heading, above any groups. */
  fields: SettingField[]
  groups?: SettingGroup[]
}

/**
 * The settings prefix a connection field belongs to, or `''` for the tracker's
 * own. `mapArchitectConnectionProfileId` -> `mapArchitect`.
 */
export function prefixForProfileKey(key: string): string {
  if (key === 'connectionProfileId') return ''
  const match = /^(.+)ConnectionProfileId$/.exec(key)
  return match ? match[1] : ''
}

/**
 * The source key that belongs with a profile key.
 *
 * The engine consults a `…ConnectionProfileId` only when its own
 * `…ConnectionSource` says `profile`, so the two must always be patched
 * together — and it has to be the *matching* pair.
 */
export function sourceKeyForProfileKey(key: string): string {
  const prefix = prefixForProfileKey(key)
  return prefix ? `${prefix}ConnectionSource` : 'connectionSource'
}

/**
 * The Lorebook Agent's lookback mode is stored as two booleans that together
 * make a three-way choice, which no single control can drive. These translate
 * between that pair and one `routerLookbackMode` value the settings form can
 * bind to. The pair stays the source of truth — the engine reads it directly.
 */
export const LOOKBACK_MODE_KEY = 'routerLookbackMode'

export function lookbackModeFrom(settings: Record<string, unknown>): string {
  if (settings.routerLookbackSinceLastRun !== false) return 'sinceRun'
  if (settings.routerLookbackSinceLastUser === true) return 'sinceUser'
  return 'fixed'
}

/** The settings the chosen mode implies. */
export function lookbackModeTo(mode: unknown): Record<string, boolean> {
  return {
    routerLookbackSinceLastRun: mode === 'sinceRun',
    routerLookbackSinceLastUser: mode === 'sinceUser',
  }
}

export const SETTINGS_SCHEMA: SettingSection[] = [
  {
    id: 'general',
    title: 'General & Visuals',
    fields: [
      {
        key: 'enabled', kind: 'toggle', fallback: true,
        label: 'Enable the framework',
        help: 'Master switch. Off stops prompt injection and the tracker pass.',
      },
      {
        key: 'injectNarratorSysprompt', kind: 'toggle', fallback: true,
        label: 'Send the narrator ruleset',
        help: 'Adds the extension\'s rules — rolls, combat, quests, loot, the '
          + 'status footer — to every generation. Turn it off if your own preset '
          + 'or character card already covers them. Pick which parts are sent '
          + 'under Narrator ruleset at the bottom.',
      },
      {
        // Upstream's Chat-Linked Mode. The engine has always carried the flag,
        // but nothing could set it, and the switch path ignored it — so "off"
        // was not reachable and would not have worked if it were. Turning it on
        // inside a chat that already has a different saved campaign asks which
        // one to keep, as upstream does; see `applyChatLinkToggle`.
        key: 'chatLinkEnabled', kind: 'toggle', fallback: true,
        label: 'Each chat keeps its own campaign',
        help: 'On: every chat has its own character, party, quests and history, '
          + 'and switching chats switches campaigns. Off: one campaign follows you '
          + 'across every chat. Portraits stay with each chat either way.',
      },
    ],
    groups: [
      {
        title: 'Display',
        fields: [
          { key: 'use24hTime', kind: 'toggle', fallback: false, label: '24-hour time' },
          {
            key: 'useDdMmYyFormat', kind: 'toggle', fallback: false,
            label: 'Day/month/year dates',
          },
        ],
      },
      {
        title: 'Relationships',
        description: 'Friendship and affection tracked per NPC.',
        fields: [
          {
            key: 'npcRelationshipBars', kind: 'toggle', fallback: false,
            label: 'Relationship bars',
          },
          {
            key: 'npcRelationshipUpdateMode', kind: 'select', fallback: 'regex',
            label: 'Relationship updates from',
            help: 'Narrator output reads awards straight from the story. State '
              + 'model has the tracker emit explicit commands — steadier, but it '
              + 'costs tokens on every pass.',
            options: [
              { value: 'regex', label: 'Narrator output' },
              { value: 'state_tracker', label: 'State model commands' },
            ],
          },
          {
            key: 'npcRelationshipMax', kind: 'number', fallback: 150, min: 10, max: 1000, step: 10,
            label: 'Relationship scale maximum',
          },
        ],
      },
      {
        title: 'Developer',
        fields: [
          {
            key: 'debugMode', kind: 'toggle', fallback: false,
            label: 'Debug logging',
            help: 'Verbose logging to the server console.',
          },
        ],
      },
    ],
  },
  {
    id: 'connections',
    title: 'Connections',
    description: 'Which model each part of the framework talks to. They all follow '
      + 'the State Tracker\'s connection until you pick something else, so setting '
      + 'the first one is usually all you need to do.',
    fields: [
      {
        key: 'connectionProfileId', kind: 'connection', fallback: '',
        label: 'State Tracker',
        help: 'The second-pass model that reads each turn and updates the memo. A '
          + 'cheap, reliable model is usually right. Everything below inherits it.',
      },
      {
        key: 'routerConnectionProfileId', kind: 'connection', fallback: '',
        label: 'Lorebook Agent',
        help: 'Reads a stretch of story and writes structured entries.',
      },
      {
        key: 'characterCreationConnectionProfileId', kind: 'connection', fallback: '',
        label: 'Character creation',
        help: 'Rolling a character, and writing Player Cards.',
      },
      {
        key: 'adventureCompanionConnectionProfileId', kind: 'connection', fallback: '',
        label: 'Adventure Companion',
      },
      {
        key: 'mapArchitectConnectionProfileId', kind: 'connection', fallback: '',
        label: 'Map Architect',
        help: 'Draws a whole map in one structured reply — the one most worth '
          + 'pointing at a stronger model.',
      },
      {
        key: 'mapRuntimeConnectionProfileId', kind: 'connection', fallback: '',
        label: 'Map Updater',
      },
      {
        key: 'mapEvolutionConnectionProfileId', kind: 'connection', fallback: '',
        label: 'Map Evolution',
      },
      {
        key: 'worldConnectionProfileId', kind: 'connection', fallback: '',
        label: 'World Progression',
      },
    ],
  },
  {
    id: 'tracker',
    title: 'State Tracker',
    description: 'The pass that reads each turn and updates the campaign memo.',
    fields: [
      {
        // The engine has always honoured this — `onGenerationEnded` skips the
        // State Model pass on non-matching ticks — but the port never surfaced
        // it, so it was pinned at 1 and every turn paid for a pass. It is the
        // largest latency control the extension has: the tracker is the one
        // model call that happens on every single turn.
        key: 'stateTrackerRunEvery', kind: 'number', fallback: 1, min: 1, max: 20, step: 1,
        label: 'Run the tracker every N turns',
        help: '1 runs it after every turn, which is the most accurate and the '
          + 'slowest — it adds a model call to every message. 2 halves that, at '
          + 'the cost of the memo lagging a turn behind. Raise it if turns feel '
          + 'slow; leave it at 1 if the memo must always be current.',
      },
      {
        key: 'lookbackSinceLastUser', kind: 'toggle', fallback: true,
        label: 'Read since the last player turn',
        help: 'On: everything since your last message, so a whole turn is covered '
          + 'even when it spans several messages. Off: a fixed message count.',
      },
      {
        key: 'lookbackMessages', kind: 'number', fallback: 2, min: 1, max: 40, step: 1,
        label: 'Fixed lookback (messages)',
        help: 'Used only when the setting above is off.',
      },
      {
        key: 'ctxWorldInfo', kind: 'toggle', fallback: false,
        label: 'Send world lore to the tracker',
        help: 'Gives the State Tracker your lorebook text so it keeps names and '
          + 'places straight. Costs tokens on every pass, and the scope below '
          + 'decides how many.',
      },
      {
        key: 'loreScope', kind: 'select', fallback: 'card',
        label: 'Which lore the tracker sees',
        options: [
          { value: 'card', label: 'Books attached to this chat\u2019s character' },
          { value: 'all', label: 'Every book in the account' },
          { value: 'manual', label: 'Leave my own filter alone' },
        ],
        help: 'Upstream read every book, because SillyTavern gave it no way to '
          + 'tell which belonged to the campaign. Lumiverse cards name theirs.',
      },
      {
        key: 'fullReviewStateMode', kind: 'toggle', fallback: false,
        label: 'Full review mode',
        help: 'Rebuild the whole memo each pass instead of only changed sections. '
          + 'More accurate, more expensive — recommended for weaker models.',
      },
      {
        key: 'fullAuditMaxTokens', kind: 'number', fallback: 32000, min: 2000, max: 200000,
        step: 1000,
        label: 'Full audit chunk size (tokens)',
        help: 'How much of the chat the Full audit button reads per model call. '
          + 'Set it near your model context window; a smaller number means more '
          + 'calls over the same campaign.',
      },
    ],
    groups: [
      {
        title: 'Advanced',
        fields: [
          {
            key: 'maxTokens', kind: 'number', fallback: 0, min: 0, max: 32000, step: 128,
            label: 'Max response tokens',
            help: '0 leaves it to the connection profile.',
          },
          {
            key: 'userPromptSuffix', kind: 'text', fallback: '## OUTPUT ONLY CHANGED SECTIONS:',
            label: 'Prompt suffix',
            help: 'The final instruction sent to the state model.',
          },
        ],
      },
    ],
  },
  {
    id: 'lorebook-agent',
    title: 'Lorebook Agent',
    description: 'Writes and maintains lorebook entries as you play, so long-term '
      + 'detail survives summarisation. Runs after a turn, on its own schedule.',
    fields: [
      {
        key: 'routerEnabled', kind: 'toggle', fallback: false,
        label: 'Enable the Lorebook Agent',
        help: 'Needs the world_books permission.',
      },
      {
        key: 'routerConnectionProfileId', kind: 'connection', fallback: '',
        label: 'Agent connection',
        help: 'The agent reads a whole stretch of story and writes structured '
          + 'entries. Leave it on the tracker\'s connection unless you want a '
          + 'different model for it.',
      },
      {
        key: 'routerRunEvery', kind: 'number', fallback: 3, min: 1, max: 20, step: 1,
        label: 'Run every N turns',
        help: 'Higher costs less and lags further behind the story.',
      },
      {
        key: 'routerLookbackMode', kind: 'select', fallback: 'sinceRun',
        label: 'How much story it reads',
        help: 'Since the last run is usually right: nothing is missed and nothing '
          + 'is re-read.',
        options: [
          { value: 'sinceRun', label: 'Everything since its last run' },
          { value: 'sinceUser', label: 'Since your last message' },
          { value: 'fixed', label: 'A fixed number of messages' },
        ],
      },
      {
        key: 'routerLookback', kind: 'number', fallback: 4, min: 1, max: 40, step: 1,
        label: 'Messages to read',
        help: 'Only used when the mode above is set to a fixed number.',
      },
      {
        key: 'routerMaxTokens', kind: 'number', fallback: 0, min: 0, max: 32000, step: 128,
        label: 'Max response tokens',
        help: '0 leaves it to the connection profile.',
      },
      {
        key: 'routerMaxTurns', kind: 'number', fallback: 5, min: 1, max: 20, step: 1,
        label: 'Max agent turns',
        help: 'How many tool round-trips one pass may take before it stops.',
      },
      {
        key: 'routerMaxActivations', kind: 'number', fallback: 12, min: 1, max: 100, step: 1,
        label: 'Max active entries',
        help: 'How many lorebook entries may be injected into a prompt at once. '
          + 'The main lever on what the agent costs you per turn.',
      },
      {
        key: 'routerMaxKeywordOverflow', kind: 'number', fallback: 6, min: 0, max: 50, step: 1,
        label: 'Keyword overflow allowance',
        help: 'Extra entries allowed in beyond the cap when their keywords match. '
          + '0 means no allowance.',
      },
      {
        key: 'routerBasicMode', kind: 'toggle', fallback: false,
        label: 'Basic mode',
        help: 'Tag-based instead of tool calls. Try it if your model handles tools '
          + 'badly.',
      },
      {
        key: 'routerNativeKeywordActivation', kind: 'toggle', fallback: false,
        label: 'Native keyword activation',
        help: 'Let the host decide which entries are relevant instead of the agent.',
      },
      {
        key: 'routerIncludeHidden', kind: 'toggle', fallback: false,
        label: 'Include hidden messages',
        help: 'Read messages hidden from the model, such as summaries.',
      },
      {
        key: 'routerSwipeRollback', kind: 'toggle', fallback: true,
        label: 'Undo on swipe',
        help: 'Rolls back what a pass wrote when you swipe away from the turn '
          + 'that triggered it, so a rejected reply leaves no lore behind.',
      },
      {
        key: 'routerCampaignPrefix', kind: 'text', fallback: '',
        label: 'Campaign prefix',
        help: 'Names the books this campaign owns. Leave empty to derive it from the chat.',
      },
    ],
  },
  {
    id: 'modules',
    title: 'Game Systems',
    description: 'Which subsystems the narrator is told about. The exact rules '
      + 'sent for each are under Narrator ruleset at the bottom.',
    fields: [
      { key: 'syspromptModules.CYOA_mode', kind: 'toggle', fallback: true, label: 'CYOA choices' },
      {
        key: 'cyoaConfig.stripOldChoicesFromPrompt', kind: 'toggle', fallback: true,
        label: 'Trim old choices from context',
        help: 'Sends only the four newest choice lists to the model, as formatting '
          + 'examples, and drops the rest. Every choice stays visible and clickable '
          + 'in the chat — this only affects what the model is charged to re-read.',
      },
      { key: 'syspromptModules.quests', kind: 'toggle', fallback: true, label: 'Quests' },
      {
        key: 'syspromptModules.questsDeadlines', kind: 'toggle', fallback: true,
        label: 'Quest deadlines',
      },
      { key: 'syspromptModules.loot', kind: 'toggle', fallback: true, label: 'Loot' },
      {
        key: 'syspromptModules.random_events', kind: 'toggle', fallback: true,
        label: 'Random events',
      },
      { key: 'syspromptModules.resting', kind: 'toggle', fallback: true, label: 'Resting' },
      {
        key: 'syspromptModules.party_bench', kind: 'toggle', fallback: true,
        label: 'Party benching',
      },
      {
        key: 'syspromptModules.dungeon_reality_and_hidden_mapping', kind: 'toggle', fallback: true,
        label: 'Persistent maps',
        help: 'Lets the narrator map a dungeon, interior or settlement and keep it '
          + 'consistent. Also the master switch for Persistent maps below.',
      },
    ],
    groups: [
      {
        title: 'Dice',
        description: 'Two engines. The queue pre-seeds rolls into every prompt and '
          + 'is always on. Tool calls make the model declare a DC before it sees '
          + 'the result, which is what stops it writing the outcome it wants.',
        fields: [
          {
            key: 'rngToolD20', kind: 'toggle', fallback: false,
            label: 'RollTheDice tool',
            help: 'Standard d20 checks with a declared DC, plus d100 percentage checks.',
          },
          {
            key: 'rngToolD100', kind: 'toggle', fallback: false,
            label: 'RollTheDiceD100 tool',
            help: 'A dedicated roll-under d100 tool for percentage-based systems.',
          },
          {
            key: 'diceD100Mode', kind: 'toggle', fallback: false,
            label: 'd100 mode',
            help: 'Treat d100 as the default die across the framework.',
          },
        ],
      },
    ],
  },
  {
    id: 'maps',
    title: 'Persistent maps',
    description: 'The narrator calls a tool to draw a map the first time the story '
      + 'enters somewhere worth mapping. After that, two background passes keep '
      + 'it current: the updater tracks where the party is and what they have '
      + 'opened, and evolution moves the site\'s inhabitants on. Turned off by '
      + '"Persistent maps" under Systems.',
    fields: [
      {
        key: 'mapArchitectMaxTokens', kind: 'number', fallback: 25000, min: 1000, max: 64000, step: 1000,
        label: 'Map Architect token budget',
        help: 'A whole map arrives in one reply, so this is much larger than the '
          + 'tracker\'s. Too low and the map is truncated and rejected.',
      },
      {
        key: 'mapUpdaterEnabled', kind: 'toggle', fallback: true,
        label: 'Keep maps current',
        help: 'Tracks the party through a mapped site: which areas they have '
          + 'reached, what they opened, what they left behind.',
      },
      {
        key: 'mapUpdaterRunEvery', kind: 'number', fallback: 1, min: 1, max: 20, step: 1,
        label: 'Update every N turns',
        help: 'Every turn is the most accurate and the most expensive.',
      },
      {
        key: 'mapEvolutionEnabled', kind: 'toggle', fallback: true,
        label: 'Let sites change on their own',
        help: 'Moves inhabitants and conditions on while you are away, so a '
          + 'dungeon you return to is not exactly as you left it.',
      },
    ],
  },
  {
    id: 'world-progression',
    title: 'World Progression',
    description: 'Off-screen reports on what the wider world is doing, written at '
      + 'a fixed in-world interval and stored in the campaign\'s World lorebook. '
      + 'The trigger is deterministic — the clock decides when, the model only '
      + 'writes the report.',
    fields: [
      {
        key: 'worldProgressionEnabled', kind: 'toggle', fallback: false,
        label: 'Enable World Progression',
        help: 'Needs the Lorebook Agent, which is where the reports are stored.',
      },
      {
        key: 'worldProgressionIntervalHours', kind: 'number', fallback: 24, min: 1, max: 720, step: 1,
        label: 'In-world hours between reports',
        help: '24 is one report a day of game time.',
      },
      {
        key: 'worldProgressionLookback', kind: 'number', fallback: 20, min: 0, max: 100, step: 1,
        label: 'Story messages to read',
        help: '0 writes the report from world state alone.',
      },
      {
        key: 'worldProgressionKeepActive', kind: 'number', fallback: 1, min: 0, max: 10, step: 1,
        label: 'Reports kept in the prompt',
        help: 'How many recent reports stay injected. Each one costs tokens every turn.',
      },
    ],
  },
]

/** Read a dotted path, falling back when any step is missing. */
export function readPath(source: Record<string, unknown>, path: string): unknown {
  let cursor: unknown = source
  for (const part of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined
    cursor = (cursor as Record<string, unknown>)[part]
  }
  return cursor
}

/** Write a dotted path, creating intermediate objects as needed. */
export function writePath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.')
  const last = parts.pop()
  if (!last) return
  let cursor: Record<string, unknown> = target
  for (const part of parts) {
    const next = cursor[part]
    if (!next || typeof next !== 'object') cursor[part] = {}
    cursor = cursor[part] as Record<string, unknown>
  }
  cursor[last] = value
}

/** Current value for a field, or its documented fallback. */
export function valueFor(settings: Record<string, unknown>, field: SettingField): unknown {
  const current = readPath(settings, field.key)
  return current === undefined || current === null ? field.fallback : current
}

/** Every field in the schema, flattened. */
export function allFields(): SettingField[] {
  return SETTINGS_SCHEMA.flatMap(section => section.fields)
}
