/**
 * fake-spindle.ts — an in-memory stand-in for the Spindle host.
 *
 * Enough of the API to boot the backend and drive the compat layer without a
 * running Lumiverse. Everything is observable so tests can assert on what the
 * port actually asked the host to do.
 */

export interface FakeLog {
  level: 'info' | 'warn' | 'error' | 'debug'
  message: string
}

export interface FakeState {
  logs: FakeLog[]
  toFrontend: unknown[]
  storage: Map<string, string>
  chatVars: Map<string, Map<string, string>>
  messages: Map<string, any[]>
  books: Map<string, { id: string; name: string; description: string; metadata: Record<string, unknown>; created_at: number; updated_at: number }>
  entries: Map<string, any>
  globalBooks: string[]
  interceptors: Array<{ handler: Function; priority: number }>
  listeners: Map<string, Set<Function>>
  /** Handlers the backend registered for frontend messages. */
  frontendHandlers: Set<Function>
  /** Tools registered with the host, by name. */
  tools: Map<string, Record<string, unknown>>
  /** Toasts raised through the host (including the toastr shim). */
  toasts: Array<{ level: string; message: string }>
  generations: unknown[]
  /** What generate.raw / .quiet resolve with. Tests set this per scenario. */
  generationResponse: string
  /**
   * Replies for a multi-call sequence, consumed one per generation.
   *
   * The Map Architect asks for topology and then for assets, so a single
   * `generationResponse` cannot describe a successful run. Falls back to
   * `generationResponse` once drained.
   */
  generationQueue: string[]
  /**
   * Runs inside a generation call, before it returns.
   *
   * The fake answers instantly; a real model takes seconds, and a user can do
   * things in those seconds — switching chats above all. Without a point where
   * that can be made to happen, no test can reach the code that runs *between*
   * asking for a character and writing one down.
   */
  duringGeneration?: () => void | Promise<void>
  activeChatId: string | null
  granted: Set<string>
  /**
   * Model an operator-scoped install: every user-scoped call must name a user,
   * exactly as the real host demands. This is what caught the port calling
   * `chats.getActive()` with no user at boot.
   */
  operatorScoped: boolean
  /** The user events are attributed to. */
  userId: string
  userStorage: Map<string, string>
  /** Personas the user can seed a character from. */
  personas: Array<Record<string, unknown>>
  /** The host's `activePersonaId` setting; unset means no active persona. */
  activePersonaId: string | null
  /** Character cards, keyed by id. */
  characterCards: Map<string, Record<string, any>>
  /** Which card each chat is played against. */
  chatCharacter: Map<string, string>
  /** Memory Cortex rows, keyed by chat. */
  cortexEntities: Map<string, Array<Record<string, any>>>
  cortexRelations: Map<string, Array<Record<string, any>>>
  cortexArcs: Map<string, Array<Record<string, any>>>
  /** Set when the extension is denied the API entirely. */
  memoriesUnavailable: boolean
  /** Stored images, keyed by id. */
  images: Map<string, { id: string; url: string }>
  /** Images uploaded through the extension, for asserting what was sent. */
  uploads: Array<{ id: string; dataUrl: string; filename?: string }>
  /** Image-gen profiles the host offers. Empty by default — most users have none. */
  imageGenConnections: Array<Record<string, unknown>>
  /** What was asked of the image model. */
  imageGenRequests: Array<Record<string, unknown>>
  /**
   * Connection profiles the host offers.
   *
   * One by default, because `ensureStateConnection()` only adopts a connection
   * automatically when there is exactly one — with two it correctly waits for
   * the user to choose. Tests about *which* connection a subsystem used pass
   * `SECOND_CONNECTION` in as well.
   */
  connections: Array<Record<string, any>>
}

/** Opt-in second profile, for tests that need two distinguishable models. */
export const SECOND_CONNECTION = {
  id: 'conn-2',
  name: 'big',
  provider: 'openrouter',
  api_url: 'https://example.invalid',
  model: 'anthropic/claude-opus-4',
  preset_id: null,
  is_default: false,
  has_api_key: true,
  metadata: {},
}

