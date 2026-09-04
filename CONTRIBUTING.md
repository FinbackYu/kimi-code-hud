# Contributing to kimi-code-hud

Thanks for helping improve kimi-code-hud. This document serves two roles: **external contributors** (fork + pull request, no write access needed) and **maintainers** (triage, merge, and release-day acceptance — maintainer-only sections are marked as such). Development conventions (project layout, style, testing) live in [AGENTS.md](AGENTS.md) — it is written for coding agents but applies equally to human contributors.

## Getting started

- Node.js 18 or newer; zero dependencies; no build step.
- Fork the repository, clone your fork, and run `npm test` before opening a pull request.
- Open an issue before starting non-trivial work so the approach can be discussed first. Typo fixes, docs touch-ups, and small bug fixes with a clear repro can go straight to a PR.

## Triaging upstream-related issues

This project tracks an upstream application (Kimi Code CLI), so issue work is triaged by **upstream release status**:

| Situation | Mode | Where the work lands |
| --- | --- | --- |
| Upstream change not yet released (merged or changelog candidate, but unreleased) | **prep** | shared `upstream/<version>-prep` branch |
| Upstream change already released and affecting current users | **fix** | short-lived `fix/<issue-N>-<slug>` branch, merged promptly |
| No code change needed (observation, docs, conclusion) | **observe** | record the conclusion in an issue comment |

If you are unsure how to classify an issue, ask in the issue thread before writing code. Useful commands: `gh issue list -R FinbackYu/kimi-code-hud --label upstream-watch` shows open upstream-tracking issues; `gh issue view -R FinbackYu/kimi-code-hud <N>` shows one in detail. The `-R` flag matters: inside a fork clone, gh would otherwise resolve the default repository to your fork and show the wrong issue tracker.

## Branching and pull requests (contributors)

- Work on your own fork. Add the upstream repository (the one you forked from, `FinbackYu/kimi-code-hud`) as a second remote so you can base branches on its current state:

  ```bash
  git remote add upstream https://github.com/FinbackYu/kimi-code-hud.git
  git fetch upstream
  ```

- For **fix** work: branch from `upstream/main` and open the pull request with `main` as the base branch.
- For **prep** work: the shared `upstream/<version>-prep` branch lives in the upstream repository and is managed by maintainers. Base your branch on it and select it as the PR base:

  ```bash
  git fetch upstream upstream/<version>-prep
  git checkout -b <version>-prep-<slug> upstream/upstream/<version>-prep
  gh pr create -R FinbackYu/kimi-code-hud --base upstream/<version>-prep
  ```

- Name short-lived branches `fix/<issue-N>-<slug>` (or `feat/<N>-<slug>`).
- Repo housekeeping unrelated to upstream (typos, CI, docs) can target `main` directly.
- You never push to or merge into the upstream repository — picking the right PR base is enough; merging is the maintainer's job.

## Implementation ground rules

- Follow the style, testing, and commit conventions in [AGENTS.md](AGENTS.md).
- Code written against unreleased upstream contracts must stay **inert** on currently released versions: no behavior change unless the corresponding records or fields are actually present. Lock both sides with fixture-based regression tests.
- User-visible behavior changes ship their docs in the same change: keep `README.md` and `README.en.md` in sync, and update `CAPABILITIES.md` / `KNOWN_ISSUES.md` when compatibility or known limitations are affected.
- Only submit changes you can explain: what each change does, its boundary behavior, and why it belongs in this repository.

## Verification gates

All must pass before merge:

```bash
npm test                  # full node:test suite
node --check <file.mjs>   # syntax-check every edited module
git diff --check          # no whitespace errors
```

## Commit messages and pull requests

- Short, imperative subjects; Conventional Commit prefixes (`fix:` / `feat:` / `docs:`) are welcome but not mandatory.
- One commit per behavior change.
- Reference the issue (`Closes #N`). For merge commits, include the user-visible change plus the verification commands and their results — release-day retrospectives depend on it.
- PRs should describe the user-visible change, list verification commands, and include terminal output or screenshots for HUD layout changes.

## `upstream-watch` issues

Issues labeled `upstream-watch` are filed and maintained by an automation monitor. **Their title and body are owned by the bot — never edit them** (edits break its dedup and continuation logic); interact through comments only. Progress convention:

1. **Starting**: one comment claiming the issue with your triage verdict (prep / fix / observe) and the planned branch name.
2. **Done**: copy the issue's checklist into a comment with completed items ticked, plus a change summary (files, test counts) and a branch/commit pointer.
3. **Accepted**: the maintainer closes the issue with the verification results, or references it via `Closes #N` in the merge commit.

## Maintainer-only: merge gates and release-day acceptance

The steps below require write access to the upstream repository (`FinbackYu/kimi-code-hud`); external contributors can skip this section.

- Work targeting **unreleased** upstream contracts never goes straight to `main`; it accumulates on the shared `upstream/<version>-prep` branch (one branch per upstream version, never shared across versions).
- A prep branch merges to `main` only when **both** gates pass: the upstream version is officially released, **and** every issue checklist item has been verified locally against the released build.
- Release-day acceptance, when the upstream version ships:
  1. Check out `upstream/<version>-prep` and make sure it is based on the latest `main`.
  2. Run every verification checklist left in the issue comments — really install the new version, really trigger the feature, and compare against the expected behavior.
  3. All green → merge to `main`, close the related issues, delete the merged branch (local and remote).
  4. Anything red → fix on the branch and re-verify; if the upstream contract drifted, record the delta in the issue and update the implementation.

## Anti-patterns

- Do not merge implementations of unreleased upstream contracts into `main` (maintainers); do not open PRs implementing them against `main` — target the prep branch instead (contributors).
- Do not edit the title or body of `upstream-watch` issues; progress goes in comments only.
- Do not commit while tests are red.
- Do not close a prep issue that still has unchecked checklist items (unless explicitly deferred).
- Do not share one prep branch across upstream versions.
