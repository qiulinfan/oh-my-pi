# omp for VS Code

A VS Code extension that shows `omp gui` in the secondary side bar, next to
Copilot Chat or Claude Code: the same page as the browser, the desktop app and
the Obsidian plugin (see [docs/gui.md](../docs/gui.md)), onto the same GUI
server, so all of them show the same live sessions.

## Build and install

```sh
bun install
bun run build         # dist/extension.js
bun run package       # out/omp-vscode.vsix
bun run install-app   # package, then `code --install-extension` it
```

`bun run check` type-checks the extension. It runs where VS Code's window runs
(`extensionKind: ui`), so in a Remote window it still uses this machine's omp.
It needs VS Code 1.140 or later.

## Use

Open the secondary side bar (⌥⌘B) and pick the **omp** tab. The refresh
button in the view's title reconnects.

- It reads your login shell's environment, as a terminal would get it, and
  runs `omp gui --no-open --json --exit-on-stdin-close` with it. The omp it
  runs is the `omp.executable` setting, else the first `omp` on the login
  shell's `PATH`, then `~/.local/bin/omp`. The setting is machine-scoped, so a
  workspace cannot choose what the extension runs.
- It attaches to a GUI server that is already running, or starts one. A server
  it started stops when VS Code quits or the extension is disabled, ending the
  sessions it hosts; one started elsewhere keeps running. Each VS Code window
  runs its own copy of the extension, so a server one window started also
  stops when that window closes.
- The page opens in the workspace's folder (the first folder of a multi-root
  workspace): new sessions start there, and the start page lists that
  project's sessions.
- The page lives in a frame inside the view's webview and stays loaded while
  the side bar is hidden. Web and mail links open in your default browser.

The server, its sessions and the page's logic are omp's own; the extension
only finds the server and frames its page (`src/extension.ts`), reaching it
through `desktop/src/attach.ts`, which it shares with the Obsidian plugin.

## Development runs

`code --extensionDevelopmentPath=<this directory>` opens an Extension
Development Host window with the extension loaded and nothing installed. To
keep it off the GUI server you use, set `omp.executable` (user settings) to a
wrapper that sets `OMP_GUI_RUNTIME_DIR` and adds `--port 0`, as
[obsidian/README.md](../obsidian/README.md) describes. A server run from source
serves `packages/gui` from source, so a page change shows after Reconnect.
