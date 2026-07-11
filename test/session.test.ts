import { test, after } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import type { AddressInfo } from "node:net";
import { startServer } from "../src/server.js";
import { sign } from "../src/hmac.js";
import type { BridgeConfig } from "../src/config.js";
import type { AgentPort, ElInbound, ElSessionHandlers } from "../src/elevenlabs.js";

const cfg: BridgeConfig = {
  port: 0,
  host: "127.0.0.1",
  workerSharedSecret: "test-secret",
  elevenLabsApiKey: "unused-in-tests",
  elevenLabsAgentId: "agent_test",
  elHost: "api.elevenlabs.io",
  elEnvironment: null,
  elTtsVoiceId: null, // goodbye falls back to user_message
  elTtsModelId: "eleven_turbo_v2_5",
  elFirstMessage: null,
  elAgentBranchId: null,
  maxCallMinutes: 0,
  goodbyeText: "Time limit reached, goodbye!",
  goodbyeGraceMs: 8000,
  visionApiUrl: null,
  visionApiKey: null,
  visionModel: null,
  hmacFreshnessMs: 60_000,
  maxConnections: 0,
  maxConnectionsPerIp: 0,
  preStartTimeoutMs: 0,
  trustProxy: false,
  tlsCertPath: null,
  tlsKeyPath: null,
  logTranscripts: false,
};

/** Fake ElevenLabs agent: records what the bridge sends, lets tests push events back. */
class FakeAgent implements AgentPort {
  conversationId = "conv_fake";
  isOpen = true;
  sent: Array<Record<string, unknown>> = [];
  closed = false;
  handlers!: ElSessionHandlers;

  sendAudioChunk(b64: string): void {
    this.sent.push({ user_audio_chunk: b64 });
  }
  sendConversationInit(init: Record<string, unknown>): void {
    this.sent.push(init);
  }
  sendPong(eventId: number): void {
    this.sent.push({ type: "pong", event_id: eventId });
  }
  sendContextualUpdate(text: string): void {
    this.sent.push({ type: "contextual_update", text });
  }
  sendUserMessage(text: string): void {
    this.sent.push({ type: "user_message", text });
  }
  sendClientToolResult(toolCallId: string, result: string, isError: boolean): void {
    this.sent.push({ type: "client_tool_result", tool_call_id: toolCallId, result, is_error: isError });
  }
  attached: Array<{ mime: string; question: string; bytes: number }> = [];
  async attachImage(bytes: Buffer, mime: string, question: string): Promise<void> {
    this.attached.push({ mime, question, bytes: bytes.length });
  }
  close(): void {
    this.closed = true;
  }
  emit(msg: ElInbound): void {
    this.handlers.onMessage(msg);
  }
}

const fakeAgent = new FakeAgent();
const connectEl = async (_cfg: BridgeConfig, _log: unknown, handlers: ElSessionHandlers): Promise<AgentPort> => {
  fakeAgent.handlers = handlers;
  return fakeAgent;
};

// server A: no vision endpoint (look routes to gated path 1)
const server = startServer(cfg, connectEl, null);
await new Promise<void>((r) => server.once("listening", () => r()));
const port = (server.address() as AddressInfo).port;
after(() => server.close());

// server B: vision path 2 via a fake describer
const fakeAgentB = new FakeAgent();
const connectElB = async (_cfg: BridgeConfig, _log: unknown, handlers: ElSessionHandlers): Promise<AgentPort> => {
  fakeAgentB.handlers = handlers;
  return fakeAgentB;
};
const serverB = startServer({ ...cfg }, connectElB, async (frame, question) => `I see a ${frame.source} frame. Q was: ${question}`);
await new Promise<void>((r) => serverB.once("listening", () => r()));
const portB = (serverB.address() as AddressInfo).port;
after(() => serverB.close());

const CALL_ID = "call-e2e-1";

function workerUrl(callId: string, opts?: { badSig?: boolean; staleTs?: boolean }): { url: string; headers: Record<string, string> } {
  const ts = opts?.staleTs ? Date.now() - 3_600_000 : Date.now();
  const sig = opts?.badSig ? "0".repeat(64) : sign(cfg.workerSharedSecret, ts, callId);
  return {
    url: `ws://127.0.0.1:${port}/voice/msteams/stream/${callId}`,
    headers: { "X-OpenClawTeamsBridge-Timestamp": String(ts), "X-OpenClawTeamsBridge-Signature": sig },
  };
}

