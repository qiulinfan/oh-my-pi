# Claude Code hooks

omp runs the command hooks declared in Claude Code's settings files and in enabled
Claude Code plugins. A project that already guards `Bash` with a `PreToolUse`
script, or injects context from a `UserPromptSubmit` hook, behaves the same way in
omp. The hooks run through a built-in extension
(`packages/coding-agent/src/extensibility/claude-hooks.ts`) that maps each Claude
Code event onto omp's [extension event bus](./extensions.md).

## Where hooks come from

The `hooks` object is read from these files, in this order:

| Source | Read when |
| --- | --- |
| `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json`) | the user-level `claude` source is opted in (`enabledProviders`, or `CLAUDE_CONFIG_DIR` is set), the same rule as every other `~/.claude` input |
| `<cwd>/.claude/settings.json` | always, unless the `claude` provider is disabled |
| `<cwd>/.claude/settings.local.json` | always, unless the `claude` provider is disabled |
| `<plugin>/hooks/hooks.json`, and the `hooks` field of `<plugin>/.claude-plugin/plugin.json` (a path, a list of paths, or an inline object) | for each Claude Code plugin omp already discovers (installed registries and `--plugin-dir`), with the same user/project gating as other plugin content |

All matching hooks from all sources run. A hook declared identically in several
settings files runs once; plugin hooks are kept separate. `disableAllHooks: true`
in any of these settings files turns every hook off.

Hooks are read once, when the session starts, as Claude Code does. Edits to the
files take effect in the next session. A session in which no hooks are declared
registers no handlers.

Only `type: "command"` hooks run. `prompt`, `agent`, `http` and `mcp_tool` hooks,
and events omp has no equivalent for, are skipped with a warning shown at session
start.

### Turning it off

Set `claudeHooks.enabled: false` (Settings → Tools → Extensions → Claude Code
Hooks). The default is on.

## Events

| Claude Code event | omp bus event | Matcher is tested against | Can block |
| --- | --- | --- | --- |
| `PreToolUse` | `tool_call` (before omp's approval gate) | Claude Code tool name (table below) | yes: blocks the call |
| `PostToolUse` | `tool_result`, successful calls only | Claude Code tool name | no: feeds the reason to the model |
| `UserPromptSubmit` | `input` (interactive and RPC); `before_agent_start` for prompts that bypass `input` | (none) | yes, on `input` only |
| `Stop` | `session_stop` (main agent) | (none) | yes: the agent continues |
| `SubagentStop` | `agent_end` in a subagent session | (none) | no (reported only) |
| `SessionStart` | `session_start`, `session_switch`, `session_compact` | `source`: `startup`, `resume`, `clear`, `fork`, `compact` | no |
| `SessionEnd` | `session_shutdown`, `session_before_switch` | `reason`: `clear`, `resume`, `other` | no |
| `PreCompact` | `session_before_compact` | `trigger`: `manual`, `auto` | yes: cancels compaction |
| `Notification` | `tool_approval_requested` | `notification_type`: `permission_prompt` | no |

`UserPromptSubmit` skips input that starts with `/` or `!`: those are omp commands.
A slash command that expands to a prompt reaches the hook through
`before_agent_start`. Prompts that never pass through `input` (print mode,
prompts sent by extensions) also run the hook there; it can add context but can no
longer withdraw the prompt, and a block is shown as a warning.

Context a `SessionStart` or `UserPromptSubmit` hook returns is attached to the next
prompt as a hidden message.

## Tool names

Matchers follow Claude Code: absent, `""` and `"*"` match everything; a matcher made
only of letters, digits, `_`, `-`, spaces, `,` and `|` is a list of exact names;
anything else is an unanchored JavaScript regular expression (`Edit.*` also matches
`NotebookEdit`; write `^Edit$` for an exact match).

omp tool names are mapped to Claude Code names before matching and in `tool_name`:

| omp tool | Claude Code name | `tool_input` additions |
| --- | --- | --- |
| `bash` | `Bash` | |
| `read` | `Read` | `file_path` (= `path`) |
| `read` of an `http(s)://` URL | `WebFetch` | `url` (= `path`) |
| `write` | `Write` | `file_path` (= `path`) |
| `edit` | `Edit` | `file_path` (= `path`) |
| `glob`, `find` | `Glob` | |
| `grep` | `Grep` | |
| `web_search` | `WebSearch` | |
| `task` | `Task` | |
| `todo` | `TodoWrite` | |
| `ask` | `AskUserQuestion` | |
| anything else (`ast_edit`, `ast_grep`, `eval`, MCP tools, extension tools, …) | unchanged | |

`tool_input` is omp's own argument object plus the aliases above, so field names
other than `file_path`/`url` follow omp's schemas (for example `edit` takes omp's
hashline edit format, not `old_string`/`new_string`). omp names MCP tools
`mcp__<server>_<tool>` with a single underscore between server and tool, where
Claude Code uses two; write MCP matchers against omp's name.

## Running a hook

