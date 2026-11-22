<!-- Pull requests go into `dev`, not `main`. See CONTRIBUTING.md. -->

## What and why

<!-- What does this change, and why? Link the issue: "Closes #123". -->

## How it was tested

<!-- Tests added or changed. For agent changes: which agent and version you ran it against. -->

## Checklist

- [ ] The base branch is `dev`
- [ ] `pnpm lint && pnpm build && pnpm typecheck && pnpm test` passes
- [ ] Tests added or updated (a bug fix has a test that fails without the fix)
- [ ] `README.md` / `MANUAL.md` / `QUICKSTART.md` updated if commands, setup or behaviour changed
- [ ] Follows the rules in CONTRIBUTING.md: code stays local, the relay stays payload-blind,
      approvals stay default-deny and show the exact action, no launch flags from remote clients,
      core does not import a specific agent
- [ ] I wrote this change (or have the right to submit it), and it is licensed under the license of
      the folder it lands in
