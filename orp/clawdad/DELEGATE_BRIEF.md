# Clawdad Delegate Brief

- Project: `tailnet-app`
- Root: `/Volumes/Code_2TB/code/tailnet-app`
- Remote: `(local only)`
- ORP workspace: `main`

## Startup Contract

- This project is ORP-governed and registered for Clawdad/Codex delegation.
- Run `orp status --json` and `orp hygiene --json` before long-running expansion.
- Stop when hygiene reports `dirty_unclassified`; classify, refresh, canonicalize, or write a blocker.
- Do not reset, checkout, or delete files merely to hide dirty state.
- Keep canonical project state in repo files and keep process state in ORP/Clawdad ledgers.

## First Checks

- `orp workspace tabs main`
- `orp project show --json`
- `orp hygiene --json`
- `clawdad delegate <project>`

## Delegate Posture

- Prefer bounded, concrete tasks with a clear write scope.
- Refresh project context after meaningful docs, manifest, roadmap, or agent-guidance changes.
- Write a blocker instead of forcing progress when the repo state is ambiguous.
