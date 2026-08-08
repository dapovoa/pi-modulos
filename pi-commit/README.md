pi-commit

Generate Conventional Commit messages from git diff.

Install

  mkdir -p ~/.pi/agent/extensions/pi-commit
  cp extension.ts ~/.pi/agent/extensions/pi-commit/index.ts
  cp config.json ~/.pi/agent/extensions/pi-commit/config.json

Usage

  /commit          generate commit from unstaged diff
  /commit --staged generate commit from staged diff

The diff is sent to the LLM, which returns a properly formatted
Conventional Commit message ready for git commit -m.

Model Configuration

  Edit config.json to set which model /commit uses:

    { "model": "provider/model-id" }

  Example: { "model": "pi-nvidia/kimi-k2.6" }

  If config.json is missing, /commit uses the currently active model.
