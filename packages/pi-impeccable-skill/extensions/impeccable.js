import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const COMMAND_METADATA = "command-metadata.json";
const SCRIPT_PATH_RE = /(["']?)(?:\.\/)?\.(?:pi|agents)\/skills\/impeccable\/scripts(?=\/)/g;
const UPDATE_TIMEOUT_MS = 120_000;
const LIVE_TAILSCALE_STATE = [".impeccable", "live", "tailscale.json"];
const TAILSCALE_PROXY_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "tailscale-proxy.mjs");

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
  "live-tailscale": {
    description: "Run Impeccable live mode through the local machine's Tailscale network.",
    argumentHint: "<start|status|stop> [--target <path>] [--app-port <port>]",
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

export function parseLiveTailscaleArgs(raw = "") {
  const tokens = String(raw).trim().split(/\s+/).filter(Boolean);
  const action = tokens.shift() || "start";
  let target;
  let appPort = 4321;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--target") {
      target = tokens[++index];
    } else if (token.startsWith("--target=")) {
      target = token.slice("--target=".length);
    } else if (token === "--app-port") {
      appPort = Number(tokens[++index]);
    } else if (token.startsWith("--app-port=")) {
      appPort = Number(token.slice("--app-port=".length));
    } else if (!target && !token.startsWith("-")) {
      target = token;
    }
  }

  if (!Number.isInteger(appPort) || appPort < 1 || appPort > 65535) {
    throw new Error("--app-port must be an integer between 1 and 65535");
  }
  if (!["start", "status", "stop"].includes(action)) {
    throw new Error(`Unknown live-tailscale action: ${action}`);
  }
  return { action, target, appPort };
}

function liveTailscaleStatePath(root) {
  return join(root, ...LIVE_TAILSCALE_STATE);
}

function readLiveTailscaleState(root) {
  try {
    return JSON.parse(readFileSync(liveTailscaleStatePath(root), "utf8"));
  } catch {
    return null;
  }
}

function writeLiveTailscaleState(root, state) {
  const file = liveTailscaleStatePath(root);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
}

