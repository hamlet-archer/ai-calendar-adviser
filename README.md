# ai-calendar-adviser

Read-only RPC over Google Calendar. Owns the 5 calendar domains transferred from the retired `life-ops` agent (`calendar.primary`, `calendar.mkkk`, `calendar.others`, `calendar.mkkk-others`, `staff.schedules`). Backs Phase 3 task body enrichment grounding (the `## Constraints` H2).

## Status

**Scaffold + SQLite cache layer (sub-item 1).** No real Google ingestion yet — the cache layer is unit-tested in isolation; main entry still exits with `scaffold_only` until sub-item 2 (Google Calendar adapter + boot self-check) lands. Implementation tracked in [ai-ops-meta `architect-backlog.md`](https://github.com/hamlet-archer/ai-ops-meta/blob/main/architect-backlog.md) under Phase 3 grounding-source agents.

Design: [`docs/architecture.md` §6.8](https://github.com/hamlet-archer/ai-ops-meta/blob/main/docs/architecture.md) — Grounding-source rollout.

## What it owns

| Domain                 | Source                               |
| ---------------------- | ------------------------------------ |
| `calendar.primary`     | Google Calendar — Kelvin's primary   |
| `calendar.mkkk`        | Google Calendar — household shared   |
| `calendar.others`      | Google Calendar — others             |
| `calendar.mkkk-others` | Google Calendar — household + others |
| `staff.schedules`      | Composed view across calendars       |

## Contracts

Accepts:

- [`calendar.query.v1`](https://github.com/hamlet-archer/ai-ops-meta/blob/main/contracts/calendar.query.v1.json)
- [`calendar.find_free_slot.v1`](https://github.com/hamlet-archer/ai-ops-meta/blob/main/contracts/calendar.find_free_slot.v1.json)

`calendar.write_event.v1` is explicitly **deferred to v2** of the agent — blast radius `external-write`, requires per-invocation approval (CLAUDE.md non-negotiable rule 8).

## Architecture

- Long-running Unix-socket daemon at `/var/run/ai-calendar-adviser/query.sock`
- SQLite cache at `/var/lib/ai-calendar-adviser/calendar.db` (mode 0600, owned by the agent unix user)
- 15-min systemd timer pulls and caches event windows from Google Calendar
- Reuses `ai@liao.info` Google OAuth (`feedback_shared_ai_credentials`); scope strictly `calendar.readonly`
- Tokens loaded via systemd `LoadCredential` from 1Password; no on-disk plaintext

## Boot self-check (AP-3 + AP-4)

On startup, before binding any RPC, the agent must:

1. Validate Google OAuth token against `ai@liao.info`
2. Enumerate the 5 expected calendarIds via `calendarList.list` — fail loud on missing
3. Round-trip one `calendar.list` against each calendar — fail loud on 403/404

Failure → `process.exit(1)` with a structured diagnostic naming (a) the dependency, (b) the verbatim Google API error, (c) ranked likely root causes (token revoked / scope downgrade / API outage).

## Develop

```
npm install
npm test       # vitest
npm run build  # tsc
```

## Deploy

Mirrors the `ai-comms-adviser` deploy shape — single systemd unit (`ai-calendar-adviser.service`) on `golden-ai-ops`, push-to-main `deploy` webhook, alpha-stage rollback via `git revert && ./scripts/deploy.sh`.
