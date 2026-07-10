import { createServer, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import type { BridgeConfig } from "./config.js";
import { isFresh, verify, SIGNATURE_HEADER, TIMESTAMP_HEADER } from "./hmac.js";
import { logger } from "./log.js";
import { CallSession, type ElConnector } from "./session.js";
import { makeVisionDescriber, type VisionDescriber } from "./vision.js";

const log = logger("server");

/**
 * Worker-facing WebSocket server. The StandIn media bridge dials
 * {wsBaseUrl}/{callId} with an HMAC-signed upgrade
 * (X-OpenClawTeamsBridge-Timestamp / -Signature over "{timestampMs}.{callId}");
 * the bridge validates exactly like the OpenClaw provider does (spec §6).
 */

// DoS guards — parity with the OpenClaw/Hermes msteams providers. A single
// shared secret gates the upgrade, but a buggy or compromised worker (or a
// leaked secret) must not be able to exhaust memory/sockets.
/** Max inbound WS frame. Caller audio is ~640 B/frame; a JPEG video.frame is the
 *  large one. 2 MB matches the sibling providers and bounds a single message. */
const MAX_INBOUND_PAYLOAD_BYTES = 2 * 1024 * 1024;
/** Max concurrent worker connections (one per live call). */
const DEFAULT_MAX_CONNECTIONS = 64;
/** Max concurrent connections from one remote address. */
const DEFAULT_MAX_CONNECTIONS_PER_IP = 8;
/** A worker that authenticates but never sends session.start is dropped after this. */
const DEFAULT_PRE_START_TIMEOUT_MS = 10_000;

/** callId = last non-empty path segment of the upgrade URL. */
export function callIdFromUrl(url: string | undefined): string | null {
  if (!url) {
    return null;
  }
  const path = url.split("?")[0];
  const segments = path.split("/").filter(Boolean);
  return segments.length > 0 ? decodeURIComponent(segments[segments.length - 1]) : null;
}

/**
 * Single-use guard for verified upgrade tuples (callId, ts, sig). Even inside
 * the freshness window, a captured handshake must not be replayable to open a
 * second (ghost) session for the same call. Records survive until the timestamp
 * itself stops being fresh (ts + window), matching the sibling providers.
 */
export class ReplayGuard {
  private readonly seen = new Map<string, number>();
  constructor(private readonly windowMs: number) {}

  /** Returns true if this tuple is NEW (and records it); false if already used. */
  claim(callId: string, ts: number, sig: string, nowMs = Date.now()): boolean {
    for (const [key, expiry] of this.seen) {
      if (expiry <= nowMs) {
        this.seen.delete(key);
      }
    }
    const key = `${callId}.${ts}.${sig}`;
    if (this.seen.has(key)) {
      return false;
    }
    // Expire when the timestamp stops being fresh, not "now + window": the tuple
    // is unusable past ts + windowMs anyway (isFresh would reject it).
    this.seen.set(key, ts + this.windowMs);
    return true;
  }

  get size(): number {
    return this.seen.size;
  }
}

export function authorizeUpgrade(
  cfg: BridgeConfig,
  req: IncomingMessage,
  replay?: ReplayGuard,
): { callId: string } | { error: string } {
  const callId = callIdFromUrl(req.url);
  if (!callId) {
    return { error: "no callId in path" };
  }
  // Fail closed: an empty/unset shared secret must reject every upgrade rather
  // than authenticating anyone. loadConfig() requires it, but never trust that.
  if (!cfg.workerSharedSecret) {
    return { error: "bridge shared secret is not configured" };
  }
  const tsHeader = req.headers[TIMESTAMP_HEADER];
  const sigHeader = req.headers[SIGNATURE_HEADER];
  const ts = Number(Array.isArray(tsHeader) ? tsHeader[0] : tsHeader);
  const sig = (Array.isArray(sigHeader) ? sigHeader[0] : sigHeader) ?? "";
  if (!isFresh(ts, cfg.hmacFreshnessMs)) {
    return { error: "stale or missing timestamp" };
  }
  if (!verify(cfg.workerSharedSecret, ts, callId, sig)) {
    return { error: "bad signature" };
  }
  // Replay guard runs LAST, so an unauthenticated probe can never consume a
  // replay slot (it fails the signature check first).
  if (replay && !replay.claim(callId, ts, sig)) {
    return { error: "replayed handshake" };
  }
  return { callId };
}

/** Best-effort remote-IP key for the per-IP connection cap. */
function remoteKey(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? "unknown";
}

// SIGTERM/SIGINT drain: on shutdown, gracefully end every live call (notify the
// worker with session.end + close both sockets) instead of hard-dropping calls
// on a redeploy — parity with the caller sibling's preStop/SIGTERM drain. Wired
// exactly once per process (process.once) so repeated startServer calls (tests)
// never accumulate listeners.
const liveRegistries = new Set<Map<string, CallSession>>();
let signalsWired = false;
function wireDrainSignals(): void {
  if (signalsWired) {
    return;
  }
  signalsWired = true;
  const drain = (sig: string): void => {
    const sessions = [...liveRegistries].flatMap((m) => [...m.values()]);
    log.info(`${sig}: draining ${sessions.length} live call(s)`);
    for (const s of sessions) {
      try {
        s.shutdown("bridge-shutdown");
      } catch {
        /* keep draining the rest */
      }
    }
    process.exit(0);
  };
  process.once("SIGTERM", () => drain("SIGTERM"));
  process.once("SIGINT", () => drain("SIGINT"));
}

export function startServer(
  cfg: BridgeConfig,
  connectEl?: ElConnector,
  vision?: VisionDescriber | null,
): ReturnType<typeof createServer> {
  const maxConnections = cfg.maxConnections > 0 ? cfg.maxConnections : DEFAULT_MAX_CONNECTIONS;
  const maxPerIp = cfg.maxConnectionsPerIp > 0 ? cfg.maxConnectionsPerIp : DEFAULT_MAX_CONNECTIONS_PER_IP;
  const preStartTimeoutMs = cfg.preStartTimeoutMs > 0 ? cfg.preStartTimeoutMs : DEFAULT_PRE_START_TIMEOUT_MS;
  const replay = new ReplayGuard(cfg.hmacFreshnessMs);

  let openConnections = 0;
  const perIp = new Map<string, number>();
  // Live calls keyed by callId: rejects a duplicate callId (a fresh handshake
  // for an already-live call would otherwise open a SECOND billed EL conversation
  // for the same call) and backs the SIGTERM drain.
  const sessions = new Map<string, CallSession>();
  liveRegistries.add(sessions);
  wireDrainSignals();

  const httpServer = createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_INBOUND_PAYLOAD_BYTES });

  const reject = (socket: Duplex, status: string, reason: string, ip: string): void => {
    log.warn(`rejected upgrade from ${ip}: ${reason}`);
    socket.write(`HTTP/1.1 ${status}\r\n\r\n`);
    socket.destroy();
  };

  httpServer.on("upgrade", (req, socket, head) => {
    const ip = remoteKey(req);
    // Cheap caps first (before HMAC) so a flood can't force expensive crypto.
    if (openConnections >= maxConnections) {
      return reject(socket, "503 Service Unavailable", "server connection cap reached", ip);
    }
    if ((perIp.get(ip) ?? 0) >= maxPerIp) {
      return reject(socket, "503 Service Unavailable", "per-IP connection cap reached", ip);
    }
    const auth = authorizeUpgrade(cfg, req, replay);
    if ("error" in auth) {
      return reject(socket, "401 Unauthorized", auth.error, ip);
    }
    // A live session already owns this callId — a retry/rollout reconnect. Reject
    // rather than spin up a second billed ElevenLabs conversation for one call.
    if (sessions.has(auth.callId)) {
      return reject(socket, "409 Conflict", `callId ${auth.callId.slice(0, 12)}… already has a live session`, ip);
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      openConnections++;
      perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
      log.info(`worker connected for call ${auth.callId.slice(0, 12)}… (${openConnections}/${maxConnections})`);

      // Drop a worker that authenticates but never starts a call (idle-socket leak).
      let started = false;
      const preStartTimer = setTimeout(() => {
        if (!started) {
          log.warn(`call ${auth.callId.slice(0, 12)}… sent no session.start in ${preStartTimeoutMs}ms; closing`);
          try {
            ws.close(1008, "no session.start");
          } catch {
            /* already closing */
          }
        }
      }, preStartTimeoutMs);
      preStartTimer.unref?.();
      ws.once("message", () => {
        started = true;
        clearTimeout(preStartTimer);
      });

      ws.once("close", () => {
        clearTimeout(preStartTimer);
        openConnections = Math.max(0, openConnections - 1);
        const n = (perIp.get(ip) ?? 1) - 1;
        if (n <= 0) {
          perIp.delete(ip);
        } else {
          perIp.set(ip, n);
        }
      });

      const session = new CallSession(
        cfg,
        ws,
        auth.callId,
        connectEl,
        vision === undefined ? makeVisionDescriber(cfg) : vision,
        () => sessions.delete(auth.callId), // evict on teardown (dedup + drain registry)
      );
      sessions.set(auth.callId, session);
    });
  });

  httpServer.on("close", () => liveRegistries.delete(sessions));

  httpServer.listen(cfg.port, cfg.host, () => {
    log.info(`elevenlabs-msteams-bridge listening on ${cfg.host}:${cfg.port} (agent ${cfg.elevenLabsAgentId}, host ${cfg.elHost})`);
  });
  return httpServer;
}
