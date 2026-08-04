# pi-impeccable-skill

[Impeccable](https://github.com/pbakaus/impeccable) design workflows for [Pi](https://pi.dev/), installed and updated with the official Impeccable CLI.

This independently maintained adapter is not affiliated with or endorsed by the Impeccable project. It adds a native `/impeccable` command, discovers the upstream skill, and fixes bundled script paths when the skill is installed globally.

## Install

```bash
pi install npm:pi-impeccable-skill
```

Restart Pi or run `/reload`. On the first Impeccable invocation, the extension asks before installing the latest upstream skill globally.

```text
/impeccable init
/impeccable critique src
/impeccable audit src
/impeccable polish src
```

The original skill command remains available as `/skill:impeccable` after installation.

## Updates

Impeccable's own once-per-session version check detects newer skill releases. When an update is available, the agent asks before running the official updater. Nothing is changed silently.

You can also update explicitly:

```text
/impeccable update
```

After an extension-managed install or update succeeds, Pi resources are reloaded. A failed or offline update leaves the existing skill untouched.

## How it works

- The npm package depends on the official [`impeccable`](https://www.npmjs.com/package/impeccable) CLI.
- `/impeccable install` runs a non-interactive, hook-free global installation for Pi's native skill format.
- The extension discovers project or global `.pi/skills/impeccable` installations, with `.agents/skills/impeccable` compatibility, through Pi's `resources_discover` event.
- Normal commands forward to the upstream skill without maintaining a fork or vendored copy.
- The upstream skill owns its update check, including daily throttling and asking the user before an update.

## Commands

```text
/impeccable install
/impeccable update
/impeccable init
/impeccable shape <target>
/impeccable craft <target>
/impeccable critique <target>
/impeccable audit <target>
/impeccable polish <target>
/impeccable live-tailscale start [--target <path>] [--app-port <port>]
/impeccable live-tailscale status
/impeccable live-tailscale stop
```

`live-tailscale` prepares Impeccable live mode for a browser on the same Tailnet. It
keeps the upstream helper unchanged, proxies its loopback port over the machine's
Tailscale IPv4 address, and rewrites the temporary injected script URL. The app's
dev server must already be running and reachable on the remote machine (Astro's
`host: true` is sufficient for direct Tailnet access).

All upstream Impeccable commands remain available.

## Local development

```bash
pi install ./packages/pi-impeccable-skill
npm test --workspace pi-impeccable-skill
npm pack --workspace pi-impeccable-skill --dry-run
```

## Licensing

The Pi adapter is MIT licensed. Impeccable is installed separately by its official npm package and remains under its upstream Apache-2.0 license.
