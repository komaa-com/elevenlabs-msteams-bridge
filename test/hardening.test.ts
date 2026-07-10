import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { ReplayGuard, authorizeUpgrade } from "../src/server.js";
import { sign, TIMESTAMP_HEADER, SIGNATURE_HEADER } from "../src/hmac.js";
import { loadConfig, type BridgeConfig } from "../src/config.js";

const SECRET = "test-secret";

const baseCfg: BridgeConfig = {
  port: 0,
  host: "127.0.0.1",
  workerSharedSecret: SECRET,
  elevenLabsApiKey: "x",
  elevenLabsAgentId: "agent_test",
  elHost: "api.elevenlabs.io",
  elEnvironment: null,
  elFirstMessage: null,
  elAgentBranchId: null,
  elTtsVoiceId: null,
  elTtsModelId: "eleven_turbo_v2_5",
  visionApiUrl: null,
  visionApiKey: null,
  visionModel: null,
  maxCallMinutes: 0,
  goodbyeText: "bye",
  goodbyeGraceMs: 8000,
  hmacFreshnessMs: 60_000,
  maxConnections: 0,
  maxConnectionsPerIp: 0,
  preStartTimeoutMs: 0,
  logTranscripts: false,
};

function req(callId: string, ts: number, sig: string): IncomingMessage {
  return {
    url: `/voice/msteams/stream/${callId}`,
    headers: { [TIMESTAMP_HEADER]: String(ts), [SIGNATURE_HEADER]: sig },
    socket: { remoteAddress: "1.2.3.4" },
  } as unknown as IncomingMessage;
}

test("ReplayGuard: a verified tuple is single-use within the window", () => {
  const g = new ReplayGuard(60_000);
  const now = 1_000_000;
  const ts = now - 1_000; // fresh: within the 60s window of `now`
  assert.equal(g.claim("callA", ts, "sigA", now), true, "first use accepted");
  assert.equal(g.claim("callA", ts, "sigA", now), false, "replay rejected");
  assert.equal(g.claim("callA", ts + 1, "sigA", now), true, "different ts is a different tuple");
});

test("ReplayGuard: records expire once the timestamp is no longer fresh", () => {
  const g = new ReplayGuard(60_000);
  const t0 = 1_000_000;
  assert.equal(g.claim("callB", t0, "sigB", t0), true);
  // advance well past t0 + window → the old record is swept when the next claim runs
  const later = t0 + 120_000;
  assert.equal(g.claim("callC", later, "sigC", later), true);
  assert.equal(g.size, 1, "expired entry swept");
});

test("authorizeUpgrade: replays are rejected even with a valid signature", () => {
  const g = new ReplayGuard(60_000);
  const ts = Date.now();
  const sig = sign(SECRET, ts, "callD");
  assert.deepEqual(authorizeUpgrade(baseCfg, req("callD", ts, sig), g), { callId: "callD" });
  const second = authorizeUpgrade(baseCfg, req("callD", ts, sig), g);
  assert.ok("error" in second && /replay/i.test(second.error), "second identical upgrade is a replay");
});

test("authorizeUpgrade: fail-closed on an empty shared secret", () => {
  const ts = Date.now();
  const sig = sign(SECRET, ts, "callE");
  const res = authorizeUpgrade({ ...baseCfg, workerSharedSecret: "" }, req("callE", ts, sig));
  assert.ok("error" in res && /not configured/.test(res.error), "empty secret rejects all");
});

test("EL_HOST is restricted to elevenlabs.io hosts (API-key exfil guard)", () => {
  const saved = { ...process.env };
  try {
    process.env.WORKER_SHARED_SECRET = SECRET;
    process.env.ELEVENLABS_API_KEY = "sk_x";
    process.env.ELEVENLABS_AGENT_ID = "agent_x";

    process.env.EL_HOST = "api.eu.residency.elevenlabs.io";
    assert.equal(loadConfig().elHost, "api.eu.residency.elevenlabs.io", "regional pin allowed");

    process.env.EL_HOST = "evil.example.com";
    assert.throws(() => loadConfig(), /not an elevenlabs\.io host/, "arbitrary host rejected");

    process.env.EL_HOST_ALLOW_ANY = "true";
    assert.equal(loadConfig().elHost, "evil.example.com", "explicit override honored");
  } finally {
    process.env = saved;
  }
});
