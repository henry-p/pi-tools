# pi-peekaboo

**Computer use for [Pi](https://pi.dev/) via Peekaboo: let the agent inspect macOS windows, capture screenshots, understand accessibility trees, and drive UI actions through the [Peekaboo CLI](https://peekaboo.sh/).**

[![npm version](https://img.shields.io/npm/v/pi-peekaboo.svg?style=for-the-badge)](https://www.npmjs.com/package/pi-peekaboo)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](./LICENSE)
![Platform](https://img.shields.io/badge/Platform-macOS-blue?style=for-the-badge)

## Why pi-peekaboo

- **Computer use for Pi** — bring the same broad category as OpenAI Codex app computer use to Pi: screen visibility plus controlled GUI interaction when files, shell commands, browser tools, or plugins are not enough.
- **Native desktop visibility** — give Pi screenshots, annotated element IDs, and UI trees from real macOS apps, not just browser pages.
- **Actionable automation** — click, type, paste, hotkey, scroll, swipe, drag, move, and target UI elements by fresh Peekaboo element IDs.
- **Broad Peekaboo CLI coverage** — expose installed Peekaboo subcommands for observation, capture, interaction, app/window control, system UI, browser MCP, and AI analysis through one Pi tool.
- **Session-level control** — enable desktop automation with `/peekaboo`, disable it with `/peekaboo off`, and tune policy with `/peekaboo config`.
- **Configurable safety model** — routine observation and UI actions can run by default, while high-risk desktop, system, credential, AI/network, and destructive actions are gated.
- **Persistent and session grants** — allow, ask, or deny actions by tool, risk category, risk level, and target app; save durable rules or one-session exceptions.
- **Shell-safe execution** — the tool accepts argv arrays and runs `peekaboo` directly via Pi's extension API.

## Computer Use and OpenAI Codex

OpenAI describes [Codex app computer use](https://developers.openai.com/codex/app/computer-use) as a way for Codex to see and operate graphical user interfaces when command-line tools or structured integrations are not enough—for example testing a desktop app, using a browser, changing app settings, reproducing a GUI-only bug, or inspecting information in an app that does not expose an API or plugin.

`pi-peekaboo` is the Pi package for that same search intent: **computer use**, **AI computer use**, **desktop automation**, **screen control**, and **GUI automation** for Pi on macOS. It is not the OpenAI Codex Computer Use plugin; instead, it gives Pi agents a macOS-native computer-use bridge through Peekaboo:

- Screen and window capture through Peekaboo screenshots.
- Accessibility-tree inspection for semantic UI understanding.
- Mouse, keyboard, menu, app, window, browser, and system-UI actions through `peekaboo` argv calls.
- Permission prompts and configurable rules for high-risk actions that can affect apps or system state outside the project workspace.

Use Pi's normal file, shell, and browser tools first when they are precise and repeatable. Use `pi-peekaboo` computer use when the task depends on a real graphical interface.

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

Check permissions after enabling the extension:

```text
/peekaboo check permissions
```

Pi can then run:

```js
peekaboo({ args: ["permissions", "status", "--json"] })
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

Open the interactive permission and exposure manager:

```text
/peekaboo config
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

## Current Capabilities

### Observe and capture the desktop

- List screens, windows, apps, server status, and available Peekaboo tools.
- Capture screenshots with `see` and `image`, including JSON output and annotated element IDs.
- Use `capture` for live screens/windows or video files when you need kept PNG frames, contact sheets, or capture metadata.
- Inspect accessibility trees with `inspect-ui` / `inspect_ui`.
- Check `permissions`, `bridge`, and `daemon` status without prompting.

### Drive routine UI actions

- Click, type, paste, press keys, send hotkeys, scroll, swipe, drag, move, set values, and perform accessibility actions.
- Target by fresh element ID whenever possible; fall back to labels and only use coordinates as a last resort.
- Re-observe after each UI-changing action so the agent does not act on stale element IDs.

### Control apps, windows, browser pages, and system UI

- Use Peekaboo's `app`, `window`, `space`, `menu`, `menubar`, `dock`, `dialog`, `clipboard`, and `open` subcommands from Pi.
- Use `browser` for Chrome page content through Peekaboo's browser MCP tool; use native Peekaboo commands for macOS chrome, menus, dialogs, permissions, and non-browser apps.
- Routine focus/layout actions are treated as medium risk by default.
- Destructive or sensitive operations such as quit, close, delete, reset, permission dialogs, clipboard access, shell/run/config/open/system changes, or unknown subcommands are high risk and require approval unless policy says otherwise.

### Analyze screenshots and delegate when explicitly requested

- `analyze`, `agent`, `see --analyze`, image-question flows, and browser/AI workflows are classified as AI/network or high-risk actions because they may call configured external providers or nested tooling.
- `peekaboo agent` is available behind approval, but Pi guidance tells the model not to delegate to Peekaboo's nested agent unless the user explicitly asks.

### Manage permissions interactively

Run `/peekaboo config` to open the interactive manager:

- **Current session grants** — revoke allow-all, revoke similar-action grants, or clear all session grants.
- **Default permission policy** — choose `allow`, `ask`, or `deny` for low-, medium-, and high-risk calls.
- **Tool exposure** — disable or re-enable specific Peekaboo subcommands at the extension policy layer.
- **Persistent rules** — create durable allow/ask/deny rules scoped by tool, risk category, risk level, and app.
- **Recent decisions** — review recent prompts, see risk details, clear history, or promote a decision into a persistent rule.
- **Reset** — restore default config, revoke session grants, or reset everything.

Persistent config is stored at:

```text
~/.pi/agent/peekaboo-config.json
```

Session grants reset when the Pi session ends.

### Track the installed Peekaboo toolset

Because `pi-peekaboo` is an argv bridge, it can call newly installed Peekaboo one-shot subcommands without a Pi package update. Unknown or newly added subcommands are treated as high risk and ask by default.

Useful discovery commands:

```js
peekaboo({ args: ["tools", "--json"] })
peekaboo({ args: ["--help"] })
peekaboo({ args: ["help", "<command>"] })
```

Recent Peekaboo command families include:

- **Core**: `bridge`, `capture`, `clean`, `commander`, `completions`, `config`, `daemon`, `image`, `learn`, `list`, `permissions`, `run`, `sleep`, `tools`.
- **Interaction**: `click`, `drag`, `hotkey`, `move`, `paste`, `perform-action`, `press`, `scroll`, `set-value`, `swipe`, `type`.
- **System UI**: `app`, `clipboard`, `dialog`, `dock`, `menu`, `menubar`, `open`, `space`, `visualizer`, `window`.
- **Vision, MCP, and AI**: `see`, `browser`, `inspect-ui`, `mcp`, `agent`, and analysis flows.

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
| `/peekaboo config` | Open the interactive policy, rule, exposure, and recent-decision manager. |
| `/peekaboo off` | Disable the `peekaboo` tool for the current session. |

## Safety Model

Peekaboo calls are classified by risk level and category, then evaluated against tool exposure, persistent rules, session grants, and the default policy.

Recommended defaults:

| Risk level | Default | Examples |
| --- | --- | --- |
| Low | Allow | Observation: `tools`, `list`, `see`, `image`, `inspect-ui`, `permissions status`, `bridge status`, `daemon status`. |
| Medium | Allow | Routine UI and non-destructive app/window actions: click, scroll, type, paste, hotkey, drag, focus, move, resize. |
| High | Ask | Submits/sends, deletes, purchases, credentials/secrets, permission dialogs, clipboard, shell/run/config/open/system changes, AI/network calls, destructive app/window operations, unknown/new commands. |

Additional guardrails:

- `peekaboo mcp` is blocked because it starts a long-running server process.
- Extension-level tool exposure denies always win over allow rules.
- Persistent and session deny rules win over allow rules.
- High-risk prompts can be answered with allow once, allow similar for this session, allow all this session, deny once, deny similar for this session, configure, or details.
- Non-interactive sessions block actions that require asking. Set `PI_PEEKABOO_ALLOW_ACTIONS=1` only when you intentionally want unattended desktop control; it bypasses prompts but not explicit deny rules or blocked commands.

## Tips for Agents

- Observe before acting: run `see --json --path ...` or `inspect-ui --json` first.
- Prefer fresh element IDs over text labels; prefer labels over coordinates.
- Re-observe after each UI-changing action.
- Pass `--json` whenever Peekaboo supports it.
- Pass `--path` for screenshot-producing commands when the image should be accessible later.
- Ask the user before submitting forms, deleting data, sending messages, making purchases, clicking permission dialogs, or typing sensitive information.
- Use `/peekaboo config` to create a durable rule instead of repeatedly approving the same high-risk action.

## License

MIT
