import type WebSocket from "ws";
import type { BridgeConfig } from "./config.js";
import { logger, type Logger } from "./log.js";
import {
  parseWorkerMessage,
  pcm16kBytesToMs,
  type AudioFrameMessage,
  type SessionStartMessage,
  type VideoFrameMessage,
  type WorkerOutbound,
} from "./protocol.js";
import {
  buildConversationInit,
  synthesizeGoodbye,
  ElAgentSocket,
  type AgentPort,
  type ElAudioEvent,
  type ElClientToolCall,
  type ElInbound,
  type ElInterruption,
  type ElPing,
  type ElSessionHandlers,
} from "./elevenlabs.js";
import { makeVisionDescriber, type VisionDescriber } from "./vision.js";

/** Injectable EL connector so tests can substitute a fake agent. */
export type ElConnector = (cfg: BridgeConfig, log: Logger, handlers: ElSessionHandlers) => Promise<AgentPort>;

/**
 * One Teams call: pairs the worker WebSocket with one ElevenLabs Agent
 * conversation and relays between them (spec §2 mapping table).
 *
 * Audio is relayed verbatim in both directions — both sides speak base64
 * PCM16K and the worker re-aligns variable-length chunks itself, so the hot
 * path is copy-only.
 */
export class CallSession {
  private readonly cfg: BridgeConfig;
  private readonly worker: WebSocket;
  private readonly log: Logger;
  private readonly connectEl: ElConnector;
  private readonly vision: VisionDescriber | null;

  private el: AgentPort | null = null;
  private callId: string;
  private closed = false;

  // outbound audio bookkeeping (bridge → worker)
  private outSeq = 0;
  private outTimestampMs = 0;

  // barge-in ghost filter: drop EL audio with event_id <= the last interruption (spec §4)
  private lastInterruptEventId = -1;

  // Teams recording gate (spec §7): transcripts may be logged/persisted only when "active"
  private recordingActive = false;

  // vision groundwork (spec §5): latest inbound frame per source, memory only
  private readonly latestVideoFrame = new Map<string, VideoFrameMessage>();

  // bridge-side call governor (spec §9)
  private governorTimer: NodeJS.Timeout | null = null;

  constructor(
    cfg: BridgeConfig,
    worker: WebSocket,
    callId: string,
    connectEl: ElConnector = ElAgentSocket.connect,
    vision: VisionDescriber | null = makeVisionDescriber(cfg),
  ) {
    this.cfg = cfg;
    this.worker = worker;
    this.callId = callId;
    this.log = logger(`call:${callId.slice(0, 12)}`);
    this.connectEl = connectEl;
    this.vision = vision;

    worker.on("message", (data) => this.onWorkerMessage(data as Buffer));
    worker.on("close", () => this.teardown("worker-closed"));
    worker.on("error", (err) => {
      this.log.warn(`worker socket error: ${(err as Error).message}`);
      this.teardown("worker-error");
    });
  }

  // ---- worker → bridge ----

  private onWorkerMessage(data: Buffer): void {
    const msg = parseWorkerMessage(data);
    if (!msg) {
      this.log.warn("unparseable worker frame; dropping");
      return;
    }
    switch (msg.type) {
      case "session.start":
        void this.onSessionStart(msg);
        break;
      case "audio.frame":
        // hot path: caller audio → agent, verbatim
        this.el?.sendAudioChunk(msg.payloadBase64);
        break;
      case "ping":
        this.sendToWorker({ type: "pong", ts: msg.ts });
        break;
      case "participants":
        this.el?.sendContextualUpdate(
          msg.count <= 1
            ? "This is a 1:1 call with a single human caller."
            : `There are ${msg.count} human participants on this call. Stay quiet unless directly addressed.`,
        );
        break;
      case "dtmf":
        this.el?.sendContextualUpdate(`The caller pressed the "${msg.digit}" key on their keypad.`);
        break;
      case "recording.status":
        this.recordingActive = msg.status === "active";
        this.log.info(`recording.status = ${msg.status}`);
        break;
      case "video.frame":
        this.latestVideoFrame.set(msg.source, msg); // buffered for on-demand vision (§5); not persisted
        break;
      case "assistant.say":
        // worker-side governor (H4): speak, the worker tears down afterwards
        void this.speakGoodbye(msg.text);
        break;
      case "session.end":
        this.log.info(`session.end from worker: ${msg.reason}`);
        this.teardown("worker-session-end");
        break;
      default:
        this.log.debug(`ignoring worker message type ${(msg as { type: string }).type}`);
    }
  }

