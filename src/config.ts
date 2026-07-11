/**
 * Bridge configuration, entirely from environment variables (spec §8).
 * The worker-side contract (HMAC secret, wire protocol) must match the
 * StandIn media bridge; the ElevenLabs side needs an API key and agent id.
 */

export interface BridgeConfig {
  /** TCP port the bridge listens on for worker WebSocket upgrades. */
  port: number;
  /** Bind address. */
  host: string;
  /** Must equal the shared secret the StandIn media bridge signs with (HMAC upgrade check). */
  workerSharedSecret: string;
  /** Server-side ElevenLabs key; mints signed URLs, uploads files, calls TTS. */
  elevenLabsApiKey: string;
  /** Default agent id (can later be resolved per tenant). */
  elevenLabsAgentId: string;
  /** ElevenLabs API host. Regional pins: api.us / api.eu.residency / api.in.residency / api.sg.residency (spec §4). */
  elHost: string;
  /** Optional environment passed to get-signed-url and conversation_initiation_client_data (spec §6). */
  elEnvironment: string | null;
  /** Optional localized greeting / spoken disclosure sent as a first_message override (must be allowlisted on the agent). */
  elFirstMessage: string | null;
  /** Optional agent branch id pinned per deployment (spec §6). */
  elAgentBranchId: string | null;
  /** Voice id for the deterministic governor goodbye via standalone TTS (spec §2 assistant.say). Null = fall back to user_message injection. */
  elTtsVoiceId: string | null;
  /** TTS model for the goodbye line. */
  elTtsModelId: string;
  /** Vision path 2 (spec §5): OpenAI-compatible chat-completions URL for describe-then-inject. Null = path disabled. */
  visionApiUrl: string | null;
  /** Bearer key for the vision endpoint (optional — local endpoints may not need one). */
  visionApiKey: string | null;
  /** Vision model name (required when visionApiUrl is set). */
  visionModel: string | null;
  /**
   * Bridge-side call governor (spec §9): hard cap on call duration in minutes
   * (fractional allowed). 0 = disabled. ElevenLabs doesn't know about your
   * billing; on limit the bridge speaks a goodbye and ends the call.
   */
  maxCallMinutes: number;
  /** Goodbye line the governor speaks (deterministic via TTS when EL_TTS_VOICE_ID is set). */
  goodbyeText: string;
  /** How long to let the goodbye play out before session.end when its duration is unknown (user_message fallback). */
  goodbyeGraceMs: number;
  /** Allowed clock skew for the HMAC timestamp, in ms (worker side documents ±60s). */
  hmacFreshnessMs: number;
  /** Max concurrent worker connections (0 = default 64). */
  maxConnections: number;
  /** Max concurrent connections from one remote IP (0 = default: same as maxConnections, i.e. no per-IP throttle). */
  maxConnectionsPerIp: number;
  /** Drop a worker that authenticates but never sends session.start after this many ms (0 = default 10s). */
  preStartTimeoutMs: number;
  /** Dead-peer window: end the call after this many ms without ANY worker message (0 = default 90s; the worker heartbeats every 30s). */
  workerIdleTimeoutMs: number;
  /** Trust X-Forwarded-For for the per-IP cap (only behind a proxy you control). */
  trustProxy: boolean;
  /** PEM cert/key paths for native TLS (wss). When both are set the bridge serves HTTPS itself; otherwise it is plain WS and MUST be fronted by a TLS terminator. */
  tlsCertPath: string | null;
  tlsKeyPath: string | null;
  /** Log EL transcripts (still gated on Teams recording.status === "active", spec §7). */
  logTranscripts: boolean;
}

/**
 * ELEVENLABS_API_KEY is sent as `xi-api-key` to `https://{EL_HOST}/...`, so an
 * attacker-influenced or fat-fingered EL_HOST would exfiltrate the key. Restrict
 * it to ElevenLabs' own hosts (the default + the documented regional pins). Set
 * EL_HOST_ALLOW_ANY=true only for a deliberate proxy/test host.
 */
function validateElHost(host: string): string {
  if (process.env.EL_HOST_ALLOW_ANY === "true") {
    return host;
  }
  const h = host.toLowerCase();
  if (h === "elevenlabs.io" || h.endsWith(".elevenlabs.io")) {
    return host;
  }
  throw new Error(
    `EL_HOST "${host}" is not an elevenlabs.io host; the API key must not be sent elsewhere. ` +
      `Set EL_HOST_ALLOW_ANY=true to override for a trusted proxy.`,
  );
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

/**
 * Parse a numeric env var, failing LOUD on a non-numeric value. `Number("abc")`
 * is NaN, which silently disables the governor (MAX_CALL_MINUTES) or throws an
 * opaque listen error (PORT). A typo should stop startup with a clear message.
 */
function numFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`Env var ${name}="${raw}" is not a number`);
  }
  // Fail loud on negatives too: e.g. MAX_CALL_MINUTES=-1 would pass Number.isFinite
  // and then `maxCallMinutes > 0` silently disables the governor - the same
  // silent-misconfig class numFromEnv exists to prevent. All these knobs are
  // counts/durations/minutes where a negative is never meaningful.
  if (n < 0) {
    throw new Error(`Env var ${name}="${raw}" must not be negative`);
  }
  return n;
}

export function loadConfig(): BridgeConfig {
  return {
    port: numFromEnv("PORT", 8080),
    host: process.env.BIND?.trim() || "0.0.0.0",
    workerSharedSecret: required("WORKER_SHARED_SECRET"),
    elevenLabsApiKey: required("ELEVENLABS_API_KEY"),
    elevenLabsAgentId: required("ELEVENLABS_AGENT_ID"),
    elHost: validateElHost(process.env.EL_HOST?.trim() || "api.elevenlabs.io"),
    elEnvironment: optional("EL_ENVIRONMENT"),
    elFirstMessage: optional("EL_FIRST_MESSAGE"),
    elAgentBranchId: optional("EL_AGENT_BRANCH_ID"),
    elTtsVoiceId: optional("EL_TTS_VOICE_ID"),
    elTtsModelId: process.env.EL_TTS_MODEL_ID ?? "eleven_turbo_v2_5",
    maxCallMinutes: numFromEnv("MAX_CALL_MINUTES", 0),
    goodbyeText:
      process.env.GOODBYE_TEXT ??
      "I'm sorry, we've reached the time limit for this call. Thank you for calling, goodbye!",
    goodbyeGraceMs: numFromEnv("GOODBYE_GRACE_MS", 8000),
    visionApiUrl: optional("VISION_API_URL"),
    visionApiKey: optional("VISION_API_KEY"),
    visionModel: optional("VISION_MODEL"),
    hmacFreshnessMs: numFromEnv("HMAC_FRESHNESS_MS", 60_000),
    maxConnections: numFromEnv("MAX_CONNECTIONS", 0),
    maxConnectionsPerIp: numFromEnv("MAX_CONNECTIONS_PER_IP", 0),
    preStartTimeoutMs: numFromEnv("PRE_START_TIMEOUT_MS", 0),
    workerIdleTimeoutMs: numFromEnv("WORKER_IDLE_TIMEOUT_MS", 0),
    trustProxy: process.env.TRUST_PROXY_XFF === "true",
    tlsCertPath: optional("TLS_CERT_PATH"),
    tlsKeyPath: optional("TLS_KEY_PATH"),
    logTranscripts: process.env.LOG_TRANSCRIPTS === "true",
  };
}