export function installFakeSpindle(overrides: Partial<FakeState> = {}): FakeState {
  const state: FakeState = {
    logs: [],
    toFrontend: [],
    storage: new Map(),
    chatVars: new Map(),
    messages: new Map(),
    books: new Map(),
    entries: new Map(),
    globalBooks: [],
    interceptors: [],
    listeners: new Map(),
    frontendHandlers: new Set(),
    tools: new Map(),
    toasts: [],
    generations: [],
    generationResponse: '',
    generationQueue: [],
    activeChatId: 'chat-1',
    operatorScoped: true,
    userId: 'user-1',
    userStorage: new Map(),
    characterCards: new Map(),
    chatCharacter: new Map(),
    cortexEntities: new Map(),
    cortexRelations: new Map(),
    cortexArcs: new Map(),
    memoriesUnavailable: false,
    personas: [
      {
        id: 'persona-1', name: 'Syg', title: 'Seeker Student',
        description: 'A small kobold with sharp eyes and a knack for ley-lines.',
        image_id: 'img-1', attached_world_book_id: null, folder: '',
        is_default: true, metadata: {}, created_at: 0, updated_at: 0,
      },
      {
        id: 'persona-2', name: 'Bram', title: '', description: 'An innkeeper.',
        image_id: null, attached_world_book_id: null, folder: '',
        is_default: false, metadata: {}, created_at: 0, updated_at: 0,
      },
    ],
    activePersonaId: null,
    images: new Map([['img-1', { id: 'img-1', url: '/api/v1/images/img-1' }]]),
    uploads: [],
    imageGenConnections: [],
    imageGenRequests: [],
    connections: [{
      id: 'conn-1',
      name: 'nano',
      provider: 'nanogpt',
      api_url: 'https://example.invalid',
      model: 'z-ai/glm-5.3-flash-uncensored',
      preset_id: null,
      is_default: true,
      has_api_key: true,
      metadata: {},
    }],
    granted: new Set([
      'generation', 'interceptor', 'tools', 'chats',
      'chat_mutation', 'world_books', 'characters', 'ui_panels',
      'personas', 'images', 'image_gen', 'memories',
    ]),
    ...overrides,
  }

  /**
   * One page of a list, the way a paginated host serves it.
   *
   * `offset` past the end yields an empty page rather than wrapping, which is
   * what stops a caller's paging loop.
   */
  const page = <T>(all: T[], options?: { limit?: number; offset?: number }): T[] => {
    const offset = Math.max(0, Number(options?.offset) || 0)
    const limit = Number(options?.limit)
    return Number.isFinite(limit) && limit > 0
      ? all.slice(offset, offset + limit)
      : all.slice(offset)
  }

  const CONNECTIONS = state.connections

  let idSeq = 0
  const nextId = (prefix: string): string => `${prefix}-${++idSeq}`
  const log = (level: FakeLog['level']) => (message: string): void => {
    state.logs.push({ level, message })
  }

  /** Mirrors the host's guard for operator-scoped extensions. */
  const requireUser = (userId: string | undefined, what: string): string => {
    if (!userId) {
      if (state.operatorScoped) {
        throw new Error('userId is required for operator-scoped extensions')
      }
      return state.userId
    }
    void what
    return userId
  }

  const chatVarsFor = (chatId: string): Map<string, string> => {
    if (!state.chatVars.has(chatId)) state.chatVars.set(chatId, new Map())
    return state.chatVars.get(chatId)!
  }

  const variableNamespace = {
    async get(chatId: string, key: string) { return chatVarsFor(chatId).get(key) ?? '' },
    async set(chatId: string, key: string, value: string) { chatVarsFor(chatId).set(key, value) },
    async has(chatId: string, key: string) { return chatVarsFor(chatId).has(key) },
    async list(chatId: string) { return Object.fromEntries(chatVarsFor(chatId)) },
    async delete(chatId: string, key: string) { chatVarsFor(chatId).delete(key) },
  }

  /** Queued reply first, then the scenario's single reply. */
  const nextResponse = (): string =>
    state.generationQueue.length ? state.generationQueue.shift()! : state.generationResponse

  const api = {
    // The real API exposes info/warn/error only — no debug.
    log: {
      info: log('info'), warn: log('warn'), error: log('error'),
    },

    permissions: {
      has: (permission: string) => state.granted.has(permission),
      getGranted: async () => [...state.granted],
      onDenied: () => () => {},
    },

    on(event: string, handler: Function) {
      if (!state.listeners.has(event)) state.listeners.set(event, new Set())
      state.listeners.get(event)!.add(handler)
      return () => state.listeners.get(event)?.delete(handler)
    },

    storage: {
      async read(path: string) {
        const value = state.storage.get(path)
        if (value === undefined) throw new Error(`ENOENT: ${path}`)
        return value
      },
      async write(path: string, data: string) { state.storage.set(path, data) },
      async exists(path: string) { return state.storage.has(path) },
      async delete(path: string) { state.storage.delete(path) },
      async list() { return [...state.storage.keys()] },
      async getJson(path: string, options?: { fallback?: unknown }) {
        const raw = state.storage.get(path)
        if (raw === undefined) return options?.fallback
        try { return JSON.parse(raw) } catch { return options?.fallback }
      },
      async setJson(path: string, value: unknown, options?: { indent?: number }) {
        state.storage.set(path, JSON.stringify(value, null, options?.indent ?? 0))
      },
    },

    variables: {
      chat: variableNamespace,
      local: variableNamespace,
      global: {
        async get(key: string) { return state.storage.get(`global:${key}`) ?? '' },
        async set(key: string, value: string) { state.storage.set(`global:${key}`, value) },
        async list() { return {} },
        async delete(key: string) { state.storage.delete(`global:${key}`) },
      },
    },

    chats: {
      async getActive(userId?: string) {
        requireUser(userId, 'chats.getActive')
        return state.activeChatId ? { id: state.activeChatId } : null
      },
      async get(chatId: string, userId?: string) {
        requireUser(userId, 'chats.get')
        // The real DTO carries `character_id`; returning a bare `{ id }` made
        // the port's card lookup look correct while resolving nothing.
        return {
          id: chatId,
          character_id: state.chatCharacter.get(chatId) ?? null,
          name: chatId,
          metadata: {},
        }
      },
      async list() { return { data: [], total: 0 } },
    },

    characters: {
      async list(options?: { userId?: string }) {
        requireUser(options?.userId, 'characters.list')
        const data = [...state.characterCards.values()]
        return { data, total: data.length }
      },
      async get(characterId: string, userId?: string) {
        requireUser(userId, 'characters.get')
        return state.characterCards.get(characterId) ?? null
      },
    },

    chat: {
      async getMessages(chatId: string) { return [...(state.messages.get(chatId) ?? [])] },
      async appendMessage(chatId: string, message: any) {
        const id = nextId('msg')
        const list = state.messages.get(chatId) ?? []
        // Mirrors the real host: append takes `role`, reads return the
        // ChatMessageDTO shape (is_user / name / send_date / extra) plus a
        // normalized `role`.
        list.push({
          id,
          chat_id: chatId,
          index_in_chat: list.length,
          is_user: message.role === 'user',
          role: message.role,
          name: message.role === 'user' ? 'You' : 'Narrator',
          content: message.content ?? '',
          send_date: Math.floor(Date.now() / 1000),
          swipe_id: 0,
          swipes: [message.content ?? ''],
          swipe_dates: [Math.floor(Date.now() / 1000)],
          extra: {},
          metadata: message.metadata ?? {},
          parent_message_id: null,
          branch_id: null,
          created_at: Math.floor(Date.now() / 1000),
        })
        state.messages.set(chatId, list)
        return { id }
      },
      async updateMessage(chatId: string, messageId: string, patch: any) {
        const list = state.messages.get(chatId) ?? []
        const hit = list.find(m => m.id === messageId)
        if (hit) Object.assign(hit, patch)
      },
      async deleteMessage(chatId: string, messageId: string) {
        const list = state.messages.get(chatId) ?? []
        state.messages.set(chatId, list.filter(m => m.id !== messageId))
      },
      async setMessageHidden() {},
      async setMessagesHidden() {},
      async isMessageHidden() { return false },
    },

    world_books: {
      async list(options?: { limit?: number; offset?: number; userId?: string }) {
        requireUser(options?.userId, 'world_books.list')
        // Honours limit/offset, because the real host does. Returning
        // everything regardless made every paging bug invisible: a caller that
        // asked for one page of 200 and stopped looked identical to one that
        // paged properly, right up until a user had 201 books.
        const all = [...state.books.values()]
        return { data: page(all, options), total: all.length }
      },
      async get(id: string) { return state.books.get(id) ?? null },
      async create(input: { name: string; description?: string }) {
        const book = {
          id: nextId('book'),
          name: input.name,
          description: input.description ?? '',
          metadata: {},
          created_at: Date.now(),
          updated_at: Date.now(),
        }
        state.books.set(book.id, book)
        return book
      },
      async update(id: string, input: Record<string, unknown>) {
        const book = state.books.get(id)!
        Object.assign(book, input)
        return book
      },
      async delete(id: string) { return state.books.delete(id) },
      async getGlobal() { return [...state.globalBooks] },
      async setGlobal(ids: string[]) { state.globalBooks = [...ids]; return state.globalBooks },
      async activateGlobal(id: string) {
        if (!state.globalBooks.includes(id)) state.globalBooks.push(id)
        return [...state.globalBooks]
      },
      async deactivateGlobal(id: string) {
        state.globalBooks = state.globalBooks.filter(x => x !== id)
        return [...state.globalBooks]
      },
      entries: {
        async list(
          worldBookId: string,
          options?: { limit?: number; offset?: number; userId?: string },
        ) {
          const all = [...state.entries.values()].filter(e => e.world_book_id === worldBookId)
          return { data: page(all, options), total: all.length }
        },
        async get(entryId: string) { return state.entries.get(entryId) ?? null },
        async create(worldBookId: string, input: Record<string, unknown>) {
          const entry = { id: nextId('entry'), world_book_id: worldBookId, ...input }
          state.entries.set(entry.id, entry)
          return entry
        },
        async update(entryId: string, input: Record<string, unknown>) {
          const entry = state.entries.get(entryId)
          Object.assign(entry, input)
          return entry
        },
        async delete(entryId: string) { return state.entries.delete(entryId) },
      },
    },

    /*
     * Memory Cortex, modelled the way the real one behaves rather than
     * generously:
     *
     *   - every call is operator-scoped and refuses a missing `userId`;
     *   - `entities.upsert` matches on name and returns the *existing* row on
     *     a hit, so a second sync must not double the graph;
     *   - `relations.upsert` returns null when an endpoint is unknown, which
     *     is the silent-drop the real API documents.
     *
     * The last one matters: a fake that happily created edges between made-up
     * ids would have hidden the two-pass ordering the bridge needs.
     */
    memories: {
      cortex: {
        async query() { return { memories: [] } },
        async getCached() { return null },
        async invalidateCache(_chatId: string) { /* no cache here */ },
      },
      entities: {
        async list(chatId: string, options?: { userId?: string }) {
          requireUser(options?.userId, 'memories.entities.list')
          return [...(state.cortexEntities.get(chatId) ?? [])]
        },
        async findByName(chatId: string, name: string, userId?: string) {
          requireUser(userId, 'memories.entities.findByName')
          return (state.cortexEntities.get(chatId) ?? []).find(
            row => String(row.name).toLowerCase() === name.toLowerCase()) ?? null
        },
        async upsert(
          chatId: string,
          entity: Record<string, any>,
          options?: { userId?: string },
        ) {
          requireUser(options?.userId, 'memories.entities.upsert')
          if (!state.cortexEntities.has(chatId)) state.cortexEntities.set(chatId, [])
          const rows = state.cortexEntities.get(chatId)!
          const existing = rows.find(
            row => String(row.name).toLowerCase() === String(entity.name).toLowerCase())
          if (existing) {
            // Upsert, not insert: the real one matches canonical name plus
            // aliases and keeps its own salience and provenance.
            existing.entityType = entity.type ?? existing.entityType
            return existing
          }
          const row = {
            id: nextId('entity'),
            chatId,
            name: String(entity.name),
            entityType: entity.type,
            status: 'active',
            salienceAvg: 0,
            facts: [] as string[],
            emotionalValence: {} as Record<string, number>,
          }
          rows.push(row)
          return row
        },
        async addFacts(entityId: string, facts: string[], userId?: string) {
          requireUser(userId, 'memories.entities.addFacts')
          for (const rows of state.cortexEntities.values()) {
            const row = rows.find(candidate => candidate.id === entityId)
            if (row) {
              row.facts = [...new Set([...(row.facts ?? []), ...facts])]
              return row
            }
          }
          throw new Error(`unknown entity ${entityId}`)
        },
        async updateStatus(
          entityId: string,
          patch: Record<string, any>,
          userId?: string,
        ) {
          requireUser(userId, 'memories.entities.updateStatus')
          for (const rows of state.cortexEntities.values()) {
            const row = rows.find(candidate => candidate.id === entityId)
            if (row) { row.status = patch.status; return row }
          }
          throw new Error(`unknown entity ${entityId}`)
        },
        async updateEmotionalValence(
          entityId: string,
          valence: Record<string, number>,
          userId?: string,
        ) {
          requireUser(userId, 'memories.entities.updateEmotionalValence')
          for (const rows of state.cortexEntities.values()) {
            const row = rows.find(candidate => candidate.id === entityId)
            if (row) { row.emotionalValence = { ...valence }; return row }
          }
          throw new Error(`unknown entity ${entityId}`)
        },
      },
      relations: {
        async list(chatId: string, userId?: string) {
          requireUser(userId, 'memories.relations.list')
          return [...(state.cortexRelations.get(chatId) ?? [])]
        },
        async upsert(
          chatId: string,
          relation: Record<string, any>,
          options?: { userId?: string },
        ) {
          requireUser(options?.userId, 'memories.relations.upsert')
          const entities = state.cortexEntities.get(chatId) ?? []
          const known = (id: unknown): boolean =>
            entities.some(row => row.id === id)
          // Documented behaviour: silently dropped when an endpoint is missing.
          if (!known(relation.source) || !known(relation.target)) return null
          if (!state.cortexRelations.has(chatId)) state.cortexRelations.set(chatId, [])
          const rows = state.cortexRelations.get(chatId)!
          const existing = rows.find(row =>
            row.source === relation.source && row.target === relation.target)
          if (existing) { Object.assign(existing, relation); return existing }
          const row = { id: nextId('relation'), chatId, ...relation }
          rows.push(row)
          return row
        },
      },
      consolidations: {
        async list(chatId: string, options?: { userId?: string }) {
          requireUser(options?.userId, 'memories.consolidations.list')
          return [...(state.cortexArcs.get(chatId) ?? [])]
        },
      },
    },

    generate: {
      async raw(input: any) {
        state.generations.push(input)
        // The host passes `provider` / `model` straight through to the
        // provider; an empty model is a 400 at the far end, not a local error.
        // Reproducing that here is what stops the port regressing to
        // "Missing or invalid required parameter: model".
        if (!input?.model) {
          throw new Error('NanoGPT generate failed (400): Missing or invalid required parameter: model.')
        }
        await state.duringGeneration?.()
        return { content: nextResponse(), finish_reason: 'stop' } as unknown
      },
      async quiet(input: unknown) {
        state.generations.push(input)
        await state.duringGeneration?.()
        return { content: nextResponse(), finish_reason: 'stop' } as unknown
      },
      async batch() { return [] },
    },

    personas: {
      async list(options?: { userId?: string }) {
        requireUser(options?.userId, 'personas.list')
        return { data: state.personas, total: state.personas.length }
      },
      async get(personaId: string, userId?: string) {
        requireUser(userId, 'personas.get')
        return state.personas.find(p => p.id === personaId) ?? null
      },
      // The host resolves "active" from the user's `activePersonaId` setting
      // and returns null when it is unset — it does *not* fall back to the
      // default on its own. Modelled exactly, because a fake that always hands
      // back a persona would never show what an unset one does.
      async getActive(userId?: string) {
        requireUser(userId, 'personas.getActive')
        if (!state.activePersonaId) return null
        return state.personas.find(p => p.id === state.activePersonaId) ?? null
      },
      async getDefault(userId?: string) {
        requireUser(userId, 'personas.getDefault')
        return state.personas.find(p => p.is_default) ?? null
      },
    },

    images: {
      async get(imageId: string, userId?: string) {
        requireUser(userId, 'images.get')
        return state.images.get(imageId) ?? null
      },
      async list() { return { data: [], total: 0 } },
      /**
       * A dropped portrait is uploaded and only the resulting URL is stored,
       * so the settings blob does not carry base64 on every write.
       */
      async uploadFromDataUrl(
        dataUrl: string,
        options?: { originalFilename?: string; userId?: string },
      ) {
        requireUser(options?.userId, 'images.uploadFromDataUrl')
        if (!/^data:image\//i.test(dataUrl)) throw new Error('not an image data URL')
        const id = `img-up-${state.images.size + 1}`
        const image = { id, url: `/api/v1/images/${id}` }
        state.images.set(id, image)
        state.uploads.push({ id, dataUrl, filename: options?.originalFilename })
        return image
      },
    },

    /**
     * Image generation. Modelled with a connection list, because the honest
     * failure — "no image gen set up" — is the state most users are in and the
     * port has to say so rather than fail obscurely.
     */
    imageGen: {
      async listConnections(userId?: string) {
        requireUser(userId, 'imageGen.listConnections')
        return state.imageGenConnections
      },
      async generate(input: { prompt?: string; userId?: string }) {
        requireUser(input?.userId, 'imageGen.generate')
        if (!state.imageGenConnections.length) throw new Error('no image gen connection')
        state.imageGenRequests.push(input)
        const id = `img-gen-${state.images.size + 1}`
        state.images.set(id, { id, url: `/api/v1/images/${id}` })
        return { imageId: id, imageUrl: `/api/v1/images/${id}` }
      },
      async getProviders() { return [] },
    },

    connections: {
      async list(userId?: string) {
        requireUser(userId, 'connections.list')
        return CONNECTIONS
      },
      async get(connectionId: string, userId?: string) {
        requireUser(userId, 'connections.get')
        return CONNECTIONS.find(c => c.id === connectionId) ?? null
      },
    },

    // Per-user storage. `spindle.storage` is extension-wide and takes no user;
    // anything belonging to one person's campaign lives here instead.
    userStorage: {
      async getJson(path: string, options?: { fallback?: unknown; userId?: string }) {
        const user = requireUser(options?.userId, 'userStorage.getJson')
        const raw = state.userStorage.get(`${user}:${path}`)
        if (raw === undefined) return options?.fallback
        try { return JSON.parse(raw) } catch { return options?.fallback }
      },
      async setJson(path: string, value: unknown, options?: { indent?: number; userId?: string }) {
        const user = requireUser(options?.userId, 'userStorage.setJson')
        state.userStorage.set(`${user}:${path}`, JSON.stringify(value, null, options?.indent ?? 0))
      },
      async read(path: string, userId?: string) {
        const user = requireUser(userId, 'userStorage.read')
        const v = state.userStorage.get(`${user}:${path}`)
        if (v === undefined) throw new Error(`ENOENT: ${path}`)
        return v
      },
      async write(path: string, data: string, userId?: string) {
        state.userStorage.set(`${requireUser(userId, 'userStorage.write')}:${path}`, data)
      },
      async exists(path: string, userId?: string) {
        return state.userStorage.has(`${requireUser(userId, 'userStorage.exists')}:${path}`)
      },
      async delete(path: string, userId?: string) {
        state.userStorage.delete(`${requireUser(userId, 'userStorage.delete')}:${path}`)
      },
      async list() { return [] },
    },

    registerInterceptor(handler: Function, priority = 100) {
      state.interceptors.push({ handler, priority })
    },

    registerTool(tool: Record<string, unknown>) {
      if (!state.granted.has('tools')) throw new Error('PERMISSION_DENIED:tools')
      state.tools.set(String(tool.name), tool)
    },
    unregisterTool(name: string) { state.tools.delete(name) },

    toast: {
      success(m: string) { state.toasts.push({ level: 'success', message: m }) },
      warning(m: string) { state.toasts.push({ level: 'warning', message: m }) },
      error(m: string) { state.toasts.push({ level: 'error', message: m }) },
      info(m: string) { state.toasts.push({ level: 'info', message: m }) },
    },
    modal: { async open() { return { dismissedBy: 'user' } } },

    sendToFrontend(payload: unknown) { state.toFrontend.push(payload) },
    onFrontendMessage(handler: Function) {
      state.frontendHandlers.add(handler)
      return () => state.frontendHandlers.delete(handler)
    },
  }

  ;(globalThis as any).spindle = api
  return state
}

/**
 * Invoke a registered tool the way the host does — through the single
 * `TOOL_INVOCATION` event — and return the textual result.
 */
export async function invokeTool(
  state: FakeState,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  const payload = { toolName, args, requestId: `req-${Date.now()}` }
  for (const handler of state.listeners.get('TOOL_INVOCATION') ?? []) {
    const result = await handler(payload)
    if (typeof result === 'string' && result) return result
  }
  return ''
}

/** Deliver a message from the frontend, as the host would. */
export async function emitFrontendMessage(
  state: FakeState,
  payload: unknown,
  userId: string = state.userId,
): Promise<void> {
  for (const handler of state.frontendHandlers) await handler(payload, userId)
}

/** Fire a host event at everything the port subscribed to. */
export async function emitHostEvent(
  state: FakeState,
  event: string,
  payload: unknown,
  userId: string = state.userId,
): Promise<void> {
  for (const handler of state.listeners.get(event) ?? []) {
    await handler(payload, userId)
  }
}
