// dsh-codegraph runtime test harness
// Loads the installed plugin's actual lib/index.js, mounts stub cordis
// services (tools/subprocess/shell), calls apply(), and exercises every
// registered tool against the real `codegraph` CLI on a real test project.
import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))

// --- locate the installed plugin -----------------------------------------
const profileNodeModules = process.env.CG_PROFILE_NM
const pluginRoot = profileNodeModules
  ? join(profileNodeModules, 'dsh-codegraph')
  : join(__dirname, '..') // fall back to the working checkout
const plugin = await import(join(pluginRoot, 'lib/index.js'))

// --- tiny real subprocess executor (minimal child_process wrapper) --------
function runProc(argv, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: cwd || '/',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d.toString()))
    child.stderr.on('data', (d) => (err += d.toString()))
    child.on('error', reject)
    child.on('close', (code) => resolve({ exitCode: code, stdout: out, stderr: err }))
  })
}

const subprocessService = {
  async resolveExecutable(name) {
    try {
      return execFileSync('which', [name]).toString().trim()
    } catch {
      throw new Error(`not found: ${name}`)
    }
  },
  spawn({ argv, cwd, stdio }) {
    // stdio caps are ignored here; real service collects streams
    const collected = {
      stdout: { readFrom: () => undefined },
      stderr: { readFrom: () => undefined }
    }
    // We bypass the stream-collection abstraction and run directly for the test.
    const p = runProc(argv, cwd)
    return {
      collected,
      done: p.then((r) => {
        collected.stdout.readFrom = () => ({ text: r.stdout })
        collected.stderr.readFrom = () => ({ text: r.stderr })
        return { exitCode: r.exitCode }
      })
    }
  }
}

const shellService = {
  resolve({ command, workdir }) {
    return { command, workdir }
  },
  async run(spec) {
    const r = await runProc(['/bin/bash', '-c', spec.command], spec.workdir)
    return { exitCode: r.exitCode, stdout: { text: r.stdout }, stderr: { text: r.stderr } }
  }
}

// --- stub cordis context --------------------------------------------------
const registeredTools = []
const promptSections = []

const ctx = {
  tools: {
    register(tool) {
      registeredTools.push(tool)
    }
  },
  systemPrompt: {
    section(sec) {
      promptSections.push(sec)
      return () => {}
    }
  },
  get(name) {
    if (name === 'subprocess') return subprocessService
    if (name === 'shell') return shellService
    return undefined
  }
}

// --- apply the plugin ------------------------------------------------------
const sessionCwd = '/tmp/cg-test-proj' // tools default to this via exec.agent

function makeExec() {
  const aborted = { value: false }
  let signal
  const ctrl = new AbortController()
  return {
    agent: { session: { header: { cwd: sessionCwd } } },
    signal: ctrl.signal,
    abort() {
      aborted.value = true
      ctrl.abort()
    }
  }
}

function results() {
  let pass = 0
  let fail = 0
  return {
    ok(label, detail) {
      pass++
      console.log(`  ✅ ${label}${detail ? ' — ' + detail : ''}`)
    },
    bad(label, detail) {
      fail++
      console.log(`  ❌ ${label}${detail ? ' — ' + detail : ''}`)
    },
    get tally() {
      return { pass, fail }
    }
  }
}

let pass = 0
let fail = 0
const ok = (l, d) => { pass++; console.log(`  ✅ ${l}${d ? ' — ' + d : ''}`) }
const bad = (l, d, e) => { fail++; console.log(`  ❌ ${l}${d ? ' — ' + d : ''}${e ? '\n     ↳ ' + e : ''}`) }
const call = async (name, args) => {
  const tool = registeredTools.find((t) => t.name === name)
  if (!tool) throw new Error(`tool not registered: ${name}`)
  const exec = makeExec()
  const raw = await tool.execute(args, exec)
  exec.abort()
  return raw
}

console.log('\n=== 1) plugin.apply mounts ===')
try {
  plugin.apply(ctx)
  ok('apply(ctx) did not throw')
} catch (e) {
  bad('apply(ctx) threw', null, e.message)
  process.exit(1)
}

console.log('\n=== 2) systemPrompt guidance injected (prefer codegraph for code search) ===')
const cg = promptSections.find((s) => s.name === 'tool:codegraph')
if (cg) {
  ok(`injected section "tool:codegraph"`, `order=${cg.order}, text.length=${cg.text.length}`)
  if (cg.order < 100) ok(`order ${cg.order} < 100 → renders before grep/glob/read`, null)
  else bad('order should be < 100 (before read=100/grep=104)', `got ${cg.order}`)
  if (/codegraph_status/.test(cg.text) && /codegraph_query/.test(cg.text)) ok('guidance mentions codegraph_status & codegraph_query')
  else bad('guidance text should instruct codegraph_* usage')
} else {
  bad('no "tool:codegraph" systemPrompt section injected')
}