  private async onSessionStart(msg: SessionStartMessage): Promise<void> {
    if (msg.callId && msg.callId !== this.callId) {
      // must match the HMAC-authenticated callId in the URL path (Protocol.cs)
      this.log.error(`session.start callId ${msg.callId} != URL callId ${this.callId}; closing`);
      this.teardown("callid-mismatch");
      return;
    }
    this.log.info(`session.start (direction=${msg.direction ?? "inbound"}, recording=${msg.recordingStatus ?? "unknown"})`);
    this.recordingActive = msg.recordingStatus === "active";

    try {
      this.el = await this.connectEl(this.cfg, this.log, {
        onMessage: (m) => this.onElMessage(m),
        onClose: (code, reason) => {
          this.log.info(`EL socket closed (${code} ${reason})`);
          this.endCall("agent-disconnected");
        },
        onError: (err) => this.log.warn(`EL socket error: ${err.message}`),
      });
    } catch (err) {
      this.log.error(`could not open ElevenLabs session: ${(err as Error).message}`);
      this.endCall("agent-unavailable");
      return;
    }

    // Per-call personalization (spec §6). CallerInfo fields are all nullable — default, never send null.
    this.el.sendConversationInit(
      buildConversationInit({
        dynamicVariables: {
          caller_name: msg.caller?.displayName?.trim() || "caller",
          tenant_id: msg.caller?.tenantId?.trim() || "unknown-tenant",
          call_direction: msg.direction?.trim() || "inbound",
        },
        environment: this.cfg.elEnvironment,
      }),
    );
    this.log.info("ElevenLabs agent session open; relaying");

    // Bridge-side governor (spec §9): ElevenLabs doesn't know about your billing.
    if (this.cfg.maxCallMinutes > 0) {
      const limitMs = this.cfg.maxCallMinutes * 60_000;
      this.governorTimer = setTimeout(() => void this.onGovernorLimit(), limitMs);
      this.log.info(`governor armed: max ${this.cfg.maxCallMinutes} min`);
    }
  }

  /** Time limit hit: speak the goodbye, let it play out, then tear the call down. */
  private async onGovernorLimit(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.log.info("governor: call time limit reached");
    const playedMs = await this.speakGoodbye(this.cfg.goodbyeText);
    // deterministic TTS reports its real duration; the agent-side fallback doesn't
    const graceMs = playedMs ?? this.cfg.goodbyeGraceMs;
    setTimeout(() => this.endCall("time-limit"), graceMs + 500);
  }

  // ---- EL → bridge ----

  private onElMessage(msg: ElInbound): void {
    switch (msg.type) {
      case "audio": {
        const ev = (msg as ElAudioEvent).audio_event;
        if (ev.event_id <= this.lastInterruptEventId) {
          this.log.debug(`dropping ghost audio event ${ev.event_id} (interrupted at ${this.lastInterruptEventId})`);
          return;
        }
        this.emitAudioToWorker(ev.audio_base_64);
        break;
      }
      case "interruption": {
        const ev = (msg as ElInterruption).interruption_event;
        this.lastInterruptEventId = Math.max(this.lastInterruptEventId, ev.event_id);
        // TurnId = EL event_id; the worker's FlushPlayback ignores the value but the field must serialize (spec §2)
        this.sendToWorker({ type: "assistant.cancel", turnId: ev.event_id });
        this.log.info(`barge-in: interruption at event ${ev.event_id}`);
        break;
      }
      case "ping": {
        const ev = (msg as ElPing).ping_event;
        this.el?.sendPong(ev.event_id);
        break;
      }
      case "user_transcript":
      case "agent_response": {
        // Recording gate (spec §7): never log/persist transcripts unless Teams recording is active.
        if (this.cfg.logTranscripts && this.recordingActive) {
          this.log.info(`${msg.type}`, msg);
        }
        break;
      }
      case "client_tool_call":
        this.onClientToolCall(msg as ElClientToolCall);
        break;
      case "conversation_initiation_metadata":
      case "vad_score":
        break; // metadata handled in ElAgentSocket; vad is informational
      default:
        this.log.debug(`ignoring EL message type ${msg.type}`);
    }
  }

