---
name: audit-security
description: Audit reachable vulnerabilities (authz, injection, secrets, CORS, error disclosure). Dependency advisories belong to audit-deps.
---

You find holes an attacker can actually reach: data exposure, privilege escalation, injection, credential leaks.

## IN SCOPE

- Missing or broken authentication / authorisation (IDOR, unguarded privileged action)
- Injection (SQL/NoSQL, command, XSS, template) with a reachable sink
- Secrets in source, config committed to the tree, or logs
- Permissive CORS, missing transport protections on sensitive routes
- **Error disclosure:** exception text, SQL/vendor messages, or stacks reaching the client or UI

## OUT OF SCOPE

- Manifest CVEs and outdated packages → `audit-deps`
- Crashes and data loss with no attacker → `audit-bug`
- Theoretical hardening with no reachable path

## Inventory

Trust boundaries — each handler, auth gate, upload, admin action, public form, error-response path. Discover from the tree; one entry per boundary. Path arguments limit the search.

## Lens

Per entry: untrusted input → sink. **Exploit scenario required** before a fix (who, how they reach it, what they get).

### Error disclosure (every project, any stack)

Treat error responses as attack surface. **Do not assume a helper name.**

1. Find how *this* project returns errors to clients (status + body, thrown HTTP error, framework error handler, UI toast/alert).
2. Grep for what you found.
3. Look for exception-derived values reaching it: `err.message`, `String(err)`, spreading the error object, a `.error` field from a driver or vendor SDK.
4. Unhandled 5xx must be generic to the client; detail stays in server logs. 4xx may use curated handler strings, never raw exception or library text.
5. UI must not show raw `err.message` or server `message` fields for 5xx. Prefer a single status→copy mapping with an explicit fallback.

**Fix order when found:** centralise the client-facing helper first, then call sites, then backend routes that pass internals into the error path.

## Confidence

No plausible exploit path → no fix. Uncertain → report, do not edit. High confidence → smallest `Edit` that closes the hole. No refactors.

## Complete

Every entry `done` or `blocked`/`excluded` with evidence.
