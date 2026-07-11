# basic-bridge example

A minimal, runnable embedding of [`@komaa/elevenlabs-msteams-bridge`](https://www.npmjs.com/package/@komaa/elevenlabs-msteams-bridge): your ElevenLabs agent answering a real Microsoft Teams call, with a custom vision hook.

## What it demonstrates

- **Programmatic use of the package** - `loadConfig()` + `startServer()` instead of the CLI, so the bridge runs inside *your* Node process next to your own code.
- **A custom `VisionDescriber`** - when the agent calls its `look` client tool ("what's on the caller's screen?"), *your* function receives the latest camera/screen-share frame and returns the answer. The raw frame never leaves your process; only your text description reaches ElevenLabs. The stub in `index.mjs` shows the wiring; swap in any vision model.
- **Env-file configuration** - the same variables as the CLI, loaded with Node's built-in `--env-file`, documented one by one in [.env.example](./.env.example).
- **Graceful shutdown for free** - on Ctrl-C / SIGTERM the bridge ends every live call cleanly (the caller hears the call end properly instead of dead air).

## Prerequisites

- **Node.js `>= 20`**.
- **An ElevenLabs agent** (Agents dashboard) and an **API key**. The agent's audio input AND output format must be **PCM 16000 Hz** in its voice settings, or you will get garbled audio.
- **A StandIn identity** - StandIn ([standin.komaa.com](https://standin.komaa.com)) is the hosted service that joins the Teams call and dials into this bridge. The sandbox tier works for a first call; pairing gives you the shared secret.

## Run it

Install, create your `.env`, and start:

```bash
npm install
```

```bash
cp .env.example .env
```

Edit `.env`, then:

```bash
npm start
```

You should see the bridge start and print the WebSocket URL to give StandIn:

```text
basic-bridge example is up.
Point your StandIn identity's agent WebSocket URL at ws://<this-host>:8080/voice/msteams/stream
```

> **No credentials yet?** The example still starts and listens with dummy values for the three
> required variables - handy for checking the wiring.

## Make it reachable by StandIn

StandIn dials your bridge **from the internet**, so a laptop/private host needs a tunnel. The tunnel
gives you a public `wss://` URL and terminates TLS for you. Run one alongside `npm start`, pointing at
port `8080`, then give StandIn the `wss://…/voice/msteams/stream` form of the printed host.

Tailscale Funnel:

```bash
tailscale funnel --bg --https=8080 8080
```

Cloudflare Tunnel (quick, throwaway hostname):

```bash
cloudflared tunnel --url http://localhost:8080
```

ngrok:

```bash
ngrok http 8080
```

VS Code dev tunnels:

```bash
devtunnel host -p 8080 --allow-anonymous
```

Then set your StandIn identity's **agent WebSocket URL** to `wss://<the-public-host>/voice/msteams/stream`
and its shared secret to your `WORKER_SHARED_SECRET`. Never give StandIn a plain `ws://` URL outside
local testing.

## The .env, variable by variable

Required:

| Variable | What it is |
|---|---|
| `ELEVENLABS_API_KEY` | Your ElevenLabs API key. Stays server-side in the bridge (used to open agent conversations, mint signed URLs, and synthesize the goodbye). It is never sent toward the Teams side, and the bridge refuses to send it to any non-`*.elevenlabs.io` host. |
| `ELEVENLABS_AGENT_ID` | The agent that answers the call. |
| `WORKER_SHARED_SECRET` | The shared secret from your StandIn identity (pairing issues it). StandIn signs each connection with it; a mismatch is rejected with 401. |

Common options (all in [.env.example](./.env.example) with comments):

| Variable | What it does |
|---|---|
| `PORT` / `BIND` | Where the bridge listens (default `0.0.0.0:8080`). StandIn dials `ws(s)://host:port/voice/msteams/stream/{callId}`. |
| `EL_TTS_VOICE_ID` | Turns on the **deterministic goodbye**: time-limit goodbyes are spoken as the exact configured text via ElevenLabs standalone TTS. Without it the agent improvises the goodbye. |
| `MAX_CALL_MINUTES` | Bridge-side hard cap per call (fractional ok, `0` = off). ElevenLabs does not know your budget; this does. |
| `GOODBYE_TEXT` | The line spoken when the cap hits. |
| `VISION_API_URL` / `VISION_API_KEY` / `VISION_MODEL` | Built-in vision path 2 (any OpenAI-compatible endpoint). This example replaces it with the code hook in `index.mjs`; remove the hook to use these instead. |
| `EL_HOST` | Regional ElevenLabs host (US/EU/India/Singapore residency + latency). |
| `EL_FIRST_MESSAGE` | Spoken greeting / AI disclosure at call start (must be allowlisted in the agent's security settings). |
| `LOG_LEVEL` | `debug` `info` `warn` `error`. |

## Using the published package

This example depends on the local checkout (`"file:../.."`) so it always runs against the code in
this repository. In your own project, depend on the published package instead:

```bash
npm install @komaa/elevenlabs-msteams-bridge
```

## Next steps

- Full docs: [komaa-com.github.io/elevenlabs-msteams-bridge](https://komaa-com.github.io/elevenlabs-msteams-bridge/)
- Library API (custom transports, HMAC helpers, protocol types): [Library API](https://komaa-com.github.io/elevenlabs-msteams-bridge/library-api/)
- Agent client tools to define on the ElevenLabs side (`look`, `show_image`, `express`, `end_call`): [Vision and Tools](https://komaa-com.github.io/elevenlabs-msteams-bridge/vision-and-tools/)