function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    ws.once("message", (d) => resolve(JSON.parse(d.toString())));
    ws.once("error", reject);
    ws.once("close", () => reject(new Error("socket closed while waiting for message")));
  });
}

function until<T>(fn: () => T | undefined, timeoutMs = 2000): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const v = fn();
      if (v !== undefined) return resolve(v);
      if (Date.now() - start > timeoutMs) return reject(new Error("until() timed out"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

test("rejects a bad signature with 401", async () => {
  const { url, headers } = workerUrl("call-unauth", { badSig: true });
  const ws = new WebSocket(url, { headers });
  const err = await new Promise<Error>((r) => ws.once("error", r));
  assert.match(err.message, /401/);
});

test("rejects a stale timestamp", async () => {
  const { url, headers } = workerUrl("call-stale", { staleTs: true });
  const ws = new WebSocket(url, { headers });
  const err = await new Promise<Error>((r) => ws.once("error", r));
  assert.match(err.message, /401/);
});

test("full relay: init, audio both ways, barge-in ghosts, ping/pong, context, goodbye", async () => {
  const { url, headers } = workerUrl(CALL_ID);
  const ws = new WebSocket(url, { headers });
  await new Promise<void>((r) => ws.once("open", () => r()));

  // session.start → bridge opens (fake) EL and sends conversation init with defaulted nullables
  ws.send(JSON.stringify({
    type: "session.start",
    callId: CALL_ID,
    threadId: "19:thread",
    caller: { aadId: null, displayName: "Alaa", tenantId: null },
    direction: "inbound",
  }));
  const init = await until(() => fakeAgent.sent.find((m) => m.type === "conversation_initiation_client_data"));
  const dyn = init.dynamic_variables as Record<string, string>;
  assert.equal(dyn.caller_name, "Alaa");
  assert.equal(dyn.tenant_id, "unknown-tenant"); // nullable → defaulted, never null
  assert.equal("user_id" in init, false, "no aadId → user_id must be OMITTED, not defaulted (no cross-caller memory bleed)");

  // caller audio → EL verbatim
  ws.send(JSON.stringify({ type: "audio.frame", seq: 1, timestampMs: 20, payloadBase64: "UENNMTZL" }));
  await until(() => fakeAgent.sent.find((m) => m.user_audio_chunk === "UENNMTZL"));

  // EL audio → worker audio.frame with seq/timestamp bookkeeping (640 bytes = 20ms)
  const pcm640 = Buffer.alloc(640).toString("base64");
  const audioP = nextMessage(ws);
  fakeAgent.emit({ type: "audio", audio_event: { audio_base_64: pcm640, event_id: 1 } });
  const frame1 = await audioP;
  assert.equal(frame1.type, "audio.frame");
  assert.equal(frame1.seq, 0);
  assert.equal(frame1.timestampMs, 0);

  const audio2P = nextMessage(ws);
  fakeAgent.emit({ type: "audio", audio_event: { audio_base_64: pcm640, event_id: 2 } });
  const frame2 = await audio2P;
  assert.equal(frame2.seq, 1);
  assert.equal(frame2.timestampMs, 20); // advanced by the first frame's real duration

  // interruption → assistant.cancel with turnId = event_id; stale audio (event_id ≤ 5) is dropped
  const cancelP = nextMessage(ws);
  fakeAgent.emit({ type: "interruption", interruption_event: { event_id: 5 } });
  const cancel = await cancelP;
  assert.equal(cancel.type, "assistant.cancel");
  assert.equal(cancel.turnId, 5);

  const afterCancelP = nextMessage(ws);
  fakeAgent.emit({ type: "audio", audio_event: { audio_base_64: pcm640, event_id: 4 } }); // ghost — dropped
  fakeAgent.emit({ type: "audio", audio_event: { audio_base_64: pcm640, event_id: 6 } }); // fresh — relayed
  const frame3 = await afterCancelP;
  assert.equal(frame3.seq, 2, "ghost audio must be dropped, fresh audio relayed");

  // worker ping → pong echoing ts
  const pongP = nextMessage(ws);
  ws.send(JSON.stringify({ type: "ping", ts: 12345 }));
  assert.deepEqual(await pongP, { type: "pong", ts: 12345 });

  // EL ping → EL pong with event_id
  fakeAgent.emit({ type: "ping", ping_event: { event_id: 77 } });
  await until(() => fakeAgent.sent.find((m) => m.type === "pong" && m.event_id === 77));

  // participants + dtmf → contextual updates
  ws.send(JSON.stringify({ type: "participants", count: 3 }));
  await until(() => fakeAgent.sent.find((m) => m.type === "contextual_update" && String(m.text).includes("3 human participants")));
  ws.send(JSON.stringify({ type: "dtmf", digit: "7" }));
  await until(() => fakeAgent.sent.find((m) => m.type === "contextual_update" && String(m.text).includes('"7"')));

  // client tool: express → expression to worker + tool result to agent
  const exprP = nextMessage(ws);
  fakeAgent.emit({ type: "client_tool_call", client_tool_call: { tool_name: "express", tool_call_id: "t1", parameters: { emotion: "happy" } } });
  const expr = await exprP;
  assert.deepEqual(expr, { type: "expression", emotion: "happy" });
  await until(() => fakeAgent.sent.find((m) => m.type === "client_tool_result" && m.tool_call_id === "t1" && m.is_error === false));

  // client tool: show_image (inline base64) → display.image to worker
  const imgP = nextMessage(ws);
  fakeAgent.emit({
    type: "client_tool_call",
    client_tool_call: { tool_name: "show_image", tool_call_id: "t2", parameters: { dataBase64: "aW1n", mime: "image/png", caption: "chart" } },
  });
  const img = await imgP;
  assert.equal(img.type, "display.image");
  assert.equal(img.mime, "image/png");
  assert.equal(img.caption, "chart");
  await until(() => fakeAgent.sent.find((m) => m.type === "client_tool_result" && m.tool_call_id === "t2" && m.is_error === false));

  // client tool: unknown → tool error, call keeps running
  fakeAgent.emit({ type: "client_tool_call", client_tool_call: { tool_name: "teleport", tool_call_id: "t3" } });
  await until(() => fakeAgent.sent.find((m) => m.type === "client_tool_result" && m.tool_call_id === "t3" && m.is_error === true));

  // SSRF: show_image with a metadata/loopback URL → tool error, nothing displayed
  fakeAgent.emit({
    type: "client_tool_call",
    client_tool_call: { tool_name: "show_image", tool_call_id: "t4", parameters: { url: "http://169.254.169.254/latest/meta-data/" } },
  });
  const ssrfResult = await until(() => fakeAgent.sent.find((m) => m.tool_call_id === "t4"));
  assert.equal(ssrfResult.is_error, true);
  assert.match(String(ssrfResult.result), /private/);
  fakeAgent.emit({
    type: "client_tool_call",
    client_tool_call: { tool_name: "show_image", tool_call_id: "t5", parameters: { url: "http://127.0.0.1:8080/secret.png" } },
  });
  await until(() => fakeAgent.sent.find((m) => m.tool_call_id === "t5" && m.is_error === true));

  // malformed EL frames (missing nested events) are dropped without killing the call
  fakeAgent.emit({ type: "audio" } as never);
  fakeAgent.emit({ type: "interruption" } as never);
  fakeAgent.emit({ type: "ping" } as never);
  fakeAgent.emit({ type: "client_tool_call" } as never);
  const alivePongP = nextMessage(ws);
  ws.send(JSON.stringify({ type: "ping", ts: 999 }));
  assert.deepEqual(await alivePongP, { type: "pong", ts: 999 }, "call must survive malformed EL frames");

  // look with no video shared → tool error
  fakeAgent.emit({ type: "client_tool_call", client_tool_call: { tool_name: "look", tool_call_id: "v1", parameters: {} } });
  await until(() => fakeAgent.sent.find((m) => m.tool_call_id === "v1" && m.is_error === true && String(m.result).includes("no video")));

  // buffer a screenshare frame, recording NOT active → path 1 is gated (no vision endpoint on server A)
  ws.send(JSON.stringify({
    type: "video.frame", source: "screenshare", ts: 1, width: 640, height: 360,
    mime: "image/jpeg", dataBase64: Buffer.from("jpegbytes").toString("base64"), participantName: "Sara",
  }));
  await new Promise((r) => setTimeout(r, 30)); // let the frame land in the buffer
  fakeAgent.emit({ type: "client_tool_call", client_tool_call: { tool_name: "look", tool_call_id: "v2", parameters: { question: "what is on screen?" } } });
  await until(() => fakeAgent.sent.find((m) => m.tool_call_id === "v2" && m.is_error === true && String(m.result).includes("recording")));
  assert.equal(fakeAgent.attached.length, 0, "frame must NOT be uploaded before recording is active");

  // recording active → path 1: frame uploaded + multimodal turn, success tool result
  ws.send(JSON.stringify({ type: "recording.status", status: "active" }));
  await new Promise((r) => setTimeout(r, 30));
  fakeAgent.emit({ type: "client_tool_call", client_tool_call: { tool_name: "look", tool_call_id: "v3", parameters: { question: "what is on screen?" } } });
  await until(() => fakeAgent.sent.find((m) => m.tool_call_id === "v3" && m.is_error === false));
  assert.equal(fakeAgent.attached.length, 1);
  assert.equal(fakeAgent.attached[0].mime, "image/jpeg");
  assert.match(fakeAgent.attached[0].question, /Sara/);

  // governor goodbye without a TTS voice → user_message fallback
  ws.send(JSON.stringify({ type: "assistant.say", text: "Goodbye, thanks for calling." }));
  await until(() => fakeAgent.sent.find((m) => m.type === "user_message" && String(m.text).includes("Goodbye")));

  // session.end → both sides torn down
  ws.send(JSON.stringify({ type: "session.end", reason: "call-ended" }));
  await until(() => (fakeAgent.closed ? true : undefined));
  await until(() => (ws.readyState === WebSocket.CLOSED ? true : undefined));
});

test("bridge-side governor: time limit → goodbye → session.end to worker", async () => {
  const fakeAgentC = new FakeAgent();
  const connectElC = async (_c: BridgeConfig, _l: unknown, handlers: ElSessionHandlers): Promise<AgentPort> => {
    fakeAgentC.handlers = handlers;
    return fakeAgentC;
  };
  // 0.002 min = 120ms limit; grace 40ms since the user_message fallback has unknown duration
  const serverC = startServer({ ...cfg, maxCallMinutes: 0.002, goodbyeGraceMs: 40 }, connectElC, null);
  await new Promise<void>((r) => serverC.once("listening", () => r()));
  const portC = (serverC.address() as AddressInfo).port;

  const callId = "call-governor-1";
  const ts = Date.now();
  const ws = new WebSocket(`ws://127.0.0.1:${portC}/voice/msteams/stream/${callId}`, {
    headers: { "X-OpenClawTeamsBridge-Timestamp": String(ts), "X-OpenClawTeamsBridge-Signature": sign(cfg.workerSharedSecret, ts, callId) },
  });
  await new Promise<void>((r) => ws.once("open", () => r()));
  const received: Array<Record<string, unknown>> = [];
  ws.on("message", (d) => received.push(JSON.parse(d.toString())));

  ws.send(JSON.stringify({ type: "session.start", callId, threadId: "t", caller: {} }));

  // goodbye fallback fires at the limit, then session.end after the grace
  await until(() => fakeAgentC.sent.find((m) => m.type === "user_message" && String(m.text).includes("Time limit reached")));
  // F1 regression: the agent's spoken goodbye (user_message fallback) must still
  // relay — a blanket mute here would hang up in silence
  fakeAgentC.emit({ type: "audio", audio_event: { audio_base_64: Buffer.alloc(640).toString("base64"), event_id: 1 } });
  await until(() => received.find((m) => m.type === "audio.frame"));
  const end = await until(() => received.find((m) => m.type === "session.end"));
  assert.equal(end.reason, "time-limit");
  // playback must be flushed BEFORE the goodbye so buffered agent audio can't delay it
  const cancelIdx = received.findIndex((m) => m.type === "assistant.cancel");
  const endIdx = received.findIndex((m) => m.type === "session.end");
  assert.ok(cancelIdx >= 0 && cancelIdx < endIdx, "assistant.cancel must precede session.end");
  await until(() => (fakeAgentC.closed ? true : undefined));
  await until(() => (ws.readyState === WebSocket.CLOSED ? true : undefined));
  serverC.close();
});

test("EL socket close mid-call → session.end(agent-disconnected) to worker; user_id sent when aadId known", async () => {
  const callId = "call-elclose-1";
  const ts = Date.now();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/voice/msteams/stream/${callId}`, {
    headers: { "X-OpenClawTeamsBridge-Timestamp": String(ts), "X-OpenClawTeamsBridge-Signature": sign(cfg.workerSharedSecret, ts, callId) },
  });
  await new Promise<void>((r) => ws.once("open", () => r()));
  const received: Array<Record<string, unknown>> = [];
  ws.on("message", (d) => received.push(JSON.parse(d.toString())));

  const sentBefore = fakeAgent.sent.length;
  ws.send(JSON.stringify({ type: "session.start", callId, threadId: "t", caller: { aadId: "aad-123", displayName: "Alaa" } }));
  const init = await until(() => fakeAgent.sent.slice(sentBefore).find((m) => m.type === "conversation_initiation_client_data"));
  assert.equal(init.user_id, "aad-123");

  fakeAgent.handlers.onClose(1006, "gone");
  const end = await until(() => received.find((m) => m.type === "session.end"));
  assert.equal(end.reason, "agent-disconnected");
  await until(() => (ws.readyState === WebSocket.CLOSED ? true : undefined));
});

test("deterministic goodbye: assistant.say with EL_TTS_VOICE_ID → exact TTS audio to worker", async () => {
  const fakeAgentD = new FakeAgent();
  const connectElD = async (_c: BridgeConfig, _l: unknown, handlers: ElSessionHandlers): Promise<AgentPort> => {
    fakeAgentD.handlers = handlers;
    return fakeAgentD;
  };
  const serverD = startServer({ ...cfg, elTtsVoiceId: "voice_x" }, connectElD, null);
  await new Promise<void>((r) => serverD.once("listening", () => r()));
  const portD = (serverD.address() as AddressInfo).port;

  // stub the standalone-TTS REST call: 640 bytes of PCM = 20ms
  const pcm = Buffer.alloc(640, 7);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const u = String(input);
    if (u.includes("/v1/text-to-speech/voice_x")) {
      return new Response(new Uint8Array(pcm), { status: 200 });
    }
    throw new Error(`unexpected fetch in test: ${u}`);
  }) as typeof fetch;

  try {
    const callId = "call-tts-1";
    const ts = Date.now();
    const ws = new WebSocket(`ws://127.0.0.1:${portD}/voice/msteams/stream/${callId}`, {
      headers: { "X-OpenClawTeamsBridge-Timestamp": String(ts), "X-OpenClawTeamsBridge-Signature": sign(cfg.workerSharedSecret, ts, callId) },
    });
    await new Promise<void>((r) => ws.once("open", () => r()));
    const received: Array<Record<string, unknown>> = [];
    ws.on("message", (d) => received.push(JSON.parse(d.toString())));
    ws.send(JSON.stringify({ type: "session.start", callId, threadId: "t", caller: {} }));
    await until(() => fakeAgentD.sent.find((m) => m.type === "conversation_initiation_client_data"));

    ws.send(JSON.stringify({ type: "assistant.say", text: "Goodbye now." }));
    const frame = await until(() => received.find((m) => m.type === "audio.frame"));
    assert.equal(frame.payloadBase64, pcm.toString("base64"), "exact synthesized PCM must reach the worker");
    assert.equal(fakeAgentD.sent.some((m) => m.type === "user_message"), false, "no agent fallback when TTS succeeds");
    // playback flushed before the goodbye, and the agent is muted while it plays
    assert.ok(received.some((m) => m.type === "assistant.cancel"), "goodbye must flush playback first");
    const framesBefore = received.filter((m) => m.type === "audio.frame").length;
    fakeAgentD.emit({ type: "audio", audio_event: { audio_base_64: pcm.toString("base64"), event_id: 99 } });
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(received.filter((m) => m.type === "audio.frame").length, framesBefore, "agent audio is muted during deterministic goodbye");
    ws.close();
  } finally {
    globalThis.fetch = realFetch;
    serverD.close();
  }
});

