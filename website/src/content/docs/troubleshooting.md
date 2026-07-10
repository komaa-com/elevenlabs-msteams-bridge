---
title: "Troubleshooting"
description: "The errors you will actually see on the upgrade, on the call, and at startup, and what each one means."
---

## `401` on the upgrade

The HMAC handshake failed. Causes:

- **Secret mismatch** - `WORKER_SHARED_SECRET` does not equal the value StandIn holds from pairing. They must match exactly.
- **Clock skew** - the timestamp is outside the freshness window (`HMAC_FRESHNESS_MS`, default 60 s). Sync the clocks (NTP).
- **Replayed handshake** - the same `(callId, ts, sig)` tuple was already used. This is the single-use guard doing its job; a genuine retry uses a fresh timestamp.
- **Secret unset** - the bridge fails closed if `WORKER_SHARED_SECRET` is empty; every upgrade is rejected.

## `409` Conflict

A live session already owns that call id (a retry or rollout reconnect). The bridge rejects the duplicate so it does not open a second billed ElevenLabs conversation for one call. It clears when the first session tears down.

## `503` Service Unavailable

A connection cap was hit: `MAX_CONNECTIONS` (default 64) or `MAX_CONNECTIONS_PER_IP` (default 8). Raise them for a busier deployment, or check for a client that is not closing sockets.

## Call connects, then `agent-unavailable`

The bridge could not open the ElevenLabs conversation. Check `ELEVENLABS_AGENT_ID`, that `ELEVENLABS_API_KEY` has access to that agent, and that the signed-URL mint succeeded (private agents). The bridge mints the signed URL per call and retries once on failure.

## No audio, or garbled audio, and the call ends

The agent's audio format is not `pcm_16000`. Set both the input and output format to **PCM 16000 Hz** in the agent's voice settings. The bridge validates this at call start and now **ends the call** on a mismatch rather than running a whole call with dead or garbled audio - so this shows up as an immediate teardown with a clear log line.

## Governor never fires

`MAX_CALL_MINUTES` must be a number. A non-numeric value stops startup with a clear error (numeric env vars fail loud), so if the process started, the value parsed. Confirm it is greater than `0` (`0` disables the governor).

## Startup error about `EL_HOST`

`EL_HOST` is restricted to `*.elevenlabs.io` so the API key can only be sent to ElevenLabs. Use one of the documented regional hosts, or set `EL_HOST_ALLOW_ANY=true` for a proxy you control.

## Port already in use

The CLI prints a friendly hint on `EADDRINUSE`. Set `PORT` to a free port.

## Where the logs are

The bridge logs one line per event to stdout/stderr, scoped by call id. Set `LOG_LEVEL=debug` for the verbose relay detail (an invalid value falls back to `info`). Transcript logging additionally requires `LOG_TRANSCRIPTS=true` and Teams recording to be active.
