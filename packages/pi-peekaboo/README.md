# pi-peekaboo

**Peekaboo desktop automation for [Pi](https://pi.dev/): let the agent inspect macOS windows, capture screenshots, and drive UI actions through the [Peekaboo CLI](https://peekaboo.sh/).**

[![npm version](https://img.shields.io/npm/v/pi-peekaboo.svg?style=for-the-badge)](https://www.npmjs.com/package/pi-peekaboo)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](./LICENSE)
![Platform](https://img.shields.io/badge/Platform-macOS-blue?style=for-the-badge)

## Why pi-peekaboo

- **Native desktop visibility** — give Pi screenshots and UI trees from real macOS apps, not just browser pages.
- **Actionable automation** — click, type, hotkey, scroll, drag, and target UI elements by fresh Peekaboo element IDs.
- **Session-level control** — enable desktop automation with `/peekaboo`, disable it with `/peekaboo off`.
- **Safety prompts by default** — observation commands run directly; desktop actions and AI-provider calls ask first.
- **Shell-safe execution** — the tool accepts argv arrays and runs `peekaboo` directly via Pi's extension API.

## Install

```bash
pi install npm:pi-peekaboo
```

Then restart Pi.

For local development from this monorepo:

```bash
pi install ./packages/pi-peekaboo
```

## Requirements

- macOS 15+
- Peekaboo installed:

  ```bash
  brew install steipete/tap/peekaboo
  ```

- Screen Recording permission
- Accessibility permission recommended for reliable clicks, typing, and window control

Check permissions from Pi after enabling the extension:

```text
/peekaboo check permissions
```

## Quick Start

Enable Peekaboo for the current session:

```text
/peekaboo
```

Enable it and immediately ask Pi to inspect an app:

```text
/peekaboo inspect the current Safari window
```

Turn it off:

```text
/peekaboo off
```

Once enabled, Pi can call the `peekaboo` tool:

```js
peekaboo({
  args: ["see", "--json", "--annotate", "--path", "/tmp/peekaboo-see.png"],
  timeoutMs: 30000,
})
```

## Common Workflows

### Inspect what is on screen

```js
peekaboo({ args: ["see", "--json", "--annotate", "--path", "/tmp/peekaboo-see.png"] })
```

Use this before taking action. The JSON output gives Pi element IDs and labels it can target later.

### Inspect the accessibility tree

```js
peekaboo({ args: ["inspect-ui", "--json"] })
```

Useful when screenshots alone are ambiguous or when you need semantic UI roles.

### Click or type into an app

```js
peekaboo({ args: ["click", "--on", "<element-id>"] })
peekaboo({ args: ["type", "hello from Pi"] })
```

Action commands prompt for confirmation unless you opt out with `PI_PEEKABOO_ALLOW_ACTIONS=1`.

### Check installed Peekaboo tools

```js
peekaboo({ args: ["tools", "--json"] })
```

## Tool

### `peekaboo`

Runs the Peekaboo macOS CLI with argv arguments.

| Parameter | Type | Description |
| --- | --- | --- |
| `args` | `string[]` | Arguments passed after the `peekaboo` executable, e.g. `["see", "--json"]`. |
| `timeoutMs` | `number` | Optional timeout in milliseconds. Defaults to `30000`; clamped to 10 minutes. |

Output is truncated to Pi's normal tool-output limits. If Peekaboo prints more than fits in context, the full output is saved to a temporary file and the tool result includes that path.

## Commands

| Command | What it does |
| --- | --- |
| `/peekaboo` | Enable Peekaboo for the current Pi session. |
| `/peekaboo <task>` | Enable Peekaboo, then send `<task>` to the agent. |
| `/peekaboo off` | Disable the `peekaboo` tool for the current session. |

## Safety Model

- Read-only commands such as `tools`, `list`, `see`, `image`, `inspect-ui`, and `permissions status` run directly.
- Desktop action commands such as `click`, `type`, `hotkey`, `scroll`, `drag`, and `window` require confirmation.
- `peekaboo mcp` is blocked because it starts a long-running server process.
- `peekaboo agent`, `analyze`, and screenshot-analysis modes require confirmation because they may invoke external AI providers.
- Non-interactive sessions block action commands by default. Set `PI_PEEKABOO_ALLOW_ACTIONS=1` only when you intentionally want unattended desktop control.

## Tips for Agents

- Observe before acting: run `see --json --path ...` or `inspect-ui --json` first.
- Prefer fresh element IDs over text labels; prefer labels over coordinates.
- Re-observe after each UI-changing action.
- Pass `--json` whenever Peekaboo supports it.
- Ask the user before submitting forms, deleting data, sending messages, making purchases, clicking permission dialogs, or typing sensitive information.

## License

MIT
