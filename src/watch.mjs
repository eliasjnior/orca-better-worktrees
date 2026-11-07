// `obw watch`: applies the sidebar changes to every Orca that starts, for as long as it runs.
// The LaunchAgent (agent.mjs) keeps it running from login.
import { evaluateInMain, findOrcaMainPid, processAgeSeconds, waitInspectorClosed } from './inspector.mjs'
import { applyExpression, buildPayload, closeInspectorExpression } from './main-agent.mjs'

// Orca's main process sets up its inspector signal handler as it starts; give it time before
// sending SIGUSR1 (which would end a process that has no handler yet).
const STARTUP_GRACE_S = 3
// While the Orca it applied to is alive, the watcher only checks that pid (a signal-0 syscall,
// no process spawned); otherwise it looks for a new Orca with `ps`.
const ALIVE_CHECK_MS = 5000
const SEARCH_MS = 2000
const MAX_ATTEMPTS = 10

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const log = (message) => console.log(`${new Date().toISOString()} ${message}`)

export async function watch() {
  let appliedPid = null
  let failedPid = null
  let attempts = 0
  log('watching for Orca')
  for (;;) {
    if (appliedPid && isAlive(appliedPid)) {
      await sleep(ALIVE_CHECK_MS)
      continue
    }
    if (appliedPid) {
      log(`Orca (pid ${appliedPid}) exited`)
      appliedPid = null
    }
    const pid = findOrcaMainPid()
    if (pid && pid !== failedPid && (processAgeSeconds(pid) ?? 0) >= STARTUP_GRACE_S) {
      try {
        const payload = await buildPayload()
        const { injected } = await evaluateInMain(applyExpression(payload))
        await evaluateInMain(closeInspectorExpression())
        await waitInspectorClosed()
        log(`applied to Orca (pid ${pid}, ${injected ? 'window open' : 'on its first window'})`)
        appliedPid = pid
        attempts = 0
      } catch (error) {
        attempts++
        log(`apply to Orca (pid ${pid}) failed, attempt ${attempts}: ${error.message}`)
        if (attempts >= MAX_ATTEMPTS) {
          log(`giving up on Orca (pid ${pid}) until it restarts`)
          failedPid = pid
          attempts = 0
        }
      }
    }
    if (!pid) failedPid = null
    await sleep(SEARCH_MS)
  }
}
