/**
 * port-defaults.ts — the port's own defaults, for new installs only.
 *
 *   bun tests/port-defaults.ts
 *
 * Persistent maps are off for a new install: the dungeon ruleset module costs
 * about 1.7k tokens on every prompt, plus the Map Architect, updater and
 * evolution passes, for a feature most campaigns never use. Existing installs
 * keep what they have — switching maps off under someone mid-campaign would be
 * worse than the default it fixes.
 *
 * Each scenario needs a cold start, so this file runs itself once per
 * scenario in a fresh process.
 */

import { installFakeSpindle } from './fake-spindle'

const scenario = process.argv[2]

if (!scenario) {
  let failures = 0
  for (const name of ['fresh', 'existing', 'unreadable']) {
    const run = Bun.spawnSync([process.execPath, import.meta.path, name], { stdout: 'pipe', stderr: 'pipe' })
    const out = run.stdout.toString()
    for (const line of out.split('\n').filter(l => /^\s+(PASS|FAIL)|^──/.test(l))) console.log(line)
    if (run.exitCode !== 0) failures++
  }
  console.log(`\n${failures === 0 ? 'port defaults test passed' : `${failures} scenario(s) failed`}`)
  process.exit(failures === 0 ? 0 : 1)
}

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}
const wait = (ms = 500): Promise<unknown> => new Promise(resolve => setTimeout(resolve, ms))

const state = installFakeSpindle()
const stored = (): Record<string, any> => JSON.parse(state.userStorage.get(`${state.userId}:settings.json`) ?? '{}')
const MAPS = 'dungeon_reality_and_hidden_mapping'

if (scenario === 'existing') {
  // Someone already playing, with maps on.
  state.userStorage.set(`${state.userId}:settings.json`, JSON.stringify({
    rpg_tracker: { enabled: true, syspromptModules: { [MAPS]: true } },
  }))
}
if (scenario === 'unreadable') {
  const real = (spindle as any).userStorage.getJson
  ;(spindle as any).userStorage.getJson = async (path: string, options: any) => {
    if (path === 'settings.json') throw new Error('storage unavailable')
    return real(path, options)
  }
}

await import('../src/backend')
const { emitHostEvent } = await import('./fake-spindle')
await emitHostEvent(state, 'CHAT_SWITCHED', { chatId: 'chat-1' })
await wait()
const { getSettings } = await import('../src/engine/state-manager.js') as {
  getSettings: () => Record<string, any>
}
const settings = getSettings()
const { isLocationMappingEnabled } = await import('../src/engine/src/state/section-enabled.js') as {
  isLocationMappingEnabled: (s: unknown) => boolean
}

if (scenario === 'fresh') {
  console.log('── a new install ──')
  check('starts with persistent maps off', settings.syspromptModules?.[MAPS] === false && !isLocationMappingEnabled(settings))
  check('and saves that', stored().rpg_tracker?.syspromptModules?.[MAPS] === false,
    JSON.stringify(stored().rpg_tracker?.syspromptModules ?? {}).slice(0, 80))
  const { buildSysprompt } = await import('../src/tracker/sysprompt')
  check('so the narrator is not sent the map rules', !/<dungeon_reality_and_hidden_mapping>/.test(await buildSysprompt()))
  check('everything else keeps upstream’s defaults', settings.syspromptModules?.combat !== false && settings.enabled !== false)
}
if (scenario === 'existing') {
  console.log('\n── an existing install ──')
  check('keeps persistent maps on', settings.syspromptModules?.[MAPS] === true && isLocationMappingEnabled(settings))
}
if (scenario === 'unreadable') {
  console.log('\n── settings that could not be read ──')
  check('are not mistaken for a new install',
    settings.syspromptModules?.[MAPS] !== false && !state.logs.some(l => /new install/.test(l.message)),
    state.logs.filter(l => /new install|settings load failed/.test(l.message)).map(l => l.message).join(' | ').slice(0, 120))
}
process.exit(failures === 0 ? 0 : 1)
