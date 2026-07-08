# Agent CLI: feedback & crash triage

A task-focused walkthrough for agents that need to **read and triage feedback
and crash tickets** from the command line. For the broader auth model and
release/share operations, see the [Agent Guide](/docs/agent-guide/); for the
full command surface, the [CLI Reference](/docs/cli-reference/).

## Why the CLI (and not `integration invoke`)

Quiver is a **Login-with-Raft HTTP API service**, not a manifest action
service. So `raft integration invoke --service quiver --list-actions`
returns **none** — that is expected, not a misconfiguration. Agents reach
Quiver two ways, both using a Bearer token from Raft Agent Login:

- the **`@oranix/quiver-cli`** npm package (what this page covers), or
- direct REST calls to `/api/*` (see the [Agent Guide](/docs/agent-guide/)).

## 1. Get a token

From any Raft-connected machine:

```bash
raft integration login --service quiver
# → prints a one-time "service callback handoff URL"
curl -s "<that URL>"
# → {"ok":true,"token_type":"Bearer","access_token":"…", …}
```

Export it for the CLI (both names work; `QUIVER_AUTH_TOKEN` takes precedence):

```bash
export QUIVER_BEARER_TOKEN=<access_token>
```

The callback code is one-time — re-run the login for a fresh session. Your
capabilities follow your Quiver **org role**; `403` responses name the role
required.

## 2. Run the CLI

No global install needed:

```bash
npm exec --package @oranix/quiver-cli -- quiver whoami
```

(Pin a version with `@oranix/quiver-cli@0.3.2` if you want reproducibility.)
Every command below takes `--json` for scripting.

## Triage commands

The first argument is the **app slug** (or id), e.g. `raft-android`.

```bash
# List tickets, newest first (filterable)
quiver feedback list raft-android --status open --kind crash
quiver feedback list raft-android --kind bug

# Show one ticket: description, device context, attachments, comments.
# Use the full UUID from the submitted ticket response/reference.
quiver feedback show raft-android 389d855b-0000-0000-0000-000000000000

# Triage: change status and/or (re)assign
quiver feedback update raft-android 389d855b-0000-0000-0000-000000000000 --status in_progress --assignee me
quiver feedback update raft-android 389d855b-0000-0000-0000-000000000000 --status resolved
quiver feedback update raft-android 389d855b-0000-0000-0000-000000000000 --assignee none   # unassign

# Leave an internal comment (also where auto-retrace/symbolication land)
quiver feedback comment raft-android 389d855b-0000-0000-0000-000000000000 "reproduced on SGT-AL10; fix in progress"
```

Status flow: `open → in_progress → resolved → closed`. Assignee is
independent of status.

## Quick lookup by feedback id

When a user pastes a Quiver feedback id, first identify the app slug. For
Raft Android/mobile, that slug is normally `raft-android`.

New Quiver feedback responses include the full UUID in both `id` and the
copyable `reference` field, for example:

```text
raft-android · 1.0.4 (1000400) · ticket 389d855b-0000-0000-0000-000000000000
```

Use that UUID directly:

```bash
TICKET_ID=389d855b-0000-0000-0000-000000000000
APP=raft-android

quiver feedback show "$APP" "$TICKET_ID"
```

The CLI now prints full UUIDs in human output. If you are working from an
older copied reference that has only an 8-character short id, expand it to the
full ticket UUID first:

```bash
SHORT_ID=389d855b
APP=raft-android

TICKET_ID="$(quiver feedback list "$APP" --json \
  | python3 -c 'import json,sys; p=sys.argv[1]; print(next(t["id"] for t in json.load(sys.stdin)["tickets"] if t["id"].startswith(p)))' "$SHORT_ID")"

quiver feedback show "$APP" "$TICKET_ID"
```

The `show` output is the first place to check for diagnostics: it includes
the user message, version/channel, device context, comments, and all
attachment ids. Crash deobfuscation/symbolication output is appended as an
internal comment when mapping/symbol assets exist.

For scripts, keep the raw JSON:

```bash
quiver feedback show "$APP" "$TICKET_ID" --json > ticket.json
```

## Crashes

Crash tickets (`--kind crash`) carry a grouping **signature** (exception
class + top frame). When the build's `mapping.txt` (Java/R8) or
`native-symbols` archive was uploaded, an auto-deobfuscated / symbolicated
stack is appended as an internal comment — visible in `feedback show`. To
aggregate by signature across a fleet, call the API directly:

```bash
curl -s -H "Authorization: Bearer $QUIVER_BEARER_TOKEN" \
  https://quiver.oranix.io/api/apps/<appId>/feedback/crash-groups
```

## Attachments (diagnostics zips, logs)

`feedback show` lists each attachment's id, filename, and size. Download one
through the authenticated API endpoint (the CLI doesn't wrap this yet). The
API path requires the app UUID, not just the slug:

```bash
APP_ID="$(quiver apps get "$APP" --json \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"

curl -s -H "Authorization: Bearer $QUIVER_BEARER_TOKEN" \
  "https://quiver.oranix.io/api/apps/$APP_ID/feedback/$TICKET_ID/attachments/<attachmentId>" \
  -o diagnostics.zip
```

Find `<appId>` with `quiver apps list` (the slug is stable; the id is the
UUID the API paths use).

Quiver does not define the files inside an app's diagnostics archive. It
stores and serves the attachment; the producing app owns the log format and
archive layout.

The same ticket detail call can be made directly without the CLI:

```bash
curl -s -H "Authorization: Bearer $QUIVER_BEARER_TOKEN" \
  "https://quiver.oranix.io/api/apps/$APP_ID/feedback/$TICKET_ID"
```

Known current limitation: the CLI can list attachment ids but does not yet
wrap attachment downloads; use the authenticated REST call above until a
`quiver feedback download-attachment` command exists.

## Other environment knobs

- `QUIVER_API` — point the CLI at a non-production Worker (defaults to the
  production origin).
- `--json` — machine-readable output on every command, for agents that parse
  results.
