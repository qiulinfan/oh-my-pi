# Agent presets

An agent preset is a named launch configuration for the main session: a
focused prompt, the few skills a task needs, its model and thinking level, and
whether the user-level context files load. Start one with
`omp --preset <name>`, or pick it in omp gui's start page (see [gui](./gui.md)).

Presets configure the session you talk to. [Task agents](./task-agent-discovery.md)
in `agents/` are a different thing: subagents the `task` tool spawns.

Implementation: [`src/config/agent-presets.ts`](../packages/coding-agent/src/config/agent-presets.ts).

## Where presets live

| Location                   | Scope                                                  |
| -------------------------- | ------------------------------------------------------ |
| `.omp/presets/<name>.md`   | Project: the nearest `.omp/presets` above the session's directory |
| `~/.omp/agent/presets/<name>.md` | User: every project and chat                     |

The file name (without `.md`) is the preset name: a letter, then letters,
digits, `-` or `_`. A project preset shadows a user preset of the same name.

## File format

```markdown
---
description: Walk me through a paper and keep study notes
model: opus
thinking: high
skills: [guided-paper-reading, write-paper-study-notes, translate-paper-to-obsidian]
user-context: false
---

You help the owner read research papers in ~/paper-reading. Each paper has its
own folder with the TeX source and 阅读笔记.md. Start from the folder the owner
names; do not look for other repositories.
```

Every field is optional:

| Field           | Effect                                                                                                                         | Same as                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------- |
| `description`   | Shown in the gui's Preset picker.                                                                                              |                            |
| `model`         | Model selector for the session.                                                                                                | `--model`                  |
| `thinking`      | Thinking level.                                                                                                                | `--thinking`               |
| `skills`        | Skill name globs (list or comma-separated) the session sees; `[]` exposes no skills.                                           | `--skills` / `--no-skills` |
| `tools`         | Built-in tools to enable.                                                                                                      | `--tools`                  |
| `approval-mode` | `always-ask`, `always-ask-cached`, `write`, `auto` or `yolo`.                                                                  | `--approval-mode`          |
| `user-context`  | `false` leaves out user-level [context files](./context-files.md) such as `~/.omp/agent/AGENTS.md`; project files still load. |                            |
| body            | Appended to the system prompt, in place of a discovered `APPEND_SYSTEM.md`.                                                    | `--append-system-prompt`   |

## Default preset

The `agentPreset` setting names the preset a session starts from when the
command line names none. Set it in a project's `.omp/config.yml` to make that
project start every session (CLI, omp gui, editor side bars, ACP clients such
as Zed) from one preset:

```yaml
# <project>/.omp/config.yml
agentPreset: paper-reader
```

`--preset <name>` starts from another preset instead, and `--no-preset` starts
without one. A default that names no preset fails the launch and says that the
setting named it.

## Precedence

Which preset: `--no-preset`, else `--preset`, else the `agentPreset` setting.

Within a preset, it only fills flags the command line left unset, so
`omp --preset reader --model sonnet` runs the reader preset on `sonnet`. In the
gui, a model or effort picked on the start page outranks the preset's.

A malformed field (an unknown thinking level, an empty `tools` list) fails the
launch with the file's path rather than starting a session with wider settings.
An unknown preset name fails with the list of presets available from that
directory.

A preset applies to the process it starts. Resuming a session in a project with
a default starts from that default again; to resume a session started from
another preset, pass `--preset` again. omp gui records the choice of the
sessions it hosts (a preset, none, or the default) and restores them with it.
