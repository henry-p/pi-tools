import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const COMMAND_METADATA = "command-metadata.json";
const SCRIPT_PATH_RE = /(["']?)(?:\.\/)?\.(?:pi|agents)\/skills\/impeccable\/scripts(?=\/)/g;
const UPDATE_TIMEOUT_MS = 120_000;

const MANAGEMENT_COMMANDS = {
  install: {
    description: "Install the latest upstream Impeccable skill globally.",
    argumentHint: "",
  },
  update: {
    description: "Update the installed upstream Impeccable skill.",
    argumentHint: "",
  },
  hooks: {
    description: "Manage the Impeccable design hook for this project.",
    argumentHint: "<on|off|status|ignore-rule|ignore-file|ignore-value|reset>",
  },
  pin: {
    description: "Create a standalone Impeccable shortcut for a sub-command.",
    argumentHint: "<command>",
  },
  unpin: {
    description: "Remove a standalone Impeccable shortcut.",
    argumentHint: "<command>",
  },
  teach: {
    description: "Deprecated alias for init.",
    argumentHint: "",
  },
};

function projectRoot(cwd) {
  let directory = resolve(cwd);
  while (directory !== dirname(directory)) {
    if (existsSync(join(directory, ".git"))) return directory;
    directory = dirname(directory);
  }
  return resolve(cwd);
}

export function locateImpeccableSkill(cwd, home = homedir()) {
  const root = projectRoot(cwd);
  const candidates = [
    join(root, ".pi", "skills", "impeccable"),
    join(cwd, ".pi", "skills", "impeccable"),
    join(root, ".agents", "skills", "impeccable"),
    join(cwd, ".agents", "skills", "impeccable"),
    join(home, ".pi", "agent", "skills", "impeccable"),
    join(home, ".pi", "skills", "impeccable"),
    join(home, ".agents", "skills", "impeccable"),
  ];
  return candidates.find(
    (directory) =>
      existsSync(join(directory, "SKILL.md")) && existsSync(join(directory, "scripts")),
  );
}

function loadCommandMetadata(skillRoot) {
  if (!skillRoot) return {};
  try {
    return JSON.parse(readFileSync(join(skillRoot, "scripts", COMMAND_METADATA), "utf8"));
  } catch {
    return {};
  }
}

function commandEntries(metadata = {}) {
  return Object.entries({ ...metadata, ...MANAGEMENT_COMMANDS })
    .map(([name, value]) => ({
      name,
      description: value?.description || `Run /impeccable ${name}.`,
      argumentHint: value?.argumentHint || "",
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getImpeccableCompletions(prefix = "", metadata = {}) {
  const leading = prefix.match(/^\s*/)?.[0] || "";
  const query = prefix.trimStart();
  if (query.includes(" ")) return null;

  const needle = query.toLowerCase();
  const matches = commandEntries(metadata)
    .filter((entry) => entry.name.startsWith(needle))
    .map((entry) => ({
      value: `${leading}${entry.name}${entry.argumentHint ? " " : ""}`,
      label: entry.name,
      description: entry.argumentHint
        ? `${entry.argumentHint} · ${entry.description}`
        : entry.description,
    }));
  return matches.length > 0 ? matches : null;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function escapeForDoubleQuotes(value) {
  return String(value).replace(/["\\$`]/g, "\\$&");
}

function replacementForQuote(quote, scriptsDir) {
  if (quote === '"') return `"${escapeForDoubleQuotes(scriptsDir)}`;
  if (quote === "'") return `'${String(scriptsDir).replace(/'/g, `'\\''`)}`;
  return shellQuote(scriptsDir);
}

export function rewriteImpeccableScriptPaths(command, options = {}) {
  if (
    typeof command !== "string" ||
    (!command.includes(".pi/skills/impeccable/scripts") &&
      !command.includes(".agents/skills/impeccable/scripts"))
  ) {
    return command;
  }

  const cwd = options.cwd || process.cwd();
  const root = projectRoot(cwd);
  const localScriptDirs = options.localScriptDirs || [
    join(cwd, ".pi", "skills", "impeccable", "scripts"),
    join(cwd, ".agents", "skills", "impeccable", "scripts"),
    join(root, ".agents", "skills", "impeccable", "scripts"),
  ];
  if (localScriptDirs.some((directory) => existsSync(directory))) return command;

  const skillRoot = options.skillRoot || locateImpeccableSkill(cwd, options.home);
  if (!skillRoot) return command;
  const scriptsDir = join(skillRoot, "scripts");
  return command.replace(SCRIPT_PATH_RE, (_match, quote) => replacementForQuote(quote, scriptsDir));
}

function resolveImpeccableCli() {
  try {
    let directory = dirname(require.resolve("impeccable"));
    while (directory !== dirname(directory)) {
      const cli = join(directory, "cli", "bin", "cli.js");
      if (existsSync(join(directory, "package.json")) && existsSync(cli)) return cli;
      directory = dirname(directory);
    }
  } catch {
    // A broken production install is reported by runImpeccable rather than at extension load.
  }
  return null;
}

export function runProcess(command, args, cwd, timeoutMs = UPDATE_TIMEOUT_MS) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
    };
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", (error) => finish({ code: 1, stdout, stderr: stderr || error.message }));
    child.on("close", (code) => finish({ code, stdout, stderr }));
  });
}

function runImpeccable(args, cwd) {
  const cli = resolveImpeccableCli();
  if (!cli) {
    return Promise.resolve({
      code: 1,
      stdout: "",
      stderr: "The impeccable npm dependency is unavailable. Reinstall pi-impeccable-skill.",
    });
  }
  return runProcess(process.execPath, [cli, ...args], cwd);
}

function report(pi, ctx, message, type = "info") {
  if (ctx.hasUI) ctx.ui.notify(message, type);
  else pi.sendMessage({ customType: "impeccable", content: message, display: true });
}

async function installOrUpdate(pi, ctx, action) {
  const args =
    action === "install"
      ? ["install", "--providers=pi", "--scope=global", "-y", "--no-hooks"]
      : ["update", "-y", "--no-hooks"];
  report(pi, ctx, `${action === "install" ? "Installing" : "Updating"} Impeccable…`);
  const result = await runImpeccable(args, ctx.cwd);
  if (result.code !== 0) {
    report(pi, ctx, result.stderr.trim() || result.stdout.trim() || `Impeccable ${action} failed.`, "error");
    return false;
  }
  const skillRoot = locateImpeccableSkill(ctx.cwd);
  if (!skillRoot) {
    report(pi, ctx, "The Impeccable command completed, but the installed skill was not found.", "error");
    return false;
  }
  report(pi, ctx, `Impeccable ${action} complete. Reloading Pi resources…`);
  await ctx.reload();
  return true;
}

export default function impeccablePiExtension(pi) {
  pi.on("resources_discover", (event) => {
    const skillRoot = locateImpeccableSkill(event.cwd);
    return skillRoot ? { skillPaths: [skillRoot] } : undefined;
  });

  pi.registerCommand("impeccable", {
    description: "Run and update upstream Impeccable design workflows.",
    getArgumentCompletions: (prefix) => {
      const skillRoot = locateImpeccableSkill(process.cwd());
      return getImpeccableCompletions(prefix, loadCommandMetadata(skillRoot));
    },
    handler: async (args = "", ctx) => {
      const trimmed = String(args || "").trim();
      const command = trimmed.split(/\s+/, 1)[0];
      if (command === "install" || command === "update") {
        await installOrUpdate(pi, ctx, command);
        return;
      }

      let skillRoot = locateImpeccableSkill(ctx.cwd);
      if (!skillRoot) {
        if (!ctx.hasUI) {
          report(pi, ctx, "Impeccable is not installed. Run /impeccable install first.", "warning");
          return;
        }
        const install = await ctx.ui.confirm(
          "Install Impeccable?",
          "The upstream Impeccable skill is not installed. Install the latest version globally now?",
        );
        if (!install) return;
        await installOrUpdate(pi, ctx, "install");
        return;
      }

      const forwarded = trimmed ? `/skill:impeccable ${trimmed}` : "/skill:impeccable";
      const options = ctx?.isIdle && !ctx.isIdle() ? { deliverAs: "followUp" } : undefined;
      pi.sendUserMessage(forwarded, options);
    },
  });

  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== "bash") return;
    const input = event.input;
    if (!input || typeof input !== "object" || typeof input.command !== "string") return;
    input.command = rewriteImpeccableScriptPaths(input.command, { cwd: ctx.cwd });
  });
}
