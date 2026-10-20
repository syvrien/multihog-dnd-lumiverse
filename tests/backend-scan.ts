/**
 * backend-scan.ts — the backend bundle passes Lumiverse's install-time scan.
 *
 *   bun tests/backend-scan.ts
 *
 * Lumiverse scans an extension's built backend before installing it, and newer
 * releases block **direct fetch API usage** with no opt-in: a bare `fetch(`
 * call, `fetch` aliased or `.call`ed, `globalThis.fetch` / `self.fetch`, or a
 * fetch library import. The port tripped it twice over — 47 `fetch(` calls in
 * the ported engine, and a startup shim that replaced `globalThis.fetch`.
 *
 * Every engine call now goes to `stFetch` (rewritten by `scripts/port.mjs`),
 * and the shim is gone. This builds the backend the way the installer does and
 * checks for each forbidden form, ignoring strings and comments as the
 * scanner does. Then it checks `stFetch` still does the shim's job.
 */

import { installFakeSpindle } from './fake-spindle'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

console.log('── the built backend ──')
const built = await Bun.build({
  entrypoints: [new URL('../src/backend.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')],
  target: 'bun',
  // Whitespace minification drops comments; names stay readable.
  minify: { whitespace: true, syntax: false, identifiers: false },
})
check('builds', built.success, built.logs.map(l => String(l)).join(' | ').slice(0, 160))
const bundle = built.success ? await built.outputs[0].text() : ''

// Drop string and template literals, as the scanner ignores them. Rough, but
// the code that matters here is plain call syntax.
const code = bundle.replace(/(["'`])(?:\\[\s\S]|(?!\1)[^\\])*\1/g, '""')

const forbidden: Array<[string, RegExp]> = [
  ['bare fetch( calls', /(?<![.\w$])fetch\s*(?:\?\.\s*)?\(/],
  ['fetch aliased to a variable', /\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*fetch\b/],
  ['fetch.call / .apply / .bind', /(?<![.\w$])fetch\s*\.\s*(?:call|apply|bind)\s*\(/],
  ['globalThis / global / self .fetch', /\b(?:globalThis|global|self)\s*(?:\?\.|\.)\s*fetch\b/],
  ['fetch destructured from globalThis', /\b(?:const|let|var)\s*\{[^}]*\bfetch\b[^}]*\}\s*=\s*(?:globalThis|global|self)\b/],
  ['fetch library imports', /(?:from\s*|import\s*\(?\s*)["'`](?:node-fetch|undici|cross-fetch)["'`]/],
]
for (const [label, re] of forbidden) {
  const hit = re.exec(code)
  check(`no ${label}`, !hit, hit ? code.slice(Math.max(0, hit.index - 60), hit.index + 40) : '')
}
// An alias of globalThis, then `.fetch` on the alias — how the old shim did it.
const aliases = [...code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:globalThis|global|self)\b/g)].map(m => m[1])
const aliasHit = aliases.find(name => new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\s*\\.\\s*fetch\\b`).test(code))
check('no .fetch through an alias of globalThis', !aliasHit, aliasHit ?? '')
check('the engine calls stFetch instead', /\bstFetch\s*\(/.test(code))

console.log('\n── stFetch does what the shim did ──')
const state = installFakeSpindle()
const { stFetch } = await import('../src/compat/st-core')
const { setActiveUser } = await import('../src/compat/user-context')
setActiveUser(state.userId)
const { saveWorldInfo } = await import('../src/compat/world-info')
await saveWorldInfo('chat_1_NPCs', { entries: { 0: { uid: 0, comment: 'Bram', key: ['bram'], content: 'Innkeeper.' } } } as never)
const listed = await stFetch('/api/worldinfo/list', { method: 'POST', body: '{}' })
const names = JSON.stringify(await listed.json())
check('serves the world info endpoints in-process', listed.ok && names.includes('chat_1_NPCs'), names.slice(0, 80))
const got = await stFetch('/api/worldinfo/get', { method: 'POST', body: JSON.stringify({ name: 'chat_1_NPCs' }) })
check('including reading a book', got.ok && JSON.stringify(await got.json()).includes('Bram'))
const doc = await stFetch('/scripts/extensions/third-party/x/docs/multihogDnDdoc.md')
check('serves the bundled manual', doc.ok && (await doc.text()).length > 1000)
const refusal = async (url: string): Promise<string> => {
  try {
    await stFetch(url)
    return ''
  } catch (error) {
    return (error as Error).message
  }
}
check('refuses other SillyTavern endpoints by name', /SillyTavern REST endpoint/.test(await refusal('/api/settings/get')))
const external = await refusal('https://aihorde.net/api/v2/generate/async')
check('and makes no network request anywhere else, saying why', /cannot make network requests/.test(external), external.slice(0, 80))
check('without touching the global fetch', !(globalThis.fetch as unknown as { __dnd?: boolean }).__dnd
  && String(globalThis.fetch).includes('native code'), String(globalThis.fetch).slice(0, 60))

console.log(`\n${failures === 0 ? 'backend scan test passed' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
