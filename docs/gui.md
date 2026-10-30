# omp gui

`omp gui` opens omp in a browser window. The page draws omp's own UI, sent over
the Tern Surface Protocol, so the transcript, pickers, slash commands, settings
and the agent hub behave as they do in a terminal. The macOS desktop app
(`desktop/`) is a native window onto the same page.

## Running it

```sh
omp gui                        # attach to the running server or start one, then open the browser
omp gui --no-open              # start or find the server without opening a browser
omp gui --json                 # print {pid, port, token, url, attached} as one line
omp gui --port 5000            # preferred port; any free port when it is taken
omp gui --exit-on-stdin-close  # stop the server and its sessions when stdin closes (the desktop app)
```

A machine runs one GUI server. The process that serves it holds a lock in
`~/.omp/run/gui/` for its whole life and writes its address to
`~/.omp/run/gui/server.json` (owner-only); every later `omp gui`, browser tab or
desktop window attaches to that server, so they all show the same live
sessions. While the server is stopping it answers "stopping", and a new
`omp gui` waits for it (up to 20 s) and then serves. A server that holds the
lock but does not answer within about 5 s is reported with its pid (`the GUI
server (pid N) is not responding`, exit 1; with `--json`, the line is
`{"error", "pid"}`), and no second server is started.

The server stops with the process that started it: Ctrl+C in the terminal, or
quitting the desktop app when the app started it. The desktop app starts it
with `--exit-on-stdin-close`, so it also stops when the app crashes or is
force-quit. Stopping it ends the sessions it hosts: each gets SIGTERM and up to
7 s for omp's own teardown, then omp and its process group (what a terminal
would have ended with it) are killed. Ending one session from the page (End
session) works the same way with SIGINT, the signal Ctrl+C sends: omp takes it
as your own stop, so the turn it cuts off is not offered for restore, while one
cut off by a server stop is. The page hears back only once that omp has exited.
Once it has, anything still running in omp's process group gets a second, then
is killed.

Nothing outside that group is killed. The daemons omp starts detached so that
they outlive it and serve other omp processes (the daemon broker with the LSP
mux, the shared browser and `omp launch` daemons; the embedding server) keep
running. So do the processes omp starts detached for its own use (bash-tool
commands, eval kernels, debug adapters, and MCP servers on Linux): omp's own
teardown ends them, so an omp killed after the 7 s leaves any that were still
running.

### A separate server for development or tests

`OMP_GUI_RUNTIME_DIR` (an absolute path) replaces `~/.omp/run/gui`, and with it
everything the GUI server persists: `server.json`, its lock, the token and the
`hosted/` roster. Use it with `--port 0` to run a separate GUI server, e.g. for
development or tests, without attaching to (or disturbing) the one in use:

```sh
OMP_GUI_RUNTIME_DIR=/tmp/omp-gui-dev bun packages/coding-agent/src/cli.ts gui --port 0
```

A value that is not an absolute path (after `~` expansion) is an error, never a
fallback to the shared directory.

## Security

The server binds 127.0.0.1 only. Every request passes a fence first: its Host
must be `127.0.0.1:<port>` or `localhost:<port>`, a browser must not mark it
cross-site, and its Origin, when it has one, must be the server's own. Then it
must carry the machine token from the URL. The token lives in
`~/.omp/run/gui/token` (owner-only) and stays the same across server restarts,
so an open page or desktop window keeps working after one; a leaked URL stays
valid until the file is deleted. Delete the file to rotate the token: the next
server start mints a new one.

Sessions the server hosts see `OMP_GUI_SERVER_PID`, the pid of the GUI server
they run in; they never see the token, port or URL. Their terminal is the GUI,
so they do not inherit the terminal multiplexer (tmux, screen, zellij, …) or
the multiplexer pane of the shell `omp gui` was started from.

## Projects and chats

The sidebar lists saved sessions by project, read from omp's own session store,
so directories you used from the terminal appear too. A session's project is
its git checkout root, or its own directory outside one; sessions with no
messages and directories that no longer exist are left out.

