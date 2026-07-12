/**
 * @komaa/elevenlabs-msteams-bridge — public API.
 *
 * Typical embedding:
 *   import { loadConfig, startServer } from "@komaa/elevenlabs-msteams-bridge";
 *   startServer(loadConfig());
 *
 * Or run the CLI: `npx @komaa/elevenlabs-msteams-bridge` (env-configured, see .env.example).
 */

export { loadConfig, type BridgeConfig } from "./config.js";
export { startServer, authorizeUpgrade, callIdFromUrl } from "./server.js";
export { CallSession, type ElConnector } from "./session.js";
export { makeVisionDescriber, type VisionDescriber } from "./vision.js";
export { assertPublicHttpUrl, isForbiddenIp, readBodyWithCap, fetchPublicImage } from "./ssrf.js";
export { renderMetrics } from "./metrics.js";
export {
  ElAgentSocket,
  getSignedUrl,
  synthesizeGoodbye,
  buildConversationInit,
  uploadConversationFile,
  type AgentPort,
  type ElInbound,
  type ElSessionHandlers,
  type ConversationInitOptions,
} from "./elevenlabs.js";
export { sign, verify, isFresh, TIMESTAMP_HEADER, SIGNATURE_HEADER, LEGACY_TIMESTAMP_HEADER, LEGACY_SIGNATURE_HEADER } from "./hmac.js";
export * from "./protocol.js";
export { logger, type Logger } from "./log.js";
