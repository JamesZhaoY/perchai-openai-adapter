# Desktop-model integration — 2026-10-24 (Asia/Shanghai)

> Historical record. The subprocess transport described here was replaced by the
> direct CLI turn protocol; see `cli-protocol.md` and `cli-protocol-live-test.json`.

## Result

The adapter invokes the unmodified official `perchai-cli@2.4.115` npm package.
No Desktop client was installed or launched. Authentication is derived in memory
from the user's existing Supabase Cookie and provided to the official CLI in a
temporary 0600 auth file. No keychain or Chrome session database is read.

Live local-HTTP test receipts: `desktop-live-test.json`.

| Model | Result | CLI-reported model ID |
| --- | --- | --- |
| glm-5.3-flash-starter | OK | z-ai/glm-5.3-flash |
| minimax-m3.1-flash-starter | OK | minimax/minimax-m3.1-flash |
| deepseek-flash-starter | OK | deepseek/deepseek-v4.1-flash-1017 |
| laguna-s | Upstream busy, no successful answer | Not verified |
| beam-1.0-starter | Trial ended; disabled without inference | Not tested |

The console itself was additionally tested with GLM and displayed `OK`, the
requested name, the reported name, CLI transport and 15,419 total tokens.
The input field was empty after submission.

## Evidence and boundary

- Official public package: https://registry.npmjs.org/perchai-cli/-/perchai-cli-2.4.115.tgz
- Registry SHA-512: `BcG7mv4zALJ8AY8XXlQlGHKljEvM5ll2Tcx9m3rQPpRrjaVS4rgBOKPCgGmk2lARmKVEj+dbLi/BWnGxv+lRqA==`.
- The shipped Web bundle advertises `npm install -g perchai-cli`; the package's
  README explicitly supports running without Desktop.
- Bounded static reading of `dist/perch.mjs` identified the official turn-ticket
  and model-call flow and the supported `PERCH_CLI_AUTH_DIR` session format.
- A handwritten turn-ticket request was rejected with HTTP 403 and
  `perch_surface_required`. That direct path was abandoned. No ticket, signature,
  or successful inference response was forged. No manual variations were retried.
- REA parent evidence: `ev_2d4a3da0058d029dae730afa95e2e11501e5a30f0f444f0ed2ca50e84ec27ae2`;
  summary: `ev_a71fe87d7bcd86d7265d5da365cfd16af5bf5229ea749aca26d649c19477fefe`.
  Whole-bundle graph coverage is partial: the 512 MiB worker exhausted its heap.
  Protocol findings rely on focused byte-level source inspection plus live CLI
  behavior, not on a complete REA call graph.

## Implementation constraints

- Calls use the official CLI executable, not a copied HTTP client.
- `--no-local-tools`, ask mode, plan permissions, isolated settings and an empty
  working directory are used. Node file permissions constrain JavaScript file
  access to dependencies and the per-call temp directory. The official canvas
  dependency requires native-addon permission; this is not an OS sandbox claim.
- CLI context snapshots and nonempty API usage are checked against the selected
  model. This is client-reported model identity, not cryptographic provider proof.
- CLI responses arrive as complete JSON. The adapter emits a waiting status then
  a completed content chunk; it does not claim token-by-token streaming.
- Web Search on this path is rejected; no fallback to the Web router is made.
- CLI conversation history is local, account/thread scoped, and mode 0600.
- Model failures are surfaced, not replaced by a different model.
- Switching between Web and CLI transports starts a separate conversation.
- Short messages still load official Agent context (roughly 13k–16k total input
  context in these tests, often substantially cached). These are real allowance-consuming calls.

Remaining external limitation: Laguna S returned busy in both official-CLI and
integrated tests. There is no verified successful Laguna answer in this run.
