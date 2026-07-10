import { createServer, type IncomingMessage } from "node:http";
import { WebSocketServer } from "ws";
import type { BridgeConfig } from "./config.js";
import { isFresh, verify, SIGNATURE_HEADER, TIMESTAMP_HEADER } from "./hmac.js";
import { logger } from "./log.js";
import { CallSession, type ElConnector } from "./session.js";

const log = logger("server");

/**
 * Worker-facing WebSocket server. The MediaNode dials
 * {OpenClawWsBaseUrl}/{callId} with an HMAC-signed upgrade
 * (X-OpenClawTeamsBridge-Timestamp / -Signature over "{timestampMs}.{callId}");
 * the bridge validates exactly like the OpenClaw provider does (spec §6).
 */

/** callId = last non-empty path segment of the upgrade URL. */
export function callIdFromUrl(url: string | undefined): string | null {
  if (!url) {
    return null;
  }
  const path = url.split("?")[0];
  const segments = path.split("/").filter(Boolean);
  return segments.length > 0 ? decodeURIComponent(segments[segments.length - 1]) : null;
}

export function authorizeUpgrade(cfg: BridgeConfig, req: IncomingMessage): { callId: string } | { error: string } {
  const callId = callIdFromUrl(req.url);
  if (!callId) {
    return { error: "no callId in path" };
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
  return { callId };
}

export function startServer(cfg: BridgeConfig, connectEl?: ElConnector): ReturnType<typeof createServer> {
  const httpServer = createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    const auth = authorizeUpgrade(cfg, req);
    if ("error" in auth) {
      log.warn(`rejected upgrade from ${req.socket.remoteAddress}: ${auth.error}`);
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      log.info(`worker connected for call ${auth.callId.slice(0, 12)}…`);
      new CallSession(cfg, ws, auth.callId, connectEl);
    });
  });

  httpServer.listen(cfg.port, cfg.host, () => {
    log.info(`elevenlabs-msteams-bridge listening on ${cfg.host}:${cfg.port} (agent ${cfg.elevenLabsAgentId}, host ${cfg.elHost})`);
  });
  return httpServer;
}