  /**
   * Map agent client tools → worker capabilities (spec §2):
   * end_call → session.end, express → expression, show_image → display.image.
   */
  private onClientToolCall(msg: ElClientToolCall): void {
    const call = msg.client_tool_call;
    const params = call.parameters ?? {};
    switch (call.tool_name) {
      case "end_call":
        this.el?.sendClientToolResult(call.tool_call_id, "call ended", false);
        this.log.info("agent requested end_call");
        this.endCall("agent-ended-call");
        return;
      case "express": {
        const emotion = typeof params.emotion === "string" ? params.emotion : "";
        if (!emotion) {
          this.el?.sendClientToolResult(call.tool_call_id, "express requires an 'emotion' parameter", true);
          return;
        }
        this.sendToWorker({ type: "expression", emotion });
        this.el?.sendClientToolResult(call.tool_call_id, `expressing ${emotion}`, false);
        return;
      }
      case "show_image":
        void this.onShowImage(call.tool_call_id, params);
        return;
      case "look":
        void this.onLook(call.tool_call_id, params);
        return;
      default:
        this.el?.sendClientToolResult(call.tool_call_id, `tool "${call.tool_name}" is not implemented by this bridge`, true);
        this.log.warn(`unmapped client tool: ${call.tool_name}`);
    }
  }

  /**
   * show_image → display.image on the bot's video tile. Accepts either inline
   * base64 ({dataBase64, mime}) or a URL the bridge fetches server-side.
   */
  private async onShowImage(toolCallId: string, params: Record<string, unknown>): Promise<void> {
    try {
      let dataBase64 = typeof params.dataBase64 === "string" ? params.dataBase64 : null;
      let mime = typeof params.mime === "string" ? params.mime : null;
      const url = typeof params.url === "string" ? params.url : null;
      if (!dataBase64 && url) {
        const res = await fetch(url);
        if (!res.ok) {
          throw new Error(`fetch ${url} → HTTP ${res.status}`);
        }
        mime = res.headers.get("content-type")?.split(";")[0] ?? "image/jpeg";
        dataBase64 = Buffer.from(await res.arrayBuffer()).toString("base64");
      }
      if (!dataBase64 || !mime || !/^image\/(jpeg|png)$/.test(mime)) {
        throw new Error("show_image needs {dataBase64, mime} or {url} resolving to image/jpeg or image/png");
      }
      this.sendToWorker({
        type: "display.image",
        dataBase64,
        mime,
        durationMs: typeof params.durationMs === "number" ? params.durationMs : null,
        mode: typeof params.mode === "string" ? params.mode : null,
        ts: 0,
        caption: typeof params.caption === "string" ? params.caption : null,
      });
      this.el?.sendClientToolResult(toolCallId, "image is being shown to the caller", false);
    } catch (err) {
      this.log.warn(`show_image failed: ${(err as Error).message}`);
      this.el?.sendClientToolResult(toolCallId, `show_image failed: ${(err as Error).message}`, true);
    }
  }

