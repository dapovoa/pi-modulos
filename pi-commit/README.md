# pi-commit

`/commit` — generate [Conventional Commits](https://www.conventionalcommits.org/) messages from git diff.

Stages all changes (`git add -A`), sends the diff to a configured model, and returns a single commit message in a code block. Prompts before running `git commit`.

## Usage

```
/commit
/commit --public
```

`/commit` applies light publication-safe wording (no "sanitized for public" phrasing).

Use `--public` when the diff removes internal paths, bench notes, or other prep before a public push — the message describes the **outcome** (e.g. "docs: add module READMEs"), not the cleanup.

## Config

`config.json`:

```json
{ "model": "deepseek/deepseek-v4-flash" }
```

If missing or the model is unavailable, `/commit` uses the current chat model.

## Install

```bash
EXT="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions"
mkdir -p "$EXT/pi-commit"
cp extension.ts "$EXT/pi-commit/index.ts"
cp config.json "$EXT/pi-commit/config.json"
```

Run `/reload` in pi.

## Deploy (this monorepo)

Edit `pi-modulos/pi-commit/`, copy to your runtime `extensions/pi-commit/`, `/reload`. See root [README](../README.md).
