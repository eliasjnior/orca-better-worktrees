#!/usr/bin/env node
// orca-better-worktrees: restyles Orca's left sidebar in the running app.
import { readFile, writeFile } from 'node:fs/promises'
import * as agent from '../src/agent.mjs'
import { evaluateInMain, waitInspectorClosed } from '../src/inspector.mjs'
import {
  applyExpression,
  buildPayload,
  closeInspectorExpression,
  removeExpression,
  rendererEvalExpression,
  screenshotExpression
} from '../src/main-agent.mjs'
import { watch } from '../src/watch.mjs'

const USAGE = `Usage: obw <command> [options]

Commands:
  apply                 Inject the sidebar changes into the running Orca (kept across reloads)
  remove                Undo them
  stats                 How often the sidebar was redrawn since apply, what it cost, and errors
  watch                 Keep running, and apply to every Orca that starts
  agent install         Run \`obw watch\` from login, as a LaunchAgent
  agent uninstall       Remove that LaunchAgent
  agent status          Whether the LaunchAgent is installed and running
  eval <js | @file>     Evaluate JavaScript in Orca's window and print the result
  shot <out.png> [x,y,w,h]
                        Save a PNG of Orca's window, or of a rectangle of it

Options:
  --keep-inspector      Leave Orca's inspector open on 127.0.0.1:9229 afterwards
                        (it is closed by default: while open, any local process can run code in Orca)
`

// Returns once the port is closed, so a command run right after opens a fresh inspector
// instead of connecting to this one as it goes away.
async function closeInspector() {
  await evaluateInMain(closeInspectorExpression())
  await waitInspectorClosed()
}

async function main(argv) {
  const keepInspector = argv.includes('--keep-inspector')
  const [command, ...args] = argv.filter((a) => a !== '--keep-inspector')
  switch (command) {
    case 'watch':
      // Runs until stopped; it opens and closes the inspector itself.
      await watch()
      return
    case 'agent': {
      const sub = args[0]
      if (sub === 'install') {
        const { plist, log, node } = await agent.install()
        console.log(`Installed ${plist}\nIt runs ${node}; install again if you remove that Node version.\nLog: ${log}`)
      } else if (sub === 'uninstall') {
        const { plist } = await agent.uninstall()
        console.log(`Removed ${plist}`)
      } else if (sub === 'status') {
        console.log(JSON.stringify(agent.status(), null, 2))
      } else {
        throw new Error('agent needs install, uninstall or status')
      }
      return
    }
    case 'apply': {
      const { injected } = await evaluateInMain(applyExpression(await buildPayload()))
      console.log(injected ? 'Applied to Orca.' : 'Applied; it takes effect when Orca opens a window.')
      break
    }
    case 'remove': {
      await evaluateInMain(removeExpression())
      console.log('Removed from Orca.')
      break
    }
    case 'stats': {
      const value = await evaluateInMain(rendererEvalExpression('window.__obw?.stats() ?? null'))
      console.log(value ? JSON.stringify(value, null, 2) : 'Not applied in the open window.')
      break
    }
    case 'eval': {
      const source = args[0]?.startsWith('@') ? await readFile(args[0].slice(1), 'utf8') : args[0]
      if (!source) throw new Error('eval needs JavaScript or @file')
      const value = await evaluateInMain(rendererEvalExpression(source))
      console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
      break
    }
    case 'shot': {
      const [out, rectArg] = args
      if (!out) throw new Error('shot needs an output path')
      const rect = rectArg && Object.fromEntries(
        rectArg.split(',').map(Number).map((n, i) => [['x', 'y', 'width', 'height'][i], n])
      )
      await writeFile(out, Buffer.from(await evaluateInMain(screenshotExpression(rect)), 'base64'))
      console.log(`Saved ${out}`)
      break
    }
    default:
      process.stdout.write(USAGE)
      process.exitCode = command ? 1 : 0
      return
  }
  if (!keepInspector) await closeInspector()
}

main(process.argv.slice(2)).catch((err) => {
  console.error(`obw: ${err.message}`)
  process.exitCode = 1
})
