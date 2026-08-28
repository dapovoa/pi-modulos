# Pi Modules

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript)](https://www.typescriptlang.org/)
[![pi.dev](https://img.shields.io/badge/pi.dev-extension-8B5CF6?logo=eslint)](https://pi.dev)
[![Modules](https://img.shields.io/badge/modules-10-4ade80)](.)

Collection of extensions for the [pi.dev](https://pi.dev) coding agent CLI — custom providers, tools, and safeguards.

**Source of truth:** all development happens here in `pi-modulos/`. Copy verified changes to your pi agent extensions directory, then `/reload`.

Agent dir defaults to `~/.pi/agent/` or `$PI_CODING_AGENT_DIR` when set (portable installs).

## Modules

| Module | Type | Description |
|---|---|---|
| [`pi-block`](pi-block/README.md) | Guard | Blocks dangerous shell commands and sensitive file reads (Cursor hooks + pi confirmations) |
| [`pi-code`](pi-code/README.md) | Provider | Command Code API provider with git-aware context injection |
| [`pi-commit`](pi-commit/README.md) | Tool | `/commit` and `/commit --public` — Conventional Commits from git diff (`config.json` model; default `deepseek/deepseek-v4-flash`) |
| [`pi-cursor`](pi-cursor/README.md) | Provider | Cursor SDK provider — agent sessions, hang detection, auto-retry, model catalog |
| [`pi-kimi`](pi-kimi/README.md) | Provider | Moonshot Kimi API (streaming, thinking, tools) |
| [`pi-mistral`](pi-mistral/README.md) | Provider + Tools | Mistral AI provider + `mistral_ocr` and `mistral_fim` tools |
| [`pi-nvidia`](pi-nvidia/README.md) | Provider | Nvidia NIM — Nemotron, Gemma, Kimi, DeepSeek, Qwen, etc. |
| [`pi-qwencloud`](pi-qwencloud/README.md) | Provider | Alibaba DashScope — Qwen3.7, DeepSeek V4, GLM-5.1, MiniMax, etc. |
| [`pi-tools`](pi-tools/README.md) | Tool | Nine skills: `/pi-fix-*`, `/pi-audit-*`, `/pi-maintain-wiki` (see pi-tools README) |
| [`pi-xiaomi`](pi-xiaomi/README.md) | Provider | Xiaomi MiMo Token Plan — prompt cache key injection |

## Deploy workflow

1. Edit in `pi-modulos/NAME/` (never treat the runtime extensions copy as source).
2. Copy changed files to `$PI_CODING_AGENT_DIR/extensions/NAME/` (or `~/.pi/agent/extensions/NAME/`).
3. Run `npm install` in the extension dir if `package.json` changed.
4. Run `/reload` in pi.
5. Commit from `pi-modulos/` only.

## Model selection

- **pi-commit** — single model in `pi-commit/config.json`. Use `/commit --public` when preparing commits for a public audience (message describes the outcome, not sanitization).
- **pi-tools** — per-skill models in `pi-tools/config.json`; commands prefixed `pi-fix-`, `pi-audit-`, `pi-maintain-`:
  - Mechanical: `fix-clean`, `fix-format`, `maintain-wiki` → `deepseek/deepseek-v4-flash`
  - Technical: `audit-bug`, `fix-dedupe`, `audit-security`, `audit-perf`, `fix-dead`, `audit-deps` → `pi-cursor/grok-4.6`
- **Providers** — enable models in `.pi/agent/settings.json` (`enabledModels`); auth in `.pi/agent/auth.json`.

See each module README for full `config.json` examples.

## Removed

- `pi-commandcode` — deleted 2026-06-02 (models migrated to `pi-qwencloud` where applicable).
- `pi-memory` — removed 2026-06-04 (redundant with pi built-in wiki injection).
- `pi-tools` `/comments` — removed 2026-08-15; merged into comment removal (`pi-fix-remove-comments`).
- `pi-tools` command names — 2026-08-17: `pi-{category}-{action}` prefix; see `pi-tools/README.md`.

---

## License

This project is under the MIT License. See the [LICENSE](LICENSE) file for details.
