# omp desktop

A macOS app for `omp gui`: an Electron window onto this machine's GUI server
(see [docs/gui.md](../docs/gui.md)). It holds no GUI of its own, so whatever
the browser page shows, the app shows too.

## Build and install

The app runs the `omp` on your login shell's `PATH` (or `~/.local/bin/omp`) as
`omp gui --no-open --json --exit-on-stdin-close`, so install omp from this tree
first: an older omp rejects `--exit-on-stdin-close`, and the app cannot start
or attach to a GUI server with it. `OMP_DESKTOP_OMP` (an absolute path) names
another omp executable to run instead, and then the only one: if it cannot be
run, the app says so instead of falling back to another omp. Then, in this
directory:

```sh
bun install
bun run fetch-electron   # download the Electron runtime
bun run install-app      # build out/omp.app and install it in /Applications
```

`bun run package` builds `out/omp.app` without installing it, and
`bun run package-dev` builds `out/omp-dev.app` for development runs (below).
Building the icon needs `rsvg-convert` (Homebrew `librsvg`). `install-app`
refuses while omp.app is running. It copies the new build next to the
installed one, verifies its signature and swaps it in by rename, so a failed or
interrupted install leaves the previous app working; the next run cleans up
after an interrupted one.

`bun run check` type-checks the app and runs its tests; `bun run test` runs
only the tests. The repository's root checks (`bun run check:ts`) lint this
directory but do not type-check it, so run `bun run check` here after changing
it. The root test runner (`bun run test`, and CI's workspace bucket) runs
`bun run check` here. When this directory has no dependencies installed, it
first installs them without the Electron runtime
(`bun install --frozen-lockfile --ignore-scripts`): the type check needs only
Electron's typings, and the tests need no Electron.

## Development runs

To try a change without installing it, `bun run package-dev` builds
`out/omp-dev.app`: this tree's app under its own name and bundle id
(`com.qiulinfan.omp-desktop.dev`), so its preferences, Electron data, logs and
single-instance lock stay apart from the installed omp.app and from every
other Electron app. It is never installed. Run its `Contents/MacOS/Electron`
with these variables set:

- `OMP_DESKTOP_OMP`: the omp to run, typically a wrapper script that sets
  `OMP_GUI_RUNTIME_DIR` to a directory of its own and adds `--port 0`, so the
  run starts its own GUI server (see [docs/gui.md](../docs/gui.md)). This is
  what keeps a run off your GUI server: without it the app runs your omp,
  which attaches to your server or starts it. A relative path, or a file that
  is missing or not executable, is reported in the app's error dialog, and
  nothing is run.
- `OMP_DESKTOP_DATA_DIR`: an absolute directory for the run's Electron data
  (`data/`) and logs, crash logs included (`logs/`), so a test run leaves
  nothing behind. Without it the development app uses
  `~/Library/Application Support/omp-dev` and `~/Library/Logs/omp-dev`. It does
  not choose the GUI server. A relative path makes the app exit with an error.

Electron's own `Electron.app` from `node_modules` can also run a bundle of
`src/main.ts`, but it shares its bundle id with every unpackaged Electron app:
macOS then updates `~/Library/Preferences/com.github.Electron.plist`, and
without `OMP_DESKTOP_DATA_DIR` the logs go to `~/Library/Logs/Electron`.

## Behavior

- The window opens at once. The app reads your login shell's environment, as a
  terminal would get it, and runs `omp gui` with it; if that read fails, the
  page says that tools on your `PATH` may be missing.
- It attaches to a GUI server that is already running, or starts one.
- Quitting stops a server the app started, after asking when sessions are
  running or when it cannot tell; the server also stops if the app crashes. A
  server started elsewhere keeps running, and quitting does not ask.
- When a server the app started stops on its own, the app starts another, at
  most twice a minute. After that, or when no server can be started, it offers
  Retry, Quit and Show log. Each such stop writes an owner-only crash log to
  `~/Library/Logs/omp`, which keeps the newest ten.
- When a server it attached to goes away, the app finds or starts another and
  reloads.
- When omp is reinstalled under a server the app started, it offers to restart
  the server onto the new build.
- A window whose page crashes reloads onto the same sessions; one that stops
  responding offers Wait or Reload.
- Links open in your default browser.
- A window in the background or covered by others keeps drawing a streaming
  turn as it arrives, so coming back to it never shows a long stretch appear
  at once. That costs some CPU while omp streams out of sight.
- This directory is not a Bun workspace package, so installing the repository
  does not download Electron.
