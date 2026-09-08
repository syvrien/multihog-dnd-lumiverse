/**
 * user-context.ts — which user this extension is currently acting for.
 *
 * Installed operator-scoped, a Spindle extension serves every user on the
 * instance, so the host refuses any user-scoped call that does not say who it
 * is for:
 *
 *   [DnD] no active chat at boot: userId is required for operator-scoped extensions
 *
 * The user id arrives as the *second* argument to every event handler and
 * frontend message. Nothing supplies one at boot, which is why the port's
 * startup calls failed — there is genuinely no user to act for until the first
 * event arrives. So user-scoped startup work is deferred rather than guessed.
 *
 * ## One user at a time
 *
 * The ported engine keeps its whole world — settings, current memo, chat
 * mirror — in module-level globals, because upstream it was a browser
 * extension serving exactly one person. That cannot be made concurrent by
 * threading an id through the compat layer; it would need per-user instances of
 * an engine that was never written to have instances.
 *
 * So the port tracks a single active user and re-homes onto whoever it last
 * saw. On a single-user instance that is simply correct. On a shared one it
 * means two people using the tracker at once would trample each other's state,
 * and the honest fix is installing it user-scoped (`scope: "user"` on the
 * install route) rather than pretending otherwise here.
 */

let activeUserId: string | undefined
const waiters = new Set<(userId: string) => void>()
let announced = false

/** The user the extension is currently acting for, if one is known yet. */
export function getActiveUser(): string | undefined {
  return activeUserId
}

/**
 * Record the user an incoming event or message belongs to.
 * Returns true when this is the first user we have seen.
 */
export function setActiveUser(userId: string | undefined): boolean {
  if (!userId || userId === activeUserId) return false

  const first = !activeUserId
  if (!first) {
    spindle.log.warn(
      `[DnD] active user changed (${activeUserId} -> ${userId}); tracker state follows the newest user. `
      + 'Install user-scoped if this instance has more than one person using the tracker.',
    )
  }
  activeUserId = userId

  if (!announced) {
    announced = true
    spindle.log.info(`[DnD] acting for user ${userId}`)
  }
  for (const waiter of [...waiters]) {
    waiters.delete(waiter)
    try {
      waiter(userId)
    } catch (error) {
      spindle.log.error(`[DnD] deferred startup step failed: ${(error as Error).message}`)
    }
  }
  return first
}

/**
 * Run `handler` as soon as a user is known — immediately if one already is.
 * Use this for startup work that needs user-scoped APIs.
 */
export function onUserResolved(handler: (userId: string) => void): void {
  if (activeUserId) {
    handler(activeUserId)
    return
  }
  waiters.add(handler)
}

/**
 * The user id to pass to user-scoped APIs.
 *
 * Returns `undefined` before any user is known, which is the correct thing to
 * send: user-scoped installs infer the owner and ignore it, and operator-scoped
 * installs reject the call rather than acting for an arbitrary user.
 */
export function userScope(): string | undefined {
  return activeUserId
}
