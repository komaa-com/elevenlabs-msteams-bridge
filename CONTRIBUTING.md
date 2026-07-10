# Contributing

Thanks for your interest in improving `@komaa/elevenlabs-msteams-bridge`. This guide covers local
setup, the conventions we follow, and how releases work.

## Prerequisites

- Node.js `>= 20` and npm.
- For running a real call end to end: an ElevenLabs agent (+ API key) and a StandIn identity
  (the [sandbox](https://standin.komaa.com/sandbox) is enough to get a call).

## Local setup

```bash
git clone https://github.com/komaa-com/elevenlabs-msteams-bridge
cd elevenlabs-msteams-bridge
npm ci
npm run typecheck   # tsc --noEmit (strict)
npm test            # node:test suites via tsx (HMAC vectors, protocol, full relay E2E, hardening, lifecycle)
npm run build       # tsc -> dist/
```

The package is authored in TypeScript under `src/` and compiled to `dist/`. `dist/` is **not**
committed; `prepublishOnly` runs typecheck + tests + build, so what ships is always freshly built
from the reviewed source.

## Working on it

- `npm run dev` runs the CLI from source (`tsx src/cli.ts`), entirely env-configured; copy
  `.env.example` and fill in the required values.
- The E2E tests exercise a full fake call (HMAC upgrade, session start, audio relay both ways,
  barge-in ghost-drop, client tools, governors, teardown) without any network dependency - a
  `FakeAgent` stands in for ElevenLabs. Add or extend tests alongside behavior changes; lifecycle
  edge cases (teardown paths, timers, reconnects) especially need them.
- The wire contract with the StandIn media bridge is fixed - message shapes in `src/protocol.ts`
  must not change field names or casing. New OUTBOUND capabilities are additive.

## Branches and pull requests

- Branch from `main`; use a short prefixed name, e.g. `feat/…`, `fix/…`, `docs/…`, `ci/…`.
- `main` is protected: PRs only, and the CI checks (`test (20)`, `test (22)`) must pass.
- Keep PRs focused. Describe the change and how you verified it (a real Teams call through the
  StandIn sandbox is the gold standard for anything touching the relay).

## Releases

Publishing to npm is automated: bump `version` in `package.json`, tag it `vX.Y.Z` (or cut a GitHub
Release), and CI publishes with `--provenance` (supply-chain attestation). Keep version references
in the docs consistent with the released version.

## Documentation and the leak policy

The StandIn media bridge is a hosted service; **its internal implementation is not public**. When
you write docs, comments, or examples, describe only this bridge's side and the observable wire
contract. Refer to the counterpart as "the StandIn media bridge" and never document how it produces
Teams media, what it runs on, or any internal component or source behind it.
