# Porting notes — SillyTavern → Lumiverse

This extension is a port of [SillyTavern-MultihogDnDFramework](https://github.com/MultihogAurelius/SillyTavern-MultihogDnDFramework)
(the author explicitly encourages forks). The strategy is a **compatibility
shim**: the engine keeps the author's code, and a `src/compat/` layer
re-implements the SillyTavern APIs it calls on top of Spindle. Upstream bugfixes
stay pullable.

Everything below is measured against the upstream tree, not estimated.

---

## Shape of the problem

| | Upstream | Here |
|---|---|---|
| Total | ~128k lines, ~200 files | — |
| Engine (DOM-free) | `router` 5,799 · `renderer` 3,328 · `dungeon-reality` 3,228 · `narrative-hooks` 3,160 · `game-systems` 3,119 · `memo-processor` 1,819 | ported as-is |
| Shell | `index.js` 12,640 (1,037 jQuery sites) · `settings.html` 2,309 · `style.css` 10,925 | rebuilt on Spindle |
| Host coupling | 283 `SillyTavern.getContext()` calls across ~40 APIs | `src/compat/` |

jQuery is 89% confined to `index.js`. That is what makes the engine portable and
the shell a rewrite.


### Raw REST calls

31 call sites bypass `getContext()` and `fetch()` SillyTavern's REST API
directly. These are invisible to a `getContext()` audit and would resolve
against the Lumiverse origin and 404 silently, so `installFetchGuard()` turns
each into a named error at the point of use.

| Endpoint | Sites | Target |
|---|---:|---|
| `/api/worldinfo/edit` | 10 | `spindle.world_books.entries.update` |
| `/api/settings/get` | 6 | `spindle.storage` |
| `/api/worldinfo/get` | 5 | `spindle.world_books.entries.list` |
| `/api/worldinfo/list` | 2 | `spindle.world_books.list` |
| `/api/worldinfo/delete` | 2 | `spindle.world_books.delete` |
| `/api/characters/all` | 2 | `spindle.characters.list` |
| `/api/images/upload`, `/api/images/delete`, `/api/avatars/upload` | 3 | `spindle.images` (needs `images`) |
| `/api/characters/create` | 1 | `spindle.characters.create` |

None are in the State Tracker path; the world info ones land when the Lorebook
Agent is wired up.

---

## API mapping

Call-site counts are from upstream.

| SillyTavern | Sites | Lumiverse | Where |
|---|---:|---|---|
| `ctx.chat` (live mutable array) | 56 | `spindle.chat.getMessages` + event-synced mirror | `compat/chat-mirror.ts` |
| `ctx.loadWorldInfo` | 58 | `spindle.world_books.entries.list` | `compat/world-info.ts` |
| `ctx.updateWorldInfoList` | 34 | `spindle.world_books.list` | `compat/world-info.ts` |
| `ctx.saveWorldInfo` | 26 | diffed entry CRUD | `compat/world-info.ts` |
| `ctx.reloadWorldInfoEditor` | 20 | **no equivalent** — cache invalidation only | `compat/world-info.ts` |
| `ctx.getWorldInfoNames` / `getWorldInfoEntries` | 15 | `spindle.world_books.*` | `compat/world-info.ts` |
| `ctx.callGenericPopup` + `POPUP_TYPE` | 77 | request/response to the frontend, host modal chrome | `compat/popup-bridge.ts` |
| `ctx.executeSlashCommandsWithOptions` | 23 | 5-command dispatcher | `compat/slash.ts` |
| `ctx.chatId` / `getCurrentChatId` | 54 | `spindle.chats.getActive` + `CHAT_CHANGED` | `compat/context.ts` |
| `ctx.characters` / `characterId` | 22 | `spindle.characters` | `compat/context.ts` |
| `ctx.saveChat` / `saveChatDebounced` | 10 | mirror `flush()` | `compat/chat-mirror.ts` |
| `ctx.generate*` / `ConnectionManagerRequestService` | 7 | `spindle.generate.raw` / `.quiet` | `compat/llm.ts` |
| `ctx.extensionSettings` / `saveSettings*` | 5 | `spindle.storage` (debounced) | `compat/settings-store.ts` |
| `ctx.chat_metadata` | 1 | `spindle.variables.chat` | `compat/context.ts` |
| `eventSource` + `event_types` (18 names) | — | `spindle.on` | `compat/events.ts` |
| `generate_interceptor` manifest hook | — | `spindle.registerInterceptor` | `backend.ts` |
| `SillyTavern.libs.droll` | 3 | bundle `droll` directly | not yet |

### SillyTavern *core* imports

Only 7 import lines across 6 files reach outside the extension. `compat/st-core.ts`
covers all of them:

| Symbol | Files | Status |
|---|---|---|
| `getRequestHeaders` | `index`, `router`, `character-creator`, `portrait-storage` | throws — every caller targets a SillyTavern REST endpoint that does not exist here |
| `getSortableDelay` | `game-systems` | constant |
| `POPUP_RESULT` | `game-systems` | re-exported |
| `SlashCommandAbortController` | `portraits` | `AbortController` subclass |

### Slash commands

Upstream issues exactly five:

| Command | Sites | Status |
|---|---:|---|
| `/world state=on\|off silent=true <name>` | 15 | implemented via `world_books.setGlobal` |
| `/profile-list` | 1 | implemented via `connections.list` |
| `/profile [name]` | 2 | returns a connection id for `connection_id` |
| `/preset [name]` | 2 | **not wired** — needs the `presets` permission |
| `/persona-lock` | 1 | **not ported** — needs the `personas` permission |

### Events

| SillyTavern | Lumiverse |
|---|---|
| `MESSAGE_SENT` / `MESSAGE_EDITED` / `MESSAGE_DELETED` / `MESSAGE_SWIPED` | same names |
| `MESSAGE_UPDATED` | `MESSAGE_EDITED` |
| `MESSAGE_RECEIVED` | `GENERATION_ENDED` |
| `CHAT_CHANGED` / `CHAT_LOADED` | `CHAT_CHANGED`, `CHAT_SWITCHED` |
| `GENERATION_*` / `STREAM_TOKEN_RECEIVED` | same names (needs `generation`) |
| `APP_READY` / `SETTINGS_LOADED` | synthesised at boot |
| `GENERATE_BEFORE_COMBINE_PROMPTS` / `CHAT_COMPLETION_PROMPT_READY` | emitted from inside the interceptor |
| `WORLD_INFO_UPDATED` | synthesised on `saveWorldInfo` |
| `CHAT_RENAMED`, `MORE_MESSAGES_LOADED` | **never fire** — no host counterpart |

---

## Behavioural differences to watch

These are the places where the port cannot be faithful, in rough order of how
much they matter.

**1. The interceptor moved.** SillyTavern's `generate_interceptor` runs on the
*chat array before prompt assembly*. Lumiverse's runs on the *assembled prompt
after* it. Injections and strips over a message list survive the move, which is
what the state memo, RNG queue, and CYOA block all do. Anything that relied on
running before assembly will not see world info or preset blocks. Watch this
first if injections land in the wrong place.

**2. There is a time budget.** SillyTavern imposed none. Lumiverse defaults to
10s and clamps to 300s. `spindle.json` requests 60s. The router's LLM passes
must not run inside the interceptor — move long work to an event handler that
writes state the interceptor only reads.

**3. `ctx.chat` writes are deferred.** Upstream mutates the array and the host
notices. Here, mutations are diffed and pushed on `saveChat()`. Engine code that
mutates without saving silently loses the change.

**4. Panel markup is sanitised.** `renderer.js` output crosses to the frontend
and goes through DOMPurify. Inline styles and colour markup in the memo are the
likely casualties — check the cards before assuming a render bug is in the
renderer.

**5. `reloadWorldInfoEditor()` is a no-op.** All 20 sites are display-only
refreshes of SillyTavern's lorebook editor, a surface Lumiverse owns.

**6. The backend has no browser globals.** Upstream ran entirely in the browser,
so engine modules reach for `localStorage` (77 sites) and occasionally
`document` even in otherwise DOM-free files. `compat/browser-env.ts` supplies
both: `localStorage` is real, backed by `spindle.storage` behind a synchronous
cache, because the engine keeps UI preferences and persisted flags there;
`document` is inert, because every remaining use is a UI refresh that the
frontend now owns. This must be installed before the first engine import —
`getSettings()` throws on `localStorage` during module initialisation otherwise.

**7. The install scanner.** No `eval` / `new Function` / `Buffer.from(…, 'base64')`
in the backend bundle unless declared in `requested_capabilities`. Nothing
currently needs a declaration; portraits may when it lands.

---

## Verified by running

`bun run test` boots the backend against `tests/fake-spindle.ts` — an in-memory
host — and exercises the tracker path. What that proved, and what it caught:

| | |
|---|---|
| Backend boots, engine modules execute | pass |
| `getSettings()` returns the migrated defaults tree | 404 keys |
| Memo parses into blocks | `TIME`, `CHARACTER`, `INVENTORY` |
| `renderMemoAsCards()` produces panel markup | 4,225 chars |
| Interceptor injects the state memo into the prompt | 2 messages in, 3 out |
| State pass reaches the model on the right connection | 1 request, `conn-1` |
| Lookback starts at the last user message | older turn excluded |
| Model reply merged into the memo | `HP: 27/34` → `HP: 20/34`, `[TIME]` preserved |
| Model + provider resolved from the connection | `z-ai/glm-5.3-flash-uncensored` / `nanogpt` |
| No runtime action called before initialisation | action table installed at boot |
| Memo survives to per-user storage | `HP: 20/34` read back from disk |
| No user-scoped call before a user is known | operator scope enforced in the fake host |
| Settings persist under the acting user's scope | `user-1:settings.json` |

Three bugs surfaced only once the code actually ran:

1. **`localStorage` is not defined.** `getSettings()` threw on the first call.
   Fixed by `compat/browser-env.ts`. The bundler could not see this.
2. **Wrong settings key.** The backend read `extensionSettings.rpg_state_tracker`;
   the engine's `MODULE_NAME` is `rpg_tracker`. The panel would have rendered
   from a different bucket than the engine wrote to. Fixed by deferring to the
   engine's own `getSettings()` instead of reaching in by key.
3. **Wrong renderer signature.** `renderMemoAsCards(memo, filterTag, sectionPages,
   uiOptions)` was being called as `(memo, settings)`, so settings acted as a
   filter tag and the panel rendered empty.

A fourth was a flaw in the test itself: the smoke check asserted "no errors"
*before* running the interceptor, and `adaptInterceptor` logs and swallows engine
throws — so it passed green while the interceptor was failing on (1). The
assertion now runs last.

---

## Typed against the real API

The port originally carried a hand-written subset of the Spindle API, written
from the developer docs. It now compiles against `lumiverse-spindle-types@0.6.16`,
which is the authority. Swapping to it produced 25 type errors — every one a
place where the docs and the implementation differ, or where the docs were
simply thinner than the truth:

| Assumption from the docs | Reality |
|---|---|
| `ctx.ui.showModal()` resolves to a result | Returns a handle **synchronously**: `{ root, dismiss(), onDismiss() }`. The extension owns the modal body and must build its own buttons. |
| `ChatMessageDTO` has `role` / `metadata` / `hidden` | Has `is_user`, `name`, `send_date`, `extra` — much closer to SillyTavern's own shape. `getMessages()` adds a normalized `role` and splits `metadata` out of `extra`. Hidden state is not on the record at all. |
| World book entries have `order` | The column is `order_value`. Entries also carry a native `uid`, and creates take a `WorldBookEntryCreateDTO`. |
| `spindle.generate.raw({ messages })` | `GenerationRequestDTO` **requires** `type: "raw" \| "quiet" \| "batch"`, and the call returns `Promise<unknown>` — cast to `GenerationResponseDTO`. |
| `spindle.log.debug()` | Only `info` / `warn` / `error` exist. |
| Event handlers receive typed payloads | `spindle.on`, `onFrontendMessage`, and `onBackendMessage` all hand you `unknown`. Narrow inside the handler. |
| `LlmMessageDTO.content` is a string | It is `string \| LlmMessagePartDTO[]`; multi-part content must be flattened before the engine sees it. |

The `ChatMessageDTO` discovery is the useful one: because Lumiverse's message
shape is already ST-like, `chat-mirror.ts` is a rename rather than the
role-mapping remodel the docs implied.

`tests/fake-spindle.ts` was updated to match, so the in-memory host now models
the same shapes the real one returns.

---

## Scope: one user at a time

Installed operator-scoped, a Spindle extension serves every user on the
instance, and the host rejects any user-scoped call that does not say who it is
for. The port's first real boot produced exactly that:

```
[DnD] no active chat at boot: userId is required for operator-scoped extensions
[DnD] world book index failed: userId is required for operator-scoped extensions
[DnD] connection lookup failed: userId is required for operator-scoped extensions
```

The user id is not available at boot. It arrives as the **second argument** to
every event handler, on interceptor context, and alongside every frontend
message. So user-scoped startup is deferred (`compat/user-context.ts`) instead
of being called with `undefined`:

- `installBrowserEnv()` is now synchronous and installs an empty store — engine
  modules read `localStorage` while initialising, long before any user is known
- `hydrateBrowserEnv()` and `loadSettings()` run behind `ensureUserState()`,
  which is idempotent and awaited by the interceptor so a generation cannot win
  the race and run against empty defaults
- persistence moved from `spindle.storage` (extension-wide, shared by everyone)
  to `spindle.userStorage` (per-user) — a campaign's memo is one person's game

**The engine is single-user by construction.** Upstream was a browser extension:
settings, current memo and chat state all live in module-level globals. That
cannot be made concurrent by threading an id through the compat layer. The port
tracks one active user and re-homes onto whoever it last saw, warning on change.
On a single-user instance that is simply correct; on a shared one, install it
user-scoped (`scope: "user"` on the install route — `import-local` always
registers operator-scoped).

`tests/fake-spindle.ts` now enforces the same rule, so this class of bug fails
the suite rather than only appearing in a server log.

---

## Found only by running against a real host

Three bugs that no amount of typechecking or harness work would have caught,
because each one type-checks perfectly and fails silently at runtime.

### `generate.raw` needs an explicit model

`connection_id` alone is not enough. The host reads `provider` and `model` as
**top-level** fields on the raw request (`worker-host.ts`: `model: input.model || ""`)
and forwards them to the provider, so omitting them arrives as an empty model:

```
NanoGPT generate failed (400): Missing or invalid required parameter: model.
```

Neither field is declared on the published `GenerationRequestDTO`, so the types
cannot flag it. `compat/llm.ts` resolves them from the connection profile.

### The runtime action table was never filled

`src/app/runtime-bridge.js` lets feature modules call back into the application
entry point without an import cycle. Upstream's `index.js` fills it during
startup; the port replaces `index.js` and filled nothing, so every call threw
`Runtime action "saveSettings" was used before initialization.`

The tracker *looked* like it worked — the memo committed in memory and the panel
rendered it — while nothing reached disk and every restart lost the campaign.
`compat/runtime-actions.ts` installs the table: `saveSettings` is real, UI
refreshes are bridged to the Spindle panel, DOM calls are inert, and unported
subsystems throw by name rather than returning a bland default.

### `saveChatState()` takes the chat id

```js
export function saveChatState(chatId, opts = {}) {
    if (!chatId) return;
```

Called bare it returns immediately, saving nothing and reporting nothing. The
port called it with no arguments, so even after the action table was installed
the commit was still dropped — with no error to log.

The lesson these share: a silent no-op is worse than a throw. Where the port now
cannot complete an operation it says so — in the panel, not just the server log.

---

## Status

**Done — foundation + State Tracker scaffolding**

- Manifest, build, TypeScript setup, local Spindle type declarations
- Full compat layer: chat mirror, world info, popups, slash commands, LLM,
  events, settings, ST-core shim
- `scripts/port.mjs` — reproducible copy + import rewrite from an upstream
  checkout. Follows static *and* dynamic imports; currently pulls a 70-file
  closure with zero unresolved imports.
- `installFetchGuard()` — fails loudly on the 31 raw SillyTavern REST calls
- Backend entry: boot, event bridging, chat following, interceptor registration
- Frontend entry: drawer tab, panel, popup host
- `compat/browser-env.ts` — `localStorage` over `spindle.storage`, inert `document`
- `tests/fake-spindle.ts` + two runnable checks (`bun run test`): the backend
  boots, the engine's `getSettings()` returns its full 404-key tree, a state
  memo renders to 4.2 KB of card markup, and the interceptor injects that memo
  into an outgoing prompt
- Compiles against the published `lumiverse-spindle-types`, not a hand-written
  subset — see "Typed against the real API"
- `tsc --noEmit` clean; both bundles build; the backend bundle is clean against
  the install scanner (no `eval` / `Function` / `Buffer.from(…, 'base64')` /
  `process.*` / `fs` / `child_process`), so no `requested_capabilities` are
  needed today

**Done — the State Tracker loop**

`src/tracker/state-pass.ts` is the one piece rebuilt rather than ported: upstream
it lives inside `index.js` as `runStateModelPass()`, tangled with jQuery status
indicators and the swipe scheduler, and `index.js` is the file the port replaces.
The prompt assembly, lookback rule ("everything since the last user message"),
`<memo>` unwrapping and merge semantics follow upstream deliberately.

It runs on `GENERATION_ENDED`, never inside the interceptor — Lumiverse bounds
interceptors by wall clock and this makes its own model call. A single available
connection is adopted automatically so an unconfigured tracker does not look
broken; with more than one the choice stays the user's.

Still not carried over from `runStateModelPass()`: dungeon-map undo snapshots,
and the linear `historyIndex` scrubber they belong to. Full-audit chunking, memo
history depth, and relationship commands landed later — see below.

**Done — CYOA clickable choices**

`src/ui/cyoa.ts`. The narrator ends each turn with a `<choices>` block of
`<button>` lines; upstream bound these by scanning `.mes_text` and, on click,
writing into SillyTavern's `#send_textarea` and clicking `#send_but`.

Lumiverse has a better primitive. `ctx.messages.registerTagInterceptor` matches
the `<choices>` tag, strips it from the rendered message, and hands over the
content plus the message id; `dom.findMessageElement` + `dom.inject` then attach
the buttons to that bubble, and the host replays them across chat
virtualisation. Clicking appends a user message with `triggerGeneration`, which
runs the same pipeline as a typed turn — so the interceptor and the tracker pass
behave identically.

Details that matter: the block is ignored while `isStreaming` (mid-stream the
markup is incomplete), bracketed mechanics like `[Persuasion (untrained) DC 12]`
render as a separate chip while the *original* line is what gets sent, the whole
block disables on click so a double tap cannot send two turns, and a re-render
from an edit or swipe replaces rather than stacks.

Not carried over: the per-user colour configuration in `cyoaConfig`
(`buttonColor`, `mechColor`, `dcColor`, …). The buttons use host theme tokens
instead, so they follow the user's Lumiverse theme.

**Done — settings surface**

`shared/settings-schema.ts` + `ui/settings.ts`. Upstream exposed its 404 settings
keys through 2,309 lines of hand-written markup; the port declares a schema
instead, so both halves read from one source and a new setting is one entry
rather than markup plus a handler.

Exposed: master enable and debug logging, the state-model connection and token
cap, tracker lookback and full-review mode, the eight system toggles, and the
display options. Everything else keeps its engine default.

Two details that were easy to get wrong:

- **Dotted paths.** Grouped settings are addressed as `syspromptModules.loot`.
  A plain `Object.assign` would create a literal key with a dot in it that the
  engine never reads — the toggle would look like it worked and change nothing.
  `writePath()` handles the nesting, and a test asserts no literal dotted key
  appears.
- **Changing the connection also pins `connectionSource: 'profile'`**, because
  the engine only consults `connectionProfileId` when the source says to.

Placement uses `ctx.ui.registerSettingsTab()`, which exists at runtime but is
**not in the published types** — so it is called behind a capability check with
a drawer tab as the fallback.

**Done — tool-call dice**

`compat/tools.ts`. The deterministic RNG queue was already working (the
interceptor injects it), but the tool-call half was silently absent:
`registerDiceFunctionTool()` opens with

```js
const { registerFunctionTool, unregisterFunctionTool } = ctx
if (!registerFunctionTool || !unregisterFunctionTool) return
```

and neither existed on the compat context, so the feature returned at its first
line with nothing logged. That half is the anti-sycophancy mechanism — the model
must declare a DC before it sees the roll.

The two APIs are shaped differently. SillyTavern attaches an `action` callback
per tool; Lumiverse's `registerTool()` takes no handler and delivers every
invocation of every tool through one `TOOL_INVOCATION` event whose return value
is the tool result. The shim keeps the action table and dispatches by name.

`RollTheDice` and `RollTheDiceD100` ship **off** (engine defaults) and are now in
the settings schema, with a settings change re-running registration so a toggle
reaches the host registry rather than only disk.

Also fixed alongside: `toastr` is a SillyTavern global the engine calls 44 times
across four files. Unshimmed those were ReferenceErrors on error paths — the
worst place to add a second failure. It now maps onto host toasts.

**Done — Lorebook Agent**

Two problems, and the interesting part is that neither was solved by editing
`router.js`.

**The raw REST calls.** 13 of the engine's 31 direct `fetch('/api/worldinfo/*')`
calls live in the router. They exist because SillyTavern's in-memory
`worldInfoCache` goes stale, so the agent reads and writes over HTTP to be sure
it sees disk. Rewriting each call site was the obvious move and the wrong one:
`src/engine/` is generated, so hand edits die on the next `port.mjs` run.
`compat/worldinfo-rest.ts` answers the requests instead — it replaces `fetch`
and implements `list` / `get` / `edit` / `delete` against `spindle.world_books`,
reusing the same document translation the `getContext()` path uses. That covers
every raw call site in every file at once, survives re-porting, and the agent's
"authoritative disk read" genuinely is one, because Lumiverse has no equivalent
stale cache. Everything else under `/api/` still rejects by name.

One shape detail worth keeping: a missing book returns **404, not an empty
document**. The agent treats a completed response as authoritative, so
`{entries:{}}` would read as "this book exists and is empty" and it would never
create it.

**The trigger.** `narrative-hooks.js` already owns the whole post-turn pipeline
— throttling by `runEvery`, the keyword-trigger accumulator, the run watermark,
the tracker pass, the agent, then World Progression — and reaches the entry
point through `globalThis._rpg*` callbacks that upstream's `index.js` installs.
Without them `onGenerationEnded()` bails at its first check. `compat/engine-hooks.ts`
installs them, so the port hands off to the engine's own scheduler instead of
inventing a trigger and drifting from upstream behaviour.

The agent ships **off** (`routerEnabled: false`) and is now in the settings
schema with its run interval, lookback, token cap, and campaign prefix.

**Done — correcting tracker state**

`src/tracker/direct-prompt.ts`. The panel was read-only, which was the port's
most-felt gap in play: when the state model got something wrong there was no way
to fix it. Both of upstream's routes are carried across —

- **Edit raw** opens the memo in a textarea and commits hand-edited text
- **Ask** sends an instruction ("Kestrel drank a full heal — set HP to maximum")
  to the state model, whose reply merges as a normal pass

"Ask" reuses the tracker's own prompt assembly and merge, so a correction
behaves exactly like an automatic pass: same modules, same merge semantics, same
history/delta/persistence. A hand edit goes through `applyQuestSyncAndStripMemo`
too, so it cannot leave the quest log and the memo disagreeing.

This also gives `sendDirectPrompt` a real implementation — it was one of the
runtime actions that threw "not ported".

`src/state/direct-prompt-system.js` is reachable only from `index.js` upstream,
so the import walk never found it; it is now an explicit entry in the port
script's slice.

**Done — Player Cards and character rolling**

`src/tracker/player-card.ts`, `src/ui/player-card.ts`, `src/ui/roll-character.ts`.

- **Create PC Card** turns the CHARACTER sheet plus recent messages into a prose
  bio, reviewed in a modal, then stored as the chat's player character for the
  Lorebook Agent.
- **Roll character** is upstream's Quick Start: pick a genre and class archetype
  and the model authors a fresh sheet. Destructive, so the modal says so; the
  previous memo goes to `memoHistory` and is recoverable from Edit raw.

Both surfaced bugs that only appear at runtime:

- `refreshAgentManifestNow` was a plain no-op returning `undefined`, but the
  engine calls `void refreshAgentManifestNow().catch(...)`. A no-op has to keep
  the shape of what it replaces.
- Character creation carries its own connection settings, defaulting to
  SillyTavern's "main API" — which does not exist here, so the request went out
  with no model. Both entry points fall back to the tracker's connection.
- `sendDirectPrompt` was mapped to the panel's Ask box and discarded its
  `systemPromptMode` and `connectionSettings`. Character creation needs
  `modules_only`, because the State Extractor's narrative-diff rules fight a
  prompt trying to author a sheet from scratch. It now honours both.

**Done — per-chat tracker state**

`src/compat/chat-state.ts`. The engine has always stored state per chat under
`settings.chatStates[chatId]`, and `settings.currentMemo` is a *projection* of
whichever chat is active. The port called `saveChatState()` and never the
loader, so opening a second chat showed the first chat's character — and the
next commit wrote that character into the second chat's partition. Characters
were effectively global, and switching chats could overwrite one campaign with
another.

`syncActiveChat()` now flushes the outgoing chat before the incoming one
replaces the projection, then restores the incoming snapshot. Upstream's loader
is a factory taking ~20 injected dependencies (supplied by `index.js`); most are
engine functions the port already had, the rest are UI hooks that become no-ops.

This also forced an inert **jQuery** stub. The ported engine still calls `$` 84
times, every one writing into a SillyTavern settings-drawer input that does not
exist here. Unstubbed, the first line threw `$ is not defined` mid-function and
the chat-state loader *half-applied* a snapshot before dying — worse than either
applying it or not.

**Done — rolling a character from a persona**

Upstream's Quick Start authors a whole sheet from a genre and a class
archetype. Two additions on top of it, both about not needing an
image-generation provider or a fixed list of classes:

- **Seed from a Lumiverse persona.** Its title and description feed the
  generation prompt, and its avatar becomes the portrait — keyed as upstream
  keys one (`customPortraits.CHARACTER`, `.PC`, the persona name, and the
  rolled name), so the tracker card and the Lorebook Agent resolve the same
  image. This needs the `personas` and `images` permissions; without them the
  picker shows "No personas available" rather than failing.
- **Custom and story-fitting classes.** The picker appends `Custom…`
  (`__other__` plus free text) and `Let the story decide` (`__story__`) to the
  preset archetypes. Both sentinels were already understood by
  `buildCharacterGenerationPrompt`; reaching them meant calling it directly
  instead of going through `generateQuickStartCharacter`, which accepts neither.

**Done — reviewing a roll before it lands**

A roll replaces the whole CHARACTER block, and it used to commit the moment the
model answered. The picker claimed the old sheet was recoverable from Edit raw.
It was not: the prior memo goes into `settings.memoHistory`, which nothing in
the UI reads. A roll you disliked took your character with it.

`sendDirectPrompt` gained a `preview` option that merges but does not commit, so
`rollCharacter()` now returns a draft and `commitRoll()` applies it. The review
modal shows the sheet in an editable box with the persona portrait beside it,
and offers *Use this character* / *Roll again* / *Discard*. What gets stored is
what the user left in the box — the same rule as the Player Card review, so one
fumbled stat costs an edit rather than a reroll.

The backend holds the pending draft rather than round-tripping it: `roll:commit`
carries only the memo, so an approval cannot smuggle in an image URL. A second
approval finds nothing pending and is refused, instead of re-applying a sheet
the user has since edited.

Still missing: nothing reads `memoHistory`. Rolls are now reviewable, but a bad
*automatic* pass is still unrecoverable from the UI. A history list in the raw
editor would close that.

**Done — undoing a bad pass**

`settings.memoHistory` has always been written on every commit
(`trackerHistoryCount`, default 3) and **nothing ever read it**, so a state pass
that mangled the sheet could not be undone from the UI. The raw editor now
offers the earlier versions; choosing one loads it into the box rather than
committing it, so there is still exactly one commit path and the version you
replaced becomes recoverable in its turn.

**Done — portraits by hand**

Every entity card renders a portrait box carrying
`title="Drop image here or click to set portrait"`. Upstream wires both
gestures in `src/ui/panel/card-events.js`; the port rendered the box and wired
neither, so the tooltip promised something that never happened.

Upstream's own answer is to *generate* the image, which needs an
image-generation provider. `src/tracker/portraits.ts` is the other half — a
persona's avatar, an uploaded file, or a pasted URL. A dropped file is uploaded
through `spindle.images.uploadFromDataUrl` and only the resulting asset URL is
stored: settings are written to per-user storage on every commit, and base64
portraits would ride along on every one of those writes. A URL must be `http(s)`
or a root-relative asset path, so a `javascript:` string cannot reach an
`<img src>` in the panel.

Keys go in normalised (`normalizeEntityName`), because that is what
`lookupCustomPortraitSrc` reads when the renderer builds a card.

**Correction — two selectors that never arrive**

`panel-controls.ts` stripped `.rt-random-char-btn` and
`.rt-quickstart-genre-btn` as "not ported". They are never rendered:
`renderMemoAsCards` emits them only for an *empty* memo, and `renderPanel()`
does not call the renderer in that case — it sends `memoPresent: false` and the
frontend paints its own empty state. Rolling a character lives on the panel
toolbar instead, reachable with or without a memo.

**Done — persistent maps**

A wiring slice, not a port: all three map modules came across with the tracker
closure, and `onGenerationEnded()` was already calling the updater and evolution
passes every turn. Nothing happened because a map has to exist first, and the
only thing that creates one is the narrator model calling the `CreateAreaMap`
tool. That tool is registered by `syncLocationMappingRuntime()`, which
upstream's `index.js` calls at boot and on every settings change — and
`index.js` is the file this port replaces. So the tool was never offered to the
model and no map could come into being.

`src/tracker/maps.ts` calls it at boot and whenever a setting that matters
changes, and applies the same connection fallback character creation needed:
all three subsystems default to `connectionSource: 'default'`, SillyTavern's
"main API", which does not exist here.

Two things surfaced only by running the whole path end to end:

- **`getRequestHeaders()` threw**, and that was no longer right. It was written
  when nothing served SillyTavern's REST API; `worldinfo-rest.ts` now serves
  `/api/worldinfo/{list,get,edit,delete}` in-process, so those callers reach a
  real implementation and were being blocked over a header the shim ignores. It
  cost the Map Architect its save — the map generated and validated, then died
  on the write. The guard belongs in `installFetchShim()`, which already
  rejects unimplemented endpoints **by name**, and still does.
- **A pinned connection profile that no longer exists** was passed through with
  no model, and the provider answered "Missing or invalid required parameter:
  model" — saying nothing about the cause. `withModel()` now names the profile.
  This got worse with maps, which added three more places to pin one.

`tests/maps.ts` drives a real `CreateAreaMap` call through topology and asset
generation to a saved lorebook entry, and pins the failure path too: an
unusable reply must save nothing.

**Fixed — connections stopped following the tracker**

Character Creation and the three map subsystems each have their own connection,
all defaulting to SillyTavern's "main API". The port made them fall back to the
tracker's connection, written as a one-shot:

```js
if (source !== 'profile' || !profileId) { /* copy the tracker's */ }
```

which is wrong in a way that only surfaces later. The copy sets
`source = 'profile'`, so the *next* call sees a pinned profile and leaves it
alone — the inherited value has become indistinguishable from a deliberate
choice. Change the tracker's connection afterwards and character creation
quietly kept generating against the old model, permanently.

The settings UI compounded it: a `connection` field patched the **tracker's**
`connectionSource` whichever field it belonged to. That was harmless while
there was one connection field; the Map Architect field made it a bug, because
`mapArchitectConnectionSource` was never set, so the engine ignored the profile
and the next sync overwrote the pick. Choosing a Map Architect connection did
nothing at all.

`src/tracker/connections.ts` now *records* inheritance
(`<prefix>ConnectionFollows`) instead of inferring it from the source field, and
`sourceKeyForProfileKey()` pairs each profile key with its own source key.
Covered by `tests/connections.ts`, down to which connection the request went out
on rather than only what the settings say.

**Done — the Adventure Companion**

A side conversation with someone who can see the campaign — memo, lorebook,
active map, recent story — and can act on it: run a tracker pass, run the
Lorebook Agent, run the map updater, or take a turn for you.

Every one of `adventure-companion.js`'s own imports was already in the tracker
closure, so the port grew by one file. What it needed was the surrounding
plumbing:

- **`act_for_user`** takes a turn by typing into SillyTavern's `#send_textarea`
  and clicking `#send_but`. There is no such DOM here, and that action is the
  point of the feature. `compat/browser-env.ts` gives those two ids working
  stand-ins wired to `setChatInputSink()` — a deliberate, named exception to the
  inert document. Without a sink they report **busy**, which the engine surfaces
  honestly, rather than claiming a turn was taken.
