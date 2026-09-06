<!--
Base branch: `main` for fix/docs/housekeeping work; `upstream/<version>-prep` for work against
unreleased upstream contracts (see CONTRIBUTING.md). Keep one behavior change per commit.
-->

## User-visible change

<!-- What changes for someone using the HUD? If nothing is user-visible (tests, CI, docs
     housekeeping), say so in one line. -->

## Related issues

<!-- e.g. `Closes #12`. If none, write "none". -->

## Docs shipped in this change

<!-- User-visible behavior changes ship their docs in the same change: README.md and
     README.en.md in sync, plus CAPABILITIES.md / KNOWN_ISSUES.md when compatibility or
     known limitations are affected. -->

- [ ] README.md / README.en.md updated — or N/A because: …
- [ ] CAPABILITIES.md / KNOWN_ISSUES.md updated — or N/A because: …

## Verification

<!-- All gates must pass before merge; paste the actual results, not just checkmarks. -->

- [ ] `npm test` — full node:test suite: … passed, 0 failed
- [ ] `node --check <file.mjs>` for every edited `.mjs` file
- [ ] `git diff --check` — no output

## HUD layout change?

<!-- If the rendered status line changed (segments, wording, colors, width behavior),
     attach terminal output or a screenshot. Otherwise write "no layout change". -->