console.log('\n=== 3) tool registration (expect 13 codegraph_* tools) ===')
const names = registeredTools.map((t) => t.name).sort()
const codeTools = names.filter((n) => n.startsWith('codegraph_'))
console.log('   registered:', names.join(', '))
if (codeTools.length === 13) ok(`13 codegraph_* tools registered`, codeTools.join(', '))
else bad(`expected 13 codegraph_* tools, got ${codeTools.length}`, null)

console.log('\n=== 4) codegraph_status (not yet indexed) ===')
try {
  const s = await call('codegraph_status', {})
  console.log('   status output:', s.slice(0, 220))
  ok('codegraph_status ran')
} catch (e) {
  bad('codegraph_status', null, e.message)
}

console.log('\n=== 5) codegraph_init (bootstrap the index) ===')
try {
  const out = await call('codegraph_init', {})
  console.log('   init output:', String(out).slice(0, 200))
  ok('codegraph_init ran')
} catch (e) {
  bad('codegraph_init', null, e.message)
}

console.log('\n=== 6) codegraph_status (indexed) ===')
try {
  const s = String(await call('codegraph_status', {}))
  console.log('   status:', s.slice(0, 260))
  ok('codegraph_status after init')
} catch (e) {
  bad('codegraph_status after init', null, e.message)
}

console.log('\n=== 7) codegraph_query("multiply") ===')
try {
  const q = String(await call('codegraph_query', { search: 'multiply' }))
  console.log('   query:', q.slice(0, 260))
  ok('codegraph_query ran')
} catch (e) {
  bad('codegraph_query', null, e.message)
}

console.log('\n=== 8) codegraph_node("add") ===')
try {
  const n = String(await call('codegraph_node', { name: 'add' }))
  console.log('   node:', n.slice(0, 280))
  ok('codegraph_node ran')
} catch (e) {
  bad('codegraph_node', null, e.message)
}

console.log('\n=== 9) codegraph_callers(double) & codegraph_callees(multiply) ===')
try {
  const c = String(await call('codegraph_callers', { symbol: 'double' }))
  console.log('   callers(double):', c.slice(0, 200))
  ok('codegraph_callers ran')
} catch (e) {
  bad('codegraph_callers', null, e.message)
}
try {
  const c = String(await call('codegraph_callees', { symbol: 'multiply' }))
  console.log('   callees(multiply):', c.slice(0, 200))
  ok('codegraph_callees ran')
} catch (e) {
  bad('codegraph_callees', null, e.message)
}

console.log('\n=== 10) codegraph_explore("math utilities") ===')
try {
  const ex = String(await call('codegraph_explore', { query: 'math utilities', maxFiles: 2 }))
  console.log('   explore:', ex.slice(0, 280))
  ok('codegraph_explore ran')
} catch (e) {
  bad('codegraph_explore', null, e.message)
}

console.log('\n=== 11) codegraph_files ===')
try {
  const f = String(await call('codegraph_files', {}))
  console.log('   files:', f.slice(0, 200))
  ok('codegraph_files ran')
} catch (e) {
  bad('codegraph_files', null, e.message)
}

console.log('\n=== 12) path arg override (point at test project explicitly) ===')
try {
  const s = String(await call('codegraph_status', { path: '/tmp/cg-test-proj' }))
  console.log('   status(path):', s.slice(0, 200))
  ok('codegraph_status with explicit path')
} catch (e) {
  bad('codegraph_status with explicit path', null, e.message)
}

console.log('\n=== 13) codegraph_sync ===')
try {
  const s = String(await call('codegraph_sync', {}))
  console.log('   sync:', (s || '(no output)').slice(0, 200))
  ok('codegraph_sync ran')
} catch (e) {
  bad('codegraph_sync', null, e.message)
}

console.log('\n=== 14) codegraph_impact(multiply) & codegraph_affected ===')
try {
  const im = String(await call('codegraph_impact', { symbol: 'multiply', depth: 1 }))
  console.log('   impact:', im.slice(0, 220))
  ok('codegraph_impact ran')
} catch (e) {
  bad('codegraph_impact', null, e.message)
}
try {
  const af = String(await call('codegraph_affected', { files: ['src/math.ts'] }))
  console.log('   affected:', af.slice(0, 220))
  ok('codegraph_affected ran')
} catch (e) {
  bad('codegraph_affected', null, e.message)
}

console.log('\n=== 15) error path: no path, no session cwd ===')
try {
  const t = registeredTools.find((x) => x.name === 'codegraph_status')
  await t.execute({}, { agent: { session: { header: {} } }, signal: new AbortController().signal })
  bad('expected throw with no cwd & no path')
} catch (e) {
  ok('throws when no session cwd and no path', e.message.slice(0, 80))
}

console.log('\n=== 16) remaining tools registered & present ===')
for (const t of ['codegraph_index', 'codegraph_uninit']) {
  const present = !!registeredTools.find((x) => x.name === t)
  if (present) ok(`registered ${t}`)
  else bad(`MISSING ${t}`)
}

console.log(`\n========== ${pass} passed, ${fail} failed ==========\n`)
process.exit(fail === 0 ? 0 : 1)