- **Prompt assembly stays upstream's.** The context builders are module-private
  because upstream's UI lives in the same file. `scripts/port.mjs` gained an
  `EXTRA_EXPORTS` table that appends an export statement for named internals —
  a reproducible transformation, and it *fails the port* if upstream renames
  one, rather than silently dropping a feature. Re-implementing prompt assembly
  in the port is exactly how a fork drifts from the engine it tracks.
- **The manual is bundled.** Tutorial mode answers questions about the extension
  by fetching `docs/multihogDnDdoc.md` from its SillyTavern folder. That path
  does not exist here and the engine degrades to "documentation could not be
  loaded", leaving the mode with nothing to teach from. The port emits it as
  `doc-md.ts` (same treatment as `style.css`) and the fetch shim serves it.
- **Its own drawer tab**, rather than upstream's floating detachable window.
  The transcript is owned by the backend and repainted whole: a second copy in
  the frontend would be a second history to disagree after a chat switch.

On a connection profile the engine deliberately does *not* send native tools —
`ConnectionManagerRequestService` forwards them unreliably — so actions arrive
as `<companion_action type="…">` text that the engine parses. That is the path
this port uses, so it is the path under test.

**Fixed — the narrator was never given the rules**

`sysprompt.txt` is 377 lines and 54 sections: how to roll, how combat resolves,
quests, loot, XP, resting, the status footer, party benching, mapping. It is
what makes the narrator play the game the tracker is tracking.

