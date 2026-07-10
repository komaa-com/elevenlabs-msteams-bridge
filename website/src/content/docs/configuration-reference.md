---
title: "Configuration Reference"
description: "Every environment variable the bridge reads, with defaults and meaning."
---

The bridge is configured entirely from environment variables. The package ships a fully commented [`.env.example`](https://github.com/komaa-com/elevenlabs-msteams-bridge/blob/main/.env.example). Only three variables are required.

## Required

| Env | Meaning |
|---|---|
| `WORKER_SHARED_SECRET` | The shared secret from StandIn pairing. Must equal what StandIn holds, or the HMAC upgrade is rejected with `401`. |
| `ELEVENLABS_API_KEY` | Server-side ElevenLabs key. Mints signed URLs, uploads files, calls TTS. Never sent to the Teams side. |
| `ELEVENLABS_AGENT_ID` | The ElevenLabs agent that answers calls. |

## ElevenLabs

| Env | Default | Meaning |
|---|---|---|
| `EL_HOST` | `api.elevenlabs.io` | Regional pin: `api.us.elevenlabs.io`, `api.eu.residency.elevenlabs.io`, `api.in.residency.elevenlabs.io`, `api.sg.residency.elevenlabs.io`. Restricted to `*.elevenlabs.io`. |
| `EL_HOST_ALLOW_ANY` | unset | Set to `true` only to point `EL_HOST` at a deliberate trusted proxy/test host. |
| `EL_ENVIRONMENT` | unset | Environment-specific agent resolution (e.g. a staging agent alongside production). |
| `EL_FIRST_MESSAGE` | unset | Localized greeting / spoken AI disclosure (`first_message` override; must be allowlisted in the agent's security settings). |
| `EL_AGENT_BRANCH_ID` | unset | Pin a specific agent branch per deployment. |
| `EL_TTS_VOICE_ID` | unset | Enables the deterministic governor goodbye (exact text via standalone TTS). Without it, the goodbye is delegated to the agent. |
| `EL_TTS_MODEL_ID` | `eleven_turbo_v2_5` | TTS model for the goodbye line. |

:::caution
`ELEVENLABS_API_KEY` is sent as `xi-api-key` to `https://{EL_HOST}/...`. `EL_HOST` is allowlisted to `*.elevenlabs.io` precisely so a mistyped or attacker-influenced host cannot exfiltrate the key. Only set `EL_HOST_ALLOW_ANY=true` for a proxy you control.
:::

## Call governor

| Env | Default | Meaning |
|---|---|---|
| `MAX_CALL_MINUTES` | `0` (off) | Bridge-side hard cap per call, in minutes (fractional allowed). |
| `GOODBYE_TEXT` | a default line | The goodbye the bridge-side governor speaks. |
| `GOODBYE_GRACE_MS` | `8000` | How long to let the goodbye play out before ending the call when its duration is unknown (agent-said fallback). Always hard-bounded. |

## Vision (path 2)

| Env | Default | Meaning |
|---|---|---|
| `VISION_API_URL` | unset | An OpenAI-compatible chat-completions endpoint with image input. Set it to enable path-2 vision (describe-then-answer). |
| `VISION_API_KEY` | unset | Bearer key for the vision endpoint (local endpoints may not need one). |
| `VISION_MODEL` | unset | Vision model name (required when `VISION_API_URL` is set). |

## Server and transport

| Env | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | TCP port the bridge listens on. |
| `BIND` | `0.0.0.0` | Bind address. |
| `HMAC_FRESHNESS_MS` | `60000` | Allowed clock skew for the HMAC timestamp. |
| `MAX_CONNECTIONS` | `0` (= 64) | Max concurrent connections. |
| `MAX_CONNECTIONS_PER_IP` | `0` (= 8) | Max concurrent connections from one remote IP. |
| `PRE_START_TIMEOUT_MS` | `0` (= 10000) | Drop a connection that authenticates but never sends `session.start`. |
| `LOG_TRANSCRIPTS` | `false` | Log ElevenLabs transcripts (still gated on Teams `recording.status == "active"`). |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error`. An invalid value falls back to `info`. |

:::note
Numeric variables **fail loud**: `MAX_CALL_MINUTES=abc` stops startup with a clear error rather than silently disabling the governor, and a non-numeric `PORT` stops with a clear message instead of an opaque listen error.
:::

:::caution
`BIND=0.0.0.0` exposes the bridge (and therefore the shared-secret-gated upgrade) on every interface. Bind to loopback and put a TLS-terminating reverse proxy in front, or restrict access at the network layer.
:::

The audio format is fixed at `pcm_16000` by design (the no-transcode contract) and is not configurable. The bridge validates the agent's declared format at call start and ends the call on a mismatch.
