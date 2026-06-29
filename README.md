# pi-tools

Personal Pi package for extensions, skills, prompts, and themes.

## Install

From npm:

```bash
pi install npm:henry-pi-tools
```

From git:

```bash
pi install git:git@github.com:henry-p/pi-tools.git
```

## Contents

### Peekaboo extension

`extensions/peekaboo.ts` provides a dormant [Peekaboo](https://peekaboo.sh/) CLI integration.

It does not add the `peekaboo` tool to Pi's context at startup. Run this in Pi when you want desktop automation:

```text
/peekaboo
```

Or enable it and immediately start a task:

```text
/peekaboo inspect the current Safari window
```

Disable it for the current session:

```text
/peekaboo off
```

When enabled, the extension exposes one generic tool:

```json
{
  "args": ["see", "--json", "--path", "/tmp/peekaboo-see.png"],
  "timeoutMs": 30000
}
```

The tool runs `peekaboo` with argv arguments via Pi's extension API, not through a shell string. Read-only commands run directly; desktop actions prompt for confirmation unless `PI_PEEKABOO_ALLOW_ACTIONS=1` is set.
