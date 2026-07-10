/**
 * Bridge configuration, entirely from environment variables (spec §8).
 * The worker-side contract (HMAC secret, wire protocol) must match the
 * OpenClawBridge MediaNode; the ElevenLabs side needs an API key and agent id.
 */

export interface BridgeConfig {
  /** TCP port the bridge listens on for worker WebSocket upgrades. */
  port: number;
  /** Bind address. */
  host: string;
  /** Must equal the worker's OpenClawSharedSecret (HMAC upgrade check). */
  workerSharedSecret: string;
  /** Server-side ElevenLabs key; mints signed URLs, uploads files, calls TTS. */
  elevenLabsApiKey: string;
  /** Default agent id (can later be resolved per tenant). */
  elevenLabsAgentId: string;
  /** ElevenLabs API host. Regional pins: api.us / api.eu.residency / api.in.residency / api.sg.residency (spec §4). */
  elHost: string;
  /** Optional environment passed to get-signed-url and conversation_initiation_client_data (spec §6). */
  elEnvironment: string | null;
  /** Voice id for the deterministic governor goodbye via standalone TTS (spec §2 assistant.say). Null = fall back to user_message injection. */
  elTtsVoiceId: string | null;
  /** TTS model for the goodbye line. */
  elTtsModelId: string;
  /** Allowed clock skew for the HMAC timestamp, in ms (worker side documents ±60s). */
  hmacFreshnessMs: number;
  /** Log EL transcripts (still gated on Teams recording.status === "active", spec §7). */
  logTranscripts: boolean;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`Missing required env var ${name}`);
  }
  return v.trim();
}

function optional(name: string): string | null {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : null;
}

export function loadConfig(): BridgeConfig {
  return {
    port: Number(process.env.PORT ?? 8080),
    host: process.env.BIND ?? "0.0.0.0",
    workerSharedSecret: required("WORKER_SHARED_SECRET"),
    elevenLabsApiKey: required("ELEVENLABS_API_KEY"),
    elevenLabsAgentId: required("ELEVENLABS_AGENT_ID"),
    elHost: process.env.EL_HOST ?? "api.elevenlabs.io",
    elEnvironment: optional("EL_ENVIRONMENT"),
    elTtsVoiceId: optional("EL_TTS_VOICE_ID"),
    elTtsModelId: process.env.EL_TTS_MODEL_ID ?? "eleven_turbo_v2_5",
    hmacFreshnessMs: Number(process.env.HMAC_FRESHNESS_MS ?? 60_000),
    logTranscripts: process.env.LOG_TRANSCRIPTS === "true",
  };
}