**None of it had ever been sent.** Upstream assembles it in `index.js`'s
`buildSysprompt()` and writes the result into SillyTavern's *Main prompt*
textarea through the `autoApplySysprompt` runtime action. That is a preset
surface with no Lumiverse equivalent, so the port left the action throwing and
nothing took its place. The text was bundled in `constants.js` the whole time,
read by nothing but the cartridge differ.

The visible cost: the Narrator Configuration toggles looked live and, for the
narrator, mostly were not. They gate the tracker's own bookkeeping and — in the
maps case — tool registration, but the rules that teach the model to *produce* a
quest or a loot drop never reached it.

There is no preset here, so delivery goes where every other injection in this
port goes: `src/tracker/sysprompt.ts` assembles it and the interceptor puts it
ahead of the conversation. `buildSysprompt()` is rebuilt rather than ported
(it lives in the file the port replaces) and follows upstream line for line —
same order resolution, same transforms, same CYOA exclusion. It is rebuilt per
generation, because the Control Room toggles, the time-format switches and the
RNG switch all change the text.

`autoApplySysprompt` and `fetchBaseSyspromptRaw` are no longer throwing: by the
time anything asks for the prompt to be applied, it already has been.

**Done — the System Prompt Control Room, and Game Systems**

`game-systems.js` came across for its assembly logic. The settings surface
gained a **Narrator ruleset** section listing every section in render order with
a switch, the assembled size in KB (it is ~25 KB of every prompt, and switching
parts off is usually about that number), and any Game Systems — a custom rule
plus the field that tracks it. Switching a Game System off also disables its
prompt section, or the rule would stay in the prompt with the system off.

A master switch, **Send the narrator ruleset**, turns the whole thing off for
users whose own preset or character card already covers this ground.

**Deferred from this slice** — the AI Game System Wizard
(`openGameSystemWizard`, `runAiSectionBuilder`, `showSectionEditor`) is a
multi-step generative UI, and section *reordering* is a drag list that fits the
drawer poorly. Neither blocks defining a system by hand or controlling what the
narrator is told.

**Fixed — the Lorebook Agent could never reach a model**

The agent has its own connection (`routerConnectionSource`), defaulting like all
the others to SillyTavern's "main API". `router` was missing from
`CONNECTION_PREFIXES`, so every agent pass went out with no model and came back
`Missing or invalid required parameter: model`.

It hid well: a failed pass logs itself and the tracker carries on, and
*tool-driven* writes kept working — so the agent log filled with "Agent tool
update" entries and lore kept appearing, while the agent's own passes had never
once succeeded. Sixth instance of this same default; the fix is one list entry.

**Done — the Lorebook Agent's settings and Modular Repertoire**

The port exposed 5 agent settings; upstream has 14. Added: the agent's own
connection, lookback mode, max agent turns, max active entries, keyword overflow
allowance, basic mode, native keyword activation, include-hidden, undo-on-swipe.

Lookback mode is three choices stored as **two booleans**
(`routerLookbackSinceLastRun` / `…SinceLastUser`), which no single control can
drive. `lookbackModeFrom`/`lookbackModeTo` translate between the pair and one
derived `routerLookbackMode` the form binds to; the derived key is expanded on
patch and never stored, so there is no setting that nothing reads.

