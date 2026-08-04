import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = dirname(EXTENSION_DIR);
const SKILL_DIR = join(PACKAGE_ROOT, "vendor", "impeccable");
const SCRIPTS_DIR = join(SKILL_DIR, "scripts");
const COMMAND_METADATA_PATH = join(SCRIPTS_DIR, "command-metadata.json");
const PROJECT_SCRIPT_PATH_RE = /(["']?)(?:\.\/)?\.pi\/skills\/impeccable\/scripts(?=\/)/g;

const MANAGEMENT_COMMANDS = {
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

function loadCommandMetadata() {
  try {
    return JSON.parse(readFileSync(COMMAND_METADATA_PATH, "utf8"));
  } catch {
    return {};
  }
}

function commandEntries(metadata = loadCommandMetadata()) {
  return Object.entries({ ...metadata, ...MANAGEMENT_COMMANDS })
    .map(([name, value]) => ({
      name,
      description: value?.description || `Run /impeccable ${name}.`,
      argumentHint: value?.argumentHint || "",
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getImpeccableCompletions(prefix = "", metadata = loadCommandMetadata()) {
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

export function rewriteImpeccableScriptPaths(command, options = {}) {
  if (typeof command !== "string" || !command.includes(".pi/skills/impeccable/scripts")) {
    return command;
  }

  const cwd = options.cwd || process.cwd();
  const localScriptsDir = options.localScriptsDir || join(cwd, ".pi", "skills", "impeccable", "scripts");
  const hasLocalScripts = options.hasLocalScripts ?? existsSync(localScriptsDir);
  if (hasLocalScripts) return command;

  const scriptsDir = options.scriptsDir || SCRIPTS_DIR;
  return command.replace(
    PROJECT_SCRIPT_PATH_RE,
    (_match, quote) => replacementForQuote(quote, scriptsDir),
  );
}

export default function impeccablePiExtension(pi) {
  pi.registerCommand("impeccable", {
    description: "Run Impeccable design workflows.",
    getArgumentCompletions: (prefix) => getImpeccableCompletions(prefix),
    handler: async (args = "", ctx) => {
      const trimmed = String(args || "").trim();
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