test("caller audio during EL connect is buffered and flushed after init; duplicate session.start ignored", async () => {
  const fakeAgentE = new FakeAgent();
  const connectElE = async (_c: BridgeConfig, _l: unknown, handlers: ElSessionHandlers): Promise<AgentPort> => {
    await new Promise((r) => setTimeout(r, 80)); // simulate signed-URL mint + WS open latency
    fakeAgentE.handlers = handlers;
    return fakeAgentE;
  };
  const serverE = startServer(cfg, connectElE, null);
  await new Promise<void>((r) => serverE.once("listening", () => r()));
  const portE = (serverE.address() as AddressInfo).port;

  const callId = "call-buffer-1";
  const ts = Date.now();
  const ws = new WebSocket(`ws://127.0.0.1:${portE}/voice/msteams/stream/${callId}`, {
    headers: { "X-OpenClawTeamsBridge-Timestamp": String(ts), "X-OpenClawTeamsBridge-Signature": sign(cfg.workerSharedSecret, ts, callId) },
  });
  await new Promise<void>((r) => ws.once("open", () => r()));

  // caller starts talking immediately after session.start, before the EL socket is open
  ws.send(JSON.stringify({ type: "session.start", callId, threadId: "t", caller: {} }));
  ws.send(JSON.stringify({ type: "audio.frame", seq: 1, timestampMs: 0, payloadBase64: "Zmlyc3Q=" }));
  ws.send(JSON.stringify({ type: "audio.frame", seq: 2, timestampMs: 20, payloadBase64: "c2Vjb25k" }));
  ws.send(JSON.stringify({ type: "session.start", callId, threadId: "t", caller: {} })); // duplicate — must be ignored

  await until(() => (fakeAgentE.sent.filter((m) => m.user_audio_chunk).length >= 2 ? true : undefined));
  const chunks = fakeAgentE.sent.filter((m) => m.user_audio_chunk).map((m) => m.user_audio_chunk);
  assert.deepEqual(chunks, ["Zmlyc3Q=", "c2Vjb25k"], "buffered frames flush in order");
  const initIdx = fakeAgentE.sent.findIndex((m) => m.type === "conversation_initiation_client_data");
  const firstChunkIdx = fakeAgentE.sent.findIndex((m) => m.user_audio_chunk);
  assert.ok(initIdx >= 0 && initIdx < firstChunkIdx, "conversation init must precede flushed audio");
  assert.equal(
    fakeAgentE.sent.filter((m) => m.type === "conversation_initiation_client_data").length, 1,
    "duplicate session.start must not open a second EL session",
  );
  ws.close();
  serverE.close();
});

