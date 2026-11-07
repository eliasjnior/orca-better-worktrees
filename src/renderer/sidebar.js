// Runs inside Orca's window (the renderer). Installed by `obw apply`; `__OBW_CSS__` is replaced
// with sidebar.css before injection. Re-running it replaces the previous install.
//
// The left sidebar is a virtualized list (TanStack Virtual): every row (group header, project
// header, worktree) is an absolutely positioned sibling, so there is no element per project to
// style. This script classifies the rendered rows in order, then:
//   - insets header rows and indents worktree rows (attributes and CSS variables, read by CSS);
//   - draws boxes, stripes and connectors in one overlay layer under the rows;
//   - sets `data-obw-status` on each worktree's title row, which CSS turns into a chip;
//   - adds virtual height after a header that closes a group, so the next box has room.
// It never moves or removes React's nodes.
;(() => {
  const CSS = __OBW_CSS__
  const POLL_MS = 1500
  const STATUS_DEFS_TTL_MS = 5000

  // Horizontal geometry, in px from the row container's left (or right) edge. Boxes nest in
  // steps of STEP: a top-level box (a group, or a project outside any group) spans
  // OUTER_LEFT..OUTER_RIGHT, a project inside a group one STEP further in on both sides, and a
  // header's icon sits STEP inside its box.
  const STEP = 8
  const OUTER_LEFT = 4
  const OUTER_RIGHT = 2
  const ICON_SIZE = 16
  // From a project's trunk to its worktrees' status slots.
  const ELBOW_REACH = 8

  // Vertical geometry. Groups and projects share one title layout: TITLE_INSET above the
  // 28px title (forced by CSS, as Orca drops it from a pinned group header), TITLE_INSET below
  // it to the separator line of an open box, or to the bottom edge of a collapsed one (a box
  // around the title alone). Below the line, a group leaves GROUP_TITLE_GAP to its first
  // project's box, a project PROJECT_TITLE_GAP to its first worktree. A project box ends
  // PROJECT_PAD below its last worktree; a group's bottom edge sits NEST below the last
  // project's. Every box sits BOX_GAP from the next. ROW_GAP is the gap Orca's virtualizer puts
  // between rows.
  const TITLE_INSET = 4
  const TITLE_HEIGHT = 28
  const TITLE_ROW = TITLE_INSET + TITLE_HEIGHT
  // Worktree cards keep STEP from their project box on every side (the selected card has its
  // own border and fill, which shows any tighter fit).
  const GROUP_TITLE_GAP = STEP
  const PROJECT_TITLE_GAP = STEP
  const PROJECT_PAD = STEP
  // The same step as the sides and the top (GROUP_TITLE_GAP), so a project box sits evenly
  // inside its group's.
  const NEST = STEP
  const GROUP_PAD = PROJECT_PAD + NEST
  const BOX_GAP = 11
  const ROW_GAP = 6
  // Bottom padding on the worktree row that closes a box (the next header's box starts at its
  // row's top).
  const GAP_PAD = {
    project: BOX_GAP - ROW_GAP + PROJECT_PAD,
    group: BOX_GAP - ROW_GAP + GROUP_PAD
  }
  // Headers have a fixed height in Orca's virtualizer, so the room around them is set as their
  // virtual size instead (see sizeRules).
  const OPEN_GROUP_SIZE = TITLE_ROW + TITLE_INSET + GROUP_TITLE_GAP - ROW_GAP
  const OPEN_PROJECT_SIZE = TITLE_ROW + TITLE_INSET + PROJECT_TITLE_GAP - ROW_GAP
  const COLLAPSED_SIZE = TITLE_ROW + TITLE_INSET + BOX_GAP - ROW_GAP

  window.__obw?.dispose()

  const style = document.createElement('style')
  style.id = 'obw-style'
  style.textContent = CSS
  document.head.append(style)

  let frame = 0
  let statusDefs = null
  let statusDefsAt = 0
  let container = null
  // Ignore the overlay's own redraws, or every update would schedule the next one.
  const isOwn = (node) => node.nodeType === 1 && node.hasAttribute('data-obw-overlay')
  const containerObserver = new MutationObserver((records) => {
    const foreign = records.some((r) => {
      if (isOwn(r.target)) return false
      const nodes = [...r.addedNodes, ...r.removedNodes]
      return nodes.length === 0 || !nodes.every(isOwn)
    })
    if (foreign) schedule()
  })

  function schedule() {
    if (!frame) frame = requestAnimationFrame(update)
  }

  /** The element that holds the rows; React may replace it (group-by change, sidebar toggle). */
  function findContainer() {
    const row = document.querySelector('[data-worktree-sidebar] [data-worktree-virtual-row]')
    return row?.parentElement ?? null
  }

  // What `obw stats` reports: how often the sidebar was redrawn and what it cost.
  const stats = { updates: 0, totalMs: 0, maxMs: 0, since: Date.now(), errors: 0, lastError: null }

  function update() {
    frame = 0
    const started = performance.now()
    try {
      render()
    } finally {
      const ms = performance.now() - started
      stats.updates++
      stats.totalMs += ms
      stats.maxMs = Math.max(stats.maxMs, ms)
    }
  }

  function render() {
    const next = findContainer()
    if (next !== container) {
      containerObserver.disconnect()
      container?.closest('[data-worktree-sidebar]')?.removeEventListener('scroll', onScroll)
      next?.closest('[data-worktree-sidebar]')?.addEventListener('scroll', onScroll, { passive: true })
      container = next
      if (container) {
        containerObserver.observe(container, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['data-worktree-virtual-row-start']
        })
      }
    }
    if (!container) return
    // Each step runs on its own: a row shape this script does not expect must not leave the
    // rest undone (or the virtualizer unpatched) until the list changes shape again. Sizes go
    // first, as they depend on Orca's row model only, not on the rendered rows.
    step('virtualizer', () => syncVirtualizer(container.closest('[data-worktree-sidebar]')))
    const model = step('classify', () => classify(container))
    if (model) {
      step('heads', () => markHeads(container, model))
      step('rows', () => markRows(container, model))
      step('overlay', () => drawOverlay(container, model))
      // The caps and title lines (pseudo-elements of the row) follow the content's animation.
      step('shift', () => {
        for (const row of model.rows) setStyleVar(row.el, '--obw-shift', `${row.shift}px`)
      })
    }
    step('statuses', () => markStatuses(container))
    step('stuck', () => markStuck())
  }

  /** Runs one step of an update; a failure is recorded (see `obw stats`) and logged once. */
  function step(name, fn) {
    try {
      return fn()
    } catch (error) {
      const message = `${name}: ${error?.message ?? error}`
      stats.errors++
      if (stats.lastError?.message !== message) console.warn('[obw]', message, error)
      stats.lastError = { message, stack: String(error?.stack ?? '').split('\n').slice(0, 4).join(' | '), at: new Date().toISOString() }
      return undefined
    }
  }

  // --- Rows --------------------------------------------------------------------------------

  const isHeader = (row) => row.key.startsWith('hdr:')

  /**
   * When rows move (a group collapses or expands), Orca jumps each row to its new place and
   * animates its content back from the old one (`translate: 0 Δy → 0` on the row's first child,
   * 180ms). While that runs, this is the content's current offset; null when nothing animates.
   */
  function animatedShift(rowEl) {
    const inner = rowEl.firstElementChild
    if (!inner || inner.getAnimations().length === 0) return null
    const translate = getComputedStyle(inner).translate
    if (!translate || translate === 'none') return 0
    return parseFloat(translate.split(' ')[1] ?? '0') || 0
  }

  /** A box's edges, from the container's left and right, for a nesting depth (0 or 1). */
  const boxInsets = (depth) => ({
    left: OUTER_LEFT + depth * STEP,
    right: OUTER_RIGHT + depth * STEP
  })

  /**
   * Where a row's content ends. Rows that close a box carry extra bottom padding (the gap to
   * the next box), which belongs below the box, not inside it.
   */
  function contentBottom(row) {
    const pad = row.el.hasAttribute('data-obw-gap') ? parseFloat(getComputedStyle(row.el).paddingBottom) : 0
    return row.top + row.el.offsetHeight - (pad || 0)
  }

  /**
   * Group and project headers in row order, with the worktree rows under each project. Every
   * group and project is boxed; a collapsed one (or a project without worktrees) around its
   * title alone.
   */
  function classify(root) {
    // Reads only: the shifts are written after the overlay is measured (see render), so a frame
    // costs one layout, not one per row.
    let animating = false
    const rows = [...root.children]
      .filter((el) => el.hasAttribute('data-worktree-virtual-row'))
      .map((el) => {
        const start = Number(el.dataset.worktreeVirtualRowStart ?? el.offsetTop)
        const shift = animatedShift(el)
        if (shift !== null) animating = true
        return {
          el,
          key: el.dataset.worktreeVirtualRowKey ?? '',
          start,
          shift: shift ?? 0,
          animating: shift !== null,
          top: start + (shift ?? 0),
          height: el.offsetHeight
        }
      })
      .sort((a, b) => a.start - b.start)
    // Follow Orca's row animation frame by frame until it ends.
    if (animating) schedule()

    const groups = []
    const projects = []
    let group = null
    let project = null
    for (const row of rows) {
      if (row.key.startsWith('hdr:project-group:')) {
        project = null
        group = { header: row, id: row.el.firstElementChild?.dataset.projectGroupHeaderId, last: row, depth: 0 }
        groups.push(group)
      } else if (row.key.startsWith('hdr:project:')) {
        const bucket = row.el.firstElementChild?.dataset.repoHeaderBucket ?? ''
        if (!group || bucket !== `group:${group.id}`) group = null
        project = { header: row, children: [], depth: group ? 1 : 0, inGroup: group }
        projects.push(project)
      } else if (isHeader(row)) {
        group = null
        project = null
        continue
      } else if (project) {
        project.children.push(row)
      }
      if (group) group.last = row
    }
    // `next` is the first row after a box. Its box keeps BOX_GAP from it, plus NEST for a
    // project that ends its group (the group's own edge sits between them).
    const after = (row) => rows[rows.indexOf(row) + 1] ?? null
    for (const g of groups) {
      g.collapsed = g.last === g.header
      g.next = after(g.last)
      g.followGap = BOX_GAP
    }
    for (const p of projects) {
      p.collapsed = p.children.length === 0
      p.next = after(p.children.at(-1) ?? p.header)
      const nextInGroup =
        p.next?.key.startsWith('hdr:project:') &&
        p.next.el.firstElementChild?.dataset.repoHeaderBucket === `group:${p.inGroup?.id}`
      p.followGap = p.inGroup && !nextInGroup ? BOX_GAP + NEST : BOX_GAP
    }
    return {
      rows,
      headers: [...groups.map((g) => ({ row: g.header, depth: 0 })), ...projects.map((p) => ({ row: p.header, depth: p.depth }))],
      groups,
      projects
    }
  }

  const HEAD_VARS = ['--obw-inner-left', '--obw-inner-right', '--obw-inner-pad']

  /**
   * Every group and project header is inset to its box, boxed or not, so all headers at one
   * depth line up: Orca's header element spans the full row and its hover, drag and reveal
   * states paint a rounded fill there, which should stay inside the box. Its left padding puts
   * the icon STEP inside the box.
   */
  function markHeads(root, { headers }) {
    const seen = new Set()
    for (const { row, depth } of headers) {
      const { left, right } = boxInsets(depth)
      seen.add(row.el)
      setAttr(row.el, 'data-obw-head', '')
      setStyleVar(row.el, '--obw-inner-left', `${left + 2}px`)
      setStyleVar(row.el, '--obw-inner-right', `${right + 2}px`)
      setStyleVar(row.el, '--obw-inner-pad', `${STEP - 2}px`)
    }
    for (const el of root.querySelectorAll(':scope > [data-obw-head]')) {
      if (seen.has(el)) continue
      el.removeAttribute('data-obw-head')
      for (const v of HEAD_VARS) el.style.removeProperty(v)
    }
  }

  const ROW_VARS = ['--obw-gap', '--obw-card-right']

  /**
   * Marks worktree rows under a boxed project (`data-obw-child`, indented by CSS) and the rows
   * that close a box (`data-obw-gap`, whose bottom padding spaces the boxes apart: Orca
   * re-measures worktree rows, so the rows below follow).
   */
  function markRows(root, { groups, projects }) {
    const marks = new Map()
    for (const project of projects) {
      if (project.collapsed) continue
      const { right } = boxInsets(project.depth)
      for (const child of project.children) marks.set(child.el, { gap: null, cardRight: right + STEP })
      marks.get(project.children.at(-1).el).gap = 'project'
    }
    for (const group of groups) {
      // The group's last row takes the group's gap, when it is one of the worktree rows marked
      // above (a notice or a row Orca shows while dragging can also end a group).
      const mark = !isHeader(group.last) && marks.get(group.last.el)
      if (mark) mark.gap = 'group'
    }
    for (const el of root.querySelectorAll(':scope > [data-obw-child]')) {
      if (marks.has(el)) continue
      el.removeAttribute('data-obw-child')
      el.removeAttribute('data-obw-gap')
      for (const v of [...ROW_VARS, '--obw-indent']) el.style.removeProperty(v)
    }
    for (const [el, mark] of marks) {
      setAttr(el, 'data-obw-child', '')
      setAttr(el, 'data-obw-gap', mark.gap)
      if (mark.gap) setStyleVar(el, '--obw-gap', `${GAP_PAD[mark.gap]}px`)
      else el.style.removeProperty('--obw-gap')
      setStyleVar(el, '--obw-card-right', `${mark.cardRight}px`)
    }
  }

  // --- Overlay -----------------------------------------------------------------------------

  // A box is split in two: its header row draws the top (a `::before` cap, so the edge follows
  // the header when Orca makes it sticky and paints it opaque), and the overlay draws the sides
  // and bottom from the header down.
  function drawOverlay(root, { groups, projects }) {
    let overlay = root.querySelector(':scope > [data-obw-overlay]')
    if (!overlay) {
      overlay = document.createElement('div')
      overlay.setAttribute('data-obw-overlay', '')
      overlay.setAttribute('aria-hidden', 'true')
      root.prepend(overlay)
    }
    const origin = root.getBoundingClientRect()
    const width = root.clientWidth
    const parts = []
    const caps = new Map()
    const part = (kind, left, top, w, h, extra = '') => {
      parts.push({ kind, css: `left:${left}px;top:${top}px;width:${w}px;height:${h}px;${extra}` })
    }
    let indentsMoved = false

    /**
     * One box: the header row's cap (its top, or the whole box when collapsed) and the
     * overlay's sides and bottom from the header down. Returns the drawn box, or null when it
     * is collapsed. While Orca animates the rows below into place (this box collapsed or
     * expanded), its bottom follows the next row instead, `followGap` above it, so it closes or
     * opens with them; a collapsing box turns into its rounded collapsed form once they arrive.
     */
    const box = (kind, { header, depth, collapsed, next, followGap }, restBottom) => {
      const { left, right } = boxInsets(depth)
      const top = header.top + header.height
      let bottom = collapsed ? top + TITLE_INSET : restBottom()
      if (next?.animating) {
        const followed = next.top - followGap
        if (!collapsed || followed > bottom + 0.5) {
          collapsed = false
          bottom = followed
        }
      }
      const cap = capFor(kind, header.el, left, right)
      caps.set(header.el, cap)
      if (collapsed) {
        // The whole box is the header's cap, reaching TITLE_INSET below the row.
        cap.collapsed = true
        cap.vars['--obw-cap-bottom'] = `${-TITLE_INSET}px`
        return null
      }
      part(kind, left, top, width - left - right, Math.max(0, bottom - top))
      // Where the content starts: just under the separator line below the title.
      return { left, right, top, bottom, width: width - left - right, contentTop: top + TITLE_INSET + 1 }
    }

    for (const group of groups) {
      box('group', group, () =>
        isHeader(group.last)
          ? group.last.top + group.last.height + TITLE_INSET + NEST
          : contentBottom(group.last) + GROUP_PAD
      )
    }

    for (const project of projects) {
      const { children } = project
      const drawn = box('project', project, () => contentBottom(children.at(-1)) + PROJECT_PAD)
      if (!drawn || children.length === 0) continue
      const { left, bottom, contentTop } = drawn

      // Every other worktree gets a faint band, so neighbours read apart. Each band reaches
      // halfway into the gaps around its row; the first starts under the title's line, and the
      // last follows the box's rounded corners.
      children.forEach((child, i) => {
        if (i % 2 !== 0) return
        const bandTop = i === 0 ? contentTop : Math.round((contentBottom(children[i - 1]) + child.top) / 2)
        const isLast = i === children.length - 1
        const bandBottom = isLast ? bottom - 1 : Math.round((contentBottom(child) + children[i + 1].top) / 2)
        part('stripe', left + 1, bandTop, drawn.width - 2, bandBottom - bandTop, isLast ? 'border-radius:0 0 7px 7px' : '')
      })

      // The trunk hangs from the title's line, under the project icon.
      const trunkX = left + STEP + ICON_SIZE / 2
      const slots = []
      for (const child of children) {
        const slot = child.el.querySelector('[data-worktree-card-status-slot]')
        slots.push(slot)
        // Rows without a status icon (Orca's notices, such as discovered worktrees it hides)
        // line their left edge up with where the worktrees' icons start, clear of the trunk.
        const anchor = slot ?? child.el.firstElementChild
        if (anchor) indentsMoved = alignIndent(child.el, anchor, origin, trunkX + ELBOW_REACH) || indentsMoved
      }
      connect(part, origin, trunkX, contentTop, slots)

      // A worktree with child worktrees lists them inside its card: connect those to it too.
      for (const child of children) {
        for (const list of child.el.querySelectorAll('[data-worktree-lineage-children]')) {
          const parentSlot = list.closest('[role="option"]')?.querySelector('[data-worktree-card-status-slot]')
          if (!parentSlot) continue
          const p = parentSlot.getBoundingClientRect()
          const nested = [...list.querySelectorAll(':scope > [role="option"]')].map((o) =>
            o.querySelector('[data-worktree-card-status-slot]')
          )
          connect(part, origin, p.left - origin.left + p.width / 2, p.bottom - origin.top - 1, nested)
        }
      }
    }

    // Most updates (a card's text changed, the poll fired) leave the geometry as it was: skip
    // the DOM writes then, so the next frame has no layout to redo.
    const signature = parts.map((p) => `${p.kind}:${p.css}`).join('|')
    if (overlay.dataset.obwSignature !== signature) {
      overlay.dataset.obwSignature = signature
      // Reuse the existing pieces (an animation moves them every frame), adding or dropping
      // only the difference.
      const existing = overlay.children
      parts.forEach((p, i) => {
        let div = existing[i]
        if (!div) {
          div = document.createElement('div')
          overlay.append(div)
        }
        if (div.dataset.obwKind !== p.kind) div.dataset.obwKind = p.kind
        // Compare against what was set: the browser normalizes cssText when it reads it back.
        if (div.__obwCss !== p.css) {
          div.__obwCss = p.css
          div.style.cssText = p.css
        }
      })
      while (existing.length > parts.length) existing[existing.length - 1].remove()
    }
    markCaps(root, caps)
    // A moved indent moved its status slot: draw again with the slots where they now are.
    if (indentsMoved) schedule()
  }

  /**
   * Indents a row under a project so `anchor` (its status slot, or the row's content when it
   * has none) starts at `targetLeft`. Orca's own card padding varies (depth, lineage, row type),
   * so this measures and corrects the indent. Returns whether it changed.
   */
  function alignIndent(rowEl, anchor, origin, targetLeft) {
    const current = parseFloat(rowEl.style.getPropertyValue('--obw-indent')) || 0
    const anchorLeft = anchor.getBoundingClientRect().left - origin.left
    const next = Math.max(0, Math.round(current + targetLeft - anchorLeft))
    if (Math.abs(next - current) < 1) return false
    rowEl.style.setProperty('--obw-indent', `${next}px`)
    return true
  }

  /**
   * A trunk at `x` from `top` down, and an elbow from it into each status slot (all in the row
   * container's coordinates). Slots that sit too close to the trunk get no elbow.
   */
  function connect(part, origin, x, top, slots) {
    x = Math.round(x)
    top = Math.round(top)
    let lastElbow = top
    for (const slot of slots) {
      if (!slot) continue
      const rect = slot.getBoundingClientRect()
      const y = Math.round(rect.top - origin.top + rect.height / 2)
      // Stop just short of the status icon, which sits centered in its 20px slot.
      const reach = Math.round(rect.left - origin.left) + 2 - x
      if (reach < 4) continue
      part('elbow', x, y - 6, reach, 7)
      lastElbow = y - 6
    }
    if (lastElbow > top) part('trunk', x, top, 1, lastElbow - top)
  }

  const CAP_VARS = ['--obw-cap-left', '--obw-cap-right', '--obw-cap-top', '--obw-cap-bottom']

  /** The cap a boxed header draws: its box's edges, its top TITLE_INSET above the title. */
  function capFor(kind, rowEl, left, right) {
    const inner = rowEl.firstElementChild
    return {
      kind,
      vars: {
        '--obw-cap-left': `${left}px`,
        '--obw-cap-right': `${right}px`,
        '--obw-cap-top': `${Math.max(0, (inner?.offsetTop ?? 0) - TITLE_INSET)}px`,
        '--obw-cap-bottom': '0px'
      }
    }
  }

  function markCaps(root, caps) {
    for (const el of root.querySelectorAll(':scope > [data-obw-cap]')) {
      if (caps.has(el)) continue
      el.removeAttribute('data-obw-cap')
      el.removeAttribute('data-obw-collapsed')
      for (const v of CAP_VARS) el.style.removeProperty(v)
    }
    for (const [el, cap] of caps) {
      setAttr(el, 'data-obw-cap', cap.kind)
      setAttr(el, 'data-obw-collapsed', cap.collapsed ? '' : null)
      for (const [name, value] of Object.entries(cap.vars)) setStyleVar(el, name, value)
    }
  }

  // --- Pinned group header -----------------------------------------------------------------

  /**
   * Orca keeps the current group's header pinned to the top (`data-worktree-sticky-header-active`,
   * set even while it sits in place). Mark it `data-obw-stuck` once the list has scrolled past
   * its own position.
   */
  function markStuck() {
    const sidebar = container?.closest('[data-worktree-sidebar]')
    if (!sidebar) return
    const scrollTop = sidebar.scrollTop
    for (const row of container.querySelectorAll(':scope > [data-worktree-virtual-row]')) {
      const stuck =
        row.hasAttribute('data-worktree-sticky-header-active') &&
        scrollTop > Number(row.dataset.worktreeVirtualRowStart ?? 0)
      setAttr(row, 'data-obw-stuck', stuck ? '' : null)
    }
  }

  // Scrolling only changes which header is stuck: a light pass, at most once per frame.
  let stuckFrame = 0
  function onScroll() {
    if (!stuckFrame) {
      stuckFrame = requestAnimationFrame(() => {
        stuckFrame = 0
        markStuck()
      })
    }
  }

  // --- Virtualizer -------------------------------------------------------------------------
  //
  // Orca's virtualizer gives header rows a fixed height (its measureElement returns the
  // estimate for them), so room around a header cannot come from padding like a worktree row's.
  // Instead its options are wrapped so those headers report the size this layout needs; the
  // virtualizer then places every later row itself, and scrolling stays consistent. The sizes
  // are worked out from Orca's full row model, so rows outside the rendered range count too.

  let virtualizer = null
  // Identifies this install's wrapper on the virtualizer.
  const OWNER = {}
  // Row key -> { size } (replaces Orca's size) or { extra } (adds to it).
  let extras = new Map()

  const sizeFor = (key, base) => {
    const rule = extras.get(key)
    if (!rule) return base
    return rule.size ?? base + rule.extra
  }

  /** The sidebar's virtualizer and the rows it lays out, from React's state. */
  function findVirtualizer(sidebar) {
    let fiber = currentFiber(sidebar)
    for (let up = 0; fiber && up < 6; up++, fiber = fiber.return) {
      if (typeof fiber.type !== 'function') continue
      for (let hook = fiber.memoizedState; hook; hook = hook.next) {
        const v = hook.memoizedState
        if (v && typeof v.getVirtualItems === 'function' && v.scrollElement === sidebar) {
          return { instance: v, fiber }
        }
      }
    }
    return null
  }

  /**
   * The size of every group and project header, from the full row model: an open one leaves
   * room for its separator line and the gap to its first row; a collapsed one (or a project
   * without worktrees) for its box and BOX_GAP, plus NEST when it is the last project of its
   * group (the group's edge closes below it).
   */
  function sizeRules(instance, rows) {
    const keys = new Map()
    const key = (i) => instance.options.getItemKey(i)
    // Rows a group's box contains: its projects (headers one level in) and their worktrees.
    const inGroup = (row) => !!row && (row.type !== 'header' || (!!row.repo && (row.projectGroupDepth ?? 0) > 0))
    rows.forEach((row, i) => {
      if (row?.type !== 'header') return
      const next = rows[i + 1]
      if (row.projectGroup) {
        keys.set(key(i), { size: inGroup(next) ? OPEN_GROUP_SIZE : COLLAPSED_SIZE })
      } else if (row.repo) {
        if (next && next.type !== 'header') {
          keys.set(key(i), { size: OPEN_PROJECT_SIZE })
        } else {
          const endsGroup = (row.projectGroupDepth ?? 0) > 0 && !inGroup(next)
          keys.set(key(i), { size: COLLAPSED_SIZE + (endsGroup ? NEST : 0) })
        }
      }
    })
    return keys
  }

  function wrapOptions(opts) {
    const estimate = opts.estimateSize?.__obwBase ?? opts.estimateSize
    const measure = opts.measureElement?.__obwBase ?? opts.measureElement
    const estimateSize = (i) => sizeFor(opts.getItemKey(i), estimate(i))
    estimateSize.__obwBase = estimate
    const out = { ...opts, estimateSize }
    if (measure) {
      const measureElement = (el, entry, inst) =>
        sizeFor(el.getAttribute('data-worktree-virtual-row-key'), measure(el, entry, inst))
      measureElement.__obwBase = measure
      out.measureElement = measureElement
    }
    return out
  }

  function unwrapOptions(opts) {
    const out = { ...opts }
    if (opts.estimateSize?.__obwBase) out.estimateSize = opts.estimateSize.__obwBase
    if (opts.measureElement?.__obwBase) out.measureElement = opts.measureElement.__obwBase
    return out
  }

  /** Sets each changed key's size: its base estimate plus its extra (if any). */
  function resizeKeys(instance, keys) {
    const base = instance.options.estimateSize.__obwBase ?? instance.options.estimateSize
    for (let i = 0; i < instance.options.count; i++) {
      const key = instance.options.getItemKey(i)
      if (keys.has(key)) instance.resizeItem(i, sizeFor(key, base(i)))
    }
  }

  function syncVirtualizer(sidebar) {
    if (!sidebar) return
    // Looked up every time (a few fibers up): a remount can bring a new instance even with the
    // same scroll element, and the fiber found here is the current one, with current rows.
    const found = findVirtualizer(sidebar)
    if (!found) return
    if (found.instance !== virtualizer?.instance) extras = new Map()
    virtualizer = found
    const { instance } = virtualizer
    // A previous install may have left its wrapper on this instance (Orca can remount the
    // sidebar, handing the old install's dispose a different instance): take over from it,
    // wrapping Orca's own setOptions again so only this install's sizes apply.
    if (instance.__obwOwner !== OWNER) {
      const base = instance.__obwSetOptions ?? instance.setOptions
      instance.__obwSetOptions = base
      instance.__obwOwner = OWNER
      instance.setOptions = (opts) => base(wrapOptions(opts))
      instance.setOptions(instance.options)
      extras = new Map()
    }
    const rows = virtualizer.fiber.memoizedProps?.rows
    if (!Array.isArray(rows) || rows.length !== instance.options.count) return
    const next = sizeRules(instance, rows)
    const changed = new Set()
    const same = (a, b) => a?.size === b?.size && a?.extra === b?.extra
    for (const [k, v] of next) if (!same(extras.get(k), v)) changed.add(k)
    for (const k of extras.keys()) if (!next.has(k)) changed.add(k)
    if (changed.size === 0) return
    extras = next
    resizeKeys(instance, changed)
  }

  function restoreVirtualizer() {
    const instance = virtualizer?.instance
    if (!instance?.__obwSetOptions || instance.__obwOwner !== OWNER) return
    const changed = new Set(extras.keys())
    extras = new Map()
    instance.setOptions = instance.__obwSetOptions
    delete instance.__obwSetOptions
    delete instance.__obwOwner
    instance.setOptions(unwrapOptions(instance.options))
    resizeKeys(instance, changed)
  }

  // --- Status chip -------------------------------------------------------------------------

  function reactKeys(el) {
    let fiber
    let props
    for (const k in el) {
      if (k.startsWith('__reactFiber$')) fiber = k
      else if (k.startsWith('__reactProps$')) props = k
    }
    return { fiber, props }
  }

  /** The committed fiber for a DOM node: the one whose props React last wrote to the node. */
  function currentFiber(el) {
    const keys = reactKeys(el)
    const fiber = keys.fiber && el[keys.fiber]
    if (!fiber) return null
    if (fiber.alternate && fiber.alternate.memoizedProps === el[keys.props]) return fiber.alternate
    return fiber
  }

  /** First descendant fiber (depth-first, bounded) whose props satisfy `test`. */
  function findProps(fiber, test, limit) {
    const stack = [fiber]
    let seen = 0
    while (stack.length && seen++ < limit) {
      const node = stack.pop()
      if (!node) continue
      const props = node.memoizedProps
      if (props && typeof props === 'object' && test(props)) return props
      stack.push(node.sibling === fiber.sibling ? null : node.sibling, node.child)
    }
    return null
  }

  function loadStatusDefs() {
    const now = Date.now()
    if (statusDefs && now - statusDefsAt < STATUS_DEFS_TTL_MS) return statusDefs
    const sidebar = document.querySelector('[data-worktree-sidebar]')
    let fiber = sidebar && currentFiber(sidebar)
    // The list lives in props of an ancestor of the sidebar; walk up until one has it.
    while (fiber) {
      const props = fiber.memoizedProps
      if (props && Array.isArray(props.workspaceStatuses)) break
      fiber = fiber.return
    }
    let defs = fiber?.memoizedProps.workspaceStatuses
    if (!defs) {
      const rootEl = document.getElementById('root')
      const rootKey = rootEl && Object.keys(rootEl).find((k) => k.startsWith('__reactContainer$'))
      const found = rootKey && findProps(rootEl[rootKey], (p) => Array.isArray(p.workspaceStatuses), 5000)
      defs = found?.workspaceStatuses
    }
    if (defs) {
      statusDefs = new Map(defs.map((d) => [d.id, d]))
      statusDefsAt = now
    }
    return statusDefs
  }

  /**
   * The worktree an option element renders. The card component that takes it as a prop sits
   * inside the option; matching the id keeps a parent's search from returning a nested child.
   */
  function worktreeOf(option) {
    const id = option.dataset.worktreeId
    const fiber = currentFiber(option)
    return (fiber && findProps(fiber.child, (p) => p.worktree?.id === id, 300)?.worktree) ?? null
  }

  // Every worktree option, including a lineage group's parent and its nested children; each
  // gets the chip on its own title (the first title inside it is its own).
  function markStatuses(root) {
    const defs = loadStatusDefs()
    for (const option of root.querySelectorAll(':scope > [data-worktree-virtual-row] [role="option"][data-worktree-id]')) {
      const title = option.querySelector('[data-worktree-title-inline-rename]')?.parentElement
      if (!title) continue
      const def = defs?.get(worktreeOf(option)?.workspaceStatus)
      setAttr(title, 'data-obw-status', def?.label ?? null)
      setAttr(title, 'data-obw-status-color', def?.color ?? null)
    }
  }

  // --- DOM helpers -------------------------------------------------------------------------

  function setAttr(el, name, value) {
    if (value === null) {
      if (el.hasAttribute(name)) el.removeAttribute(name)
    } else if (el.getAttribute(name) !== value) {
      el.setAttribute(name, value)
    }
  }

  function setStyleVar(el, name, value) {
    if (el.style.getPropertyValue(name) !== value) el.style.setProperty(name, value)
  }

  // --- Lifecycle ---------------------------------------------------------------------------

  // Status changes do not always touch the DOM, and the sidebar can be remounted: a slow poll
  // covers both. It only schedules a frame, and skips while the window is hidden.
  const poll = setInterval(() => {
    if (document.visibilityState === 'visible') schedule()
  }, POLL_MS)
  window.addEventListener('resize', schedule)
  document.addEventListener('visibilitychange', schedule)
  schedule()

  const ATTRS = ['data-obw-head', 'data-obw-child', 'data-obw-gap', 'data-obw-cap', 'data-obw-collapsed', 'data-obw-stuck', 'data-obw-status', 'data-obw-status-color']
  const VARS = [...HEAD_VARS, ...ROW_VARS, ...CAP_VARS, '--obw-indent', '--obw-shift']

  window.__obw = {
    version: 2,
    update,
    stats() {
      const seconds = (Date.now() - stats.since) / 1000
      return {
        seconds: Math.round(seconds),
        updates: stats.updates,
        updatesPerMinute: Math.round((stats.updates / seconds) * 60 * 10) / 10,
        avgMs: stats.updates ? Math.round((stats.totalMs / stats.updates) * 1000) / 1000 : 0,
        maxMs: Math.round(stats.maxMs * 1000) / 1000,
        errors: stats.errors,
        lastError: stats.lastError
      }
    },
    dispose() {
      clearInterval(poll)
      window.removeEventListener('resize', schedule)
      document.removeEventListener('visibilitychange', schedule)
      containerObserver.disconnect()
      container?.closest('[data-worktree-sidebar]')?.removeEventListener('scroll', onScroll)
      if (frame) cancelAnimationFrame(frame)
      if (stuckFrame) cancelAnimationFrame(stuckFrame)
      restoreVirtualizer()
      style.remove()
      for (const el of document.querySelectorAll('[data-obw-overlay]')) el.remove()
      for (const name of ATTRS) {
        for (const el of document.querySelectorAll(`[${name}]`)) el.removeAttribute(name)
      }
      for (const el of document.querySelectorAll('[data-worktree-virtual-row]')) {
        for (const v of VARS) el.style.removeProperty(v)
      }
      delete window.__obw
    }
  }
})()
