# Microsoft Teams Bridge for ElevenLabs Agents

[![CI](https://github.com/komaa-com/elevenlabs-msteams-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/komaa-com/elevenlabs-msteams-bridge/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@komaa/elevenlabs-msteams-bridge.svg)](https://www.npmjs.com/package/@komaa/elevenlabs-msteams-bridge)
[![downloads](https://img.shields.io/npm/dm/@komaa/elevenlabs-msteams-bridge.svg)](https://www.npmjs.com/package/@komaa/elevenlabs-msteams-bridge)
[![docs](https://img.shields.io/badge/docs-komaa--com.github.io-2563eb.svg)](https://komaa-com.github.io/elevenlabs-msteams-bridge/)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6.svg)](https://www.typescriptlang.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

**`@komaa/elevenlabs-msteams-bridge`** puts an [ElevenLabs Agent](https://elevenlabs.io/docs/eleven-agents/api-reference/eleven-agents/websocket) on a real **Microsoft Teams call**. The hosted **StandIn media bridge** ([standin.komaa.com](https://standin.komaa.com)) joins the Teams call and dials into this bridge over an HMAC-authenticated WebSocket; the bridge opens one ElevenLabs Agent conversation per call and relays between them.

```
Microsoft Teams ⇄ StandIn media bridge ──HMAC WS──▶ this bridge ──WS──▶ ElevenLabs Agent
      (call)          (hosted service)                 (yours)          (STT+LLM+TTS+VAD)
```

The hot path is **copy-only**: both sides speak base64 PCM 16 kHz mono (`pcm_16000`), so caller audio and agent audio are relayed **verbatim** in both directions. No resampling, no re-encoding, no transcoding.

## Features

- **Realtime voice, end to end** - the caller talks to your ElevenLabs agent and hears it reply. Turn-taking, VAD and interruption are the agent's own (server-side); the bridge adds nothing to the latency budget beyond a relay hop.
- **Barge-in done right** - when the caller interrupts, the bridge cancels playback on the Teams side and drops stale in-flight agent audio by `event_id`, so no "audio ghosts" play after the cut.
- **Per-call personalization** - caller name, tenant and call direction are injected as `dynamic_variables` at conversation start; an optional localized greeting or spoken disclosure rides `first_message`; per-caller memory uses the caller's AAD id as `user_id` (guests get none, never a shared identity).
- **Vision on demand** - a `look` client tool lets the agent see the caller's camera or screen-share: describe-then-answer via any OpenAI-compatible vision endpoint, or native multimodal upload (recording-gated). See [Vision](#vision-look-client-tool).
- **Agent client tools** - `end_call`, `express` (avatar emotion), `show_image` (image on the bot's video tile, SSRF-guarded), `look`.
- **Two call governors** - a StandIn-side cutoff the bridge speaks a goodbye for, and a bridge-side `MAX_CALL_MINUTES` hard cap with a deterministic TTS goodbye.
- **Hardened transport** - replay-proof HMAC upgrade, single-use handshake guard, connection caps, payload caps, backpressure bounds, pre-start timeout, duplicate-call rejection, graceful SIGTERM drain, and an `EL_HOST` allowlist so your API key can only be sent to ElevenLabs.
- **Group-call awareness** - participant counts and DTMF digits are fed to the agent as contextual updates ("3 humans on the call, stay quiet unless addressed").

## Install

```bash
# run directly
npx @komaa/elevenlabs-msteams-bridge

# or add it to your project
npm install @komaa/elevenlabs-msteams-bridge
```

Node.js `>= 20`. One runtime dependency (`ws`).

## Quick start

### 1. As a CLI (env-configured)

```bash
ELEVENLABS_API_KEY=sk_... \
ELEVENLABS_AGENT_ID=agent_... \
WORKER_SHARED_SECRET=... \
  npx @komaa/elevenlabs-msteams-bridge
```

Every option is an environment variable; see [`.env.example`](./.env.example) (it ships with the package) and the [Configuration Reference](https://komaa-com.github.io/elevenlabs-msteams-bridge/configuration-reference/).

### 2. As a library

```ts
import { loadConfig, startServer } from "@komaa/elevenlabs-msteams-bridge";

// env-configured, same variables as the CLI
startServer(loadConfig());
```

With a custom vision hook (path-2 `look`: your model, your prompt, the raw frame never leaves your process):

```ts
import { loadConfig, startServer, type VisionDescriber } from "@komaa/elevenlabs-msteams-bridge";

const myVision: VisionDescriber = async (frame, question) => {
  // frame: { source, mime, dataBase64, width, height, participantName?, ... }
  const description = await myModel.describe(Buffer.from(frame.dataBase64, "base64"), question);
  return description; // returned to the agent as the `look` tool result
};

startServer(loadConfig(), undefined, myVision);
```

A complete runnable project lives in [`examples/basic-bridge/`](./examples/basic-bridge/). The full programmatic surface (custom agent transports, HMAC helpers, protocol types) is documented in the [Library API](https://komaa-com.github.io/elevenlabs-msteams-bridge/library-api/) page.

### 3. Connect it to StandIn

StandIn is the hosted service that joins the Teams call and dials into this bridge. Pick a tier at [standin.komaa.com](https://standin.komaa.com) (instant sandbox, a free developer tier with your own Teams bot, or a subscription for production), pair your identity, and then:

1. Set the identity's **agent WebSocket URL** to where this bridge listens, e.g. `wss://el-bridge.example.com:8080/voice/msteams/stream` (StandIn appends `/{callId}` per call).
2. Set `WORKER_SHARED_SECRET` to the **shared secret from pairing** - the two sides must match exactly, or the handshake is rejected with 401.
3. Call your Teams bot (or the sandbox meeting). StandIn joins, dials the bridge, and your ElevenLabs agent answers.

Details and the tier walk-through: [Connecting to StandIn](https://komaa-com.github.io/elevenlabs-msteams-bridge/connecting-to-standin/).

## Configuration

The most important variables (full list in [`.env.example`](./.env.example) and the [reference](https://komaa-com.github.io/elevenlabs-msteams-bridge/configuration-reference/)):

| Env | Required | Meaning |
|---|---|---|
| `ELEVENLABS_API_KEY` | yes | Server-side key; mints signed URLs, uploads files, calls TTS. Never sent to the Teams side. |
| `ELEVENLABS_AGENT_ID` | yes | The agent that answers calls. |
| `WORKER_SHARED_SECRET` | yes | The shared secret from StandIn pairing (HMAC upgrade check). |
| `PORT` / `BIND` | no | Listen address, default `0.0.0.0:8080`. |
| `EL_HOST` | no | Regional pin: `api.us.elevenlabs.io`, `api.eu.residency.elevenlabs.io`, `api.in.residency.elevenlabs.io`, `api.sg.residency.elevenlabs.io`. Restricted to `*.elevenlabs.io` so the API key cannot be sent elsewhere. |
| `EL_TTS_VOICE_ID` | no | Enables the deterministic governor goodbye (exact text via standalone TTS). Without it, the goodbye is delegated to the agent. |
| `EL_FIRST_MESSAGE` | no | Localized greeting / spoken AI disclosure (`first_message` override; must be allowlisted in the agent's security settings). |
| `MAX_CALL_MINUTES` | no | Bridge-side hard cap per call (fractional ok, `0` = off). |
| `VISION_API_URL` / `VISION_API_KEY` / `VISION_MODEL` | no | Path-2 vision: any OpenAI-compatible chat-completions endpoint with image input. |

Notes that save debugging time:

- The agent's audio in/out format **must** be `pcm_16000` (agent settings). The bridge validates the conversation metadata at call start and logs an error on mismatch - anything else means garbled audio.
- `conversation_config_override` fields (first message, prompt, voice) are **rejected by ElevenLabs unless allowlisted** in the agent's security settings.
- Numeric env vars fail loud: `MAX_CALL_MINUTES=abc` stops startup with a clear error instead of silently disabling the governor.

## Vision (`look` client tool)

Define a client tool named `look` on the agent (parameters: optional `source` = `camera`|`screenshare`, optional `question`). When the agent calls it, the bridge grabs the latest buffered frame and answers one of two ways:

1. **Path 2 (preferred, if `VISION_API_URL`/`VISION_MODEL` are set):** the frame goes to your OpenAI-compatible vision endpoint and the description comes back as the tool result. The **raw frame never leaves the bridge** (only the text description does), and it works **regardless of recording state**. Note the data flow, though: the description becomes ElevenLabs conversation content, which ElevenLabs **persists by default** - so a description of the caller's screen/camera can be stored by a third party even when Teams recording is off. This is a deliberate choice (vision stays usable without recording). If your deployment needs "no vision until recording is on," enable ElevenLabs zero-retention on the agent, or leave `VISION_API_URL` unset so only the recording-gated path 1 is available.
2. **Path 1 (fallback):** the frame is uploaded to the live ElevenLabs conversation and injected as a `multimodal_message` (the agent's LLM must be multimodal). Because this **persists the raw frame** with a third party, it is refused unless Teams recording is `active`.

The other client tools the bridge maps: `end_call`, `express` (`{emotion}`), `show_image` (`{dataBase64, mime}` or `{url}`, jpeg/png; URLs are SSRF-guarded - public hosts only, no redirects, bounded time and size).

## Call governors

Two governors can end a call gracefully; both speak before hanging up:

- **StandIn-side:** when a tier limit is reached, StandIn sends `assistant.say` with the goodbye text; the bridge speaks it (exact text via standalone TTS when `EL_TTS_VOICE_ID` is set, otherwise the agent is asked to say it) and the call is torn down.
- **Bridge-side** (`MAX_CALL_MINUTES` > 0): the bridge arms a timer at call start. On expiry it flushes playback, speaks `GOODBYE_TEXT`, waits for the audio to play out (real TTS duration, or `GOODBYE_GRACE_MS` when unknown, always hard-bounded), then ends the call with reason `time-limit`. Use this when the billing limit lives with you, since ElevenLabs knows nothing about your budget.

## Privacy / recording gate

StandIn reports the Teams recording state (`recording.status`). The bridge never logs or persists transcripts unless `LOG_TRANSCRIPTS=true` **and** recording is `active`. Video frames are buffered in memory only and dropped at teardown.

**Vision and recording (know the trade-off):** the recording gate blocks path-1 frame **uploads** to ElevenLabs when recording is off, but path-2 vision descriptions (see above) are ungated by design. In both cases caller audio and any vision descriptions transit ElevenLabs' cloud and are retained per the agent's retention settings. For deployments that must not retain caller data with a third party, enable ElevenLabs zero-retention on the agent and disclose in a spoken `EL_FIRST_MESSAGE` that an AI is on the call.

## Documentation

- **Docs site:** [komaa-com.github.io/elevenlabs-msteams-bridge](https://komaa-com.github.io/elevenlabs-msteams-bridge/) - getting started, architecture, configuration and library API reference, wire protocol, troubleshooting.
- **Example project:** [`examples/basic-bridge/`](./examples/basic-bridge/) - a runnable embedding with a custom vision hook and a documented `.env`.
- **StandIn (the hosted service):** [standin.komaa.com](https://standin.komaa.com) · [docs.komaa.com](https://docs.komaa.com).

## Repository layout

```
src/
  server.ts      HTTP + WS upgrade, HMAC validation, connection guards, session registry
  session.ts     per-call relay: StandIn WS ⇄ ElevenLabs Agent WS, tools, governors
  elevenlabs.ts  ElevenLabs Agent socket, signed-URL mint, standalone TTS, file upload
  protocol.ts    wire message types (JSON, camelCase, discriminated on "type")
  hmac.ts        HMAC-SHA256("{timestampMs}.{callId}") hex, constant-time verify
  ssrf.ts        public-URL guard for agent-supplied fetches
  vision.ts      path-2 describe-then-answer vision hook
  config.ts      env config (fail-loud numeric parsing)
examples/        runnable example projects
website/         docs site (Astro Starlight), deployed to GitHub Pages
test/            node:test suites (run with tsx)
```

## Contributing

PRs welcome - see [CONTRIBUTING.md](./CONTRIBUTING.md) for local setup, conventions, the release flow, and the documentation policy.

## License

[MIT](./LICENSE)
