# @oranix/quiver-cli

Quiver CLI — manage apps, builds, releases from the terminal.

Status: **alpha** (P3.4.1 / P3.4.2). See `docs/cli-reference.md` for the
planned command taxonomy; v1 ships `login`, `logout`, `whoami`, `apps list/get`,
and `builds list/get`. Other commands listed in the reference land
incrementally as backend endpoints become available.

## Install

```bash
# From the repo root (after `pnpm install` at the top level):
pnpm --filter @oranix/quiver-cli build
pnpm --filter @oranix/quiver-cli start -- whoami

# Or, once published to npm:
npm install -g @oranix/quiver-cli
quiver --help
```

## Quickstart

```bash
# 1. Log in. The CLI prints a URL you must open in a browser.
quiver login

# 2. Verify who you are.
quiver whoami

# 3. List your apps.
quiver apps list

# 4. List builds for an app (by slug or id).
quiver builds list myapp-android
```

## CI mode

```bash
export QUIVER_API=https://quiver-worker.artin.workers.dev
export QUIVER_SESSION_COOKIE=...   # paste from browser DevTools
quiver whoami
quiver builds list myapp-android
```

## How auth works (v1)

Raft OAuth today only supports the browser-redirect flow with HttpOnly
cookies. The CLI can't intercept the redirect, so `quiver login` asks
you to:

1. Open the printed URL in any browser.
2. Sign in with Raft.
3. Copy the `quiver_session` cookie value from DevTools.
4. Paste it back into the CLI.

The token is saved to `$XDG_CONFIG_HOME/quiver/auth.json` (mode 0600).
For CI, pass it via `QUIVER_SESSION_COOKIE` instead.

v2 will swap this for a true headless flow (Raft Device Flow or a
`--token-stdin` service-user mode). See `publish-tasks.md` P3.4.x.
