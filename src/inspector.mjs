// Talks to Orca's Electron main process over the Node inspector.
//
// Orca ships with the EnableNodeCliInspectArguments fuse on, so SIGUSR1 makes its main
// process open the inspector on 127.0.0.1:9229. Nothing in the app bundle changes.
import { execFileSync } from 'node:child_process'

const INSPECTOR_HOST = '127.0.0.1'
const INSPECTOR_PORT = 9229
const ORCA_BINARY = '/Applications/Orca.app/Contents/MacOS/Orca'

/** Seconds since `pid` started, or null when it is gone. */
export function processAgeSeconds(pid) {
  try {
    const out = execFileSync('ps', ['-o', 'etime=', '-p', String(pid)], { encoding: 'utf8' }).trim()
    // [[dd-]hh:]mm:ss
    const [days, rest] = out.includes('-') ? out.split('-') : ['0', out]
    const parts = rest.split(':').map(Number)
    while (parts.length < 3) parts.unshift(0)
    const [h, m, s] = parts
    return Number(days) * 86400 + h * 3600 + m * 60 + s
  } catch {
    return null
  }
}

/** PID of Orca's main process (the binary started with no arguments), or null. */
export function findOrcaMainPid() {
  const out = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
  for (const line of out.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(.*)$/)
    if (match && match[2] === ORCA_BINARY) return Number(match[1])
  }
  return null
}

async function listTargets() {
  try {
    const res = await fetch(`http://${INSPECTOR_HOST}:${INSPECTOR_PORT}/json/list`, {
      signal: AbortSignal.timeout(1000)
    })
    return await res.json()
  } catch {
    return null
  }
}

/** Resolves once nothing answers on the inspector port (or after `timeoutMs`). */
export async function waitInspectorClosed(timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await listTargets())) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return false
}

/** The main process inspector's WebSocket URL, opening the inspector first if needed. */
export async function openInspector() {
  let targets = await listTargets()
  if (!targets) {
    const pid = findOrcaMainPid()
    if (!pid) throw new Error('Orca is not running')
    process.kill(pid, 'SIGUSR1')
    for (let i = 0; i < 20 && !targets; i++) {
      await new Promise((r) => setTimeout(r, 250))
      targets = await listTargets()
    }
  }
  const target = targets?.find((t) => t.type === 'node')
  if (!target) throw new Error(`No inspector on ${INSPECTOR_HOST}:${INSPECTOR_PORT}`)
  return target.webSocketDebuggerUrl
}

/** A minimal CDP client: `send(method, params)` resolves with the result. */
export async function connect(url) {
  const ws = new WebSocket(url)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', () => reject(new Error(`Cannot connect to ${url}`)), {
      once: true
    })
  })
  let nextId = 1
  const pending = new Map()
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    const entry = msg.id && pending.get(msg.id)
    if (!entry) return
    pending.delete(msg.id)
    if (msg.error) entry.reject(new Error(msg.error.message))
    else entry.resolve(msg.result)
  })
  // The inspector can close under a request (a previous command closing it): fail what is
  // pending, or the caller would wait on it forever and Node would exit silently.
  ws.addEventListener('close', () => {
    for (const entry of pending.values()) entry.reject(new Error('the inspector closed before answering'))
    pending.clear()
  })
  return {
    send(method, params = {}) {
      const id = nextId++
      ws.send(JSON.stringify({ id, method, params }))
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
    },
    close() {
      ws.close()
    }
  }
}

/**
 * Evaluates `source` (an expression, awaited) in Orca's main process and returns its JSON
 * value. Inside it, `electron` is the electron module and `node(name)` loads a builtin.
 */
export async function evaluateInMain(source) {
  const client = await connect(await openInspector())
  try {
    // 9229 is Node's default inspector port: another process (a dev server run with --inspect)
    // could be listening there instead. Only ever run code in Orca's main process.
    const owner = await client.send('Runtime.evaluate', { expression: 'process.pid', returnByValue: true })
    const orcaPid = findOrcaMainPid()
    if (owner.result?.value !== orcaPid) {
      throw new Error(`the inspector on ${INSPECTOR_HOST}:${INSPECTOR_PORT} belongs to pid ${owner.result?.value}, not Orca (${orcaPid})`)
    }
    const expression = `(async () => {
      const node = (name) => process.getBuiltinModule(name)
      const electron = process.mainModule?.require?.('electron') ?? node('module').createRequire(process.execPath)('electron')
      return await (${source})
    })()`
    const { result, exceptionDetails } = await client.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      includeCommandLineAPI: true
    })
    if (exceptionDetails) {
      const detail = exceptionDetails.exception?.description ?? exceptionDetails.text
      throw new Error(`Main process threw: ${detail}`)
    }
    return result.value
  } finally {
    client.close()
  }
}