Each hook receives Claude Code's JSON payload on stdin: `session_id`,
`transcript_path` (omp's session file, in omp's format; empty for an unsaved
session), `cwd`, `hook_event_name`, plus `agent_id`/`agent_type` inside a subagent
and the event's own fields (`tool_name`, `tool_input`, `tool_use_id`,
`tool_response`, `prompt`, `stop_hook_active`, `last_assistant_message`, `source`,
`reason`, `trigger`, `custom_instructions`, `message`, `notification_type`).
`tool_response` for `Bash` is `{ stdout, stderr, interrupted, isImage }` with the
tool's text output in `stdout`; other tools get `{ output, success }` plus
`filePath` or `url`.

Matching hooks for one event run in parallel. A shell-form hook runs as
`<shell> -c <command>` with omp's configured shell (non-login, so profile output
cannot corrupt JSON stdout); a hook with an `args` array is executed directly. The
environment is the one omp gives its own commands (dotenv values and secrets
filtered, non-interactive defaults such as `CI=true` and no pagers) plus
`CLAUDE_PROJECT_DIR` (the session cwd) and, for plugin hooks, `CLAUDE_PLUGIN_ROOT`.
`${CLAUDE_PLUGIN_ROOT}` in a plugin hook's command is substituted.

### Timeouts

`timeout` is in seconds. The default is Claude Code's: 600 s, 30 s for
`UserPromptSubmit`, 1.5 s for `SessionEnd`. A hook is also stopped 0.5 s before
omp's extension handler budget ends: `extensionHandlers.toolCallTimeoutMs`
(default 30 s, paused while an approval prompt is open) for `PreToolUse`, 2 s for
`SessionEnd` on shutdown, and 30 s for the other events. A hook that times out is
killed and counts as a non-blocking error.

### Exit codes

- **0**: proceed. Stdout is parsed as JSON when it is a JSON object. Plain stdout
  becomes context for `UserPromptSubmit` and `SessionStart` and is otherwise
  ignored.
- **2**: block where the event can block; stderr is the reason. `PreToolUse`
  blocks the call and the model sees the reason; `UserPromptSubmit` drops the
  prompt and shows the reason to the user; `Stop` makes the agent continue with
  the reason; `PreCompact` cancels compaction; `PostToolUse` feeds the reason to
  the model. For the other events stderr is shown to the user.
- **anything else**, a timeout, or a command that cannot start: non-blocking
  error, shown as a warning in the transcript, and the action proceeds.

### JSON output

| Field | Effect |
| --- | --- |
| `continue: false` | Stops the session: `PreToolUse` blocks the call and aborts the turn, `PostToolUse` aborts the turn, `UserPromptSubmit` drops the prompt, `Stop` lets the agent stop. `stopReason` is shown to the user. Takes precedence over `decision`. |
| `systemMessage` | Shown to the user as a warning. |
| `suppressOutput` | Ignored (it has no effect in Claude Code either). |
| `hookSpecificOutput.permissionDecision` (`PreToolUse`) | `deny` blocks with `permissionDecisionReason` as the model-visible reason. `ask` opens omp's approval prompt with the reason; refusing it, or having no interactive UI, blocks the call. `allow` proceeds but does **not** skip omp's own approval policy, so critical-command prompts still appear. With several hooks, deny wins over ask over allow. The deprecated top-level `decision: "approve"`/`"block"` maps to allow/deny. `defer` is not supported and is ignored. |
| `hookSpecificOutput.updatedInput` (`PreToolUse`) | Merged over the tool's arguments before it runs (`file_path`/`url` map back to `path`); omp revalidates the result against the tool schema. |
| `hookSpecificOutput.additionalContext` | Context for the model: on the next request for `PreToolUse`/`PostToolUse`, with the prompt for `UserPromptSubmit`/`SessionStart`, as continuation feedback for `Stop`. |
| `decision: "block"` + `reason` | `UserPromptSubmit`: drops the prompt. `PostToolUse`: feeds `reason` to the model. `Stop`: the agent continues with `reason`. `PreCompact`: cancels compaction. |

## Transcript

Blocking results appear where Claude Code shows them: a blocked tool call's result
reads `PreToolUse:<Tool> hook blocked this tool call:` followed by the reason. A
blocked prompt, `Stop` feedback, `PostToolUse` feedback, a cancelled compaction,
`systemMessage` text and non-blocking hook errors (with the command and exit code)
are shown in the transcript as warnings (a blocked prompt as an error).

## Differences from Claude Code

- `allow` does not bypass omp's approval policy, and `ask` prompts in addition to
  whatever omp's own policy asks.
- `SubagentStop` cannot keep a subagent running; omp's subagents have no stop
  continuation hook. Its block reason is shown as a warning.
- `UserPromptSubmit` can block only prompts that pass through omp's `input` event
  (interactive and RPC).
- `Notification` fires only for permission prompts (no `idle_prompt`,
  `auth_success`, …).
- Events without an omp equivalent (`PostToolUseFailure`, `PermissionRequest`,
  `PreModelSwitch`, …) and non-command hook types do not run.
- Hooks are not reviewed through a `/hooks` menu; edit the JSON files and start a
  new session.
- Payloads have no `permission_mode`, `prompt_id` or `effort`; `transcript_path` is
  an omp session file.
