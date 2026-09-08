/**
 * llm.ts — SillyTavern generation helpers over `spindle.generate`.
 *
 * `llm-client.js` calls the host three ways: through
 * `ConnectionManagerRequestService` (silent, profile-scoped), through
 * `generateRaw` (main API), and through `generateQuietPrompt`. All three land
 * on `spindle.generate.raw`.
 *
 * ## `raw` needs an explicit model
 *
 * `connection_id` alone is not enough. The host's raw path reads `provider` and
 * `model` as **top-level** fields on the request and passes them straight
 * through, so omitting them reaches the provider as an empty model:
 *
 *   NanoGPT generate failed (400): Missing or invalid required parameter: model.
 *
 * Both fields are absent from the published `GenerationRequestDTO`, so they are
 * resolved from the connection profile here and attached through a cast. The
 * lookup is cached — the tracker fires a request per narrator turn and the
 * profile does not change between them.
 */

import type {
  ConnectionProfileDTO,
  GenerationRequestDTO,
  GenerationResponseDTO,
  LlmMessageDTO,
} from 'lumiverse-spindle-types'
import { userScope } from './user-context'

export interface GenerateRawOptions {
  prompt?: string
  systemPrompt?: string
  prefill?: string
  jsonSchema?: Record<string, unknown> | null
  signal?: AbortSignal | null
  connectionId?: string
  parameters?: Record<string, unknown>
}

/** Fields the host's raw path reads but the published DTO does not declare. */
type RawGenerationRequest = GenerationRequestDTO & {
  provider?: string
  model?: string
}

const connectionCache = new Map<string, ConnectionProfileDTO | null>()

function ensurePermission(): void {
  if (!spindle.permissions.has('generation')) {
    throw new Error('PERMISSION_DENIED:generation')
  }
}

/** Look up a connection profile, remembering the answer (including misses). */
async function getConnection(connectionId: string): Promise<ConnectionProfileDTO | null> {
  if (connectionCache.has(connectionId)) return connectionCache.get(connectionId) ?? null
  let profile: ConnectionProfileDTO | null = null
  try {
    profile = await spindle.connections.get(connectionId, userScope())
  } catch (error) {
    spindle.log.warn(`[DnD] connection lookup failed: ${(error as Error).message}`)
  }
  connectionCache.set(connectionId, profile)
  return profile
}

/** Drop cached profiles so a re-selected or edited connection is re-read. */
export function invalidateConnectionCache(): void {
  connectionCache.clear()
}

/**
 * Attach `provider` and `model` from the connection profile.
 *
 * Without a connection id there is nothing to resolve; the request goes out as
 * it is and the host applies its own defaults.
 */
async function withModel(
  request: RawGenerationRequest,
  connectionId?: string,
): Promise<RawGenerationRequest> {
  if (!connectionId) return request
  const profile = await getConnection(connectionId)
  if (!profile) {
    // Passing the request through unchanged sends it with no model, and the
    // provider rejects it as "Missing or invalid required parameter: model" —
    // which says nothing about the cause. A pinned profile that was deleted or
    // renamed is the likely one, so name it instead.
    throw new Error(
      `connection profile "${connectionId}" no longer exists — pick one in settings`,
    )
  }
  return {
    ...request,
    connection_id: connectionId,
    ...(profile.provider ? { provider: profile.provider } : {}),
    ...(profile.model ? { model: profile.model } : {}),
  }
}

/** ST's `generateRaw({ prompt, systemPrompt, ... })`. */
export async function generateRaw(options: GenerateRawOptions | string): Promise<string> {
  ensurePermission()
  const opts: GenerateRawOptions = typeof options === 'string' ? { prompt: options } : options
  const messages: LlmMessageDTO[] = []
  if (opts.systemPrompt) messages.push({ role: 'system', content: opts.systemPrompt })
  if (opts.prompt) messages.push({ role: 'user', content: opts.prompt })

  const request = await withModel({
    type: 'raw',
    userId: userScope(),
    messages,
    ...(opts.parameters ? { parameters: opts.parameters } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  }, opts.connectionId)

  const result = await spindle.generate.raw(request) as GenerationResponseDTO
  return result.content ?? ''
}

/** ST's `generateQuietPrompt(prompt)` — uses the user's active profile. */
export async function generateQuietPrompt(prompt: string): Promise<string> {
  ensurePermission()
  const result = await spindle.generate.quiet({
    type: 'quiet',
    userId: userScope(),
    messages: [{ role: 'user', content: prompt }],
  }) as GenerationResponseDTO
  return result.content ?? ''
}

/**
 * ST's `ConnectionManagerRequestService`. The engine calls
 * `sendRequest(profileId, messages, maxTokens, options)` and reads text off the
 * result, so the shape is preserved rather than simplified.
 */
export const ConnectionManagerRequestService = {
  async sendRequest(
    profileId: string,
    messages: LlmMessageDTO[],
    maxTokens?: number,
    options: Record<string, unknown> = {},
  ): Promise<{ content: string }> {
    ensurePermission()
    const parameters: Record<string, unknown> = { ...(options.parameters as object ?? {}) }
    if (typeof maxTokens === 'number' && maxTokens > 0) parameters.max_tokens = maxTokens

    const request = await withModel({
      type: 'raw',
      userId: userScope(),
      messages,
      ...(Object.keys(parameters).length ? { parameters } : {}),
      ...(options.signal ? { signal: options.signal as AbortSignal } : {}),
    }, profileId)

    const result = await spindle.generate.raw(request) as GenerationResponseDTO
    return { content: result.content ?? '' }
  },
}

/** ST's `getConnectionProfiles()` / connection manager listing. */
export async function getConnectionProfiles(): Promise<Array<{ id: string; name: string }>> {
  if (!spindle.permissions.has('generation')) return []
  try {
    return await spindle.connections.list(userScope())
  } catch (error) {
    spindle.log.warn(`[DnD] connection listing failed: ${(error as Error).message}`)
    return []
  }
}
