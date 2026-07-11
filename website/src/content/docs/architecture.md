---
title: "Architecture"
description: "How a call flows through the bridge, the no-transcode audio property, the source-module map, and the trust and security model."
---

The bridge is a small, stateless-per-call relay. It holds two WebSockets per call - the StandIn media bridge on one side, an ElevenLabs Agent conversation on the other - and mostly copies bytes between them.

## System overview

```mermaid
flowchart LR
    Teams["Microsoft Teams<br/>voice/video call"]
    StandIn["StandIn media bridge<br/>(hosted)<br/>joins the call, speaks<br/>the wire protocol"]
    Bridge["this bridge (Node/TS)<br/>verifies HMAC, terminates<br/>the wire protocol,<br/>one WS per call"]
    EL["ElevenLabs Agent<br/>STT + LLM + TTS + VAD<br/>one conversation per call"]

    Teams <--> StandIn
    StandIn -- "HMAC WebSocket" --> Bridge
    Bridge -- "Agent WebSocket" --> EL
    Bridge -. "relay audio verbatim,<br/>map barge-in, inject<br/>context, run governors" .-> EL
```

The StandIn media bridge handles everything about Teams itself and exposes each call as a single WebSocket carrying `audio.frame` (PCM 16 kHz), `video.frame` (JPEG) and control messages. This bridge has no idea what is on the other end of the Teams call - it only speaks the wire protocol.

## The no-transcode property

Both sides speak base64 **PCM 16 kHz, 16-bit, mono**. The Teams side sends `audio.frame` payloads and ElevenLabs' `user_audio_chunk` / `audio_event` are the same `pcm_16000`, so the hot path is **copy-only**: no resampling, no re-encoding, nothing added to the latency budget beyond one relay hop. This is a hard contract - the bridge validates the agent's declared input/output format at call start and, on a mismatch, closes the agent socket and ends the call rather than run a whole call with garbled audio.

## Call lifecycle

```mermaid
flowchart TD
    A["upgrade + HMAC verify<br/>401 on bad / replayed / stale signature<br/>409 if callId already live"]
    B["session.start<br/>callId cross-checked vs the URL<br/>10s pre-start timeout if it never arrives"]
    C["connect ElevenLabs<br/>signed URL minted per call<br/>caller audio buffered ~5s while connecting"]
    D["relay<br/>audio.frame &lt;-&gt; user_audio_chunk / audio_event<br/>interruption -&gt; assistant.cancel + ghost-drop<br/>participants / dtmf -&gt; contextual_update<br/>look / show_image / express / end_call"]
    E["teardown<br/>worker close, agent close, session.end,<br/>governor, or SIGTERM<br/>closes BOTH sockets once, clears timers,<br/>de-registers the call"]

    A --> B --> C --> D --> E
```

Barge-in is handled by dropping any ElevenLabs `audio` event whose `event_id` is at or below the interrupted one, so stale agent audio never plays after the caller cuts in ("ghost drop").

## Source module map

| Module | Responsibility |
|---|---|
| `src/server.ts` | HTTP server + WS upgrade, HMAC validation, connection guards (caps, replay, pre-start, dup-callId 409), session registry, SIGTERM/SIGINT drain |
| `src/session.ts` | One call: the StandIn WS ⇄ ElevenLabs WS relay, ghost-drop, governors, goodbye, client tools, speaker attribution, vision buffering |
| `src/elevenlabs.ts` | ElevenLabs Agent socket, per-call signed-URL mint, standalone TTS for the goodbye, conversation-init builder, path-1 file upload |
| `src/protocol.ts` | Wire message types (JSON, camelCase, discriminated on `type`) + PCM duration helper |
| `src/hmac.ts` | `HMAC-SHA256("{timestampMs}.{callId}")` sign/verify (constant-time), header names, freshness |
| `src/ssrf.ts` | Public-URL guard for the agent-supplied `show_image` fetch |
| `src/vision.ts` | Path-2 describe-then-answer vision hook (OpenAI-compatible endpoint) |
| `src/config.ts` | Env config, fail-loud numeric parsing, `EL_HOST` allowlist |
| `src/cli.ts` | CLI entry point + friendly startup errors |
| `src/log.ts` | Minimal leveled logger |

## Trust and security model

| Layer | Protection |
|---|---|
| Upgrade auth | `HMAC-SHA256("{timestampMs}.{callId}")`, constant-time compare, fails closed when the secret is unset |
| Replay | Single-use `(callId, ts, sig)` guard within a 60 s freshness window |
| Duplicate call | A second live connection for the same `callId` is rejected (`409`) - no second billed conversation |
| DoS | Max connections (64), per-IP cap (8), 2 MB inbound frame cap, 1 MB outbound backpressure cap, 10 s pre-start timeout |
| Key hygiene | `ELEVENLABS_API_KEY` is server-side only, never sent to the Teams side; `EL_HOST` is pinned to `*.elevenlabs.io` so the key cannot be exfiltrated to another host |
| SSRF | The agent-supplied `show_image` URL is resolved to public hosts only, no redirects, bounded time and size |
| Crash safety | Every async entry point is guarded so a single socket-send throw cannot take the process down |
| Shutdown | SIGTERM/SIGINT drains live calls (`session.end` + close) instead of hard-dropping them |
