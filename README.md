# orca-better-worktrees

Restyles [Orca](https://github.com/stablyai/orca)'s left sidebar while it runs:

- **Nested worktrees.** Worktrees move one step right of their project, with a connector from
  the project icon down into each one.
- **Status chip.** The workspace status you set with *Move to Status* shows next to the
  worktree's name, in Orca's own status colors.
- **Boxes per project.** Each expanded project group, and each project with worktrees, gets a
  box around it.

Orca's plugin API cannot reach the left sidebar (plugins contribute right-sidebar panels,
themes, commands and the like), so this injects CSS and JavaScript into the running app instead.
Nothing in `Orca.app` is modified, and app updates do not undo it.

## Use

```sh
node bin/obw.mjs apply    # restyle the sidebar of the running Orca
node bin/obw.mjs remove   # put it back as it was
node bin/obw.mjs stats    # redraws since apply, and their cost
```

The injection lives in the running process: it survives window reloads, not an Orca restart.
To have every Orca start restyled, install the LaunchAgent:

```sh
node bin/obw.mjs agent install     # runs `obw watch` from login
node bin/obw.mjs agent status
node bin/obw.mjs agent uninstall
```

`obw watch` stays running (launchd restarts it if it stops). While the Orca it applied to is
alive it only checks that pid every 5 s, without spawning anything; when a new Orca starts, it
waits 3 s for its main process to set up, applies, and closes the inspector. It logs to
`~/Library/Logs/orca-better-worktrees.log`. The agent runs the Node binary `agent install` ran
with, by its real path: install again after removing that Node version.

## How it works

Orca ships with Electron's `EnableNodeCliInspectArguments` fuse on, so `SIGUSR1` makes its main
process open the Node inspector on `127.0.0.1:9229`. `obw` opens it, evaluates
[`src/main-agent.mjs`](src/main-agent.mjs) there to inject
[`src/renderer/sidebar.js`](src/renderer/sidebar.js) (with
[`sidebar.css`](src/renderer/sidebar.css) inlined) into the main window, then closes the
inspector. While the inspector is open, any local process can run code in Orca; pass
`--keep-inspector` only while developing. Before running anything, `obw` checks that the
process behind the port is Orca's main process (9229 is Node's default inspector port, so a
dev server run with `--inspect` could hold it instead).

The sidebar is a virtualized list of absolutely positioned rows, so the script:

- classifies the rendered rows in order (group header, project header, worktree);
- marks worktree rows (`data-obw-child`) so CSS indents them, and the row that closes each box
  (`data-obw-gap`), whose bottom padding spaces the boxes apart (Orca re-measures worktree
  rows, so the rows below follow; header rows have a fixed height and cannot be padded);
- connects child worktrees listed inside a parent's card to the parent, one level deeper;
- draws boxes and connectors in one overlay under the rows, with each box's top drawn by its
  header row, so the edge follows the header when Orca makes it sticky;
- reads each worktree's `workspaceStatus` from React's props and sets `data-obw-status` on its
  title row, which CSS turns into the chip.

It only adds attributes and its own overlay. It redraws once per frame at most, after sidebar
mutations, plus a 1.5 s poll for status changes that do not touch the DOM. An update without
geometry changes costs about 0.6 ms with 25 rendered rows.

## Develop

```sh
node bin/obw.mjs apply --keep-inspector
node bin/obw.mjs eval 'document.querySelectorAll("[data-obw-child]").length' --keep-inspector
node bin/obw.mjs shot /tmp/sidebar.png 0,200,500,760 --keep-inspector
```

`shot` saves a PNG of the window (or a rectangle of it, in window points), even when Orca is
behind other windows.

Relies on Orca's markup (`data-worktree-virtual-row*`, `data-repo-header-*`,
`data-worktree-card-status-slot`, `data-worktree-title-inline-rename`) and on worktree props
carrying `workspaceStatus`. Tested on Orca 1.4.251.
