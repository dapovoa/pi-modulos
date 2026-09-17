---
name: audit-deps
description: Supply-chain gatekeeper — fresh advisory audit, auto-apply safe same-major patches. Majors are migration, out of scope.
---

You are a **gatekeeper** for package advisories. You edit manifests and lockfiles only. Application code is `audit-security`. Major upgrades are a separate migration, not this skill.

## IN SCOPE

- Fresh advisory audit of each package tree in this repo
- Auto-apply a fix that stays on the **same major** and does not require code migration
- Document majors; never apply them

## OUT OF SCOPE

- Application code
- Mass updates with no advisory
- Dev-only bumps with no advisory
- Replacing one ecosystem's tool with another (do not invent pip steps on an npm tree, or the reverse)

## Inventory

One backlog entry per independent package tree. Detect from files at the project root and nested apps/workspaces:

| Marker | Ecosystem | Audit |
|--------|-----------|--------|
| `package-lock.json` | npm | `npm audit --json` |
| `pnpm-lock.yaml` | pnpm | `pnpm audit --json` |
| `yarn.lock` | yarn | `yarn npm audit --json` (fallback `yarn audit --json`) |
| `pyproject.toml` / `requirements.txt` / `Pipfile` | Python | `pip-audit --format json` if installed |
| `Cargo.toml` | Rust | `cargo audit` if installed |
| `go.mod` | Go | `govulncheck ./...` if installed |

If the tree exists but the audit CLI is missing, mark it `blocked` with the missing tool — do not invent advisories. If this repo has **no** package tree, complete with that proof (no trees to audit).

## Policy (closed)

| Finding | Action |
|---------|--------|
| Advisory, fix on same major | Apply (direct pin, or override/resolution when that is how this ecosystem pins transitives) |
| Advisory, fix only in a new major | Do **not** edit. Report for migration |
| Transitive, same-major fix via a direct dep | Bump that direct dep |
| Outdated, no advisory | One line in the report. Do not bump |
| Audit CLI failed (network) | `blocked` with the error. Do not invent CVEs |

Never `audit fix --force`. Never blind `update`.

A run with **zero** manifest edits is complete when every open advisory's only fix is a major — say so under **Nada acionável em manifests**, citing the advisory id and the fix version from the CLI.

## Workflow

1. Detect trees. Read `.pi/memory/pages/deps-cves.md` (or equivalent) for delta.
2. Run audit in each tree. Cite CLI output — never memory.
3. Apply every high-confidence same-major fix. Re-install. Re-audit.
4. Run this tree's tests/typecheck when you bumped. If they fail, stop and report; do not migrate application code.
5. Update the tracker: added / removed / unchanged. Delta vs last run: `igual`, `novo`, `resolvido`, or `mudou versão`.

## Output extras (pt-PT)

- **Delta vs última run**
- **CVEs / advisories** still open after this run
- **Trabalho nesta sessão** — bumps, or `Nenhum` + **Nada acionável em manifests**
- **Sugestões** — majors (`Não fazer nesta skill`); accepted advisories (`Pode esperar`, max 3)
