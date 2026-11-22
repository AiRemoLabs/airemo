# Contributing to Airemo

Thanks for wanting to help. This page explains how to set up and what we expect in a pull request.

## Contributions and licensing

There is no CLA. By opening a pull request You confirm that You wrote the change (or have the right
to submit it) and that it is licensed under the license of the folder it lands in (see below).
You keep the copyright in your work.

## Licenses in this repo

| Path | License |
|---|---|
| Everything except the relay | Apache-2.0 (`LICENSE`) |
| `apps/relay` | FSL-1.1-ALv2 (`apps/relay/LICENSE`) |

Your contribution is covered by the license of the folder it lands in.

## Setup

Requirements: Node 22+ (see `.nvmrc`) and pnpm.

```
pnpm install
pnpm build
pnpm lint && pnpm typecheck && pnpm test
```

See `README.md` and `MANUAL.md` for running the daemon, relay and CLI from source.

The phone app is not public yet, so the remote path (pairing, relay, encrypted channel) is tested
through code: the tests drive the real client, relay and daemon against each other. Run them
rather than relying on a phone.

**Adding an agent?** Read [`packages/plugin-sdk/README.md`](packages/plugin-sdk/README.md) and open
a "New agent plugin" issue first.

## Making a change

1. Open an issue first for anything bigger than a small fix, so we can agree on the approach.
2. Fork the repo and create a branch: `feat/...`, `fix/...`, `docs/...`, `chore/...`,
   `refactor/...` or `test/...`.
3. Keep one concern per pull request.
4. Add or update tests. Bug fixes need a test that fails without the fix.
5. Run `pnpm lint && pnpm build && pnpm typecheck && pnpm test` and make sure everything passes.
6. Update `README.md`, `MANUAL.md` or `QUICKSTART.md` if commands, setup or behaviour change.
7. Open the pull request against `dev` (not `main`) and describe what changed and why.

## Rules that protect users

These come from Airemo's design. A pull request that breaks them will be declined:

- **Local first.** Project files and code stay on the user's computer.
- **The relay must stay payload-blind.** It forwards encrypted frames and never decrypts or logs
  them.
- **Approvals are default-deny** and always show the exact command or action.
- **A remote client must not be able to pass launch flags** (for example
  `--dangerously-skip-permissions`).
- **Core must not import a specific agent.** Agents are added as plugins through
  `@airemo/plugin-sdk`.
- **`packages/protocol` is shared with mobile and web**, so keep it free of Node-only APIs.

## Reporting security problems

Do not open a public issue. Follow [SECURITY.md](SECURITY.md).

## Conduct

By taking part You agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
