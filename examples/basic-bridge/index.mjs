/**
 * basic-bridge example: embed @komaa/elevenlabs-msteams-bridge in your own project.
 *
 * What it shows:
 *   1. loadConfig()  - the same env variables as the CLI (see .env.example here)
 *   2. a custom VisionDescriber - your own model answers the agent's `look` tool
 *      (path 2: the raw frame never leaves this process, only your description does)
 *   3. startServer() - the HTTP + WebSocket server StandIn dials into
 *
 * Run:  npm install && cp .env.example .env  (fill it in)  && npm start
 *
 * With dummy env values the bridge starts and listens fine; a real Teams call
 * additionally needs a StandIn identity pointed at this server and a live
 * ElevenLabs agent (see README.md).
 */
import { loadConfig, startServer } from "@komaa/elevenlabs-msteams-bridge";

// 1. Env-driven config, identical to the CLI. Throws a clear error when a
//    required variable is missing or a numeric one is not a number.
const cfg = loadConfig();

// 2. OPTIONAL: answer the agent's `look` client tool with your own vision model.
//    Delete this block (and pass nothing as the third argument) to use the
//    built-in behavior instead: VISION_API_URL (an OpenAI-compatible endpoint)
//    when set, otherwise the recording-gated ElevenLabs multimodal upload.
/** @type {import("@komaa/elevenlabs-msteams-bridge").VisionDescriber} */
const describeFrame = async (frame, question) => {
  // frame: { source: "camera"|"screenshare", mime, dataBase64, width, height,
  //          participantName?, participantId?, ts }
  // Plug in any model you like here; this stub just proves the hook is wired.
  const kb = Math.round((frame.dataBase64.length * 3) / 4 / 1024);
  return (
    `Stub vision hook: got a ${frame.width}x${frame.height} ${frame.source} ` +
    `frame (~${kb} KB) from ${frame.participantName ?? "the caller"}. ` +
    `The question was: "${question}". Replace this with a real vision model.`
  );
};

// 3. Start the bridge. StandIn dials {your-url}/{callId} per call with an
//    HMAC-signed upgrade; one ElevenLabs Agent conversation is opened per call.
//    (second argument = custom agent transport, only useful in tests; keep undefined)
startServer(cfg, undefined, describeFrame);

console.log("basic-bridge example is up.");
console.log(`Point your StandIn identity's agent WebSocket URL at ws://<this-host>:${cfg.port}/voice/msteams/stream`);

// Graceful shutdown is built in: on SIGINT/SIGTERM the bridge ends every live
// call cleanly (session.end to StandIn + the ElevenLabs socket closed) before
// the process exits, so a Ctrl-C or a rolling deploy never hard-drops a call.
