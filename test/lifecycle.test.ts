import { test, after } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import type { AddressInfo } from "node:net";
import { startServer } from "../src/server.js";
import { sign } from "../src/hmac.js";
import { loadConfig } from "../src/config.js";
import type { BridgeConfig } from "../src/config.js";
import type { AgentPort, ElInbound, ElSessionHandlers } from "../src/elevenlabs.js";

const baseCfg: BridgeConfig = {
  port: 0,
  host: "127.0.0.1",
  workerSharedSecret: "test-secret",
  elevenLabsApiKey: "unused",
  elevenLabsAgentId: "agent_test",
  elHost: "api.elevenlabs.io",
  elEnvironment: null,
  elTtsVoiceId: null,
  elTtsModelId: "eleven_turbo_v2_5",
  elFirstMessage: null,
  elAgentBranchId: null,
  maxCallMinutes: 0,
  goodbyeText: "Goodbye!",
  goodbyeGraceMs: 8000,
  visionApiUrl: null,
  visionApiKey: null,
  visionModel: null,
  hmacFreshnessMs: 60_000,
  maxConnections: 0,
  maxConnectionsPerIp: 0,
  preStartTimeoutMs: 0,
  workerIdleTimeoutMs: 0,
  trustProxy: false,
  tlsCertPath: null,
  tlsKeyPath: null,
  logTranscripts: false,
};

/** Minimal fake agent; one fresh instance per test so state never bleeds across cases. */
class FakeAgent implements AgentPort {
  conversationId = "conv";
  isOpen = true;
  sent: Array<Record<string, unknown>> = [];
  closed = false;
  handlers!: ElSessionHandlers;
  sendAudioChunk(b64: string): void { this.sent.push({ user_audio_chunk: b64 }); }
  sendConversationInit(init: Record<string, unknown>): void { this.sent.push(init); }
  sendPong(id: number): void { this.sent.push({ type: "pong", event_id: id }); }
  sendContextualUpdate(text: string): void { this.sent.push({ type: "contextual_update", text }); }
  sendUserMessage(text: string): void { this.sent.push({ type: "user_message", text }); }
  sendClientToolResult(id: string, result: string, isError: boolean): void {
    this.sent.push({ type: "client_tool_result", tool_call_id: id, result, is_error: isError });
  }
  async attachImage(): Promise<void> {}
  close(): void { this.closed = true; }
  emit(msg: ElInbound): void { this.handlers.onMessage(msg); }
}