`src/tracker/modules.ts` and `src/ui/modules.ts` expose `settings.routerModules`
— the record types the agent may write (people, places, factions, quests,
events, world reports), each with its field layout and the rule deciding when
one gets written. Those rules are where most of the agent's behaviour lives:
"ONLY record a quest if the player unambiguously begins to pursue one" is the
difference between a quest log and a list of tavern rumours, and it is one
editable sentence. Reset is offered per type, and only once something differs
from the shipped rule.

Defaults are read through their getters rather than snapshotted — several are
assembled from other settings and a copy would go stale.

Upstream renders the field layout as draggable chips; this is the same
pipe-separated string the engine stores, which does not imply a reordering
gesture the port has not built.

**Done — the Game System Wizard**

Describe a mechanic in a sentence and a model drafts both halves: the rules the
narrator follows, and the tracker field carrying the number. Saved as one
bundle, so switching it off takes its rules out of the prompt and deleting it
takes the prompt section and the field with it — an orphaned section would stay
in every prompt with nothing left to switch it off.

`generateGameSystemDraft` and `saveGameSystemFromPreview` are the engine's own,
re-exported through `EXTRA_EXPORTS`; only the two-step UI is rebuilt. Nothing is
saved until the draft is approved, and both halves are editable in the preview —
the model gets the shape right and a detail wrong often enough that fixing one
line beats regenerating.

A tracked value needs a **driver** — time, a narrator annotation, or a number
stated in the prose. Saving without one is refused, because a field nothing
moves sits at its starting value forever.

**Done — Campaign Records**

Its own drawer tab: what the agent has filed, grouped as people, places,
factions, quests, events and world reports, each with its entry count, how many
are **active** (injected into every prompt), and roughly what they cost. Entries
open on demand rather than pushing the whole encyclopedia into the panel.

Token counts are estimated at 4 characters per token and labelled as
approximate — the host does not expose the tokeniser for the user's connection,
and a rough number they can act on beats none.

Books whose names match no known suffix are left out entirely: those are the
user's own lorebooks, and folding them into a group would misattribute them.

**Fixed — two settings that did nothing**

`refreshQuestPrompt` and `rebuildNpcInstructionIfNeeded` were registered as
no-ops beside the genuinely inert DOM actions. Neither is a DOM chore: the first
rewrites the stored quest prompt from the deadline and frustration toggles, the
second rebuilds the agent's module instructions from settings like the
relationship scale. So "Quest deadlines" left the DEADLINE rules in the prompt
either way, and changing the relationship maximum never reached the agent.

**Done — the map viewer, the agent's activity, and the terminal**

One drawer tab, because these are read together: looking at a map usually ends
in telling the Map Updater it is wrong.

`dungeon-map-graph.js` turned out to be **DOM-free** — the `document` it takes
is the *map* document, not the browser's — so it renders SVG on the backend
beside `renderer.js`, and the frontend injects markup the host sanitises. Two
things were wrong on the first attempt, both found by running it: the map lives
in a `[MAP]` section of the entry content (or, for older entries, extension
metadata — `getDungeonMapAttachment` resolves both), and
`parseDungeonMapDocument` returns `{ document, migrated }` rather than the
document. The result was a valid-looking 64-character SVG of nothing.

Maps render **player-facing by default**: the graph builder hides undiscovered
areas, and drawing the unexplored half of a dungeon into a panel the player is
looking at spoils the thing the Architect was asked to build. Revealing is one
deliberate toggle.

`settings.routerLog` and `settings.activeRouterKeys` had been written every pass
and read by nothing. Recent passes now show what each changed, and the active
set shows what is being injected right now — with a way to drop one, which is a
real lever rather than a debug view: an entry that should not be there costs
tokens on every single turn.

The terminal targets all five subsystems. Each already accepted a direct
instruction; this routes to the right one. The Map Architect is the exception
and says so — it is driven by the narrator calling `CreateAreaMap` with a
structured brief, and inventing one here would build a map nobody described.

**Done — the NPC library and the memo backup**

The library is the shelf of characters you keep *between* campaigns, as opposed
to the agent's NPC entries which belong to one. It sits under Campaign Records,
because the two answer neighbouring questions: who this campaign knows, and who
you keep.

Capturing out of a campaign is the direction that saves work — an NPC the agent
has been writing for twenty turns is worth keeping and retyping is not — so
"Keep from this campaign" lifts the card straight out of the tracker state.
`extractLibraryIdentityContent` strips the campaign-specific relationship lines
on the way in, so a card taken from one game does not arrive in the next already
resenting a player it has never met. Bringing one back in goes through the
tracker's direct-prompt path rather than editing the memo by hand.

Two things caught by running it. `serializeNpcPackage` returns the package
*object*, not text — exporting produced `undefined`. And my first test fixture
invented the relationship line format; the engine's is `Friendship/Rapport:`,
and its strip was right all along.

Memo recovery is now wired to chat open and to every commit. It is a second
copy of the memo for the case `memoHistory` does not cover: the settings tree
itself coming back short. The engine's conservative logic comes across
unchanged — it only offers a restore when the backup is meaningfully larger, and
**refuses to replace a backup with a shorter one**, which is the whole point
given the case it guards against is a memo that came back short.

In SillyTavern the backup was per-browser `localStorage`; here that is
`spindle.userStorage`, so it is per-user on the server. A better backup, but it
no longer protects against "this browser is the odd one out".

**Done — campaign branching and cloning**

A campaign is not just the chat: it is the tracker state for that chat, a stack
of lorebooks named after it, and relationship values keyed by `Book::UID`. Fork
the chat and leave that behind and the branch opens with no character, no lore,
and every NPC back at zero — silently.

**The port inverts upstream's design, and it is better this way.** Upstream owns
the gesture: a "Branch Campaign" button calls SillyTavern's `createBranch()` and
then copies the state. Lumiverse gives an extension no way to fork a chat, but
it **emits `CHAT_FORKED`** when the user forks one. So forking stays the host's
job and carrying the campaign becomes the extension's, which is the right split
— and it covers every fork made through Lumiverse's own UI, which a button of
ours never could.

The remapping comes across from the engine unchanged, because it is the part
that fails quietly: relationship values and active keys are keyed by book name,
so cloning the books under new names without following the keys leaves a branch
that looks fine until you notice nobody remembers you.

Carrying is idempotent by omission — `CHAT_FORKED` and the chat switch behind it
can both land, and a second copy would leave a duplicate lorebook stack.

**Copy world** (in Campaign Records) duplicates the lorebooks under a new name
*without* the chat state: a fresh run in a world you have already built, rather
than the same campaign twice.

**Done — Game Cartridges**

A named snapshot of every setting: the narrator ruleset and its section order,
Game Systems and custom fields, the agent's record types and prompt templates,
CYOA setup, dice and display flags. Exportable as JSON, importable, loadable.

The 32 DOM call sites are all in the dialogs — the share popup, the file picker,
the manage window. The snapshot and restore underneath them are DOM-free, so
`buildCartridgePayload` / `applyCartridgePayloadKeys` came across and only the
dialogs were rebuilt.

**Selective load is the important half.** `applyCartridgePayload` replaces every
field, which is rarely what anyone wants — someone taking a cartridge for its
Game Systems will not expect their dice settings to move with it. A cartridge
opens into its `CARTRIDGE_PAYLOAD_GROUPS` with everything ticked, and anything
unticked is left exactly as it was.

Two boundaries worth stating, both upstream's and both now pinned by tests:

- A cartridge carries **configuration, never a playthrough** — no chat state, no
  memo, no lorebook entries. Sharing one hands over a setup, not a campaign.
- **No connection settings are in the payload**, so a shared cartridge cannot
  repoint someone's subsystems at profile ids that do not exist for them.

An import is stored, not applied. A cartridge replaces configuration wholesale,
and importing one should never change how the game plays until asked.

One honest wrinkle: the Lorebook Agent group reads as "changed" on any live
install, because its module instructions are rebuilt from current settings and
so never match the raw factory snapshot. The stock chip is a hint, not a claim
about what the user did.

**Done — portrait generation and the theme system**

Upstream reaches four image providers directly — Pollinations, AI Horde,
SillyTavern's native image extension, an OpenAI-compatible endpoint — each with
its own key handling and polling. None of that is needed here: `spindle.imageGen`
is the host's own image generation over the connection profiles the user already
configured, so the port asks the host and lets it deal with providers. That
replaces roughly 600 lines of upstream with one call.

The prompt is still upstream's — `generatePortraitPrompt` reads the entity out
of the CHARACTER, PARTY and COMBAT blocks, so the portrait matches the character
the tracker has been describing rather than the name alone. "Describe them"
writes the prompt *without* drawing, because the image model is the expensive
half and reading the prompt first is how you find out the tracker thinks your
ranger is a dwarf before paying to see it. An edited prompt is what gets drawn.

The result is stored as a **Lumiverse image URL, never a data URL**: the
engine's `persistPortraitSrc` only uploads when handed base64, and its upload
path is SillyTavern's REST API. Passing the URL short-circuits that entirely.

The theme is a map of `--rt-custom-*` variables the engine's stylesheet already
reads, so applying one is a style block in the frontend and no engine change at
all. Its wizard prompt is a `const` inside upstream's dialog function, so
`scripts/port.mjs` gained a **`LIFTED_CONSTS`** step that lifts the literal into
an export — one copy of the prompt, and a rename upstream fails the port rather
than shipping a stale one.

Two things the tests caught, both the kind that would have shipped silently:

- `imageGen.listConnections()` was called with no user. This is an
  operator-scoped extension, so it threw — and the failure surfaced as "userId
  is required" where the user would have read "no image gen configured". Sixth
  or seventh time the fake host's operator-scope modelling has earned itself.
- The cast list picked up **"HP"** as a character, because `HP: 8/8` starts with
  a capital. Stat lines are now skipped.

A palette goes straight into a stylesheet, so model output is sanitised: unknown
variables are dropped, and so is any value carrying a brace or semicolon that
could close the rule and write arbitrary CSS. Undo is prominent because a bad
palette can make the panel unreadable, and the button that fixes that must not
be one you have to read the panel to find.

**Done — immersion (the scene view)**

Where the party is, who is with them, and the art for it. `immersion.js` is
DOM-free like the map renderer: `buildImmersionSceneState` reads the memo and
the campaign's Locations book, `renderImmersionViewHtml` returns markup, and
both run on the backend beside `renderer.js`.

It sits at the top of the Scene tab, above the maps and the agent's machinery,
because it is the one surface about the *place* rather than the numbers.

Scene art goes through `spindle.imageGen` and is stored under
`settings.customLocationImages[path]`, which is where the renderer looks. The
prompt asks for an establishing shot with **no people in it** — the scene view
already shows the NPC portraits, and figures in the background would fight them.

**Auto-generation on arrival is deliberately not wired.** Upstream fires it
whenever the party enters somewhere new; on a paid image endpoint that is a bill
arriving without anyone asking for it. `_rpgCheckRealtimeSceneArt` stays inert
and drawing is a button. `_rpgRefreshImmersionView` is now a real repaint,
because the party moving is exactly when the scene goes stale.

---

## Trimming superseded CYOA choices

`src/features/cyoa-prompt-history.js` -> `src/tracker/cyoa-history.ts`

In CYOA mode every narrator turn ends with a `<choices>` block, and those blocks
stay in the chat forever. That is right for the transcript and wrong for the
prompt: nothing was removing them on the way out, so by turn thirty the model
re-read two dozen dead menus every single turn — paid for on every turn, and the
oldest ones serving as formatting examples.

Upstream keeps the four newest and drops the rest, on a disposable copy of the
prompt. Every choice stays visible and clickable in the chat; only what the model
is charged to re-read changes.

The port does it in the interceptor, which is a **better** place than upstream
has: Lumiverse hands over an already-assembled prompt, so there is no live chat
array to be careful about. `stripSupersededChoicesFromChatPrompt` is the engine's
own function, unmodified — it takes an OpenAI-shaped array, which is exactly what
an interceptor receives.

Two details carried over deliberately:

- **Only assistant content is eligible.** The CYOA instruction block carries
  worked `<choices>` examples and the engine prepends it to the *user* message,
  so restricting the sweep to assistant turns is what keeps the model's own
  instructions intact. A player who typed `<choices>` at the narrator is left
  alone for the same reason.
- **It is not gated on `settings.enabled`.** Upstream is explicit: powering the
  framework down must not leave stale menus steering the model. The CYOA module
  toggle and `cyoaConfig.stripOldChoicesFromPrompt` gate it; the master switch
  does not.

`stripOldChoicesFromPrompt` was already in the ported defaults (`true`) with
nothing reading it. It is now a toggle under Game Systems.

---

## The full audit

`runStateModelPass(narrative, isFullContext)` -> `runFullAudit()` in `state-pass.ts`

