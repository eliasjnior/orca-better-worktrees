// The LaunchAgent that keeps `obw watch` running from login, so every Orca start gets the
// sidebar changes without running `obw apply`.
import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const LABEL = 'dev.orca-better-worktrees.watch'
const PLIST = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`)
export const LOG = join(homedir(), 'Library', 'Logs', 'orca-better-worktrees.log')
const CLI = fileURLToPath(new URL('../bin/obw.mjs', import.meta.url))
const DOMAIN = `gui/${process.getuid()}`

const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function plist(node) {
  const args = [node, realpathSync(CLI), 'watch'].map((a) => `    <string>${xml(a)}</string>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xml(LOG)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(LOG)}</string>
</dict>
</plist>
`
}

function launchctl(...args) {
  return execFileSync('launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function bootout() {
  try {
    launchctl('bootout', `${DOMAIN}/${LABEL}`)
  } catch {
    // Not loaded.
  }
}

/**
 * Writes the LaunchAgent and starts it. It runs this Node binary by its real path (not a
 * version manager's shim, which launchd's minimal environment may not resolve): install again
 * after removing that Node version.
 */
export async function install() {
  const node = realpathSync(process.execPath)
  await mkdir(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true })
  await mkdir(join(homedir(), 'Library', 'Logs'), { recursive: true })
  await writeFile(PLIST, plist(node))
  bootout()
  launchctl('bootstrap', DOMAIN, PLIST)
  return { plist: PLIST, log: LOG, node }
}

export async function uninstall() {
  bootout()
  if (existsSync(PLIST)) await rm(PLIST)
  return { plist: PLIST }
}

/** Whether the agent is installed and running, from launchctl. */
export function status() {
  if (!existsSync(PLIST)) return { installed: false }
  try {
    const out = launchctl('print', `${DOMAIN}/${LABEL}`)
    const state = out.match(/^\s*state = (.+)$/m)?.[1] ?? 'unknown'
    const pid = out.match(/^\s*pid = (\d+)$/m)?.[1] ?? null
    return { installed: true, state, pid: pid && Number(pid), log: LOG }
  } catch {
    return { installed: true, state: 'not loaded', log: LOG }
  }
}
