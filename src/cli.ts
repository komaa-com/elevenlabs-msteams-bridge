#!/usr/bin/env node
/**
 * CLI entry point: `elevenlabs-msteams-bridge` (or `npx @komaa/elevenlabs-msteams-bridge`).
 * Entirely env-configured — see .env.example in the package root.
 */
import { loadConfig } from "./config.js";
import { startServer } from "./server.js";

try {
  const server = startServer(loadConfig());
  // listen() errors are ASYNC (e.g. EADDRINUSE) — without this handler they
  // crash with an opaque uncaught exception instead of the friendly hint below.
  server.on("error", (err) => {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "EADDRINUSE") {
      console.error(`elevenlabs-msteams-bridge: port already in use (${e.message}). Set PORT to a free port.`);
    } else {
      console.error(`elevenlabs-msteams-bridge: server error: ${e.message}`);
    }
    process.exit(1);
  });
} catch (err) {
  console.error(`elevenlabs-msteams-bridge: ${(err as Error).message}`);
  console.error("Required env: ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID, WORKER_SHARED_SECRET (see .env.example).");
  process.exit(1);
}