The server lists a project's 50 newest sessions and the 40 newest chats,
newest first by their last message (a record omp appends without one, such as the
note it writes on exit, does not move a session up). The sidebar shows the
three newest of each project and eight chats, plus any whose turn was cut
off; the start page's Show all and the history menu reach the rest. A pinned
session comes
first in its list and is never left out; pin or unpin one with the pin on its
row. Pins are omp's own, in `session-pins.json` in its agent directory, so
`omp --resume` and every window onto the server show the same ones. In the
sidebar, pinned sessions from every project gather under Pinned, below the
running ones, and leave their project's list. A project's own pin (on its row)
keeps it at the top of Projects, in the order pinned; project pins are the
GUI's alone, kept with its other choices.

The start page lists the chosen project's sessions (or the chats, with no
project): five, every pinned one, and the rest behind Show all.

A new session runs in the project picked on the start page. "Choose folder…"
opens the macOS folder chooser. "No project" starts a chat in its own empty
directory under `~/.omp/chats/`; chats share the session directory
`~/.omp/agent/sessions-chats/`.

The model picker lists the models `omp models` reports, with the `default`
model role from `config.yml` first.

The effort picker beside it sets the new session's thinking level
(`--thinking`). It offers what omp's `/effort` picker offers for that model
(off, Auto, then the model's levels; no Auto where omp has not verified the
model's levels), and Default names the level the session would start at.
Auto picks a level for each message by how hard it looks. The choice is
remembered, applies to resumed sessions too, and falls back to Default on a
model that lacks it. In a session, click the effort ring in the model chip to
choose a level; Shift+Tab cycles through them.

The Work details picker beside it sets how much of its work a new session shows
(`--work-detail`):

- Compact (the default): thinking and tool calls stay folded to one line, also
  while they stream. A folded thought shows the start of its latest paragraph;
  a failed tool shows its first error line or exit code.
- Standard: thinking is open while it streams, showing its last lines, and
  folds when it ends; tool output is cut to a short preview.
- Verbose: thinking and tool output stay open. A thought that is still
  streaming shows its last lines too; scroll it up to read its start, and it
  opens in full when it ends.

Click a row to open or fold it; that choice holds until the mode changes. From
the keyboard, F6 moves from the prompt to the newest row (keys typed in a
session otherwise go to omp, Tab included); there Enter or Space opens or folds
it, Up and Down (Home and End) move between rows, and F6 or Escape goes back to
the prompt. The pick is remembered and applies to resumed sessions too. In a
session, the Work details chip in the composer switches the mode of that
session at once, without redrawing it from the start; a restored session comes
back in the mode it last ran in. The terminal is not affected: omp started from
a terminal keeps its own display settings.

The Approvals picker beside it sets which tool calls a new session asks about
before running them (`--approval-mode`; see
[approval-mode.md](approval-mode.md)): Always ask, Ask and remember, Write,
Auto or Yolo. From settings (the default) passes no flag, so the session takes
`tools.approvalMode`. Every mode still asks before a critical command such as
`rm -rf /`. The pick is remembered and applies to resumed sessions too; a
restored session comes back in the mode it was started with. A session started
From settings follows `/settings` (Interaction, Tool Approval) from its next
tool call; one started with a picked mode keeps that mode until it ends, since
the flag outranks the saved setting.

In a session, each turn's work (thinking and tool calls) runs down a timeline
on the left, and the assistant's answer sits at full width between those runs.
Answers draw Markdown as the terminal reads it, plus what a browser can show:
math typeset with KaTeX (`$…$`, `\(…\)`, `$$…$$`, `\[…\]`; a `$` read as
currency stays text, and a `|` inside a table cell's math stays in that cell),
` ```mermaid ` fences as diagrams once the fence is closed, highlighted code
fences, and footnotes. A web link opens in the browser. A link to a local path
(`src/a.ts:12`, an absolute path, or the `file://` link omp writes for one)
opens through the GUI server, relative to the session's directory: a folder is
revealed in Finder, images, PDFs and other media open in their viewer, and
every other file opens in the default text editor, so a link never runs a
script or launches an app.

Resuming a session the GUI already runs shows that session instead of starting
a second omp on the same file. A session open in another omp process (a
terminal, or one still shutting down) is waited for up to 10 s, then refused;
while a resume or restore of a session file waits for more than a second, the
page says "Waiting for the previous omp to finish shutting down…".

A saved session whose last turn `omp --restore` can continue is marked
"Interrupted" and gets its own Restore action. That is a turn cut off by omp
being killed or crashing, or by the GUI server stopping; a turn you stopped
yourself (End session, or quitting with Ctrl+C) is not one. Restore continues
the turn: a command cut off mid-run runs again, and the turn may spend tokens.
A plain click only reopens the session.

## Settings

Settings, at the bottom of the sidebar, opens a page with the GUI's own pages
above omp's settings, the same pages as `/settings`:

- **General**: the GUI's theme and answer font.
- **Instructions**: the global `AGENTS.md` in omp's agent directory, which
  every session loads. When that file is a symlink, a save writes the file it
  points to, and a save over a file changed elsewhere since the page read it
  is refused.
- **Models**: the model and thinking level of each chat role, the same
  assignments as `/model`. New sessions use them; running ones keep theirs.
- **Providers & Auth**: omp's `/login` and `/logout` pickers. The sign-in runs
  on the page, and Back to settings returns to the panel (cancelling a sign-in
  not finished).

omp's pages are drawn by an omp the server starts for the page
(`--settings-panel`, in your home directory so no project settings apply),
with no session behind it; it ends when you leave the page. Changes there
write omp's global config, which running sessions pick up.

The GUI's own choices, the theme and answer font on General and the start
page's last project, model, effort and Work details, are kept by the server in
`gui.json` in omp's agent directory, not in the browser (which keeps only a
copy of the theme and font, to paint the first frame in them). The desktop app, a
browser tab and the Obsidian and VS Code side bars, which each have storage of
their own, all show the same choices, and a window that comes back into view
picks up a change made in another.

## When a session or the server goes away

When omp ends, the session's view says why: you ended it, it stopped with the
GUI server, it was stopped by a signal (an exit code of 128 + N, which omp's
own signal handling ends with, reads as that signal: 143 as SIGTERM), it exited
with another code, or it was killed by a signal. When omp printed anything
outside the GUI's protocol before it ended (the error it failed with, say), the
view keeps its last 40 lines under "Show omp's last output". Unless you ended
it or omp quit cleanly by itself (`/exit`, exit code 0), the view offers
Restore: it continues the session's file with `omp --restore`, or starts the
first message again (on the same model, in the same project or as a new chat)
when omp died before writing a message to its file. The restored session takes
the ended one's place. An ended session stays in the sidebar until it is
dismissed (its × button) or opened again.

A view whose connection drops asks the server why. While the server does not
answer, the page says so and keeps trying (Reconnect now tries at once). When
a different server run answers (it was restarted), the page reloads, which
also loads a newer page. The composer is read-only while disconnected, and the
keys omp handles (Enter, Tab, Esc, …) do nothing there; once the view is
connected again, any of its text omp did not get is sent.

## Unfinished sessions

The server keeps one file per hosted session in `~/.omp/run/gui/hosted/`: its
directory, its omp process (pid and start time), its omp session file once
known, the first message of a new session with its model, and its Work details
mode (the one it was started in, then each one picked with its chip, which the
server reads from the chip omp draws), which a restore brings back (the page's
current pick applies only to an entry that records none). The file is written
before omp starts, and again with omp's pid as soon as it has started; when the
first write fails the session is not started and the request fails with that
error.

A server stop or crash leaves these files, and so does omp crashing or being
killed by a signal (the file then records how it ended). The next server's
start page lists those sessions under "Unfinished sessions", each with why it
is there: "Running when the GUI server stopped", how omp ended ("omp exited
with code N", "omp was stopped by SIGX" for an exit code of 128 + N, "omp was
killed by SIGX"), or "Still running from the previous server" (below).
Each can be restored or dismissed. Restoring a session omp saved continues it
with `omp --restore`: a command cut off mid-run runs again, and the turn may
spend tokens. A session omp never saved starts its first message again in a
new session, so the whole task runs and spends tokens again; its Restore
button says so. A session file with no message yet (the one `/new` writes at
once, or one a crash left empty or cut short) counts as never saved. One the
server cannot read counts as saved, so a failed read never loses a session:
its Restore reports the error, and the session stays listed. A session left
with neither a saved message nor a first message is not listed. Restore all
first asks, with the number of sessions of each kind. The first message
belongs to the session omp started with: after `/new`, `/resume` or a
directory switch, a restore continues the session file omp reported last. A
first message typed after `/new` is not recorded, so a session that dies
before omp writes it cannot be started again from it.

Restoring a session twice (from two windows, from a view that missed the first
restore, or after a crash between recording the restore and dropping the old
entry) starts it once. Dismissing a session, restoring it, or omp quitting
cleanly by itself removes its file, and so does ending it once its omp has
exited. Ending one first marks the file as ended, before omp gets any signal,
so no server offers it for restore again. An omp that outlives the stop keeps
that file: the page lists the session as ending until omp exits, and a server
that stops or dies first leaves the file to the next server, which lists it as
"Still running after you ended it" while that omp runs, so End can be tried
again, and drops it once that omp is gone.

A session whose omp still runs after its server went away (the recorded pid is
alive with the recorded start time, whether or not it responds) is marked as
still running. It cannot be restored while it runs, since that would start a
second agent on its work; End stops it like End session does (SIGINT, up to
7 s, then omp and its process group are killed), after checking the pid is
still that omp. A live pid whose start time is not known (the server died before
recording it, or it cannot be read) is also marked as still running, but End
does not signal it, since nothing confirms it is that omp: stop it yourself,
or dismiss it. When omp exits by itself before End, End leaves the session to
restore or dismiss. Dismissing a session whose omp still runs asks first, since
nothing here can end that omp afterwards, and Dismiss all leaves such sessions
listed.

A starting server answers at once and reads these files in the background, so
a large roster never makes it look unresponsive; the session list waits for
the read.

## Desktop app

The desktop app runs `omp gui --no-open --json --exit-on-stdin-close` with
your login shell's environment and loads the page, so new GUI features appear
in the browser and the app together. When the app started the server, quitting
the app stops it, and so does the app crashing. A server the app started that
stops on its own is restarted at most twice a minute; each such stop writes a
crash log to `~/Library/Logs/omp`. Building, installing and the rest of its
behavior are described in [desktop/README.md](../desktop/README.md).

## Obsidian sidebar

The Obsidian plugin in `obsidian/` shows the same page in an Obsidian sidebar.
Like the desktop app, it attaches to the running server or starts one, and a
server it started stops with Obsidian. Building, installing and its behavior
are described in [obsidian/README.md](../obsidian/README.md).

The plugin opens the page in the vault's folder: new sessions start there,
and the start page lists that project's sessions. A pick on the page changes
this window only, not the project other windows remember. The view leaves
room at its bottom for Obsidian's status bar, which floats over the right
sidebar.

Below 640 px the page takes the whole width: the session list slides over it
from the left (the button at the top left shows it), and the composer's
controls wrap onto further lines. At the top right, the clock opens the
session history, the way an editor's agent panel offers it: the sessions
running now, then the saved ones (pinned first), for the page's project or for
all of them, narrowed by a search; its badge counts the running sessions. The
pen beside it goes back to the start page for a new session.

## VS Code side bar

The VS Code extension in `vscode/` shows the same page in VS Code's secondary
side bar, in a frame inside a webview. It reaches the server as the Obsidian
plugin does, and opens the page in the workspace's folder (the first of a
multi-root workspace) the same way. The webview's sandbox opens no windows, so a page that finds
itself framed posts its web and mail links to the embedder (a
`{type: "omp-gui.open-external", url}` message to its parent), which opens
them in the browser. Building, installing and its behavior are described in
[vscode/README.md](../vscode/README.md).