The incremental pass only ever reads the last turn, so anything it misses stays
missed. The audit is the repair: it walks the whole chat in chunks and rebuilds
the sheet. Until now `_rpgRunStateModelPass(_, true)` logged a warning and ran
the incremental pass instead — loud, but still the wrong operation.

Chunking follows upstream: `Name: content` lines, four characters per token,
chunks sized at the budget minus 3,000. Upstream sizes that budget from
SillyTavern's `contextSize`; Lumiverse does not hand an extension the assembled
context budget, so `fullAuditMaxTokens` is the lever here rather than a
fallback, and it is now a settings field instead of a defaults entry nothing
read.

**Each chunk commits as though it were a completed turn.** That is upstream's
design and the thing that makes chunking work at all: chunk N is shown the memo
chunk N-1 produced, so the audit accumulates rather than every chunk arguing
over the same starting state. It also means an interrupted audit leaves the
sheet further along rather than broken, which is why stopping partway is not
treated as a failure. A chunk that returns nothing is skipped and the run
continues — losing a whole campaign's audit to one weak reply is how a user
learns never to press the button again.

The panel is told which chunk it is on. On a long campaign this runs for
minutes, and a status line that only said "working" is indistinguishable from a
hang.

### Three prompt-assembly bugs it sat on top of

Writing the audit's variant of `buildSystemPrompt()` exposed three things wrong
with the incremental one:

- **`fullReviewStateMode` did nothing.** The toggle has been in settings since
  the port began. Upstream swaps the core prompt for
  `FULL_REVIEW_STATE_SYSTEM_PROMPT` and the closing instruction for
  `FULL_REVIEW_USER_PROMPT_SUFFIX`; the port always sent the incremental pair.
- **`useDdMmYyFormat` never reached the prompt.** The core prompt teaches the
  memo's time format by example (`[Day 3, 14:00]`), so leaving the examples
  alone while the renderer shows real dates trains the model to write a format
  nothing else uses.
- **`trackerHistoryCount` was cosmetic.** It is how many past memos the model is
  *shown* — upstream stacks them as `TRACKER STATE -2`, `-1`, `0` — not only how
  many are archived. The port kept the archive and dropped the prompt half.

---

## Instant Action

`quickstart.js` -> `src/tracker/quickstart.ts`

Pick a genre, get a character and a started story. The counterpart to the roll
picker, which asks six questions and shows the sheet before committing; this
one commits unattended, which is the entire point of it.

Upstream's file is the orchestration plus a jQuery status line and
`bindQuickStartEvents` wired to onboarding markup this port replaces, so the
sequence is rebuilt over the engine functions it calls — all of them ported and
unmodified: `getArchetypesForGenre`, `generateQuickStartCharacter`,
`generatePersonaBio`, `addPlayerCardToLorebookAgent`, plus the
`instant-action-instructions` helpers.

**One upstream step is deliberately dropped.** Upstream then calls
`activateSillyTavernPersona()`, which reaches into
`power_user.persona_descriptions` and creates a persona named after the
character. `st-core.ts` exports none of those globals, so the call would throw —
and it is not needed: SillyTavern used the persona name as `{{user}}` in the
prompt, whereas here the name reaches the narrator through the memo and the
Player Card, both already written by the preceding steps. Creating an
account-level persona for someone who asked for a character would be the wrong
trade even if the shim existed. The test asserts no persona appears.

Three model calls deep, so it reports each step by name, and it lives in the
panel's empty state — the one moment when the answer to "now what?" is a
character you do not have.

---

## Editing a map, and undoing what changed it

`map-editor-lib.js` -> `src/tracker/map-edit.ts`