function removeLiveTailscaleState(root) {
  try {
    unlinkSync(liveTailscaleStatePath(root));
  } catch {
    // The state may already have been cleaned up.
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stopProcess(pid) {
  if (!processIsAlive(pid)) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // The process may exit between the liveness check and the signal.
  }
}

function jsonFromOutput(output) {
  const text = String(output || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first !== -1 && last > first) {
      try {
        return JSON.parse(text.slice(first, last + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

async function runSkillScript(skillRoot, script, args, cwd, timeoutMs = UPDATE_TIMEOUT_MS) {
  return runProcess(process.execPath, [join(skillRoot, "scripts", script), ...args], cwd, timeoutMs);
}

async function getTailscaleIdentity(cwd) {
  const ipResult = await runProcess("tailscale", ["ip", "-1"], cwd, 10_000);
  if (ipResult.code !== 0) {
    throw new Error(ipResult.stderr.trim() || "Tailscale is not connected");
  }
  const ip = ipResult.stdout.trim().split(/\s+/)[0];
  if (!ip) throw new Error("Tailscale returned no IPv4 address");

  let hostname;
  const statusResult = await runProcess("tailscale", ["status", "--json"], cwd, 10_000);
  if (statusResult.code === 0) {
    const status = jsonFromOutput(statusResult.stdout);
    hostname = status?.Self?.DNSName || status?.Self?.HostName;
  }
  hostname = String(hostname || ip).replace(/\.$/, "");
  return { ip, hostname };
}

function hostForUrl(host) {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

export function rewriteLiveScriptOrigin(file, localPort, remoteOrigin) {
  const content = readFileSync(file, "utf8");
  const start = content.indexOf("impeccable-live-start");
  const end = content.indexOf("impeccable-live-end", start + 1);
  if (start === -1 || end === -1) return false;

  const blockEnd = end + "impeccable-live-end".length;
  const block = content.slice(start, blockEnd);
  const localSrc = `http://localhost:${localPort}/live.js`;
  if (!block.includes(localSrc)) return false;

  const updatedBlock = block.replaceAll(localSrc, `${remoteOrigin}/live.js`);
  writeFileSync(file, content.slice(0, start) + updatedBlock + content.slice(blockEnd));
  return true;
}

function startTailscaleProxy(listenHost, publicHost, targetPort, cwd) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      process.execPath,
      [TAILSCALE_PROXY_SCRIPT, "--listen", listenHost, "--public-host", publicHost, "--target-port", String(targetPort)],
      { cwd, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    let errorOutput = "";
    let ready = false;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      rejectPromise(new Error("Timed out starting the Tailscale live proxy"));
    }, 10_000);

    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(error instanceof Error ? error : new Error(String(error)));
    };

    child.stdout.on("data", (chunk) => {
      output += String(chunk);
      const lines = output.split(/\r?\n/);
      output = lines.pop() || "";
      for (const line of lines) {
        const message = jsonFromOutput(line);
        if (!message?.ready || ready) continue;
        ready = true;
        settled = true;
        clearTimeout(timer);
        resolvePromise({ child, ...message });
      }
    });
    child.stderr.on("data", (chunk) => {
      errorOutput += String(chunk);
    });
    child.on("error", fail);
    child.on("close", (code) => {
      if (!ready) fail(new Error(errorOutput.trim() || `Tailscale live proxy exited with code ${code}`));
    });
  });
}

function formatLiveTailscaleState(state) {
  return [
    `Browser URL: ${state.pageUrl}`,
    `Live helper: ${state.liveUrl}`,
    `Tailscale host: ${state.hostname}`,
  ].join("\n");
}

async function startLiveTailscale(pi, ctx, rawArgs) {
  const parsed = parseLiveTailscaleArgs(rawArgs);
  const skillRoot = locateImpeccableSkill(ctx.cwd);
  if (!skillRoot) {
    report(pi, ctx, "Impeccable is not installed. Run /impeccable install first.", "warning");
    return;
  }

  const staleState = readLiveTailscaleState(projectRoot(ctx.cwd));
  if (staleState && processIsAlive(staleState.proxyPid)) {
    report(pi, ctx, `Tailscale live is already running.\n${formatLiveTailscaleState(staleState)}`);
    return;
  }
  if (staleState) removeLiveTailscaleState(projectRoot(ctx.cwd));

  let identity;
  try {
    identity = await getTailscaleIdentity(ctx.cwd);
  } catch (error) {
    report(pi, ctx, error.message, "error");
    return;
  }

  const liveArgs = parsed.target ? ["--target", parsed.target] : [];
  const bootResult = await runSkillScript(skillRoot, "live.mjs", liveArgs, ctx.cwd);
  const boot = jsonFromOutput(bootResult.stdout);
  if (bootResult.code !== 0 || !boot?.ok) {
    report(pi, ctx, boot?.error ? `Impeccable live could not start: ${boot.error}` : (bootResult.stderr.trim() || "Impeccable live could not start."), "error");
    return;
  }

  const project = boot.projectRoot || ctx.cwd;
  const remoteOrigin = `http://${hostForUrl(identity.hostname)}`;
  let proxy;
  try {
    proxy = await startTailscaleProxy(identity.ip, identity.hostname, boot.serverPort, project);
    const liveOrigin = `${remoteOrigin}:${proxy.port}`;
    const files = (boot.pageFiles || []).map((file) => resolve(project, file));
    const rewrittenFiles = files.filter((file) => rewriteLiveScriptOrigin(file, boot.serverPort, liveOrigin));
    if (rewrittenFiles.length === 0) {
      stopProcess(proxy.child.pid);
      await runSkillScript(skillRoot, "live-server.mjs", ["stop"], project);
      throw new Error("Could not find the injected Impeccable live script tag to rewrite");
    }

    const pageUrl = `${remoteOrigin}:${parsed.appPort}`;
    const state = {
      version: 1,
      projectRoot: project,
      proxyPid: proxy.child.pid,
      helperPort: boot.serverPort,
      proxyPort: proxy.port,
      ip: identity.ip,
      hostname: identity.hostname,
      pageUrl,
      liveUrl: `${liveOrigin}/live.js?token=${encodeURIComponent(boot.serverToken)}`,
      rewrittenFiles,
      startedAt: new Date().toISOString(),
    };
    writeLiveTailscaleState(project, state);
    report(pi, ctx, `Tailscale live started.\n${formatLiveTailscaleState(state)}`);
  } catch (error) {
    if (proxy) stopProcess(proxy.child.pid);
    await runSkillScript(skillRoot, "live-server.mjs", ["stop"], project);
    report(pi, ctx, error.message, "error");
  }
}

async function stopLiveTailscale(pi, ctx) {
  const state = readLiveTailscaleState(projectRoot(ctx.cwd));
  const skillRoot = locateImpeccableSkill(ctx.cwd);
  if (state) {
    stopProcess(state.proxyPid);
    if (skillRoot) await runSkillScript(skillRoot, "live-server.mjs", ["stop"], state.projectRoot || ctx.cwd);
    removeLiveTailscaleState(state.projectRoot || projectRoot(ctx.cwd));
    report(pi, ctx, "Tailscale live stopped.");
    return;
  }
  if (skillRoot) await runSkillScript(skillRoot, "live-server.mjs", ["stop"], ctx.cwd);
  report(pi, ctx, "No Tailscale live session was recorded.");
}

function statusLiveTailscale(pi, ctx) {
  const state = readLiveTailscaleState(projectRoot(ctx.cwd));
  if (!state || !processIsAlive(state.proxyPid)) {
    report(pi, ctx, "Tailscale live is not running.");
    return;
  }
  report(pi, ctx, `Tailscale live is running.\n${formatLiveTailscaleState(state)}`);
}

async function handleLiveTailscale(pi, ctx, rawArgs) {
  try {
    const { action } = parseLiveTailscaleArgs(rawArgs);
    if (action === "start") return startLiveTailscale(pi, ctx, rawArgs);
    if (action === "stop") return stopLiveTailscale(pi, ctx);
    return statusLiveTailscale(pi, ctx);
  } catch (error) {
    report(pi, ctx, error.message, "error");
  }
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
      if (command === "live-tailscale") {
        await handleLiveTailscale(pi, ctx, trimmed.slice(command.length).trim());
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
