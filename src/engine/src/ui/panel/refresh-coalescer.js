/**
 * Collapse overlapping refresh requests into one active run plus, at most, one
 * follow-up run with the latest arguments. This prevents event bursts from
 * cloning and rendering the same large lorebooks concurrently.
 *
 * @param {(...args: any[]) => Promise<any>} run
 * @param {{ mergeArgs?: (queued: any[]|null, incoming: any[]) => any[] }} [options]
 */
export function createCoalescedRefresh(run, options = {}) {
    let active = null;
    let queuedArgs = null;
    const mergeArgs = options.mergeArgs || ((_queued, incoming) => incoming);

    return (...args) => {
        if (active) {
            queuedArgs = mergeArgs(queuedArgs, args);
            return active;
        }

        active = (async () => {
            let nextArgs = args;
            while (nextArgs) {
                queuedArgs = null;
                await run(...nextArgs);
                nextArgs = queuedArgs;
            }
        })().finally(() => {
            active = null;
        });

        return active;
    };
}
