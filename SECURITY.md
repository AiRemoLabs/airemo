# Security policy

Airemo lets a phone approve commands that AI agents run on a computer, so security reports are
taken seriously.

## Reporting a vulnerability

**Please do not open a public issue.** Report it privately by either:

- using GitHub's "Report a vulnerability" button on the repository's Security tab, or
- emailing **airemo.connect@gmail.com** with the subject `SECURITY`.

Include what You found, the steps to reproduce it, the affected version (`airemo -v`) and the
impact You expect. A proof of concept helps, but please do not run it against other people's
systems, and do not access or change data that is not yours.

## What to expect

- A reply within **5 days** confirming we received it.
- An assessment and a plan within **14 days**.
- A fix released as soon as we can, and credit to You in the release notes if You want it.

Please give us reasonable time to fix a problem before You publish details.

## Supported versions

Airemo is pre-1.0. Only the latest release gets security fixes.

## In scope

- Pairing, encryption and device authorization (`packages/crypto`, the daemon's remote code)
- Permission approvals (anything that lets a command run without the user's approval)
- The relay (anything that lets it read, alter or misroute traffic, or be taken down by one client)
- The daemon's local server (host and origin checks, folder allowlist)

## Out of scope

- Attacks that need full control of the user's computer or phone already
- Denial of service through sheer volume against the public hosted relay
- Problems in third-party agents themselves (Claude Code, Cursor); report those to their vendors
- Social engineering

## Safe harbour

If You act in good faith, follow this policy and avoid harming users or their data, we will not
pursue legal action against You for your research.
