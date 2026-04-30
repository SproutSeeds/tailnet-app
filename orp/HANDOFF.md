# ORP Repo Handoff

- Repo: `tailnet-app`
- ORP-governed since: `2026-04-30T02:59:14Z`
- Protected branch expectation: `main`

## Current Objective

- Describe the current implementation goal.
- Link the active branch and the next meaningful checkpoint.

## Validation State

- Record what was validated, what is still failing, and what blocks readiness.

## Agent Rules

- Do not do meaningful implementation work directly on `main` unless explicitly allowed.
- Create a work branch before substantial edits.
- Run `orp hygiene --json` before long delegation, after material writeback, before remote side effects or unbudgeted paid compute, and when dirty state grows unexpectedly.
- Do not hard-stop solely because an OpenAI research lane is paid; budgeted ORP research may run when `orp research` spend preflight is within the configured daily cap.
- Stop long-running expansion while hygiene reports `dirty_unclassified`; classify, refresh generated surfaces, canonicalize useful scratch, or write a blocker.
- Hygiene is non-destructive: never reset, checkout, or delete files merely to hide dirty state.
- Create a checkpoint commit after each meaningful completed unit of work.
- Do not mark work ready when validation is failing.
- Update this handoff before leaving the repo.
