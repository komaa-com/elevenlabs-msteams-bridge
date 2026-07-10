#!/usr/bin/env node
/**
 * CLI entry point: `elevenlabs-msteams-bridge` (or `npx @komaa/elevenlabs-msteams-bridge`).
 * Entirely env-configured — see .env.example in the package root.
 */
import { loadConfig } from "./config.js";
import { startServer } from "./server.js";

try {
  startServer(loadConfig());
} catch (err) {
  console.error(`elevenlabs-msteams-bridge: ${(err as Error).message}`);
  console.error("Required env: ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID, WORKER_SHARED_SECRET (see .env.example).");
  process.exit(1);
}
