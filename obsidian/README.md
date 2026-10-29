# omp for Obsidian

An Obsidian plugin that shows `omp gui` in a sidebar: the same page as the
browser and the desktop app (see [docs/gui.md](../docs/gui.md)), onto the same
GUI server, so the sidebar, a browser tab and the desktop app all show the
same live sessions. Desktop only.

## Build and install

```sh
bun install
bun run build                        # out/main.js, manifest.json, styles.css
bun run install-vault ~/path/to/vault  # build, then copy them into the vault's .obsidian/plugins/omp-sidebar/
```

Then enable **omp** under Settings → Community plugins. `install-vault`
refuses a directory without `.obsidian/`, so it never makes a vault out of a
folder Obsidian has not opened. `bun run check` type-checks the plugin.

The plugin reaches the GUI server through `desktop/src/attach.ts`, which it
shares with the VS Code extension (`vscode/`) and which builds on the desktop
app's Electron-free modules; all of it is bundled into `main.js`.

## Use

The first time the plugin loads in a vault it adds its view to the right
sidebar, behind the tab showing there; once you close it, it stays closed.
Open it again with the bot icon in the ribbon or the **omp: Open sidebar**
command. The refresh button in the view's header reconnects.

- It reads your login shell's environment, as a terminal would get it, and
  runs `omp gui --no-open --json --exit-on-stdin-close` with it. The omp it
  runs is the one named in the plugin's settings, else the first `omp` on the
  login shell's `PATH`, then `~/.local/bin/omp`.
- It attaches to a GUI server that is already running, or starts one. A server
  it started stops when Obsidian quits or the plugin is disabled, ending the
  sessions it hosts, as quitting the desktop app does; one started elsewhere
  keeps running.
- Web and mail links open in your default browser; the page opens nothing
  inside Obsidian.
- The page keeps its remembered picks (model, effort, project) in its own
  storage, apart from Obsidian's.

## Development runs

Point the plugin at a separate GUI server so a test never attaches to the one
you use: set the plugin's omp executable to a wrapper script that sets
`OMP_GUI_RUNTIME_DIR` and adds `--port 0`, for example

```sh
#!/bin/sh
OMP_GUI_RUNTIME_DIR=/tmp/omp-gui-dev exec bun /path/to/oh-my-pi/packages/coding-agent/src/cli.ts "$@" --port 0
```

and use a throwaway vault. A server run from source serves `packages/gui`
from source too, so a page change shows after reloading the view.
