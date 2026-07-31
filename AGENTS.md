# Repository Guidelines

## Project Structure & Module Organization

This is a zero-dependency Node.js ESM CLI. `bin/kimi-hud.mjs` is the executable entry point. Reusable logic lives in `src/`, split by concern: payload parsing, rendering, metrics, quota access, Git state, plugin state, TOML editing, host config model-table parsing (`model-config.mjs`), and thinking-level resolution. `hooks/sync-status-line.mjs` implements the plugin `SessionStart` hook. Tests live in `test/` and mirror source modules with names such as `test/render.test.mjs`. Plugin metadata is in `kimi.plugin.json`; user documentation is maintained in both `README.md` and `README.en.md`.

## Build, Test, and Development Commands

- `npm test` — run the complete `node:test` suite. There is no build step.
- `node --test --experimental-test-coverage` — run tests with Node’s built-in coverage report.
- `node bin/kimi-hud.mjs --help` — verify the CLI entry point and supported options.
- `printf '' | node bin/kimi-hud.mjs` — smoke-test the empty-input fallback.
- `node --check src/render.mjs` — syntax-check an edited module; repeat for other changed `.mjs` files.

Node.js 18 or newer is required.

## Coding Style & Naming Conventions

Use two-space indentation, semicolons, single-quoted strings, and ESM `import`/`export`. Follow existing JSDoc patterns for exported functions. Use `camelCase` for functions and variables, `UPPER_SNAKE_CASE` for constants, and kebab-case filenames. No formatter or linter is configured, so match nearby code and run syntax checks before submitting.

## Testing Guidelines

Use `node:test` with `node:assert/strict`. Name files `test/<module>.test.mjs` and give each test a behavior-focused description. Use temporary directories for filesystem scenarios; never touch the user’s real Kimi configuration. Add regression tests for bug fixes, including exact boundary behavior. There is no enforced coverage threshold, but new branches should receive focused tests.

## Commit & Pull Request Guidelines

Write short, imperative commit subjects. History uses both direct subjects (`Add SessionStart self-heal hook`) and Conventional Commit prefixes (`fix: harden state and config handling`). Keep each commit scoped to one behavior. Pull requests should explain the user-visible change, list verification commands, link relevant issues, and include terminal output or screenshots for HUD layout changes.

## Security & Runtime Constraints

The HUD runs on a hot path with a 300ms host deadline. Avoid blocking network calls, unbounded scans, and new dependencies. Preserve silent fallback behavior: do not print diagnostics during rendering. Never log or cache access tokens. Keep cache writes atomic, sanitize path components, and preserve unrelated TOML settings during install, uninstall, and hook repair.
