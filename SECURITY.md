# Security Policy

## Supported versions

Security fixes are made against the **latest release** (see the [Releases page](https://github.com/FinbackYu/kimi-code-hud/releases)). The project is 0.x software with no long-term support branches — please update to the latest release and retest before reporting a vulnerability.

## Reporting a vulnerability

**Do not open a public GitHub issue for an undisclosed vulnerability.**

GitHub's private vulnerability reporting is **not currently enabled** on this repository, so there is no private issue channel yet. Report security problems by email to the maintainer:

- **yu_haoran97@126.com** — the address published in this repository's commit history and on the [maintainer's GitHub profile](https://github.com/FinbackYu). Start the subject with `kimi-code-hud security` so it is not lost.

If the Security tab of this repository ever offers "Report a vulnerability", that channel becomes preferred over email.

If you cannot use email, open a regular issue with the [bug report template](.github/ISSUE_TEMPLATE/bug_report.yml), strip every sensitive detail as described below, and say that details will follow by email.

### What to include

- HUD version of the installed plugin (see the bug report template for how to find it);
- Node.js version (`node --version`), OS, and terminal;
- Kimi Code CLI version (`kimi --version`);
- A description and minimal reproduction steps, using synthetic data only;
- Evidence, **sanitized**: replace every credential with an obvious placeholder (`sk-***`, `eyJ***`), and never attach raw `wire.jsonl`, config files, or session content. You do not need to send real tokens to prove a leak — a synthetic marker string showing up where it must not is stronger evidence.

### Response expectations

- Acknowledgment within **7 days**. If you have heard nothing after a week, send a follow-up.
- After acknowledgment you get an assessment: affected versions, severity, and the plan. Fix timing depends on severity — anything that exposes credentials or session content takes priority.
- You choose whether to be credited; anonymous reports are fine. The project offers no bug bounty.

## Scope

### In scope (examples)

Anything that breaks the privacy and safety promises documented in [README.md](README.md) (Privacy & security) and [CAPABILITIES.md](CAPABILITIES.md):

- Access tokens, API keys, or session content (prompts, replies, tool output) written to logs, caches, output, or anywhere else the docs promise they never go;
- Unsanitized control characters, ANSI escapes, or terminal injection reaching the rendered status line from wire data or other dynamic input;
- Path traversal or unsafe writes in cache, session-state, or config handling, including install, uninstall, and hook repair;
- Command injection through shell command construction during install, update, or uninstall;
- Credential use beyond the documented read-only access to fixed official endpoints.

### Out of scope

- Bugs in the Kimi Code CLI host itself — report upstream at [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code/issues). The HUD fails closed where the host contract is unclear, but it cannot fix the host.
- Attacks that already assume a compromised machine, the user's own account, or an attacker-modified `~/.kimi-code` configuration. The host process and its local files are trusted inputs by design (the HUD still sanitizes the dynamic text it renders).
- Reports from automated scanners without demonstrated impact; social engineering.

## Disclosure process

1. You report privately (email); the report is acknowledged and assessed against the supported versions.
2. A fix is developed without public discussion; when feasible, you are asked to verify it before release.
3. The fix ships in a regular release; the vulnerability is disclosed afterwards in the changelog and release notes, with credit unless you prefer to stay anonymous.
4. If a report is declined as out of scope or not reproducible, you get the reasoning and may respond with additional evidence.
