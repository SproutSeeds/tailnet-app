# Tailnet App

## Scope

This file governs `/Volumes/Code_2TB/code/tailnet-app`.

## North Star

Provide reusable, production-grade Tailnet app setup and diagnostics for
SproutSeeds local-first web apps.

## Rules

- Keep the package dependency-free unless a dependency removes substantial risk.
- Default to tailnet-only Tailscale Serve. Do not enable Funnel by default.
- Treat named Tailscale Services as optional polish, not first-run requirements.
- Keep the CLI usable by Node and non-Node apps.
- Tests must not require a live Tailscale daemon; inject runners/fetchers.

<!-- ORP:AGENT_GUIDE:BEGIN -->
## ORP Agent Guide

- File: `AGENTS.md`
- Role: `project`
- Root: `/Volumes/Code_2TB/code/tailnet-app`
- Parent umbrella root: `/Volumes/Code_2TB/code`
- Parent root source: `explicit`
- Inherited AGENTS.md: `../AGENTS.md`
- Inherited CLAUDE.md: `../CLAUDE.md`
- Read the parent files for the high-level north star, roadmap, broad guardrails, and recurring pitfalls.
- Keep this local file project-specific so the parent can stay high-level and the child can stay concrete.
- Preserve human notes outside ORP-managed blocks.
- Use this local file for the project-specific current state, local constraints, and concrete next moves.
- Run `orp hygiene --json` before long delegation, after material writeback, before remote side effects or unbudgeted paid compute, and when dirty state grows unexpectedly.
- Do not hard-stop solely because an OpenAI research lane is paid; budgeted ORP research may run when `orp research` spend preflight is within the configured daily cap.
- Stop long-running expansion while hygiene reports `dirty_unclassified`; classify, refresh generated surfaces, canonicalize useful scratch, or write a blocker.
- Hygiene is non-destructive: never reset, checkout, or delete files merely to hide dirty state.
- ORP only manages the marked blocks. Human-written notes outside those blocks are preserved.
- Refresh with `orp agents sync`.
- Audit with `orp agents audit`.
<!-- ORP:AGENT_GUIDE:END -->

<!-- ORP:BEGIN -->
## Open Research Protocol (ORP)

**Non-negotiable boundary:** ORP docs/templates are **process-only** and are **not evidence**. Evidence must live in canonical
artifact paths (code/data/proofs/logs/papers).

### Default operating rules

- **Always label claims** as one of: **Exact / Verified / Heuristic / Conjecture**.
- If unsure, **downgrade** rather than overclaim.
- For **Exact/Verified**: include a **Verification Hook** (commands + expected outputs + determinism notes) and produce a
  **Verification Record** with **PASS / FAIL / INCONCLUSIVE**.
- If verification is **FAIL**: **downgrade immediately** and link the failure evidence.
- Treat **failed paths** as assets: record dead ends as a `Failed Path Record` with the blocking reason/counterexample and a
  next hook.
- Resolve disputes by **verification or downgrade**, not argument.
- Run `orp hygiene --json` before long delegation, after material writeback, before remote side effects or unbudgeted paid
  compute, and when dirty state grows unexpectedly.
- Do not hard-stop solely because an OpenAI research lane is paid; budgeted ORP research may run when `orp research` spend
  preflight is within the configured daily cap.
- Stop long-running expansion while hygiene reports `dirty_unclassified`; classify, refresh generated surfaces, canonicalize
  useful scratch, or write a blocker before continuing.
- Hygiene is non-destructive: never reset, checkout, or delete files merely to hide dirty state.

### How to work in an ORP repo

- Before starting: read `PROTOCOL.md` and confirm the project’s **Canonical Paths** are defined.
- When proposing a result: create/update a claim (via `templates/CLAIM.md`) that points to canonical artifacts (not ORP docs).
- When verifying: run the hook and write `templates/VERIFICATION_RECORD.md`.
- When something fails: write `templates/FAILED_TOPIC.md` and link it from the claim/issue.

### Instruments (optional; upstream framing only)

- ORP may include optional Instruments under `modules/instruments/` (e.g., Orbit / Compression / Adversarial).
- Instruments are **process-only** and must not contain evidence/results. Verification remains blind to instruments.
- If an Instrument is used, note it in the claim’s **Instrument (optional)** section (name + parameters explored).

### Protocol sync checks (required)

To prevent drift (especially after **context compaction / summarization**), re-check ORP and re-sync this block:

- at **session start** / **new task**,
- **immediately after any context compaction/summarization**,
- before publishing any **Verified/Exact** claim,
- after pulling/updating ORP files in the repo.

Sync procedure:
1) Find the ORP root directory (the folder containing `PROTOCOL.md`).
2) Ensure this ORP block matches `<ORP_ROOT>/AGENT_INTEGRATION.md` (between `<!-- ORP:BEGIN -->` and `<!-- ORP:END -->
