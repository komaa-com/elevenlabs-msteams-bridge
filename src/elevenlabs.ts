import WebSocket from "ws";
import type { BridgeConfig } from "./config.js";
import type { Logger } from "./log.js";

/**
 * ElevenLabs Agent WebSocket client + the two REST calls the bridge needs
 * (signed URL minting, standalone TTS for the governor goodbye).
 *
 * Wire reference (validated 2026-07-10 against the live AsyncAPI, see the
 * spec doc §2/§12): client→server messages are user_audio_chunk, pong,
 * conversation_initiation_client_data, contextual_update, user_message,
 * client_tool_result, multimodal_message; server→client are
 * conversation_initiation_metadata, audio, interruption, ping, vad_score,
 * user_transcript, agent_response, client_tool_call, ...
 */

// ---- server→client event shapes (subset the bridge consumes) ----

export interface ElInitMetadata {
  type: "conversation_initiation_metadata";
  conversation_initiation_metadata_event: {
    conversation_id: string;
    agent_output_audio_format?: string;
    user_input_audio_format?: string;
  };
}

export interface ElAudioEvent {
  type: "audio";
  audio_event: { audio_base_64: string; event_id: number };
}

export interface ElInterruption {
  type: "interruption";
  interruption_event: { event_id: number };
}

export interface ElPing {
  type: "ping";
  ping_event: { event_id: number; ping_ms?: number | null };
}

export interface ElUserTranscript {
  type: "user_transcript";
  user_transcript_event: { user_transcript: string };
}

export interface ElAgentResponse {
  type: "agent_response";
  agent_response_event: { agent_response: string };
}

export interface ElClientToolCall {
  type: "client_tool_call";
  client_tool_call: { tool_name: string; tool_call_id: string; parameters?: Record<string, unknown> };
}

export type ElInbound =
  | ElInitMetadata
  | ElAudioEvent
  | ElInterruption
  | ElPing
  | ElUserTranscript
  | ElAgentResponse
  | ElClientToolCall
  | { type: string; [k: string]: unknown };

// ---- client→server payload builders ----

export interface ConversationInitOptions {
  dynamicVariables: Record<string, string>;
  firstMessage?: string;
  environment?: string | null;
}

export function buildConversationInit(opts: ConversationInitOptions): Record<string, unknown> {
  const msg: Record<string, unknown> = {
    type: "conversation_initiation_client_data",
    dynamic_variables: opts.dynamicVariables,
  };
  // conversation_config_override fields are rejected unless allowlisted in the
  // agent's security settings (spec §6 caveat 2) — only send when configured.
  if (opts.firstMessage) {
    msg.conversation_config_override = { agent: { first_message: opts.firstMessage } };
  }
  if (opts.environment) {
    msg.environment = opts.environment;
  }
  return msg;
}

// ---- REST helpers ----

/**
 * Mint a short-lived signed URL for a private agent (spec §6). Endpoint is
 * get-signed-url (hyphens). Expires in ~15 min: call per session.start, never cache.
 */
export async function getSignedUrl(cfg: BridgeConfig): Promise<string> {
  const url = new URL(`https://${cfg.elHost}/v1/convai/conversation/get-signed-url`);
  url.searchParams.set("agent_id", cfg.elevenLabsAgentId);
  if (cfg.elEnvironment) {
    url.searchParams.set("environment", cfg.elEnvironment);
  }
  const res = await fetch(url, { headers: { "xi-api-key": cfg.elevenLabsApiKey } });
  if (!res.ok) {
    throw new Error(`get-signed-url failed: HTTP ${res.status} ${await res.text().catch(() => "")}`);
  }
  const body = (await res.json()) as { signed_url?: string };
  if (!body.signed_url) {
    throw new Error("get-signed-url returned no signed_url");
  }
  return body.signed_url;
}

/**
 * Standalone TTS for the deterministic governor goodbye (spec §2 assistant.say):
 * synthesize the exact text as raw PCM16K and return the bytes.
 */
