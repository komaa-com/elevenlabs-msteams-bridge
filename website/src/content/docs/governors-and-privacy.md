---
title: "Governors and Privacy"
description: "The two call governors, the deterministic goodbye, the recording gate, and ElevenLabs retention guidance."
---

## Two governors

Both governors end a call gracefully - the caller hears a goodbye rather than a sudden drop.

### StandIn-side (tier limits)

When a StandIn tier limit is reached (a sandbox/free daily cap or a subscription max-minutes governor), StandIn sends an `assistant.say` with the goodbye text. The bridge speaks it and StandIn tears the call down. ElevenLabs is not involved in the timing.

### Bridge-side (`MAX_CALL_MINUTES`)

Because ElevenLabs knows nothing about your budget, the bridge can enforce its own hard cap. Set `MAX_CALL_MINUTES` (fractional allowed; `0` disables it). At call start the bridge arms a timer; on expiry it flushes playback, speaks `GOODBYE_TEXT`, and ends the call with reason `time-limit`.

## Deterministic goodbye

Set `EL_TTS_VOICE_ID` and the goodbye is synthesized as the **exact** `GOODBYE_TEXT` via standalone TTS - the agent is muted while it plays, and the real audio duration is used for the grace. Without it, the goodbye is delegated to the agent via a `user_message`, and `GOODBYE_GRACE_MS` covers the unknown duration.

:::note
The goodbye can never wedge a call open. The bridge arms a hard-bounded teardown deadline **before** waiting for the goodbye, and the goodbye-TTS fetch is itself time-bounded, so a slow or hung ElevenLabs endpoint still ends the call on time.
:::

## Recording gate

StandIn reports the Teams recording state (`recording.status`). The bridge honors it:

- Transcripts are never logged or persisted unless `LOG_TRANSCRIPTS=true` **and** recording is `active`.
- Vision **path 1** (uploading the raw frame to ElevenLabs) is refused unless recording is `active`.
- Video frames are buffered in memory only and dropped at teardown.

Vision **path 2** descriptions are ungated by design - see the trade-off in [Vision and Tools](/elevenlabs-msteams-bridge/vision-and-tools/).

## Data residency and retention

Caller audio, transcripts, and any vision descriptions transit ElevenLabs' cloud and are retained per the agent's settings. For deployments that must not retain caller data with a third party:

- Enable ElevenLabs **zero-retention** on the agent (or the account-level equivalent).
- Pin `EL_HOST` to the region that matches your residency requirement.
- Disclose that an AI is on the call - a spoken `EL_FIRST_MESSAGE` is the simplest way, and follows most tenants' call-recording/AI-disclosure policy.

This is the same "customer data leaves the tenant" conversation as any hosted agent; surface it to your stakeholders explicitly.
