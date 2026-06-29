# pi-peekaboo

Dormant [Peekaboo](https://peekaboo.sh/) desktop automation extension for [Pi](https://pi.dev/).

The extension is intentionally dormant: it only registers a lightweight `/peekaboo` command at startup. The actual `peekaboo` tool and usage guidance are added to the model context only after you run `/peekaboo`.

## Install

```bash
pi install npm:pi-peekaboo
```

For local development from a checkout:

```bash
pi install ./packages/pi-peekaboo
```

## Usage

Enable Peekaboo for the current Pi session:

```text
/peekaboo
```

Enable it and immediately start a task:

```text
/peekaboo inspect the current Safari window
```

Disable it for the current session:

```text
/peekaboo off
```

When enabled, the extension exposes one generic `peekaboo` tool:

```json
{
  "args": ["see", "--json", "--path", "/tmp/peekaboo-see.png"],
  "timeoutMs": 30000
}
```

The tool runs `peekaboo` with argv arguments via Pi's extension API, not through a shell string.

## Safety

- Read-only commands like `tools`, `list`, `see`, `image`, and `permissions status` run directly.
- Desktop action commands like `click`, `type`, `hotkey`, and `window` prompt for confirmation.
- `peekaboo mcp` is blocked because it is a long-running server process.
- `peekaboo agent`, `analyze`, and screenshot analysis require confirmation because they may invoke external AI providers.
- Set `PI_PEEKABOO_ALLOW_ACTIONS=1` to skip confirmation prompts for action commands.

## Requirements

- macOS 15+
- Peekaboo installed (`brew install steipete/tap/peekaboo`)
- Screen Recording permission
- Accessibility permission recommended for robust automation
