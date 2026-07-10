# elevenlabs-msteams-bridge

Bring Microsoft Teams voice/video calls to an [ElevenLabs Agent](https://elevenlabs.io/docs/eleven-agents/api-reference/eleven-agents/websocket).

This is the ElevenLabs **bridge provider** for the OpenClawBridge Teams media stack: the Windows MediaNode terminates Teams Graph Calling + Skype media and exposes each call as one WebSocket speaking a provider-agnostic wire protocol (`OpenClaw/Protocol.cs`). This service terminates that protocol on one side and an ElevenLabs Agent WebSocket on the other. The media worker needs **no code changes**.

Design spec: `OpenClawBridge/docs/experimental/ELEVENLABS-AGENT-BRIDGE.md` (validated against the repo tree and the live ElevenLabs API docs, 2026-07-10).

```
Teams ──Graph+Skype media──▶ MediaNode ──WS (Protocol.cs, PCM16K)──▶ this bridge ──WS──▶ ElevenLabs Agent
```

Audio is relayed **verbatim** in both directions: both sides speak base64 PCM 16 kHz mono (`pcm_16000`), and the worker re-aligns variable-length chunks itself. No resampling, no re-encoding.

## Status

| Build-order step (spec §10) | State |
|---|---|
| 1. Voice MVP (HMAC upgrade, EL session per call, audio relay, interruption→assistant.cancel, both ping/pong pairs, session.end) | Done |
| 2. Context (conversation init dynamic variables, participants/dtmf → contextual_update) | Done |
| 3. Barge-in polish (ghost-audio drop by event_id) | Done |
| 4. Governor goodbye (assistant.say → standalone TTS, user_message fallback) | Done |
| 5. Vision on-demand (frames are buffered per source; upload/multimodal not wired yet) | Groundwork |
| 6. Avatar | Nothing to do (RMS path, worker-side) |
| 7. Client tools | `end_call` only; others return a tool error |

## Run

```bash
npm install
npm test          # 10 tests: HMAC vectors, protocol parsing, full E2E relay
npm run build
ELEVENLABS_API_KEY=... ELEVENLABS_AGENT_ID=agent_... WORKER_SHARED_SECRET=... npm start
```

Then point the Teams identity's `OpenClawWsBaseUrl` at this service (e.g. `wss://el-bridge.internal:8080/voice/msteams/stream`) and set its `OpenClawSharedSecret` to the same value as `WORKER_SHARED_SECRET`. The worker dials `{base}/{callId}` per call.

## Configuration

See `.env.example`. Notable:

- `EL_HOST` — pin the ElevenLabs region (`api.us.elevenlabs.io`, `api.eu.residency.elevenlabs.io`, `api.in.residency.elevenlabs.io`, `api.sg.residency.elevenlabs.io`) to match MediaNode locality and data-residency requirements.
- `EL_TTS_VOICE_ID` — enables the deterministic governor goodbye (exact text via standalone TTS). Without it, the goodbye is delegated to the agent via `user_message`.
- The agent's audio in/out format **must** be `pcm_16000` (agent settings); the bridge logs an error at call start if the conversation metadata reports anything else.
- `conversation_config_override` fields (first message, prompt, voice) are rejected by ElevenLabs unless allowlisted in the agent's security settings.

## Privacy / recording gate

The worker reports Teams recording state (`recording.status`). The bridge never logs or persists transcripts unless `LOG_TRANSCRIPTS=true` **and** recording is `active` (Media Access API requirement). Video frames are buffered in memory only and dropped at teardown.

## Layout

```
src/
  server.ts      HTTP + WS upgrade, HMAC validation (mirror of HmacSigner.cs)
  session.ts     per-call relay: worker WS ⇄ ElevenLabs Agent WS
  elevenlabs.ts  EL Agent socket, signed-URL mint, standalone TTS
  protocol.ts    worker wire types (mirror of OpenClaw/Protocol.cs, camelCase)
  hmac.ts        HMAC-SHA256("{timestampMs}.{callId}") hex, constant-time verify
  config.ts      env config
test/            node:test suites (run with tsx)
```
