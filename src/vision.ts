import type { BridgeConfig } from "./config.js";
import type { VideoFrameMessage } from "./protocol.js";

/**
 * Vision path 2 (spec §5, "describe-then-inject"): run the buffered frame
 * through YOUR vision model and return a short text description. Model-agnostic:
 * any OpenAI-compatible chat-completions endpoint with image_url input
 * (OpenAI, Azure OpenAI, Ollama, vLLM, ...). Frames are sent transiently for
 * inference, not persisted — which is why this path is allowed even before the
 * Teams recording gate opens, unlike the ElevenLabs file upload (path 1).
 */

export type VisionDescriber = (frame: VideoFrameMessage, question: string) => Promise<string>;

export function makeVisionDescriber(cfg: BridgeConfig): VisionDescriber | null {
  if (!cfg.visionApiUrl || !cfg.visionModel) {
    return null;
  }
  const url = cfg.visionApiUrl;
  const model = cfg.visionModel;
  const key = cfg.visionApiKey;

  return async (frame, question) => {
    const who =
      frame.source === "screenshare"
        ? `screen shared by ${frame.participantName ?? "a participant"}`
        : `camera of ${frame.participantName ?? "the caller"}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({
        model,
        max_tokens: 300,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  `This is a live frame from a Microsoft Teams call (${who}). ` +
                  `Answer concisely for a voice agent to relay aloud. Question: ${question}`,
              },
              {
                type: "image_url",
                image_url: { url: `data:${frame.mime};base64,${frame.dataBase64}` },
              },
            ],
          },
        ],
      }),
    });
    if (!res.ok) {
      throw new Error(`vision endpoint HTTP ${res.status} ${await res.text().catch(() => "")}`);
    }
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = body.choices?.[0]?.message?.content?.trim();
    if (!text) {
      throw new Error("vision endpoint returned no content");
    }
    return text;
  };
}