export async function synthesizeGoodbye(cfg: BridgeConfig, text: string): Promise<Buffer> {
  if (!cfg.elTtsVoiceId) {
    throw new Error("EL_TTS_VOICE_ID not configured");
  }
  const url = new URL(`https://${cfg.elHost}/v1/text-to-speech/${cfg.elTtsVoiceId}`);
  url.searchParams.set("output_format", "pcm_16000");
  const res = await fetch(url, {
    method: "POST",
    headers: { "xi-api-key": cfg.elevenLabsApiKey, "content-type": "application/json" },
    body: JSON.stringify({ text, model_id: cfg.elTtsModelId }),
  });
  if (!res.ok) {
    throw new Error(`TTS failed: HTTP ${res.status} ${await res.text().catch(() => "")}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

// ---- Agent WebSocket session ----

export interface ElSessionHandlers {
  onMessage: (msg: ElInbound) => void;
  onClose: (code: number, reason: string) => void;
  onError: (err: Error) => void;
}

/** What the relay needs from an agent connection; ElAgentSocket is the real one, tests fake it. */
export interface AgentPort {
  conversationId: string | null;
  readonly isOpen: boolean;
  sendAudioChunk(base64Pcm: string): void;
  sendConversationInit(init: Record<string, unknown>): void;
  sendPong(eventId: number): void;
  sendContextualUpdate(text: string): void;
  sendUserMessage(text: string): void;
  sendClientToolResult(toolCallId: string, result: string, isError: boolean): void;
  close(): void;
}

/** One agent conversation socket. Thin: parsing + send helpers only; relay logic lives in session.ts. */
export class ElAgentSocket implements AgentPort {
  private ws: WebSocket;
  private readonly log: Logger;
  conversationId: string | null = null;

  private constructor(ws: WebSocket, log: Logger) {
    this.ws = ws;
    this.log = log;
  }

  /** Open the agent WS (signed URL) and wire handlers. Resolves once the socket is open. */
  static async connect(cfg: BridgeConfig, log: Logger, handlers: ElSessionHandlers): Promise<ElAgentSocket> {
    const signedUrl = await getSignedUrl(cfg);
    const ws = new WebSocket(signedUrl);
    const sock = new ElAgentSocket(ws, log);

    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", (err) => reject(err));
    });

    ws.on("message", (data) => {
      let msg: ElInbound | null = null;
      try {
        msg = JSON.parse(data.toString("utf8")) as ElInbound;
      } catch {
        log.warn("EL sent unparseable frame; dropping");
        return;
      }
      if (msg.type === "conversation_initiation_metadata") {
        const meta = (msg as ElInitMetadata).conversation_initiation_metadata_event;
        sock.conversationId = meta.conversation_id;
        // pcm_16000 is the no-transcode contract (spec §4); anything else is an agent misconfig.
        if (meta.agent_output_audio_format && meta.agent_output_audio_format !== "pcm_16000") {
          log.error(`agent_output_audio_format is ${meta.agent_output_audio_format}, expected pcm_16000 — fix the agent's audio settings`);
        }
      }
      handlers.onMessage(msg);
    });
    ws.on("close", (code, reason) => handlers.onClose(code, reason.toString("utf8")));
    ws.on("error", (err) => handlers.onError(err as Error));
    return sock;
  }

  get isOpen(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  private send(obj: Record<string, unknown>): void {
    if (this.isOpen) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  /** Caller audio → agent. Payload is base64 PCM16K, forwarded verbatim (no "type" field on this one). */
  sendAudioChunk(base64Pcm: string): void {
    this.send({ user_audio_chunk: base64Pcm });
  }

  sendConversationInit(init: Record<string, unknown>): void {
    this.send(init);
  }

  sendPong(eventId: number): void {
    this.send({ type: "pong", event_id: eventId });
  }

  /** Non-interrupting background context (participants, dtmf, vision descriptions). */
  sendContextualUpdate(text: string): void {
    this.send({ type: "contextual_update", text });
  }

  /** Interrupting user-turn text (governor-goodbye fallback path). */
  sendUserMessage(text: string): void {
    this.send({ type: "user_message", text });
  }

  sendClientToolResult(toolCallId: string, result: string, isError: boolean): void {
    this.send({ type: "client_tool_result", tool_call_id: toolCallId, result, is_error: isError });
  }

  close(): void {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close(1000, "session-end");
    }
  }
}