function until<T>(fn: () => T | undefined, timeoutMs = 2000): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      const v = fn();
      if (v !== undefined) return resolve(v);
      if (Date.now() - start > timeoutMs) return reject(new Error("until() timed out"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

function upgradeHeaders(callId: string, secret = baseCfg.workerSharedSecret): Record<string, string> {
  const ts = Date.now();
  return {
    "X-OpenClawTeamsBridge-Timestamp": String(ts),
    "X-OpenClawTeamsBridge-Signature": sign(secret, ts, callId),
  };
}

// ---- C1: worker dies while the EL socket is still connecting ----
test("C1: worker closing during EL connect closes the orphaned agent socket", async () => {
  const fake = new FakeAgent();
  let releaseConnect: () => void = () => {};
  const gate = new Promise<void>((r) => (releaseConnect = r));
  const connectEl = async (_c: BridgeConfig, _l: unknown, handlers: ElSessionHandlers): Promise<AgentPort> => {
    fake.handlers = handlers;
    await gate; // hold the connect open until the worker has closed
    return fake;
  };
  const server = startServer({ ...baseCfg }, connectEl, null);
  await new Promise<void>((r) => server.once("listening", () => r()));
  const port = (server.address() as AddressInfo).port;
  after(() => server.close());

  const callId = "c1-orphan";
  const ws = new WebSocket(`ws://127.0.0.1:${port}/voice/msteams/stream/${callId}`, { headers: upgradeHeaders(callId) });
  await new Promise<void>((r) => ws.once("open", () => r()));
  ws.send(JSON.stringify({ type: "session.start", callId, threadId: "t", caller: {} }));
  // give onSessionStart a tick to enter the awaited connect, then kill the worker
  await new Promise((r) => setTimeout(r, 30));
  ws.close();
  await new Promise((r) => setTimeout(r, 30));
  releaseConnect(); // connect now resolves AFTER teardown already ran
  // the just-opened agent socket must be closed, not left as an orphaned billed conversation
  await until(() => (fake.closed ? true : undefined));
  assert.equal(fake.closed, true);
  assert.equal(fake.sent.length, 0, "must not send conversation_init on a torn-down call");
});

// ---- duplicate callId rejection ----
test("rejects a second live connection for the same callId (409)", async () => {
  const fake = new FakeAgent();
  const connectEl = async (_c: BridgeConfig, _l: unknown, handlers: ElSessionHandlers): Promise<AgentPort> => {
    fake.handlers = handlers;
    return fake;
  };
  const server = startServer({ ...baseCfg }, connectEl, null);
  await new Promise<void>((r) => server.once("listening", () => r()));
  const port = (server.address() as AddressInfo).port;
  after(() => server.close());

  const callId = "dup-1";
  const a = new WebSocket(`ws://127.0.0.1:${port}/voice/msteams/stream/${callId}`, { headers: upgradeHeaders(callId) });
  await new Promise<void>((r) => a.once("open", () => r()));
  a.send(JSON.stringify({ type: "session.start", callId, threadId: "t", caller: {} }));
  await until(() => fake.sent.find((m) => m.type === "conversation_initiation_client_data"));

  // second connection for the SAME callId (fresh, valid handshake) must be rejected
  const b = new WebSocket(`ws://127.0.0.1:${port}/voice/msteams/stream/${callId}`, { headers: upgradeHeaders(callId) });
  const err = await new Promise<Error>((resolve) => b.once("error", resolve));
  assert.match(err.message, /409|Unexpected server response: 409/);
  a.close();
});

// ---- MED-2: participants buffered during the EL-connect window ----
test("MED-2: participants sent before EL connects are flushed after init", async () => {
  const fake = new FakeAgent();
  let releaseConnect: () => void = () => {};
  const gate = new Promise<void>((r) => (releaseConnect = r));
  const connectEl = async (_c: BridgeConfig, _l: unknown, handlers: ElSessionHandlers): Promise<AgentPort> => {
    fake.handlers = handlers;
    await gate;
    return fake;
  };
  const server = startServer({ ...baseCfg }, connectEl, null);
  await new Promise<void>((r) => server.once("listening", () => r()));
  const port = (server.address() as AddressInfo).port;
  after(() => server.close());

  const callId = "med2-parts";
  const ws = new WebSocket(`ws://127.0.0.1:${port}/voice/msteams/stream/${callId}`, { headers: upgradeHeaders(callId) });
  await new Promise<void>((r) => ws.once("open", () => r()));
  ws.send(JSON.stringify({ type: "session.start", callId, threadId: "t", caller: {} }));
  await new Promise((r) => setTimeout(r, 20));
  // participants arrives DURING the connect window (el still null)
  ws.send(JSON.stringify({ type: "participants", count: 3 }));
  await new Promise((r) => setTimeout(r, 20));
  releaseConnect();

  const ctx = await until(() => fake.sent.find((m) => m.type === "contextual_update"));
  assert.match(String(ctx.text), /3 human participants/);
  ws.close();
});

// ---- LOW: numeric env validation fails loud ----
test("loadConfig throws on a non-numeric MAX_CALL_MINUTES", () => {
  const prev = process.env.MAX_CALL_MINUTES;
  process.env.WORKER_SHARED_SECRET = "s";
  process.env.ELEVENLABS_API_KEY = "k";
  process.env.ELEVENLABS_AGENT_ID = "a";
  process.env.MAX_CALL_MINUTES = "abc";
  try {
    assert.throws(() => loadConfig(), /MAX_CALL_MINUTES.*not a number/);
  } finally {
    if (prev === undefined) delete process.env.MAX_CALL_MINUTES;
    else process.env.MAX_CALL_MINUTES = prev;
  }
});

test("dead-peer: a silent worker socket is torn down after the idle window and the callId is freed", async () => {
  const fake = new (class {
    conversationId = "conv_idle";
    isOpen = true;
    sent: Array<Record<string, unknown>> = [];
    closed = false;
    handlers!: import("../src/elevenlabs.js").ElSessionHandlers;
    sendAudioChunk(): void {}
    sendConversationInit(m: Record<string, unknown>): void { this.sent.push(m); }
    sendPong(): void {}
    sendContextualUpdate(): void {}
    sendUserMessage(): void {}
    sendClientToolResult(): void {}
    async attachImage(): Promise<void> {}
    close(): void { this.closed = true; }
  })();
  const connect = async (_c: unknown, _l: unknown, handlers: import("../src/elevenlabs.js").ElSessionHandlers) => {
    fake.handlers = handlers;
    return fake;
  };
  // 150ms idle window (check interval = max(20, 150/3) = 50ms)
  const server = startServer({ ...baseCfg, workerIdleTimeoutMs: 150 }, connect as never, null);
  await new Promise<void>((r) => server.once("listening", () => r()));
  const port = (server.address() as AddressInfo).port;

  const callId = "call-idle-1";
  const ts = Date.now();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/voice/msteams/stream/${callId}`, {
    headers: { "X-OpenClawTeamsBridge-Timestamp": String(ts), "X-OpenClawTeamsBridge-Signature": sign(baseCfg.workerSharedSecret, ts, callId) },
  });
  await new Promise<void>((r) => ws.once("open", () => r()));
  const received: Array<Record<string, unknown>> = [];
  ws.on("message", (d) => received.push(JSON.parse(d.toString())));
  ws.send(JSON.stringify({ type: "session.start", callId, threadId: "t", caller: {} }));
  await until(() => fake.sent.find((m) => m.type === "conversation_initiation_client_data"));

  // keep-alive traffic holds the session open past the window...
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 60));
    ws.send(JSON.stringify({ type: "ping", ts: i }));
  }
  assert.equal(ws.readyState, WebSocket.OPEN, "active session must survive the idle window");

  // ...then true silence tears it down and frees the callId (no 409 lockout)
  const end = await until(() => received.find((m) => m.type === "session.end"), 2000);
  assert.equal(end.reason, "worker-idle-timeout");
  await until(() => (fake.closed ? true : undefined));
  await until(() => (ws.readyState === WebSocket.CLOSED ? true : undefined));

  const ts2 = Date.now();
  const ws2 = new WebSocket(`ws://127.0.0.1:${port}/voice/msteams/stream/${callId}`, {
    headers: { "X-OpenClawTeamsBridge-Timestamp": String(ts2), "X-OpenClawTeamsBridge-Signature": sign(baseCfg.workerSharedSecret, ts2, callId) },
  });
  await new Promise<void>((resolve, reject) => {
    ws2.once("open", () => resolve());
    ws2.once("error", (e) => reject(new Error(`reconnect after idle teardown must not 409: ${e.message}`)));
  });
  ws2.close();
  server.close();
});

test("pre-start bypass closed: pings without session.start no longer defuse the timer", async () => {
  const connect = async () => {
    throw new Error("EL must never be dialed for a never-started session");
  };
  const server = startServer({ ...baseCfg, preStartTimeoutMs: 200 }, connect as never, null);
  await new Promise<void>((r) => server.once("listening", () => r()));
  const port = (server.address() as AddressInfo).port;

  const callId = "call-nostart-1";
  const ts = Date.now();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/voice/msteams/stream/${callId}`, {
    headers: { "X-OpenClawTeamsBridge-Timestamp": String(ts), "X-OpenClawTeamsBridge-Signature": sign(baseCfg.workerSharedSecret, ts, callId) },
  });
  await new Promise<void>((r) => ws.once("open", () => r()));
  // keep sending pings — under the old code the FIRST message defused the timer
  const pinger = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping", ts: 1 }));
  }, 40);
  const code = await new Promise<number>((r) => ws.once("close", (c) => r(c)));
  clearInterval(pinger);
  assert.equal(code, 1008, "authenticated-but-never-started socket must be closed at the pre-start deadline");
  server.close();
});