  /**
   * Vision on demand (spec §5) — agent client tool `look`
   * ({source?: "camera"|"screenshare", question?: string}).
   *
   * Route: prefer path 2 (describe via YOUR vision model → answer in the tool
   * result; frames are processed transiently, not persisted). Fall back to
   * path 1 (upload to ElevenLabs + multimodal_message) — that one PERSISTS the
   * frame with a third party, so it is gated on Teams recording being active
   * (spec §7).
   */
  private async onLook(toolCallId: string, params: Record<string, unknown>): Promise<void> {
    const requested = typeof params.source === "string" ? params.source : null;
    const frame =
      (requested && this.latestVideoFrame.get(requested)) ??
      this.latestVideoFrame.get("screenshare") ??
      this.latestVideoFrame.get("camera");
    if (!frame) {
      this.el?.sendClientToolResult(
        toolCallId,
        "no video is available — the caller has not shared their camera or screen",
        true,
      );
      return;
    }
    const question =
      typeof params.question === "string" && params.question.trim()
        ? params.question.trim()
        : "Describe what is visible.";
    try {
      if (this.vision) {
        const description = await this.vision(frame, question);
        this.el?.sendClientToolResult(toolCallId, description, false);
        return;
      }
      if (!this.recordingActive) {
        this.el?.sendClientToolResult(
          toolCallId,
          "cannot inspect video: Teams recording is not active, so frames may not be shared (and no local vision endpoint is configured)",
          true,
        );
        return;
      }
      const who =
        frame.source === "screenshare"
          ? `screen shared by ${frame.participantName ?? "a participant"}`
          : `camera of ${frame.participantName ?? "the caller"}`;
      await this.el!.attachImage(
        Buffer.from(frame.dataBase64, "base64"),
        frame.mime,
        `[live Teams frame: ${who}] ${question}`,
      );
      this.el?.sendClientToolResult(toolCallId, "the frame was attached to the conversation — answer based on it", false);
    } catch (err) {
      this.log.warn(`look failed: ${(err as Error).message}`);
      this.el?.sendClientToolResult(toolCallId, `look failed: ${(err as Error).message}`, true);
    }
  }

  // ---- governor goodbye (spec §2 assistant.say) ----

  /**
   * Speak a goodbye line. Preferred: deterministic, the exact text via
   * standalone TTS (returns the real audio duration in ms). Fallback: ask the
   * agent itself via user_message (returns null, duration unknown).
   */
  private async speakGoodbye(text: string): Promise<number | null> {
    this.log.info("speaking goodbye");
    if (this.cfg.elTtsVoiceId) {
      try {
        const pcm = await synthesizeGoodbye(this.cfg, text);
        this.emitAudioToWorker(pcm.toString("base64"));
        return pcm16kBytesToMs(pcm.length);
      } catch (err) {
        this.log.warn(`goodbye TTS failed (${(err as Error).message}); falling back to user_message`);
      }
    }
    this.el?.sendUserMessage(`[system: the call is about to end due to a time limit. Say a brief goodbye now: "${text}"]`);
    return null;
  }

  // ---- plumbing ----

  private emitAudioToWorker(base64Pcm: string): void {
    const frame: AudioFrameMessage = {
      type: "audio.frame",
      seq: this.outSeq++,
      timestampMs: Math.round(this.outTimestampMs),
      payloadBase64: base64Pcm,
    };
    // advance the timeline by the actual PCM duration (base64 → bytes → ms)
    this.outTimestampMs += pcm16kBytesToMs(Buffer.byteLength(base64Pcm, "base64"));
    this.sendToWorker(frame);
  }

  private sendToWorker(msg: WorkerOutbound): void {
    if (this.worker.readyState === this.worker.OPEN) {
      this.worker.send(JSON.stringify(msg));
    }
  }

  /** Ask the worker to tear the call down, then close both sockets. */
  private endCall(reason: string): void {
    if (!this.closed) {
      this.sendToWorker({ type: "session.end", reason });
    }
    this.teardown(reason);
  }

  private teardown(reason: string): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.log.info(`teardown: ${reason}`);
    if (this.governorTimer) {
      clearTimeout(this.governorTimer);
      this.governorTimer = null;
    }
    try {
      this.el?.close();
    } catch {
      /* already closing */
    }
    try {
      this.worker.close(1000, reason);
    } catch {
      /* already closing */
    }
    this.latestVideoFrame.clear();
  }
}
