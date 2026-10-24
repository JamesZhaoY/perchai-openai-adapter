# Perch CLI turn protocol — reverse engineering notes

Target: `perchai-cli@2.4.115`, `dist/perch.mjs` (12,213,475 bytes, bundled).
Source of truth for the implementation: `src/cli-protocol.mjs`.

## Method

1. Static reading of the bundle around the request strings
   (`/api/perch-terminal/turn-ticket`, `/api/perch-terminal/model-call`), the
   ticket store (`x-perch-turn-ticket`), and the delta wrapper
   (`x-perch-call-delta`).
2. Live capture: the unmodified official CLI was run with `--app-url` pointed at
   a local reverse proxy that forwarded every request to `https://chat.perchai.app`
   and logged method/path/headers/body (credentials redacted). One real turn
   (`Reply with exactly: OK`) produced the trace below.
3. A standalone probe replayed the captured protocol without the CLI binary and
   returned `OK` from `z-ai/glm-5.3-flash` with 32 total tokens.

## Captured sequence

| # | Method | Path | Purpose |
| - | ------ | ---- | ------- |
| 1 | GET | `/api/perch-terminal/public-model-default` | client default model hint |
| 2 | GET | `/api/perchai/account` | plan / entitlement check |
| 3 | POST | `/api/perch-terminal/cli-context` | `{query:"",includeIndex:false}` → `session.{userId,workspaceId}` |
| 4 | POST | `/api/perch-terminal/turn-ticket` | `{surface:"cli",profile:"standard"}` → signed ticket + `runId` |
| 5 | POST | `/api/perch-terminal/model-call` | SSE model call, requires the ticket header |
| 6 | POST | `/api/perch-terminal/cli-turn` | persist the finished turn (not needed by the adapter) |

Only steps 3–5 are required for an adapter turn; step 3 is cached per session.

## Authentication and headers

All calls use the Supabase access token as `Authorization: Bearer <token>`.
The CLI never sends the Cookie; the adapter derives the token from the imported
Cookie and refreshes it through Supabase as before.

`turn-ticket` and `model-call` additionally send:

```
user-agent: perchai-cli/<version>
x-perch-locale: en
content-type: application/json
```

`model-call` sends `Accept: text/event-stream` and
`x-perch-turn-ticket: <ticket>`. The ticket is a signed JWT-like value whose
payload binds `tid`, `uid`, `wid`, `surface` (`cli`), `plan`, `run` and `exp`.
It cannot be forged, and a ticket for another surface cannot be substituted.

## Model-call body (captured)

```json
{
  "request": { "messages": [...], "tools": [...], "temperature": 0.6, "maxTokens": 32000, "toolChoice": "auto" },
  "runId": "tkt-cli-...",
  "lane": "chat",
  "strictManual": false,
  "preferredModelId": "openrouter-z-ai-glm-5-3-flash",
  "avoidModelIds": ["..."],
  "attribution": { "userId": "...", "workspaceId": "...", "runId": "...", "lane": "chat", "source": "tool_loop", "billingMultiplier": null },
  "clientSurface": "cli",
  "resendAfterOutput": true,
  "manualModelOptionId": "openrouter-z-ai-glm-5-3-flash"
}
```

The adapter keeps the same shape but sets `strictManual: true` and an empty
`avoidModelIds` so the requested model cannot be silently replaced. It also
sends a compact system prompt instead of the CLI's ~33 KB Saffron operator
prompt.

## Response

`text/event-stream` with `data: {...}` events, notably:

- `reasoning_delta` → `{text}`
- `answer_delta` → `{text}`
- `stream_restart` → reset accumulated text
- `retrying`, `status` → transient state
- `done` → `{ok, text, model, provider, durationMs, usage:{inputTokens,outputTokens,cacheReadInputTokens,totalTokens}, finishReason}`

Example tail from the live probe:

```json
{"type":"done","ok":true,"text":"OK","model":"z-ai/glm-5.3-flash",
 "durationMs":1391,"usage":{"inputTokens":29,"outputTokens":3,"totalTokens":32}}
```

## Why the earlier handwritten attempt failed

The first attempt posted a turn ticket without the CLI surface identity carried
by `clientSurface: "cli"` on the model call (and without reproducing the exact
ticket/runId pairing), so the server answered `403 perch_surface_required`.
The surface is enforced on both the signed ticket and the model-call body;
the adapter now obtains the ticket from the issuer for every turn instead of
constructing one.

## Implementation

- `src/cli-protocol.mjs` — context + ticket + streaming model call, SSE parsing,
  error mapping.
- `src/perch.mjs` — per-thread CLI history, compact prompt split into
  system/user messages, `done.model` identity check, event translation.
- `src/official-cli.mjs` — legacy subprocess transport, kept for reference and
  no longer imported.
- `console/index.html` — untouched. The console still shows transport
  `official-cli` because that value is part of its existing rendering contract.

## Boundaries

- Tickets are requested live per turn; nothing is forged or cached across
  surfaces.
- The reported model id comes from the upstream `done` event and is checked
  against the selected Starter model. This is server-reported identity, not
  cryptographic provider attestation.
- Tool calling, attachments, Perch Terminal session persistence and the
  `cli-turn` persistence call are out of scope.
