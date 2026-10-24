# Account pool — design and verification

## Goal

Run the adapter with several Perch accounts and route each conversation to one
of them, without changing the OpenAI-compatible surface used by clients.

## Storage

`data/accounts.json` (mode 0600) holds the pool:

```json
{
  "version": 1,
  "activeId": "default",
  "strategy": "round-robin",
  "rrIndex": 0,
  "accounts": [
    { "id": "default", "label": "主账号", "cookie": "...", "userId": "...",
      "email": "...", "planCode": "pilot", "enabled": true,
      "lastUsedAt": null, "lastOkAt": null, "lastError": null, "cooldownUntil": 0 }
  ],
  "bindings": { "my-conversation-1": { "accountId": "default", "updatedAt": 0 } }
}
```

- Existing single-account installs migrate automatically: on first start the
  `state.json` Cookie (or `PERCHAI_COOKIE`) becomes the `default` account.
- The console API never returns `cookie`; only derived identity and status.
- Refresh tokens are saved back to the same entry through the `onRefresh` hook of
  `PerchClient`, so each account keeps its own rotated Cookie.
- Adding the same upstream `userId` again updates the existing entry instead of
  creating a duplicate.

## Selection

Priority in `AccountPool.resolve()`:

1. Explicit pin (`X-Perch-Account` header or `perch.account` body field).
2. Thread binding (`threads.json` entry has `accountId`).
3. Sticky conversation binding (`body.user` / `X-Perch-Conversation`).
4. Pool strategy: `round-robin` (default) or `least-recently-used`.

Disabled accounts and accounts inside a cooldown are skipped. If nothing is
available the request fails with `no_available_account` instead of silently
using a stale account.

Cooldowns:

- 401/403 → 5 minutes.
- 429 or `turn_rate_limited` / `usage_limit_reached` → 60 seconds.
- A successful turn clears the cooldown.

## Thread isolation

`threads.json` records now include `accountId`. When a conversation is moved to
a different account, `prepare()` detects the mismatch and creates a new upstream
thread. This prevents sending account A's thread id to account B. CLI history was
already keyed by `userId + threadId` in `data/cli-history/`, so it is isolated by
construction. The console stores `console:<threadId> → accountId` in the same
file for the same reason.

## Console

The rail has a new “号池” section:

- “自动分配” row (uses the strategy) plus one row per account with
  email · plan · cooldown/error state.
- Clicking a row pins that account for the next conversations; clicking
  “自动分配” clears the pin.
- Per-account actions: 停用/启用, 测 (account probe only), 删 (remove locally).
- “＋ 添加账号” opens the Cookie modal with an optional label field.
- The reply metadata shows `账号：<label>`, so a multi-account test is visible.

## API

All under `/console/api` and guarded by the console cookie:

| Method | Path | Body |
| --- | --- | --- |
| GET | `/accounts` | – |
| POST | `/accounts` | `{cookie,label}` |
| PATCH | `/accounts` | `{id,label?,enabled?}` |
| DELETE | `/accounts` | `{id}` |
| POST | `/accounts/select` | `{id}` |
| POST | `/accounts/strategy` | `{strategy}` |
| POST | `/accounts/test` | `{id}` |
| POST | `/accounts/refresh` | `{id}` |

OpenAI path: `POST /v1/chat/completions` accepts `X-Perch-Account: <id>` or
`{"perch":{"account":"<id>"}}`. Responses include `perch.account`.

## Verification

Mock end-to-end (`npm test`) covers:

- two pooled accounts added through the console API;
- no Cookie leakage in the list response;
- round-robin rotation for new conversations;
- sticky `user` across turns (same account + same thread);
- explicit `X-Perch-Account` overriding the thread/strategy;
- switching an existing `user` to another account creates a new thread.

Live verification with the real account (`主账号`, Pilot):

- `/console/api/account` returned the migrated account and refreshed its token;
- zero-inference probe `POST /console/api/accounts/test` returned
  `主账号 ✓ you@example.com · pilot` (email redacted here);
- a pinned console turn returned `POOL-OK`, reported
  `z-ai/glm-5.3-flash`, `42 tokens`, and the message metadata showed
  `账号：主账号`.

A true two-account live run needs a second real Cookie; the pool UI and API are
the entry point for adding it (`＋ 添加账号` or `pbpaste | npm run session`).
