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
import OpenAI from "openai";

// 1. Env-driven config, identical to the CLI. Throws a clear error when a
//    required variable is missing or a numeric one is not a number.
const cfg = loadConfig();

// 2. OPTIONAL: answer the agent's `look` client tool with your own vision model.
//    Delete this block (and pass nothing as the third argument) to use the
//    built-in behavior instead: VISION_API_URL (an OpenAI-compatible endpoint)
//    when set, otherwise the recording-gated ElevenLabs multimodal upload.
//
//    This uses OpenAI's vision model when OPENAI_API_KEY is set, so the example
//    still boots (and the bridge still runs) without a key. For Azure OpenAI,
//    swap `new OpenAI()` for `new AzureOpenAI({ endpoint, apiKey, apiVersion,
//    deployment })` and keep the same call (see README.md).
const openai = process.env.OPENAI_API_KEY ? new OpenAI() : null;

/** @type {import("@komaa/elevenlabs-msteams-bridge").VisionDescriber} */
const describeFrame = async (frame, question) => {
  // frame: { source: "camera"|"screenshare", mime, dataBase64, width, height,
  //          participantName?, participantId?, ts }
  const who = frame.source === "screenshare" ? "the caller's shared screen" : "the caller's camera";
  if (!openai) {
    return `(No OPENAI_API_KEY set, so vision is stubbed.) The agent asked "${question}" about ${who}.`;
  }
  const res = await openai.chat.completions.create({
    model: process.env.OPENAI_VISION_MODEL || "gpt-4o", // any vision-capable model
    max_tokens: 300,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: `This is ${who}. ${question}` },
          {
            type: "image_url",
            image_url: { url: `data:${frame.mime};base64,${frame.dataBase64}`, detail: "low" },
          },
        ],
      },
    ],
  });
  return res.choices[0]?.message?.content ?? "I could not make out the image.";
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
