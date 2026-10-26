#!/bin/sh
# Runs this worktree's omp from source, so GUI sessions include the prototypes
# (cross-session peers, ACP subagent child sessions). Usage: OMP_GUI_OMP=./omp-dev.sh bun server.ts
here="$(cd "$(dirname "$0")" && pwd)"
exec bun "$here/../coding-agent/src/cli.ts" "$@"
