---
title: "Getting Started"
description: "Install the bridge, configure the three required variables, connect a StandIn identity, and make your first Teams call to an ElevenLabs agent."
---

By the end of this page an ElevenLabs agent answers a Microsoft Teams call. You need Node.js `>= 20`, an ElevenLabs agent + API key, and a StandIn identity (the sandbox is enough).

## 1. Prepare the ElevenLabs agent

1. Create (or pick) an agent in the ElevenLabs **Agents** dashboard and note its **agent id**.
2. Set the agent's audio **input format** and **output format** to **PCM 16000 Hz** in its voice settings. This is required: the bridge relays audio verbatim, so any other format means garbled audio on the call.
3. Create an **API key** with access to the agent.

:::note
If you plan to use overrides (`EL_FIRST_MESSAGE`, prompt or voice overrides), enable those specific overrides in the agent's **security settings** first; ElevenLabs rejects non-allowlisted overrides.
:::

## 2. Install and run the bridge

As a CLI:

```bash
ELEVENLABS_API_KEY=sk_... \
ELEVENLABS_AGENT_ID=agent_... \
WORKER_SHARED_SECRET=... \
  npx @komaa/elevenlabs-msteams-bridge
```

Or embedded in your own project:

```bash
npm install @komaa/elevenlabs-msteams-bridge
```

```ts
import { loadConfig, startServer } from "@komaa/elevenlabs-msteams-bridge";

startServer(loadConfig()); // same env variables as the CLI
```

Every option is an environment variable; the package ships a fully commented [`.env.example`](https://github.com/komaa-com/elevenlabs-msteams-bridge/blob/main/.env.example), and the [Configuration Reference](/elevenlabs-msteams-bridge/configuration-reference/) documents each one. The bridge listens on `0.0.0.0:8080` by default and exposes `GET /healthz` for liveness checks.

`WORKER_SHARED_SECRET` comes from StandIn in the next step.

## 3. Connect a StandIn identity

StandIn is the hosted service that joins the Teams call and dials into your bridge. Pick a tier at [standin.komaa.com](https://standin.komaa.com) (sandbox for an instant trial), pair, and you get a **shared secret**.

1. Put the secret in `WORKER_SHARED_SECRET` (both sides must match exactly).
2. Point the identity's **agent WebSocket URL** at your bridge, for example `wss://el-bridge.example.com:8080/voice/msteams/stream`. StandIn appends `/{callId}` per call.
3. Restart the bridge if you changed the env.

StandIn dials in **from the internet**, so a laptop or private host needs a public URL. A tunnel gives you one and terminates TLS (so you get `wss://` for free). Run one pointing at port `8080`, then use the `wss://…/voice/msteams/stream` form of the printed host:

Tailscale Funnel:

```bash
tailscale funnel --bg --https=8080 8080
```

Cloudflare Tunnel:

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

For a fixed production host use an ingress/load balancer, or serve TLS natively with `TLS_CERT_PATH` + `TLS_KEY_PATH`. Never give StandIn a plain `ws://` URL outside local testing.

More detail (tiers, what pairing does, cutoff behavior): [Connecting to StandIn](/elevenlabs-msteams-bridge/connecting-to-standin/).

## 4. Make the first call

Call your Teams bot (or join the sandbox meeting). In the bridge logs you should see the call arrive,