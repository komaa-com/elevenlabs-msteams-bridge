---
title: "Library API"
description: "Embed the bridge in your own Node project: startServer, custom vision hooks, custom agent transports, HMAC helpers, and protocol types."
---

The package is both a CLI and an importable TypeScript library. Everything below is exported from the package root and fully typed.

```ts
import { loadConfig, startServer } from "@komaa/elevenlabs-msteams-bridge";
```

## Run the bridge in your own service

`loadConfig()` reads the same environment variables as the CLI and throws a clear error when a required variable is missing or a numeric one is not a number. `startServer(cfg)` returns the Node `http.Server`.

```ts
import { loadConfig, startServer } from "@komaa/elevenlabs-msteams-bridge";

const server = startServer(loadConfig());
server.on("listening", () => console.log("bridge up"));
```

`startServer` also installs a once-per-process SIGTERM/SIGINT handler that drains live calls, so a rolling deploy never hard-drops a call.

## Custom vision hook

The third argument to `startServer` is a `VisionDescriber` - your own answer to the agent's `look` tool. The raw frame never leaves your process; only the string you return is sent to the agent.

```ts
import { loadConfig, startServer, type VisionDescriber } from "@komaa/elevenlabs-msteams-bridge";

const describe: VisionDescriber = async (frame, question) => {
  // frame: { source: "camera" | "screenshare", mime, dataBase64, width, height, participantName?, ... }
  const bytes = Buffer.from(frame.dataBase64, "base64");
  return await myModel.describe(bytes, question); // becomes the `look` tool result
};

startServer(loadConfig(), undefined, describe);
```

Pass `null` as the third argument to disable path-2 vision entirely (the agent then falls back to the recording-gated ElevenLabs multimodal upload). Omit it to use the built-in `makeVisionDescriber(cfg)`, which is driven by `VISION_API_URL`.

## Custom agent transport (testing)

The second argument to `startServer` is an `ElConnector` - a factory that returns an `AgentPort`. The default opens a real ElevenLabs Agent socket; tests substitute a fake so no network is needed.

```ts
import { startServer, loadConfig, type ElConnector, type AgentPort } from "@komaa/elevenlabs-msteams-bridge";

const fakeConnector: ElConnector = async (_cfg, _log, handlers) => {
  const port: AgentPort = {
    conversationId: "conv_test",
    isOpen: true,
    sendAudioChunk() {},
    sendConversationInit() {},
    sendPong() {},
    sendContextualUpdate() {},
    sendUserMessage() {},
    sendClientToolResult() {},
    async attachImage() {},
    close() {},
  };
  // push server->bridge events at any time with handlers.onMessage(...)
  return port;
};

startServer(loadConfig(), fakeConnector, null);
```

## HMAC helpers

Useful if you build tools that talk to the bridge, or want to test the upgrade.

```ts
import { sign, verify, isFresh, TIMESTAMP_HEADER, SIGNATURE_HEADER } from "@komaa/elevenlabs-msteams-bridge";

const ts = Date.now();
const signature = sign(secret, ts, callId); // HMAC-SHA256(secret, `${ts}.${callId}`) hex
// send as headers X-OpenClawTeamsBridge-Timestamp / -Signature
verify(secret, ts, callId, signature); // constant-time, false on any missing input
isFresh(ts, 60_000);                    // within the freshness window?
```

## Protocol types

All wire message types are exported for building or validating messages: `SessionStartMessage`, `AudioFrameMessage`, `VideoFrameMessage`, `ParticipantsMessage`, `DtmfMessage`, `AssistantSayMessage`, `AssistantCancelMessage`, `ExpressionMessage`, `DisplayImageMessage`, the `WorkerInbound` / `WorkerOutbound` unions, plus `parseWorkerMessage()` and `pcm16kBytesToMs()`. See the [Wire Protocol](/elevenlabs-msteams-bridge/wire-protocol/) for the full contract.

## Also exported

- `authorizeUpgrade`, `callIdFromUrl` - the upgrade-authorization primitives.
- `CallSession` - the per-call relay class (advanced embedding).
- `assertPublicHttpUrl`, `isForbiddenIp`, `readBodyWithCap` - the SSRF-guard primitives.
- `ElAgentSocket`, `getSignedUrl`, `synthesizeGoodbye`, `buildConversationInit`, `uploadConversationFile` - the ElevenLabs-side helpers.
- `logger` - the minimal leveled logger.
