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
import { assertPublicHttpUrl, readBodyWithCap } from "./ssrf.js";

/** show_image fetch cap: display.image goes to a 640×360 tile; 5 MB is generous. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Pending caller-audio cap while EL connects: 250 × 20 ms = 5 s. */
const MAX_PENDING_AUDIO_FRAMES = 250;

/** Outbound (bridge→worker) send-buffer cap. Above this, drop realtime frames
 *  instead of letting a stalled worker balloon memory. Matches the siblings. */
const MAX_OUTBOUND_BUFFER_BYTES = 1 * 1024 * 1024;

/** Pending contextual-update cap while EL connects (participants/dtmf). */
const MAX_PENDING_CONTEXT = 32;

/** Extra headroom on top of the goodbye grace before the governor force-ends the
 *  call, so a hung TTS synth can never wedge a time-limited call open (H3). */
const GOODBYE_HARD_CAP_MS = 8_000;

/** Min gap between "now speaking" contextual updates (group calls), so VAD
 *  flapping between speakers cannot spam the agent. */
const SPEAKER_UPDATE_MIN_INTERVAL_MS = 5_000;

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
  // highest event_id relayed so far — the flush point for goodbye ghost-dropping
  private lastSeenAudioEventId = 0;
  // hard mute: set ONLY while a deterministic TTS goodbye plays (never for the
  // user_message fallback, where the agent itself must stay audible)
  private muteAgentAudio = false;
  // first goodbye wins: both governors (worker assistant.say + bridge time limit) can race
  private goodbyeInProgress = false;
  // group-call speaker attribution: last name surfaced + a rate limit so VAD flapping can't spam
  private lastSpeakerName: string | null = null;
  private lastSpeakerUpdateMs = 0;
  private participantCount = 1;
  // caller audio arriving while the EL socket is still connecting (session.start → open)
  private pendingAudio: string[] = [];
  private sessionStarted = false;

  // Teams recording gate (spec §7): transcripts may be logged/persisted only when "active"
  private recordingActive = false;

  // vision groundwork (spec §5): latest inbound frame per source, memory only
  private readonly latestVideoFrame = new Map<string, VideoFrameMessage>();

  // bridge-side call governor (spec §9)
  private governorTimer: NodeJS.Timeout | null = null;
  // hard-bounded teardown timer for the goodbye grace (so a hung TTS can't wedge the call open)
  private goodbyeTimer: NodeJS.Timeout | null = null;
  // contextual updates (participants/dtmf) that arrived before the EL socket was open
  private pendingContext: string[] = [];
  // invoked exactly once when the session tears down (server uses it to de-register)
  private readonly onClosed: (() => void) | undefined;

  constructor(
    cfg: BridgeConfig,
    worker: WebSocket,
    callId: string,
    connectEl: ElConnector = ElAgentSocket.connect,
    vision: VisionDescriber | null = makeVisionDescriber(cfg),
    onClosed?: () => void,
  ) {
    this.cfg = cfg;
    this.worker = worker;
    this.callId = callId;
    this.log = logger(`call:${callId.slice(0, 12)}`);
    this.connectEl = connectEl;
    this.vision = vision;
    this.onClosed = onClosed;

    worker.on("message", (data) => {
      // parity with the EL side: a handler throw must not escape the ws
      // listener (uncaught exception → process down)
      try {
        this.onWorkerMessage(data as Buffer);
      } catch (err) {
        this.log.error(`error handling worker message: ${(err as Error).message}`);
      }
    });
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
        this.onSessionStart(msg).catch((err) =>
          this.log.error(`session.start handling failed: ${(err as Error).message}`),
        );
        break;
      case "audio.frame":
        // hot path: caller audio → agent, verbatim. While the EL socket is
        // still connecting, buffer (bounded) instead of dropping the caller's
        // first words; flushed right after conversation init.
        if (this.el) {
          this.el.sendAudioChunk(msg.payloadBase64);
          this.noteSpeaker(msg.speakerName);
        } else if (this.sessionStarted) {
          this.pendingAudio.push(msg.payloadBase64);
          if (this.pendingAudio.length > MAX_PENDING_AUDIO_FRAMES) {
            this.pendingAudio.shift(); // keep the most recent speech
          }
        }
        break;
      case "ping":
        this.sendToWorker({ type: "pong", ts: msg.ts });
        break;
      case "participants":
        this.participantCount = msg.count;
        this.pushContext(
          msg.count <= 1
            ? "This is a 1:1 call with a single human caller."
            : `There are ${msg.count} human participants on this call. Stay quiet unless directly addressed.`,
        );
        break;
      case "dtmf":
        this.pushContext(`The caller pressed the "${msg.digit}" key on their keypad.`);
        break;
      case "recording.status":
        this.recordingActive = msg.status === "active";
        this.log.info(`recording.status = ${msg.status}`);
        break;
      case "video.frame":
        // Known sources only (camera/screenshare): the key comes from the peer, so an
        // unexpected value must not grow the map unbounded (review LOW).
        if (msg.source === "camera" || msg.source === "screenshare") {
          this.latestVideoFrame.set(msg.source, msg); // buffered for on-demand vision (§5); not persisted
        } else {
          this.log.debug(`ignoring video.frame with unknown source "${msg.source}"`);
        }
        break;
      case "assistant.say":
        // worker-side governor (H4): speak, the worker tears down afterwards
        this.performGoodbye(msg.text).catch((err) =>
          this.log.error(`goodbye failed: ${(err as Error).message}`),
        );
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
    if (this.sessionStarted) {
      // A second session.start would orphan the first EL socket; the worker
      // sends exactly one per connection, so treat a repeat as a protocol error.
      this.log.warn("duplicate session.start ignored");
      return;
    }
    this.sessionStarted = true;
    if (msg.callId && msg.callId !== this.callId) {
      // must match the HMAC-authenticated callId in the URL path (wire contract)
      this.log.error(`session.start callId ${msg.callId} != URL callId ${this.callId}; closing`);
      this.teardown("callid-mismatch");
      return;
    }
    this.log.info(`session.start (direction=${msg.direction ?? "inbound"}, recording=${msg.recordingStatus ?? "unknown"})`);
    this.recordingActive = msg.recordingStatus === "active";

    let el: AgentPort;
    try {
      el = await this.connectEl(this.cfg, this.log, {
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

    // C1: the worker may have dropped (ring cancelled, rollout) DURING the connect
    // above. If so, teardown already ran with this.el still null — assigning the
    // just-opened socket now would orphan a live, billed ElevenLabs conversation
    // that nothing ever closes. Close it and bail.
    if (this.closed) {
      this.log.info("worker closed during EL connect; closing the orphaned agent socket");
      try {
        el.close();
      } catch {
        /* already closing */
      }
      return;
    }
    this.el = el;

    // Per-call personalization (spec §6). CallerInfo fields are all nullable — default, never send null.
    this.el.sendConversationInit(
      buildConversationInit({
        dynamicVariables: {
          caller_name: msg.caller?.displayName?.trim() || "caller",
          tenant_id: msg.caller?.tenantId?.trim() || "unknown-tenant",
          call_direction: msg.direction?.trim() || "inbound",
        },
        environment: this.cfg.elEnvironment,
        firstMessage: this.cfg.elFirstMessage,
        // per-person memory: AAD id when known; omitted for guests/anonymous so
        // distinct callers never share an identity (CallerInfo fields are nullable on the wire)
        userId: msg.caller?.aadId?.trim() || null,
        branchId: this.cfg.elAgentBranchId,
      }),
    );
    // flush caller audio buffered while the socket was connecting
    for (const chunk of this.pendingAudio) {
      this.el.sendAudioChunk(chunk);
    }
    this.pendingAudio = [];
    // flush contextual updates (participants/dtmf) that arrived during the connect
    // window — the "N humans, stay quiet" signal often lands right at join (MED-2)
    for (const text of this.pendingContext) {
      this.el.sendContextualUpdate(text);
    }
    this.pendingContext = [];
    this.log.info("ElevenLabs agent session open; relaying");

    // Bridge-side governor (spec §9): ElevenLabs doesn't know about your billing.
    if (this.cfg.maxCallMinutes > 0) {
      const limitMs = this.cfg.maxCallMinutes * 60_000;
      this.governorTimer = setTimeout(() => {
        this.onGovernorLimit().catch((err) => this.log.error(`governor error: ${(err as Error).message}`));
      }, limitMs);
      this.log.info(`governor armed: max ${this.cfg.maxCallMinutes} min`);
    }
  }

  /** Time limit hit: speak the goodbye, let it play out, then tear the call down. */
  private async onGovernorLimit(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.log.info("governor: call time limit reached");
    // H3: guarantee teardown regardless of the goodbye. Arm a HARD-bounded
    // deadline BEFORE awaiting performGoodbye — a hung/slow ElevenLabs TTS must
    // never wedge the call open past its limit (the worker's H4 does the same).
    const hardMs = this.cfg.goodbyeGraceMs + GOODBYE_HARD_CAP_MS;
    this.goodbyeTimer = setTimeout(() => this.endCall("time-limit"), hardMs);
    this.goodbyeTimer.unref?.();
    // performGoodbye's TTS fetch is itself time-bounded (see synthesizeGoodbye).
    const playedMs = await this.performGoodbye(this.cfg.goodbyeText);
    if (this.closed) {
      return; // the hard deadline (or another path) already tore down
    }
    // Deterministic TTS reports its real duration; the agent-side fallback does
    // not. Reschedule to the real grace, but never later than the hard cap.
    const graceMs = Math.min(playedMs ?? this.cfg.goodbyeGraceMs, hardMs);
    if (this.goodbyeTimer) {
      clearTimeout(this.goodbyeTimer);
    }
    this.goodbyeTimer = setTimeout(() => this.endCall("time-limit"), graceMs + 500);
    this.goodbyeTimer.unref?.();
  }

  /**
   * Group-call speaker attribution (review LOW / sibling parity): the worker tags
   * audio.frame with the active speaker's display name. Surface it to the agent
   * as a non-interrupting contextual update so it can reason about who said what.
   * Only in group calls (1:1 attribution is noise), only when the name CHANGES,
   * and rate-limited so VAD flapping between speakers cannot spam the agent.
   */
  private noteSpeaker(name: string | null | undefined): void {
    if (!name || this.participantCount <= 1) {
      return;
    }
    const now = Date.now();
    if (name === this.lastSpeakerName || now - this.lastSpeakerUpdateMs < SPEAKER_UPDATE_MIN_INTERVAL_MS) {
      return;
    }
    this.lastSpeakerName = name;
    this.lastSpeakerUpdateMs = now;
    this.el?.sendContextualUpdate(`The person now speaking is ${name}.`);
  }

  /**
   * Queue a contextual update (participants/dtmf). While the EL socket is still
   * connecting it is buffered (MED-2) and flushed after conversation init, so a
   * "N humans on the call" signal that lands right at join is not lost.
   */
  private pushContext(text: string): void {
    if (this.el) {
      this.el.sendContextualUpdate(text);
    } else if (this.sessionStarted && !this.closed) {
      this.pendingContext.push(text);
      if (this.pendingContext.length > MAX_PENDING_CONTEXT) {
        this.pendingContext.shift();
      }
    }
  }

  // ---- EL → bridge ----

  private onElMessage(msg: ElInbound): void {
    // Defensive: one malformed EL frame must never throw out of the ws message
    // listener (that would be an uncaught exception → process down). Guard the
    // nested event objects like parseWorkerMessage guards the worker side.
    switch (msg.type) {
      case "audio": {
        const ev = (msg as ElAudioEvent).audio_event;
        if (!ev || typeof ev.event_id !== "number" || typeof ev.audio_base_64 !== "string") {
          this.log.warn("EL audio frame missing audio_event/event_id/audio_base_64; dropping");
          return;
        }
        this.lastSeenAudioEventId = Math.max(this.lastSeenAudioEventId, ev.event_id);
        if (this.muteAgentAudio) {
          this.log.debug(`dropping agent audio ${ev.event_id} (deterministic goodbye playing)`);
          return;
        }
        if (ev.event_id <= this.lastInterruptEventId) {
          this.log.debug(`dropping ghost audio event ${ev.event_id} (interrupted at ${this.lastInterruptEventId})`);
          return;
        }
        this.emitAudioToWorker(ev.audio_base_64);
        break;
      }
      case "interruption": {
        const ev = (msg as ElInterruption).interruption_event;
        if (!ev || typeof ev.event_id !== "number") {
          this.log.warn("EL interruption missing interruption_event/event_id; dropping");
          return;
        }
        this.lastInterruptEventId = Math.max(this.lastInterruptEventId, ev.event_id);
        // TurnId = EL event_id; the worker's FlushPlayback ignores the value but the field must serialize (spec §2)
        this.sendToWorker({ type: "assistant.cancel", turnId: ev.event_id });
        this.log.info(`barge-in: interruption at event ${ev.event_id}`);
        break;
      }
      case "ping": {
        const ev = (msg as ElPing).ping_event;
        if (!ev || typeof ev.event_id !== "number") {
          this.log.warn("EL ping missing ping_event/event_id; dropping");
          return;
        }
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
      case "client_tool_call": {
        const call = (msg as ElClientToolCall).client_tool_call;
        if (!call || typeof call.tool_name !== "string" || typeof call.tool_call_id !== "string") {
          this.log.warn("EL client_tool_call missing tool_name/tool_call_id; dropping");
          return;
        }
        this.onClientToolCall(msg as ElClientToolCall);
        break;
      }
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
        this.onShowImage(call.tool_call_id, params).catch((err) =>
          this.log.error(`show_image failed: ${(err as Error).message}`),
        );
        return;
      case "look":
        this.onLook(call.tool_call_id, params).catch((err) =>
          this.log.error(`look failed: ${(err as Error).message}`),
        );
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
        // SSRF guard: the URL is agent-(LLM-)controlled, i.e. indirectly caller-controlled.
        // Public hosts only, no redirects (rebind bypass), bounded time and size.
        const safeUrl = await assertPublicHttpUrl(url);
        const res = await fetch(safeUrl, { redirect: "error", signal: AbortSignal.timeout(10_000) });
        if (!res.ok) {
          throw new Error(`fetch ${url} → HTTP ${res.status}`);
        }
        mime = res.headers.get("content-type")?.split(";")[0] ?? "image/jpeg";
        const body = await readBodyWithCap(res, MAX_IMAGE_BYTES); // streams; rejects before buffering an oversized body
        dataBase64 = body.toString("base64");
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
        // Path 2 is INTENTIONALLY NOT recording-gated (owner decision 2026-07-10).
        // The raw frame never leaves the bridge — only a text description does —
        // but note that description becomes ElevenLabs conversation content, which
        // EL persists by default. Operators who need "no vision until recording is
        // on" should enable EL zero-retention or use recording-gated path 1. See
        // "Vision and recording" in the README.
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
      const el = this.el;
      if (!el) {
        throw new Error("agent connection is not open");
      }
      const who =
        frame.source === "screenshare"
          ? `screen shared by ${frame.participantName ?? "a participant"}`
          : `camera of ${frame.participantName ?? "the caller"}`;
      await el.attachImage(
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
   * Speak a goodbye line (both governors: worker assistant.say and the
   * bridge-side time limit). Flushes buffered playback first (assistant.cancel
   * + drop in-flight ghosts up to the last seen event_id) so stale agent audio
   * cannot delay the goodbye.
   *
   * Preferred: deterministic, the exact text via standalone TTS — the agent is
   * hard-muted while it plays and the real duration (ms) is returned.
   * Fallback: the agent itself says it via user_message — its audio MUST keep
   * relaying (mute stays off), duration unknown (null).
   */
  private async performGoodbye(text: string): Promise<number | null> {
    // Both governors can race (worker assistant.say + bridge time limit). Running
    // performGoodbye twice would double-speak and leave the mute latch in an
    // ambiguous state (review LOW: double-goodbye) — first one wins.
    if (this.goodbyeInProgress) {
      this.log.info("goodbye already in progress; ignoring duplicate");
      return null;
    }
    this.goodbyeInProgress = true;
    this.log.info("speaking goodbye");
    this.sendToWorker({ type: "assistant.cancel", turnId: 0 });
    this.lastInterruptEventId = Math.max(this.lastInterruptEventId, this.lastSeenAudioEventId);
    if (this.cfg.elTtsVoiceId) {
      try {
        this.muteAgentAudio = true; // only the deterministic goodbye may speak now
        const pcm = await synthesizeGoodbye(this.cfg, text);
        this.emitAudioToWorker(pcm.toString("base64"));
        return pcm16kBytesToMs(pcm.length);
      } catch (err) {
        this.muteAgentAudio = false; // fallback: the agent must stay audible
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
    if (this.worker.readyState !== this.worker.OPEN) {
      return;
    }
    // Backpressure guard: ws.send is fire-and-forget, so if the worker stalls,
    // bufferedAmount grows unbounded (50 audio.frames/s) and leaks memory.
    // Above the cap, drop this frame rather than queue it — audio is realtime,
    // a stale frame is worthless, and this bounds memory (parity with siblings).
    if (this.worker.bufferedAmount > MAX_OUTBOUND_BUFFER_BYTES) {
      this.log.warn(`dropping ${msg.type} — worker send buffer backpressure (${this.worker.bufferedAmount} bytes)`);
      return;
    }
    this.worker.send(JSON.stringify(msg));
  }

  /** Graceful external shutdown (e.g. SIGTERM drain): tell the worker the call
   *  is ending, then close both sockets. Idempotent via teardown's closed flag. */
  shutdown(reason: string): void {
    this.endCall(reason);
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
    if (this.goodbyeTimer) {
      clearTimeout(this.goodbyeTimer);
      this.goodbyeTimer = null;
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
    this.pendingAudio = [];
    this.pendingContext = [];
    // let the server de-register this call (registry eviction, dup-callId dedup)
    try {
      this.onClosed?.();
    } catch {
      /* registry callback must never throw back into teardown */
    }
  }
}