test("look uses vision path 2 (describe) when a vision endpoint is configured — no upload, no gate", async () => {
  const callId = "call-vision-1";
  const ts = Date.now();
  const ws = new WebSocket(`ws://127.0.0.1:${portB}/voice/msteams/stream/${callId}`, {
    headers: { "X-OpenClawTeamsBridge-Timestamp": String(ts), "X-OpenClawTeamsBridge-Signature": sign(cfg.workerSharedSecret, ts, callId) },
  });
  await new Promise<void>((r) => ws.once("open", () => r()));
  ws.send(JSON.stringify({ type: "session.start", callId, threadId: "t", caller: {} }));
  await until(() => fakeAgentB.sent.find((m) => m.type === "conversation_initiation_client_data"));

  // recording NOT active — path 2 is transient processing, allowed
  ws.send(JSON.stringify({
    type: "video.frame", source: "camera", ts: 1, width: 640, height: 360,
    mime: "image/jpeg", dataBase64: Buffer.from("cam").toString("base64"),
  }));
  await new Promise((r) => setTimeout(r, 30));
  fakeAgentB.emit({ type: "client_tool_call", client_tool_call: { tool_name: "look", tool_call_id: "w1", parameters: { question: "who is there?" } } });
  const result = await until(() => fakeAgentB.sent.find((m) => m.tool_call_id === "w1"));
  assert.equal(result.is_error, false);
  assert.match(String(result.result), /camera frame.*who is there\?/);
  assert.equal(fakeAgentB.attached.length, 0, "path 2 must not upload to ElevenLabs");
  ws.close();
});
