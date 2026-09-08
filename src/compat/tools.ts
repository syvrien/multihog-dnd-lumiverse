/**
 * tools.ts — SillyTavern function-tool registration over `spindle` tools.
 *
 * The engine registers LLM tools with a per-tool `action` callback:
 *
 *     registerFunctionTool({ name, displayName, description, parameters, action })
 *
 * Lumiverse splits that in two. `spindle.registerTool()` declares the tool and
 * takes no handler; every invocation of every tool arrives on a single
 * `TOOL_INVOCATION` event, and the handler's return value is the tool result.
 * So this module keeps the action table and dispatches by name.
 *
 * Why it matters: `registerDiceFunctionTool()` opens with
 *
 *     const { registerFunctionTool, unregisterFunctionTool } = ctx
 *     if (!registerFunctionTool || !unregisterFunctionTool) return
 *
 * With those absent the whole tool-call RNG returned silently — which is the
 * half of the hybrid dice system that prevents sycophancy, because the model
 * must declare a DC before it sees the roll.
 */

/** The SillyTavern tool definition shape the engine passes. */
export interface StFunctionTool {
  name: string
  displayName?: string
  description: string
  parameters: Record<string, unknown>
  action: (args: Record<string, unknown>) => unknown | Promise<unknown>
  formatMessage?: (...args: unknown[]) => string
  shouldRegister?: () => boolean | Promise<boolean>
}

const actions = new Map<string, StFunctionTool>()
let dispatching: (() => void) | null = null

/**
 * Route every tool invocation to the matching engine action.
 *
 * Registered once and left in place; tools come and go from `actions` as the
 * engine re-registers them on settings changes.
 */
function ensureDispatcher(): void {
  if (dispatching) return
  dispatching = spindle.on('TOOL_INVOCATION', async (payload: unknown) => {
    const invocation = payload as { toolName?: string; args?: Record<string, unknown> }
    const tool = invocation?.toolName ? actions.get(invocation.toolName) : undefined
    if (!tool) return ''
    try {
      const result = await tool.action(invocation.args ?? {})
      // The host coerces null/undefined to an empty string, but a non-string
      // result would be dropped — the dice actions return prose, so anything
      // else is a bug worth surfacing as text rather than silence.
      return typeof result === 'string' ? result : JSON.stringify(result ?? '')
    } catch (error) {
      spindle.log.error(`[DnD] tool "${invocation.toolName}" failed: ${(error as Error).message}`)
      return `The ${invocation.toolName} tool failed: ${(error as Error).message}`
    }
  }) as unknown as () => void
}

/** ST's `registerFunctionTool`. */
export function registerFunctionTool(tool: StFunctionTool): void {
  if (!tool?.name) return
  if (!spindle.permissions.has('tools')) {
    spindle.log.warn(`[DnD] "tools" not granted — ${tool.name} not registered`)
    return
  }
  ensureDispatcher()
  actions.set(tool.name, tool)
  try {
    spindle.registerTool({
      name: tool.name,
      display_name: tool.displayName ?? tool.name,
      description: tool.description,
      parameters: tool.parameters,
      // The narrator calls these mid-generation; that is the whole point.
      inline_available: true,
    })
    spindle.log.info(`[DnD] registered tool ${tool.name}`)
  } catch (error) {
    actions.delete(tool.name)
    spindle.log.error(`[DnD] registering ${tool.name} failed: ${(error as Error).message}`)
  }
}

/**
 * ST's `unregisterFunctionTool`.
 *
 * The engine calls this unconditionally for names that may never have been
 * registered (including legacy aliases), so an unknown name is not an error.
 */
export function unregisterFunctionTool(name: string): void {
  if (!name) return
  const known = actions.delete(name)
  try {
    spindle.unregisterTool(name)
  } catch (error) {
    if (known) {
      spindle.log.warn(`[DnD] unregistering ${name} failed: ${(error as Error).message}`)
    }
  }
}

/** Drop every tool. Used on teardown. */
export function unregisterAllTools(): void {
  for (const name of [...actions.keys()]) unregisterFunctionTool(name)
  dispatching?.()
  dispatching = null
}

/** Names currently registered — used by tests and diagnostics. */
export function registeredToolNames(): string[] {
  return [...actions.keys()]
}
