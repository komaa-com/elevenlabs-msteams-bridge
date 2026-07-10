---
title: "Contributing"
description: "Local setup, conventions, and where the full contributor guide lives."
---

Contributions are welcome. The full guide - local setup, branch and PR conventions, the release flow, and the documentation policy - lives in [`CONTRIBUTING.md`](https://github.com/komaa-com/elevenlabs-msteams-bridge/blob/main/CONTRIBUTING.md) in the repository.

## Quick start for contributors

```bash
git clone https://github.com/komaa-com/elevenlabs-msteams-bridge
cd elevenlabs-msteams-bridge
npm ci
npm test        # node:test suites via tsx
npm run typecheck
npm run build
```

- **One runtime dependency** (`ws`); everything else is dev-only.
- **`main` is protected**: land changes through a pull request with the `test (20)` and `test (22)` checks green.
- **Docs live in `website/`** (this site). Any merged change to `website/` redeploys the site automatically.

## Documentation policy

Document how to **connect to** the hosted StandIn service and how the bridge behaves on the wire. Do not document the internals of the hosted media bridge - this repository only depends on its published wire contract.