The viewer landed first, and a map you can only look at is a map you can only be
annoyed by. Upstream's editor is a graph canvas in `src/ui/panel/**` — the part
this port replaces wholesale — but what it *validates* with is
`map-editor-lib.js`, which is DOM-free (its `document` parameters are map
documents, not the browser's) and ports intact. So the rules come across and a
text editor goes in front of them, the same trade the raw memo editor makes.

### Validate before normalising

The obvious wiring is wrong, and the tests caught it. Handing the text to
`parseEditableDungeonMapJson` (the engine's own parser for upstream's Raw JSON
tab) and validating the result **passes edits that should fail**: that parser
normalises, so an exit pointing at a room that does not exist is *dropped* and a
duplicated area id is *reassigned*. The validator then sees a clean document,
reports nothing, and the save succeeds with the connection you typed silently
missing.

So the raw parsed object is validated first. A wrong edit now comes back named —
`$.areas[0].connections[0].to: Unknown area "..."` — instead of quietly
discarded.

### What the undo covers, exactly

Two snapshots: every save the editor makes, and **the state of a map when you
open it**. The second is the one that bites — you open a map, find the Updater
has invented a corridor, and want the version you last looked at.

It does not snapshot every intermediate write a pass makes. Those go through
`replaceDungeonMapSection` in a dozen call sites inside engine modules this port
must not hand-edit; upstream catches them by hanging map snapshots off the memo
history's `historyIndex` scrubber, which this port still does not have.

Export and import go through `createPortableMapPackage`, which strips host
identity and per-asset runtime provenance — a map lifted out of one campaign
must not carry "the party opened this in session four" into another.

---

## Chat rename migration — not needed on this host

`chat-rename-migrate.js` (305 lines) is **deliberately not ported**, and the
reason is structural rather than a matter of effort.

In SillyTavern a chat's id *is* its filename, so renaming a chat changes the id,
which re-derives `getEffectiveRouterCampaignPrefix()` and detaches the whole
lorebook stack. Upstream's file exists to pin the prefix back.

Lumiverse separates the two: `ChatDTO` carries `id` and `name` as different
fields, and `ChatUpdateDTO` can only change `name` and `metadata`. The id is
stable across a rename, the prefix is derived from the id, and there is nothing
to detach. Porting the file would add 305 lines guarding against a failure this
host cannot produce.

---

## "Apply to All" connections — covered differently

`src/state/connection-setups.js` (400 lines) is **not** ported. It backs
upstream's Connections & Models button that copies one agent's connection
settings onto the other eight.

The port solves the same problem earlier: `connections.ts` records inheritance
per subsystem, so an agent with no connection of its own *follows* the main one
rather than needing to be told about it once and then re-told after every change.
A button that pushes a snapshot outward is the fix for a model where the copy is
the only link; here the link is the model.

---

## Shipped-prompt updates

`prompt-diff.js` -> `src/tracker/prompt-defaults.ts`

The extension ships roughly 25 KB of prompt text, and an update can change any of
it. Upstream fingerprints the shipped defaults and, on the first load after they
move, shows what changed with a per-line diff and a badge per category. This port
had none of it — the fingerprint sat in the defaults with nothing reading it, so
updated prompts either overwrote silently or never arrived, depending on which
key the user had touched.

**The badge is the point.** "This changed" is not actionable; `does your copy
still match what shipped before` is. `getPromptCategoryImpactBadge` answers it,
and the dialog starts a category **unticked** when you have edited it — a
ticked-by-default box on customised text is a dialog that destroys work for
anyone who presses the obvious button.

Three states are acknowledged silently rather than shown, all of them upstream's:
a fresh install, an install predating fingerprint tracking, and a fingerprint
that moved without any user-visible text changing. Dismissing the dialog counts
as "keep mine" — an unanswered dialog that returns every load is one people learn
to close without reading.

Upstream's fourth button, "Save as Cartridge & Update All", is not reimplemented
inline: cartridges already have a tab that does exactly that, and the dialog
points at it rather than growing a second flow that snapshots a configuration.

---

## Display Groups

`src/features/display-groups.js` (already ported) -> `src/tracker/display-groups.ts`

Fold several tracker cards into one — hunger, thirst and temperature under
"Survival". Upstream's own docstring is clear that this is presentation only:
groups "never alter memo blocks, prompts, module activation, or Game System
ownership".

`renderer.js` has called `buildDisplayGroupRenderPlan()` on every repaint since
the panel landed, so a group in settings has always been drawn — there was simply
no way to make one. This is the editor, and `normalizeDisplayGroups()` is
deliberately its only writer: it caps the counts, drops excluded tags, and
resolves a module claimed twice. Re-normalising after every change means the
stored shape cannot drift from what the renderer expects.

Two consequences are surfaced rather than hidden. A new group is created *with*
its first member, because the engine drops memberless groups and an empty row
would vanish on reload. Removing a group's last member deletes the group, for the
same reason.

---

## Four leaves out of `src/ui/panel/**`

That directory is the part of upstream this port replaces wholesale, but four
files in it import nothing and assume nothing about SillyTavern, so they came
across intact.

**`card-synopsis.js` (95 lines).** A stored NPC or PC card is a wall of labelled
fields, so the records browser showing its first 240 characters showed
`Species: ... Body: ...` — headers, not a person. This pulls the appearance line
out and takes its first sentence. It also has a fallback for content that is not
card-shaped, which is most of a lorebook, so places and factions get their own
first sentence rather than a hard cut. The NPC library uses the longer blurb
(appearance plus personality) beside the portrait.

**`refresh-coalescer.js` (33 lines).** A single turn can ask for a panel repaint
half a dozen times — the tracker pass commits, the agent finishes, World
Progression writes, the map updater runs — and each one re-rendered the whole
memo and shipped the markup across. Repaints now collapse into the run in flight
plus at most one more with the newest arguments. The property that makes this
safe is that the **last** caller still wins; the panel ends on the newest state,
it just stops rendering the intermediate ones nobody sees. That also stops a
burst from cutting the bar animations off mid-flight.

**`xp-gain-animation.js` and `bar-change-animation.js` (404 lines).** These use
the DOM — the *real* one. They read data attributes off markup `renderer.js`
already emits, against CSS classes the ported stylesheet already carries, and
drive `requestAnimationFrame`. So they run unmodified in the frontend and the
only missing piece was calling them.

`panel:render` now carries `chatId`, because both work by capturing the visible
numbers before the markup is replaced and replaying them into the new markup.
That comparison is only meaningful within one chat: a bar sliding from another
campaign's values is worse than no animation. Both honour
`prefers-reduced-motion` by shortening rather than removing — the count is
information.

Two fixture mistakes worth recording, both the same shape as earlier ones:
`getBarChangeTransition` requires `animateChanges` on the incoming snapshot (a
bar the renderer did not mark stays still), and the capture path gates on
`instanceof HTMLElement`, which does not exist in a Bun process. The engine was
right both times.

---

## Searching the settings

`src/ui/settings-search.js` is **not** ported, and the reason is that it would be
the wrong 419 lines. Upstream walks SillyTavern's drawer markup looking for
`label`, `.checkbox_label`, `small`, `select` and the rest, because it did not
build that markup. This port did: the settings surface is generated from
`SETTINGS_SCHEMA`, so the index is built as the fields are rendered and the
filter is a few lines over it.

Three details it keeps: a collapsed group holding a hit is **forced open** (a
match inside a closed `<details>` is the same as no match), clearing the query
restores the schema's own open state rather than leaving the page unfolded, and
the **settings key** is part of the haystack — someone reading a log line about
`routerCampaignPrefix` can paste it in and land on the field, even though
nothing on screen says that word.

The editors embedded in a section — the Modular Repertoire, appearance and
display groups, the narrator ruleset, cartridges — are not schema rows and
cannot be filtered field by field, so each is indexed once against the words
someone would search for to find it. Otherwise searching "theme" hides the panel
that does themes.

---

## The hand-editing surfaces

`ui-editors.js` -> `src/tracker/blocks.ts`, `src/tracker/sections.ts`

2,056 lines, ported with the rest of the engine and then **called by nothing**.
It went unnoticed because its subject matter was reachable another way: the Game
System Wizard invents a tracked module for you, so modules existed and the gap
looked like a UI preference rather than a missing capability. The shape of it,
once seen, was consistent — *anything a model can generate for you worked;
anything you would want to adjust by hand afterwards did not.*

Four surfaces, all of them writing settings the engine had been reading the
whole time:

**Card order.** `renderer.js` has read `settings.blockOrder` since the panel
landed. Nothing wrote it, so the order was the shipped default permanently.

**Switching a card off.** `settings.modules[tag]` was equally unwritten — and
this one is not cosmetic. `buildModulesInstructionText()` builds the tracker's
prompt from the enabled set, so switching Inventory off removes its block from
what the model is asked for, not just its card from the panel. The test measures
that directly (3 references down to 1, 19,681 chars down to 18,150) and records
the residue honestly: one mention survives inside *another* module's
instruction, which is the engine's own cross-reference and not a leak.

**Custom modules by hand.** Create, retune, delete. The hard part is the rename
cascade: a module's tag is a foreign key living in six places — `blockOrder`,
every Display Group's `members`, `gameSystems[].customFieldTag`,
`modulePageSizes`, `categoryRenderOptions`, and the deleted-tag tombstones.
`renameCascade()` follows upstream's save handler step for step rather than
approximating it, because every one of those, missed, fails silently: a card in
the wrong position, a group quietly one member short.

**What a built-in module asks for.** `settings.stockPrompts` is read in
preference to the shipped defaults, so this is the text the tracker actually
gets. One caveat is surfaced rather than discovered: the **quests** prompt is
derived, not authored — `refreshQuestPrompt()` regenerates it from the shipped
text whenever a quest toggle moves, so an edit there lasts until the next
toggle. The editor says so on that module only.

### Card schemas

`npcCoreSections` / `pcCoreSections` are what the Lorebook Agent writes character
cards against, and each section's `description` is an instruction the model
follows rather than a label — several run to a paragraph arguing what belongs in
that section and what does not. They reached the model already; they were simply
not editable, so the only way to change one was the prompt-defaults dialog's
reset.

Editing one rebuilds the agent's NPC instruction immediately, because otherwise
the settings and the prompt disagree and only the prompt is consulted.

### Still not reached

`handleCategorySettings` — the per-category render options — remains unbound,
and `panel-controls.ts` still removes its button with a stated reason. It is
presentation-only and the one genuinely cosmetic thing in that file.

---

## The summarizer requirement does not transfer

Upstream's README says a summarizer is **mandatory** and recommends
Summaryception. That is true of SillyTavern, which has no memory of its own —
without something to compress the context it grows without bound.

Lumiverse does not have that hole. `spindle.memories` exposes a hybrid memory
architecture: vectorised chat chunks behind the `{{memories}}` macro, an entity
graph with salience scoring and typed relations, tiered consolidations, and
vaults that can be attached across chats. There is no summarizer to install and
nothing in this extension to configure for it.

### What does transfer is the pairing

Upstream's design has the summarizer keep a rough arc while the Lorebook Agent
keeps precise records. On this host both jobs land on the same machinery, so
left alone the two duplicate: the Cortex infers "this person seems important"
from prose while Multihog already knows exactly who is in the party, at what
standing, and whether they are alive.

`src/tracker/cortex.ts` hands over the half Multihog is authoritative about —
the player character and party, the tracked cast, mapped sites, relationship
standing as real graph edges with signed sentiment, and deaths as a status
change rather than an inference. Those go in at `confidence: 1` and never
`provisional`, because they are not extracted from prose: they are the tracker's
own state, which the user can see and correct.

Three properties the tests hold to:

- **Off by default.** This writes to account-level memory that outlives the
  extension and is readable by everything else on Lumiverse. Installing a
  tracker does not imply consent to that.
- **Upsert, never insert.** A commit fires this often; a graph that grew a
  duplicate party member every turn would be worse than no sync at all.
- **Two passes, entities then relations.** `relations.upsert` drops an edge
  *silently* when an endpoint is unknown, so getting the order wrong would fail
  without saying so. The fake models that drop rather than papering over it.

Settings -> Lorebook Agent -> **Lumiverse memory** shows both graphs side by
side, marking names that appear in both — which is the only way to see whether
the agent is paying to re-describe someone the host already holds.

### The manual said the wrong thing

The bundled manual still recommended Summaryception, twice, and the Adventure
Companion loads it into its prompt in tutorial mode — so asking the companion
about context growth sent you after an extension that cannot be installed here,
for a job already done. `DOC_SUBSTITUTIONS` in `scripts/port.mjs` rewrites those
two passages on the way in, and **fails the port** if either stops matching, so
an upstream rewording surfaces instead of quietly restoring the bad advice.

That guard earned its keep immediately: the first substitution I wrote targeted
`## A Summarizer is Mandatory`, which lives in `README.md` and not in the manual
at all. The port refused rather than silently applying one of two fixes.

---

## The character card was never reaching anything

`ctx.characters?.[ctx.characterId]` is read at eight call sites — in
`character-creator.js` (three), `portraits.js` (three) and `narrative-hooks.js`
— and **every one of them was getting `undefined`.**

`context.ts` exposed both fields, but `setActiveCharacter` and `setCharacters`
were never called by anything, so the id stayed `null` and the list stayed
empty. `charId !== undefined` is true for `null`, so the guard passed and the
lookup returned nothing.

The visible effect was that rolling a character — by Instant Action or by hand —
had no idea which campaign it was for, and the portrait prompts had no world to
describe. Nothing threw, and a generic character reads as a bland model rather
than as a wiring fault, which is why it went unnoticed through the whole port.

`loadActiveCharacter()` now resolves `chats.get(chatId).character_id` ->
`characters.get(...)` on every chat change. `characterId` is an **array index**
in SillyTavern, not an id — `narrative-hooks.js` checks
`Array.isArray(ctx.characters)` before indexing — so the mapping keeps that
shape exactly: a one-element array with the index at 0.

### The opening scene, which SillyTavern never had

Upstream's card snippet is `name — description`, because that is all the object
carried. Lumiverse also has `scenario` and `first_mes`, and those are the better
answer to what the generator is being asked: not "what is this world" but "who
is about to walk into *this* scene". Instant Action now sends both.

Two hazards came with that, both caught before shipping:

- **The story must not be echoed back.** The instruction text is also what
  `buildInstantActionOpeningMessage()` puts in the chat as "Initial Setup:", so
  folding the scene into it would read the story back to the narrator that just
  told it. The user's setup and the generation context are now two values, and
  only the first reaches the chat.
- **A scenario's level is not the player's level.**
  `extractInstantActionLevel()` scans for `level 5` and treats a hit as the
  character's starting level. A card saying "a level 5 threat guards the vault"
  would have quietly made the player level 5. `defuseLevels()` strips the digits
  from the borrowed text only — the user's own "start at level 7" keeps every
  one of them.

---

## Which lorebooks the tracker reads

Asked whether the card's lorebook gets read, the answer turned out to be "no,
and neither did any other" — `buildLorebookContext()` returned an empty string
in every configuration, for two stacked reasons.

**`ctxWorldInfo` defaults to `false` and was never exposed.** The feature could
not be switched on at all.

**And with it on, the "every book" branch was broken.** It calls
`stCtx.getWorldInfoNames?.()` *synchronously*, and this port made that function
`async`. A Promise has no `.length`, so it took the retry path, got another
Promise, fell through to a REST fetch the shim rejects, and finally tried to
iterate the Promise — into a `catch` that only warns. Always empty, never a
word in the log.

### The obvious fix was wrong

Making `getWorldInfoNames()` synchronous satisfies both callers on paper —
`router.js` awaits it, and `await` on a plain array is harmless. It also
**emptied the map manifest**, which the workshop test caught immediately.

The lazy `ensureIndex()` inside the async version is load-bearing: books are
created through paths that do not all go through `saveWorldInfo`, so the name
index goes stale, and a cold read rebuilding from the host is what covers that.
A synchronous read cannot rebuild. Two further attempts — refreshing the index
eagerly on chat change, then keeping it across invalidation — both left the
manifest empty, because the staleness is created *after* those points.

So the function stays async and the call site is fixed instead:
`applyLoreScope()` fills `settings.lorebookFilter`, and `buildLorebookContext()`
uses the filter directly whenever it is non-empty, never reaching the broken
branch.

### The card names its own books

`CharacterDTO.world_book_ids` is the thing SillyTavern never had. Upstream read
every book in the account because it had no way to tell which belonged to the
campaign; on a machine with six campaigns that is five campaigns of irrelevant
lore, paid for on every tracker pass.

`loreScope` now offers the card's own books (the default), every book, or
"leave my filter alone" for anyone who curated one. A card with nothing attached
resolves to a sentinel that matches no book — because an empty filter means
*every* book, which is the opposite of what that scope asked for.

**Character generation still reads no lore, on either platform.**
`character-creator.js` never touches a lorebook; what it gets is the card's
name, description, scenario and opening scene.

---

## What a chat switch has to clear

Three bugs, one shape: **`loadActiveCharacter` could set state but not unset
it.** It reset `characters` and `characterId` up front and then returned early
on each path where no card resolves — no chat, no `characters` permission, a
chat with no card, a deleted card. Everything after those returns belonged to
the chat before.

So switching from a campaign into a freeform chat left:

- **`settings.lorebookFilter` still naming the last campaign's books.** The
  tracker read one story's lore while summarising another. That is worse than
  the bug it followed: an empty context is visible, a confidently wrong one is
  not.
- **`{{char}}` still naming the last card.** `narrative-hooks.js` reads
  `ctx.name2` as the active character in two places.

The fix is structural rather than one more branch: the resolve half moved into
its own function, and the caller now always resets, always re-derives the lore
scope, and treats a thrown lookup the same as an absent card.

`loreScope: 'card'` with no card at all resolves to the same matches-no-book
sentinel as a card with no books attached. It used to fall through to "every
book", which is not what that scope asked for either.

### `{{persona}}` was answering with its own name

`substituteParams` handled `{{user}}` and `{{char}}` and passed everything else
through — the right default, until a caller tests the *result* for content:

```js
const persona = ctx.substituteParams?.('{{persona}}') || '';
if (persona.trim()) contextParts.push(`User Persona:\n${persona.trim()}`);
```

An unreplaced macro passes `.trim()`. So three prompt builders in
`portraits.js` were pushing the literal line `User Persona: {{persona}}` into
image-generation context as though it described the player.

Underneath it, `personaName` had the card's fault exactly: a setter nothing
called, so `ctx.name1` sat at the string `'You'` and `router.js` rendered
`{{user}}` as that word. The host has had `personas.getActive()` and
`personas.getDefault()` all along; both are read on chat change now.

**The fake host hid this too, for the familiar reason** — it offered
`personas.list`/`get` and neither of the two methods the real host has, so
nothing could have called them. It now models `getActive()` returning `null`
when `activePersonaId` is unset rather than helpfully falling back on its own,
which puts the fallback in the port where it can be read.

### The same rule, for work still in flight

`chat-scope.ts` had established that state at rest belongs to a chat. What it
did not cover is the gap between *starting* something and *writing* it. Three
flows spent seconds of model time in that gap and then resolved their target at
write time, so the result landed wherever the user had moved to:

- **Instant Action** — two model calls, then `addPlayerCardToLorebookAgent()`
  (which reads `ctx.chatId` itself) and an opening message. Switching chats
  mid-roll put the character sheet *and* an unasked-for "Begin the adventure"
  into the other campaign, and reported success, because from the roll's point
  of view nothing had failed.
- **Rolling a character by hand** — worse, because the draft waits in a review
  dialog for as long as the user likes. Approving after a switch ran `writeMemo`
  against the *active* chat, replacing that campaign's memo with a character
  belonging to another one. The old memo went to `memoHistory`, so it was
  recoverable — if you noticed.
- **Scene art** — the slowest call in the extension, then
  `customLocationImages` written under whatever chat was open by then.

Each now decides its chat before the first model call. Instant Action abandons
rather than retargets, because the engine function it calls resolves the chat
internally and this port does not hand-edit generated code. The roll stamps its
draft and refuses a commit into a different chat, leaving the draft pending so
switching back still works. Scene art returns the URL it paid for, and says it
was not saved.

**Nothing in the fake could produce this.** Its generation calls answer
instantly, so there was no moment at which a chat switch could be made to
happen. It now has a `duringGeneration` hook that runs inside a generation
call — the fake's fourth iteration in this port on the same lesson, which is
that a fake behaving *better* than the host tests nothing.

### Pinning the chat, rather than guarding every write

The three above are each guarded where they write. That does not scale to the
map and Campaign Records subsystems, which are generated engine code: they ask
`ctx.chatId` at the moment they write, from dozens of places, and `router.js`
names its helper `getLivePrefix()` — reading live is the deliberate design.

It is also correct *in SillyTavern*, where an extension shares a thread with the
UI and the chat cannot move underneath a call. Here it can, and the Map
Architect is the worst case: two model calls, then a save. Switching chats in
between wrote a finished dungeon to `<other chat>_Locations` and returned "Map
saved" to the narrator — so one campaign went on believing in a map that had
been filed under another.

Rather than patch generated code, the compat layer holds the answer still.
`withChatPinned()` fixes `ctx.chatId` for the length of an operation, and three
callers use it:

- **every tool invocation** (`compat/tools.ts`) — a tool runs mid-generation, so
  the chat that triggered it is the one active at dispatch; the host sends no
  chat id with an invocation, and there is nothing else to go on;
- **the post-turn pipeline** (`GENERATION_ENDED`) — the tracker, the Lorebook
  Agent, the map updater, the evolution pass and World Progression all belong to
  the turn that just ended;
- **the terminal's manual passes** — an instruction is about the chat it was
  sent from.

Pinning beats refusing here: the work belongs to the chat that asked for it, and
that chat is still there to receive it. The tracker pass, which genuinely must
not run against a moved-on chat, keeps its own `chatMirror` check and still
stops.

**Checked and found clean:** `records.ts` only reads, and `map-edit.ts` writes
to a book it already resolved by id rather than from the live chat.

### The companion's conversation went to the wrong chat

`flushAdventureCompanionForChat` carries its contract in its own docstring:
*"Must run before the live companion is swapped on chat switch."* The port ran
it after — `onChatChanged(old, new)` does flush-then-load in one call, and
`syncActiveChat` called it *after* `loadChatState()` had already swapped the
arriving chat's state in. So the flush snapshotted the **arriving** chat's
conversation and wrote it into the **departing** chat's slot.

Leave a campaign and come back and you were reading the other one's
conversation; your own was gone. The existing test went chat 1 → chat 2 →
chat 1, which is the half that works. It is the return trip to chat 2 that
loses.

The pair is split now — `flushCompanionFor` before `saveChatStateFor`, while the
departing chat is still live, and `loadCompanionFor` after the arriving chat's
state is restored.

**The in-flight case was already safe**, and is now covered: asking the
companion and switching chats mid-answer keeps the answer with the chat that
asked.

### Cortex entities were named after their hit points

`namesFrom()` strips a trailing `(Class)`, which is right for `[CHARACTER]` —
`Syg (Resonator)` — and wrong for `[PARTY]`, whose shipped format is
`Elara (Ranger): 26/45 HP`. The bracket is no longer last, the strip missed, and
the entity reached the Cortex named `Elara (Ranger): 26/45 HP`.

Entities are upserted **by name** and the HP moves every turn, so each sync
filed a *new* Elara rather than updating the one already there — and relations,
matched by name, never lined up. Every fixture in `tests/cortex.ts` used the
`Name — detail` form, which is why nothing caught it; the roster's own format is
in there now.

**Checked and found clean:** `syncToCortex` captures its chat id once and uses
that captured value for every write, so a switch mid-sync cannot split a
campaign across two chats.

### A guard is not enough when the target is looked up later

Instant Action's fix above checked `chatMirror` before writing. That held until
an unrelated change added one more `await` earlier in the switch, and the
opening message started landing in the new chat again: a chat switch completes
on an await boundary, and there is one *inside* the send.

So the target travels with the message instead. `sendChoice()` takes the chat
the turn belongs to and compares it in the same synchronous block as the append.
Check-then-act across an await is not a guard; it is a smaller window.

The test asserted the wrong thing too — that the roll *fails* — which pinned
the timing rather than the requirement. A roll that finished before the user
moved is a good roll. What must never happen is anything reaching the chat they
moved to, and that is what it checks now.

### Upstream reached the same diagnosis, with a better mechanism

Checked in October against upstream's `main`, 75 commits past this port's base
(`de2d97b`, 2026-09-06; upstream is now 2026.9.25). Upstream spent September on
this exact bug class and arrived at the same word for the fix:

```
8036044  Fix Map Evolution loading World Reports from a stale ctx.chatId
f6acdff  Fix Scene View loading another campaign's Locations via stale ctx.chatId
466ca51  Fix auto-gen loading another campaign's lorebook via stale ctx.chatId
0756821  pin dungeon map capture to its originating chat
c09b11c  pin Map Evolution world reports to the tracked chat
e3a8d10  Guard Companion cancellation and request lifetime across chat switches
```

Plus roughly 1,550 lines of new tests named for it (`chat-operation-races`,
`character-creation-races`, `autogen-chat-affinity`,
`world-progression-affinity`, `lorebook-agent-races`, `panel-import-affinity`)
and a design note, `docs/chat-ownership.md`.

Their mechanism is stronger than the id comparison used above, and the doc says
why in one line: **"Comparing chat IDs alone misses an A → B → A round trip."**
`pass-affinity.js` grew a switch *epoch* — `createChatCommitGuard` captures the
counter, `invalidateChatCommitGuards()` bumps it on a real switch, and a guard
captured before a round trip stays invalid even though the chat id matches
again.

### The call upstream makes from the one file this port replaces

`invalidateChatCommitGuards()` is called from **`index.js`** — which is the file
the port *is*. Eleven engine files the port does generate consume the guards
(`character-creator`, `map-architect`, `map-evolution`, `map-updater`,
`narrative-hooks`, `portraits`, `router`, `immersion`, `game-cartridges`,
`memo-recovery`, `map-evolution-debug`), so a re-port brings the guards across
and leaves the thing that arms them behind.

The failure would be silent in the worst way: the guards still run, still return
`true`/`false`, and simply never notice a switch — every one of them quietly
degraded to the comparison upstream wrote the doc to warn against.

So `syncActiveChat` makes the call, after the departing chat is flushed and
before anything projects the arriving one. `pass-affinity.js` itself is updated
to upstream's current version; it imports nothing, so `scripts/port.mjs`
reproduces it byte-for-byte and this is not a hand edit that will drift.

**It is inert today** — no engine file in this port uses the new guards yet —
and deliberately so: it is wired now because by the time the consumers arrive
the omission is invisible. `tests/chat-scope.ts` pins it down, and removing the
call fails exactly one check: the A → B → A one.

**The port's own guards were measured, not assumed** — and the conclusion did
not survive the re-port, which is worth recording as such. Before it, an
A → B → A round trip through an Instant Action roll landed correctly with an id
comparison, so converting looked like it would add refusals without removing a
defect. After it, the engine guards the same roll on the epoch, and the epoch
flips synchronously at a switch while the chat mirror the id comparison reads
flips some awaits later. In that gap the engine had already stopped the roll
and the port's check still said "same chat", so it reported a chat switch as a
failure. `quickstart.ts` uses the epoch now: one signal on both sides of the
seam. See "The 2026.9.25 re-port" below.

---

## What a turn actually costs

Measured against the fake host, so the numbers are structural — call counts and
prompt sizes, not wall-clock, since the fake answers instantly.

**The extension's own work is not the cost.** One turn, end to end:

| chat length | interceptor (blocking) | extension CPU | chat re-reads |
|---|---|---|---|
| 50 messages | 24ms | 24ms | 0 |
| 500 messages | 5ms | 8ms | 0 |
| 2,000 messages | 7ms | 11ms | 0 |

Flat, because the chat mirror is attached on switch rather than re-read per
turn, and the lorebook cache serves repeat passes with no host calls at all.
The post-turn pipeline is fire-and-forget, so it never blocks the host either.

**The cost is one extra model call per turn, and what it carries:**

| configuration | prompt | approx tokens |
|---|---|---|
| lore off (the default) | 25,141 chars | ~6,300 |
| lore on, `loreScope: 'card'` | 41,174 chars | ~10,300 |
| lore on, `loreScope: 'all'` | 121,214 chars | ~30,300 |

With lore off, **96% of that is the static module instructions** — 24,242
characters of them, and all ten modules are on by default (upstream's default,
not the port's). It is byte-identical turn to turn, which was worth confirming
rather than assuming: a single varying character near the start would make it
uncacheable.

`buildLorebookContext()` puts the lore block *before* the story inside the user
message, which keeps the stable half at the front where a prefix cache can
reach it. It also dumps every entry of every filtered book with no cap, which is
why `'all'` costs what it does.

### The setting that was never exposed

`stateTrackerRunEvery` has always been in the engine and always been honoured —
`onGenerationEnded` skips the State Model pass on non-matching ticks. The port
put `routerRunEvery` and `mapUpdaterRunEvery` in the settings schema and missed
this one, so it sat at its default of 1 and could not be changed.

It is the largest latency control the extension has, because the tracker is the
one model call that happens on **every** turn:

```
stateTrackerRunEvery=1:  8 passes over 8 turns
stateTrackerRunEvery=2:  4 passes over 8 turns
```

Now in the schema. The trade is real and stated in its help text: the memo lags
a turn behind.

### Prompt caching belongs to the connection, not to the extension

Lumiverse applies prompt caching in `prepareRawCall()` →
`applyPromptCaching()`, driven by **`connection.metadata`** — and extension
generations go through that same path. So enabling caching on the connection
profile the tracker uses covers the static prompt above; nothing in the
extension needs to ask for it.

The extension deliberately does **not** force `prompt_caching: true`. The host
gates it per provider for a reason: `services/caching/nanogpt.ts` warns that
sending it on non-Claude routes "biases provider selection toward cache-capable
upstreams and bypasses subscription coverage". Overriding a user's connection
configuration from an extension would be the wrong call.

---

## Where the port stands

**Engine regenerated from upstream 2026.9.25 (`d6aab00`)** — 114 files from
`scripts/port.mjs` — across 36 test suites and 1,058 checks. (Against the earlier
`de2d97b` base the count was 107 of 133 upstream files, 55,387 lines; that
figure has not been re-measured for the new base.)

Everything upstream ships is now reachable except the parts this port replaced
by design: `index.js` (the file the port *is*), `src/ui/panel/**` (jQuery panel
builders against SillyTavern's DOM), and `settings.html` (the schema-driven
surface). Those are ~28,600 lines that were never going to come across.

### Known, not fixed

**A card with a scenario softens Instant Action's rolled level and class.**
`character-creator.js` sets `instantActionLevelFallback` from
`!!instantActionInstructions`, and folding the card's opening scene into that
string makes it non-empty even when the user typed nothing. The prompt then
carries the rolled level and class as "fallback — follow the Initial Setup
instead", where "Initial Setup" now includes text the user did not write.

`defuseLevels()` takes the digits out of the borrowed half, so there is no
number for the model to follow, and the panel's own summary reads the level off
the user's text only — the two agree in every case tested. What is left is that
a strongly-worded scenario could still argue the model into a different class
than the one rolled, which is arguably the feature working. Separating the two
inputs properly means changing a generated engine signature, which is not a
hand-edit this port makes.

---

## The finishing pass

Three fixes, none of them a missing feature — each was a **silent wrong answer**,
which is this port's characteristic failure mode.

### Framework notes were arriving as narrator turns

`roleForStMessage()` in `chat-mirror.ts`

The engine splices Dungeon Reality, depth-injected lore and World Progression
into the chat as `{ is_user: false, extra: { type: 'narrator' } }`. That marker
is the whole signal, and SillyTavern's `setOpenAIMessages()` maps it to role
`system`. The port's shim read only `is_user` / `is_system`, so all of it went
out as `assistant` — **the model was shown the framework's own notes as though it
had written them, and then asked to continue from there.**

The mapping is now a named function with the table it implements in its
docstring, because there are three cases and only one of them was wrong:

| `loreInjectionRole` | `is_user` | `extra.type` | role      |
|---------------------|-----------|--------------|-----------|
| 0 (default)         | false     | `'narrator'` | system    |
| 1                   | true      | —            | user      |
| 2                   | false     | —            | assistant |

A message promoted to `system` also drops its `name`: the field identifies a
speaker, a framework note has none, and some providers reject it on that role.

### Display Group members could not be reordered

The engine says, in as many words: *"Membership order is deliberately
user-configurable in the Display Group editor. Respect it here instead of
falling back to the raw module order."* It uses that order for the cards inside
a folded group. The editor built one section earlier assigns modules one at a
time, which only ever appends — so a group's internal order was whatever
sequence you happened to add things in, with no way to change it.

Members are now chips with up/down controls, and `moveDisplayMember` reorders
through the same `normalizeDisplayGroups` writer as everything else.

### The book list took one page and stopped

`updateWorldInfoList()` had been paging correctly for a while; the note here was
stale about *that* function but right about the problem, which was two floors
down. The REST shim's `list` and `delete` routes called
`world_books.list({ limit: 200 })` and read the first page only, so past 200
books the Lorebook Agent simply never saw the rest — and `delete` reported "not
found" for a book that exists, which looks exactly like success.

Both now go through the index, which is paged in full.

**The fake host was hiding it.** `world_books.list()` ignored `limit` and
`offset` entirely and returned everything, so a caller that paged and one that
did not were indistinguishable. The fake now serves real pages, and the test was
checked against the old code to confirm it fails there — `200 of 260` before,
all 260 after. That is the second time modelling the host too generously has
concealed a real bug, and it is worth stating plainly: **a fake that is kinder
than the host tests nothing.**

---

## The stylesheet

`style.css` is 10,925 lines and was missed on the first pass, because
SillyTavern declares it in the manifest (`"css": "style.css"`) rather than
importing it from a module — so the port script's import walk never reached it.

The symptom was subtle: the ported renderer emitted *correct markup* that
painted as plain text, and collapsing a section flipped the chevron without
hiding anything, because `.rt-collapsed .rt-section-body` lives in that file.
Everything looked wired and nothing looked right.

`scripts/port.mjs` now emits it as `src/engine/style-css.ts` (a TS module rather
than a `.css` file, so the frontend bundle inlines it without depending on a
bundler's CSS loader) and the frontend injects it ahead of its own rules.

The panel body also carries the `rpg-tracker-panel` class. That is not
decoration: the stylesheet defines every `--rt-*` variable on that class and
scopes 109 rules under it.

The theme variables fall back to SillyTavern's `--SmartTheme*` names, which do
not exist here — but every reference has a literal fallback, so the panel uses
upstream's default palette rather than breaking.

### It also brings a floating window

`.rpg-tracker-panel` is not only the variable scope; it is upstream's draggable
panel chrome:

```css
.rpg-tracker-panel { position: fixed; top: 100px; right: 20px;
                     width: 300px; height: 420px; z-index: 2000 }
```

Inside a drawer that overlaps the toolbar and clips the content at 420px. The
class cannot be dropped — it carries every `--rt-*` variable and scopes 109
rules — so `frontend.ts` overrides the placement through the compound selector
`.dnd-panel__body.rpg-tracker-panel`, which outranks it on specificity rather
than on injection order. `position: relative`, not `static`, because
`.rt-has-bg-image::before/::after` are absolutely positioned and need this
element as their containing block.

## Re-running the port

```bash
node scripts/port.mjs /path/to/SillyTavern-MultihogDnDFramework
```

Add entry files as arguments to widen the slice. The script reports any import
that leaves the extension so a new host dependency cannot slip in unnoticed.

What it cannot report is a contract that moved inside `index.js`. Upstream
implements its runtime actions and its chat-switch handler there, and that is
the one file this port replaces — so when upstream changes what those return or
when they run, the regenerated engine and the port's replacements disagree with
no import in sight. The 2026.9.25 re-port hit this three times. Before trusting
a re-port, diff `index.js` across the range and read every runtime action and
the `CHAT_CHANGED` path.

### The 2026.9.25 re-port

From `de2d97b` (2026-09-06) to `d6aab00` (2026.9.25), 75 upstream commits.
`scripts/port.mjs` ran cleanly — 24 files changed (+2,001 / −820), 5 added,
all 16 host imports rewritten, nothing unresolved — and 22 checks failed across
4 suites. None of the failures were in the generated code. All of them were the
seam.

**`sendDirectPrompt` changed its result.** Upstream's returns
`{ success, status, changed, message }`, with `status` one of `changed`,
`unchanged`, `busy`, `unavailable`, `no_output`, `chat_changed`, `cancelled`,
`failed`, and `character-creator.js` now asserts `result.success`. The port's
reimplementation returned `{ ok }`, so every roll threw "returned no character
sheet" with a good sheet in hand — 21 of the 22. It returns both vocabularies
now, built from one status so `ok` and `success` cannot disagree.

**…and the port's version had a bug of its own, on `main` as well.** It
committed straight after the model call, into whatever chat was live by then:
asking the tracker a question in one campaign and switching mid-answer wrote
that campaign's merged memo over the other one's, and reported success.
Upstream has refused that commit since 2026.9. The port does now, on the epoch.

**The epoch was armed too late.** It was bumped at the end of the switch, after
two awaited flushes. A Map Architect pass between model calls checked its guard
inside that window, found it valid, and saved a full map into the chat the user
had just left before the guard caught up. Upstream bumps it first thing,
synchronously; so does the port now, which is why `pass-affinity.js` is a
static import in `backend.ts` — a dynamic one is an await of its own.

**And the switch stopped one pass where upstream stops six.** The router, World
Progression, the map updater, map evolution and Real-Time location art are now
stopped before the chat flips, as upstream does. Each import is a literal
specifier. A loop over a list of paths is tidier and invisible to the bundler:
it passes every test, which run from `src/`, and fails every time from
`dist/backend.js`, where the surrounding `catch` would have reduced it to a
warning.

**Abort, not pin, for the Map Architect.** Upstream's guard abandons a pass
whose chat changed; the port's `withChatPinned` had finished it into the
originating chat. The engine is upstream's, so its behaviour stands, and
`tests/maps.ts` now asserts it — on the *reason* the pass stopped, since "nothing
was written" is also what a failed validation produces. The pin stays: it still
fixes `ctx.chatId` for the unguarded engine paths that read `getLivePrefix()`.

**File-backed history is not ported, deliberately.** Upstream moved memo and map
history out of `settings.json` into uploaded files, through SillyTavern's
`/api/files/*`, an attachment registry, and a read-back of the on-disk settings
before anything is deleted. Emulating that is a feature with real data-safety
stakes, not a re-port fix. Uploads reach `getRequestHeaders()`, which throws, and
upstream's own catch keeps the history inline — byte-for-byte what the port did
before. That is verified rather than assumed, in `tests/history-storage.ts`:
history stays in the partition, stays enumerable, reaches storage, survives a
chat round trip, and no file pointer is ever recorded. The cost is one error
line per save in the worker log.

Do **not** use `blockHistoryPersistence()` to switch it off. It reads like the
off switch, and `saveChatState()` and `saveProfile()` both return early when it
is set — it is an emergency brake on all saving.

### Auditing the seam, after the re-port

The re-port's fixes were the ones the tests caught. Tests catch what they
exercise, so the seam was then audited directly, surface by surface:

| surface | method | result |
|---|---|---|
| runtime actions | every `invoke('…')` in the bridge against what `installRuntimeActions` provides | 1 missing — `setUse24hTime`, unreachable itself, but it led to the first bug below |
| `globalThis._rpg*` bridges | read by the engine, set by nothing in the port | 5 — four UI repaints, one only ever `delete`d |
| `getContext()` members | used by the engine against `context.ts` | 2 unguarded; neither reachable (below) |
| `fetch('/api/…')` | engine endpoints against the shim's routes | clean |
| the chat-switch handler | upstream's `onChatChanged` read line by line against `syncActiveChat` | three steps never run — the last three bugs below |

The first pass of the action audit matched names with `[A-Za-z]+`. That drops
`setUse24hTime` from *both* lists and reports a clean match. Include digits.

Five bugs came out of it, every one silent:

**A clock-format change only flipped the flag.** Upstream routes both toggles
through setters in `index.js` that also rewrite the stored agent templates and
stock prompts, which carry worked timestamps teaching the model which format to
write. From the port's panel, 13 AM/PM stamps and 16 "Day N" examples stayed
behind, along with "08:00 AM" as the start time.
`stock-prompts.ts:applyTimeFormatChange` is those setters without the DOM, and
now matches upstream's own functions step for step. The format round trip is
lossy (13 → 3 → 7 AM/PM stamps going on and off again). That is upstream's
regex-based `adjustPromptTimestamps`, reproduced with no port code involved, so
it is recorded here rather than patched.

**Rebuilt prompts never reached storage.** `settings:patch` rebuilt derived
prompt text *after* `saveSettings()`, which writes immediately. Storage got the
toggle and not the text it implies: turn "Quest deadlines" off, restart, and the
panel said off while the stored prompt still taught the DEADLINE rules. The
rebuilds now run before the save. The existing test missed it because it read
the live settings object, which was always right, and never what was saved.

**A new chat started as a copy of the last campaign.** The port kept whatever
was live on reaching a chat with no saved state, so every new campaign began
with the previous character sheet, inventory, quest log, memo history and
portraits, and its first tracker pass merged into all of it. Upstream resets in
`resetUnseenChatState`, in `index.js`; `chat-state.ts` now has the port's copy,
field for field. Its two exceptions are kept because both protect real data:
**Chat Link off** (one shared campaign, chosen deliberately), and **the first
chat attached at startup**, which adopts the live campaign through
`shouldPreserveLiveChatStateOnBoot` when it has substance and no other owner.
Forks get upstream's `isBranchSeedInProgress` treatment. The fork is marked
synchronously on `CHAT_FORKED`, spared the reset while the carry runs, and
projected once the carry is done.

Per-chat portraits were not new: the loader and `saveChatState` have scoped them
since before the re-port. A fresh chat inheriting them was this same bug.

**A routine chat update read as switching to no chat.** In Lumiverse,
`CHAT_SWITCHED` is the switch and `CHAT_CHANGED` is an *update* — a rename, a
metadata write, an avatar switch — arriving as `{ chat, changedFields }` with no
`chatId`. Both went through `syncActiveChat(payload.chatId ?? null)`, so a rename
detached the chat and stopped every pass in flight; a tracker pass lost its
turn. Every suite in this repo switched chats by emitting `CHAT_CHANGED` with a
`chatId`, a payload the host never sends for a switch, and that is why nothing
caught it. The suites now switch with `CHAT_SWITCHED`, as the host does, and
`chat-scope.ts` sends the real update shape.

**And two resets the switch skipped.** `resetRouterTick(true)` clears the
run-every counters and the Lorebook Agent's pending keyword pool, which held
keywords one story had triggered until the next story's agent ran.
`resetCombatProfileOverride()` drops a combat connection override left on by a
fight in the chat being left. Both now run on every switch, as upstream's do.

**Two unguarded context calls, left alone because nothing reaches them.**
`sendSystemMessage` only runs on the un-quiet dice path, which only a slash
command reaches, and that command registers only when `SlashCommand` exists;
here it does not. `getPresetManager()` runs only off the connection-profile
path *and* with a `completionPresetId` set, which nothing in the port's settings
can set. Wholesale-imported SillyTavern settings could reach the second.

## Features the seam was missing

Three upstream features lived entirely in `index.js`, so the port never had
them. Two are now in place; the third is listed under what is left.

### Chat Link

Upstream's Chat-Linked Mode is either "each chat keeps its own campaign" or "one
campaign follows the user". The engine always carried `chatLinkEnabled`, but
nothing could set it, and the switch ignored it: the engine's loader and saver
do not check the flag themselves, because upstream gates them at the call site.
It is now a General setting, and the switch follows upstream's rules:

- Portraits stay with each chat either way.
- With the link off, the departing chat is not saved and the arriving one is
  not loaded. Only scene-scoped state resets.
- Turning the link on inside a chat whose saved campaign differs asks
  Restore / Overwrite / Cancel, as upstream does.

Offering that three-way choice meant the popup bridge had to honour `okButton`,
`cancelButton` and `customButtons`. Before that, every labelled engine popup
read as a plain "OK or Cancel?".

### Deleted chats

The host emits `CHAT_DELETED` and the port ignored it. A deleted chat's saved
campaign stayed in the settings blob for good: its memo, up to twenty snapshots,
its quests and its relationships, all rewritten on every save. Its lorebooks
stayed in the account. Upstream 2026.9 cleans up in `deleted-chat-data.js` and
`purge-orphaned-lorebooks.js`. Both are now ported unchanged (two TRACKER_SLICE
entries), and `tracker/chat-cleanup.ts` wires them with upstream's caution:

- **Only verified deletions.** The cleanup runs only for a chat the host no
  longer has, and checks again after the lorebook question in case the chat
  came back. A failed lookup counts as "still exists".
- **Lorebooks are their own question.** A book is offered only if it was
  recorded for that chat, no other saved campaign records it, and no character
  card or persona has it attached. Each book is re-checked just before it is
  deleted. If the card list cannot be read, every book is protected.
- **Catch-up asks first.** A *Clean up deleted chats* button under General
  handles chats deleted before any of this existed. It compares saved
  campaigns against the user's whole chat list and refuses to judge anything
  if the pages read do not add up to the host's total.

Upstream protects SillyTavern's globally selected books. The nearest Lumiverse
equivalent is a book attached to a card or persona, so that is what is
protected. Managed portrait files and file-backed history are upstream-only and
are not touched.

**Chat switches overlapped, and the slower one won.** Testing a deletion that
races the host's own switch away exposed this. `syncActiveChat` is about a dozen
awaits long, and nothing serialized it. Switching to C and then to B left the
tracker on C while the user was in B. A deletion arriving mid-switch read the
not-yet-updated mirror and queued a switch to "no chat" behind the real one.
Switches now run one at a time, in the order requested, as SillyTavern's event
loop gives upstream. Anything asking "which chat is open" while switches are
queued reads where the queue is heading. Two details keep the queue safe:

- The commit-guard epoch is bumped when a switch is requested, not when the
  queue reaches it.
- The memo-recovery check, which can open a popup, runs after the switch,
  outside the queue, so an unanswered question cannot hold up every later
  switch.

### Still missing: automatic art

`checkAndTriggerAutoGenerations` and its location twin generate portraits and
scene art after each reply. Upstream calls them from `index.js` after render,
and nothing in the port does. Every image is a paid call, so this should arrive
switched off.
