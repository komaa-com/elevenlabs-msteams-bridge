---
title: "Wire Protocol"
description: "The exact contract on both sockets: the HMAC upgrade, connection guards, and every message the bridge relays."
---

The bridge terminates two protocols: the StandIn media bridge's worker protocol on one side, and the ElevenLabs Agent WebSocket on the other. This page documents both.

## The upgrade (StandIn side)

The StandIn media bridge opens one WebSocket per call to `{path}/{callId}` - the **call id is the last path segment** of the URL. The upgrade carries two headers:

| Header | Value |
|---|---|
| `X-OpenClawTeamsBridge-Timestamp` | Unix epoch milliseconds |
| `X-OpenClawTeamsBridge-Signature` | `HMAC-SHA256(secret, "{timestampMs}.{callId}")`, lowercase hex |

Verification (`401` on failure): the timestamp must be within the freshness window (`HMAC_FRESHNESS_MS`, default 60 s), the signature must match (constant-time compare), and the `(callId, ts, sig)` tuple must be **single-use** (a captured handshake cannot be replayed within the window). The bridge fails closed if the shared secret is unset. The call id is also cross-checked against the `session.start` body.

## Connection guards

| Guard | Value |
|---|---|
| Max concurrent connections | 64 (`MAX_CONNECTIONS`) |
| Per-IP cap | 8 (`MAX_CONNECTIONS_PER_IP`) |
| Max inbound frame | 2 MB |
| Outbound backpressure cap | 1 MB (drops realtime frames above it) |
| Pre-start timeout | 10 s (`PRE_START_TIMEOUT_MS`) - drops a socket that never sends `session.start` |
| Duplicate call id | rejected with `409` - no second billed conversation for one call |

Audio on both sides is base64 **PCM 16 kHz, 16-bit, mono**.

## Worker to bridge

| Message | Fields | Bridge action |
|---|---|---|
| `session.start` | `callId`, `threadId`, `caller{aadId?, displayName?, tenantId?}`, `recordingStatus?`, `direction?` | Open the ElevenLabs conversation; send `conversation_initiation_client_data` with caller name/tenant/direction. All caller fields are nullable and are defaulted, never sent as null. |
| `audio.frame` | `seq`, `timestampMs`, `payloadBase64`, `speakerName?` | Forward payload verbatim as `user_audio_chunk`. In group calls, a changed `speakerName` becomes a rate-limited contextual update. |
| `video.frame` | `source` (`camera`/`screenshare`), `ts`, `width`, `height`, `mime`, `dataBase64`, `participantId?`, `participantName?` | Buffer the latest frame per source, in memory, for the on-demand `look` tool. Unknown sources are ignored. |
| `participants` | `count` | `contextual_update` ("N humans on the call, stay quiet unless addressed"). |
| `dtmf` | `digit` | `contextual_update` ("the caller pressed {digit}"). |
| `ping` | `ts` | Reply `pong` with the same `ts`. |
| `recording.status` | `status` | Gate what may be persisted (transcripts, path-1 uploads). |
| `assistant.say` | `text` | Governor goodbye: speak it, then StandIn tears the call down. |
| `session.end` | `reason` | Close the ElevenLabs socket, tear down. |

## Bridge to worker

| Message | Fields | Meaning |
|---|---|---|
| `audio.frame` | `seq`, `timestampMs`, `payloadBase64` | Agent audio for the Teams side. |
| `assistant.cancel` | `turnId` | Barge-in: flush queued playback on the Teams side. |
| `expression` | `emotion` | Avatar emotion cue (from the agent's `express` tool). |
| `display.image` | `dataBase64`, `mime`, `mode?`, `caption?`, ... | Show an image on the bot's video tile (from `show_image`). |
| `pong` | `ts` | Reply to a worker `ping`. |
| `session.end` | `reason` | Ask StandIn to tear the call down (governor, agent `end_call`, or fatal error). |

## ElevenLabs side (mapping)

| ElevenLabs message | Direction | Bridge behavior |
|---|---|---|
| `conversation_initiation_client_data` | bridge → EL | Sent once at call start: `dynamic_variables`, optional `first_message`/prompt/voice overrides, `user_id`, `branch_id`, `environment`. |
| `conversation_initiation_metadata` | EL → bridge | Captures `conversation_id`; validates `agent_output_audio_format` / `user_input_audio_format` are `pcm_16000` (else the call ends). |
| `user_audio_chunk` | bridge → EL | Caller audio, verbatim. |
| `audio` (`audio_event.audio_base_64`, `event_id`) | EL → bridge | Agent audio → `audio.frame`. Dropped if `event_id` is at or below the last interruption (ghost drop). |
| `interruption` (`event_id`) | EL → bridge | Emit `assistant.cancel` and set the ghost-drop floor to that `event_id`. |
| `ping` (`event_id`) | EL → bridge | Reply `pong` with the `event_id` (keeps the socket alive). |
| `contextual_update` | bridge → EL | Non-interrupting context (participants, dtmf, speaker). |
| `user_message` | bridge → EL | The goodbye fallback when no deterministic TTS voice is set. |
| `client_tool_call` / `client_tool_result` | both | Agent tools: `look`, `show_image`, `express`, `end_call`. See [Vision and Tools](/elevenlabs-msteams-bridge/vision-and-tools/). |

The signed URL for a private agent is minted **per call** at `session.start` (never cached at boot) and refreshed on failure.
