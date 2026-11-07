// Builds the code evaluated in Orca's main process. State lives on `globalThis.__obwMain`, so
// applying again replaces the payload instead of stacking listeners.
import { readFile } from 'node:fs/promises'

const RENDERER_DIR = new URL('./renderer/', import.meta.url)

/** The renderer script with its stylesheet inlined. */
export async function buildPayload() {
  const [script, css] = await Promise.all([
    readFile(new URL('sidebar.js', RENDERER_DIR), 'utf8'),
    readFile(new URL('sidebar.css', RENDERER_DIR), 'utf8')
  ])
  const marker = 'const CSS = __OBW_CSS__'
  if (!script.includes(marker)) throw new Error(`sidebar.js lost its "${marker}" line`)
  return script.replace(marker, () => `const CSS = ${JSON.stringify(css)}`)
}

// Orca's main window loads out/renderer/index.html; other webContents (embedded browser,
// plugin frames) are left alone.
const IS_MAIN_WINDOW = `(wc) => !wc.isDestroyed() && wc.getURL().includes('/out/renderer/index.html')`

/** Expression for evaluateInMain: inject `payload` now and after every reload. */
export function applyExpression(payload) {
  return `(() => {
    const { app, BrowserWindow } = electron
    const isMainWindow = ${IS_MAIN_WINDOW}
    const state = (globalThis.__obwMain ??= { listeners: new Map() })
    state.payload = ${JSON.stringify(payload)}
    const inject = (wc) =>
      wc.executeJavaScript(state.payload).catch((err) => console.error('[obw] inject failed', err))
    state.attach ??= (win) => {
      const wc = win.webContents
      if (state.listeners.has(wc)) return
      const onLoad = () => { if (state.payload && isMainWindow(wc)) inject(wc) }
      wc.on('did-finish-load', onLoad)
      state.listeners.set(wc, onLoad)
      wc.once('destroyed', () => state.listeners.delete(wc))
    }
    if (!state.onWindow) {
      state.onWindow = (_event, win) => state.attach(win)
      app.on('browser-window-created', state.onWindow)
    }
    let injected = 0
    for (const win of BrowserWindow.getAllWindows()) {
      state.attach(win)
      if (isMainWindow(win.webContents)) { inject(win.webContents); injected++ }
    }
    return { injected }
  })()`
}

/** Expression for evaluateInMain: undo everything `applyExpression` did. */
export function removeExpression() {
  return `(() => {
    const { app, BrowserWindow } = electron
    const state = globalThis.__obwMain
    if (state) {
      if (state.onWindow) app.off('browser-window-created', state.onWindow)
      for (const [wc, onLoad] of state.listeners) if (!wc.isDestroyed()) wc.off('did-finish-load', onLoad)
      delete globalThis.__obwMain
    }
    const isMainWindow = ${IS_MAIN_WINDOW}
    let cleaned = 0
    for (const win of BrowserWindow.getAllWindows()) {
      if (!isMainWindow(win.webContents)) continue
      win.webContents.executeJavaScript('window.__obw?.dispose()').catch(() => {})
      cleaned++
    }
    return { cleaned }
  })()`
}

/** Expression for evaluateInMain: close the inspector once this connection has returned. */
export function closeInspectorExpression() {
  return `(setTimeout(() => node('inspector').close(), 100), true)`
}

/** Expression for evaluateInMain: run `source` in the main window and return its value. */
export function rendererEvalExpression(source) {
  return `(() => {
    const isMainWindow = ${IS_MAIN_WINDOW}
    const win = electron.BrowserWindow.getAllWindows().find((w) => isMainWindow(w.webContents))
    if (!win) throw new Error('Orca has no main window open')
    return win.webContents.executeJavaScript(${JSON.stringify(source)})
  })()`
}

/** Expression for evaluateInMain: a PNG (base64) of the main window, or of `rect` in it. */
export function screenshotExpression(rect) {
  return `(() => {
    const isMainWindow = ${IS_MAIN_WINDOW}
    const win = electron.BrowserWindow.getAllWindows().find((w) => isMainWindow(w.webContents))
    if (!win) throw new Error('Orca has no main window open')
    // A window behind others counts as hidden: it stops painting and keeps its last frame.
    // Turning background throttling off for the shot keeps it rendering; restore it after.
    const wc = win.webContents
    const throttled = wc.getBackgroundThrottling()
    wc.setBackgroundThrottling(false)
    return new Promise((r) => setTimeout(r, 300))
      .then(() => wc.executeJavaScript('window.__obw?.update()'))
      .then(() => { wc.invalidate(); return new Promise((r) => setTimeout(r, 700)) })
      .then(() => wc.capturePage(${rect ? JSON.stringify(rect) : 'undefined'}))
      .then((image) => image.toPNG().toString('base64'))
      .finally(() => wc.setBackgroundThrottling(throttled))
  })()`
}
