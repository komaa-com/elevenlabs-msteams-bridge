---
title: "Vision and Tools"
description: "The look tool (both vision paths and the data-flow trade-off), plus show_image, express, and end_call."
---

The ElevenLabs agent drives the Teams side through **client tools**. Define these on the agent (Agent > Tools > Client tools); the bridge maps each one onto a Teams capability.

## `look` - see the caller's camera or screen

Define a client tool named `look` with optional parameters `source` (`camera` or `screenshare`) and `question`. When the agent calls it, the bridge takes the latest buffered frame and answers one of two ways.

### Path 2 - describe (preferred, if `VISION_API_URL`/`VISION_MODEL` are set)

The frame goes to your OpenAI-compatible vision endpoint (or your custom `VisionDescriber`) and the text description comes back as the tool result. The **raw frame never leaves the bridge** - only the description does - and it works **regardless of recording state**.

:::caution
Know the data flow: the description becomes ElevenLabs conversation content, which ElevenLabs **persists by default**. So a description of the caller's screen or camera can be stored by a third party even when Teams recording is off. This is a deliberate choice so vision stays usable without recording. If your deployment needs "no vision until recording is on," enable ElevenLabs zero-retention on the agent, or leave `VISION_API_URL` unset so only the recording-gated path 1 is available.
:::

### Path 1 - upload (fallback)

If no vision endpoint is configured, the frame is uploaded to the live ElevenLabs conversation and injected as a `multimodal_message` (the agent's LLM must be multimodal). Because this **persists the raw frame** with a third party, it is refused unless Teams recording is `active`.

## `show_image` - put an image on the bot's tile

Parameters: either inline `{dataBase64, mime}` or `{url}` (jpeg/png). The bridge sends a `display.image` to the Teams side.

:::caution
A `url` is agent-controlled, i.e. indirectly caller-controlled. The bridge SSRF-guards it: public hosts only, no redirects (closing a DNS-rebind bypass), and bounded fetch time and size.
:::

## `express` - avatar emotion

Parameter: `{emotion}`. The bridge forwards an `expression` cue so the bot's avatar reflects the agent's sentiment.

## `end_call` - hang up

The agent decides the call is done. The bridge acknowledges the tool, sends `session.end` to StandIn, and tears down both sockets.

## Group-call awareness (no tool needed)

The bridge feeds the agent non-interrupting context automatically: participant counts ("N humans on the call, stay quiet unless directly addressed"), DTMF key presses, and - in group calls - a rate-limited note when the active speaker changes. This helps the agent stay quiet in meetings until addressed.
