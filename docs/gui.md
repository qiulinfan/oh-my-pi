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
known, and the first message of a new session with its model. The file is
written before omp starts, and again with omp's pid as soon as it has started;
when the first write fails the session is not started and the request fails
with that error.

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
