/**
 * Compatibility flags the LINE Harness Worker requires.
 *
 * The script upload API replaces metadata wholesale, so these must be
 * re-sent on every PUT — omitting them would strip flags and silently
 * change runtime behavior. Single source for self-update (apply /
 * rollback), CLI update, fresh installs, and release artifact builds.
 * Kept in lockstep with apps/worker/wrangler.toml (+ staging).
 *
 * global_fetch_strictly_public limits subrequests to the public Internet
 * route, preventing outbound webhooks from accessing private addresses.
 */
export const WORKER_COMPATIBILITY_FLAGS = ['nodejs_compat', 'global_fetch_strictly_public'];
