import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

const TOOL_NAME = "peekaboo";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 10 * 60_000;
const CONFIG_PATH = join(homedir(), ".pi", "agent", "peekaboo-config.json");
const MAX_RECENT_DECISIONS = 30;

const OBSERVATION_COMMANDS = new Set([
	"--help",
	"-h",
	"help",
	"--version",
	"-v",
	"tools",
	"list",
	"see",
	"image",
	"inspect-ui",
	"inspect_ui",
	"sleep",
	"permissions",
	"bridge",
	"daemon",
]);

const ROUTINE_UI_COMMANDS = new Set([
	"click",
	"type",
	"press",
	"hotkey",
	"paste",
	"scroll",
	"swipe",
	"drag",
	"move",
	"set-value",
	"set_value",
	"perform-action",
	"perform_action",
	"visualizer",
]);

const SYSTEM_COMMANDS = new Set(["mcp", "run", "config", "open", "clean"]);
const AI_NETWORK_COMMANDS = new Set(["agent", "analyze"]);
const APP_COMMANDS = new Set(["app", "window", "space", "menu", "menubar", "dock", "dialog"]);

const TOOL_EXPOSURE_COMMANDS = [
	"see",
	"image",
	"inspect-ui",
	"list",
	"click",
	"scroll",
	"type",
	"paste",
	"hotkey",
	"drag",
	"move",
	"swipe",
	"app",
	"window",
	"menu",
	"dock",
	"dialog",
	"clipboard",
	"analyze",
	"agent",
	"permissions",
] as const;

const HIGH_RISK_KEYWORDS = {
	submitSend: ["send", "submit", "post", "publish", "share", "email", "message", "reply", "comment", "invite"],
	destructive: ["delete", "remove", "archive", "trash", "destroy", "erase", "clear", "reset", "clean", "wipe", "discard"],
	purchase: ["buy", "purchase", "pay", "payment", "checkout", "order", "subscribe", "invoice", "billing"],
	credential: [
		"password",
		"passcode",
		"credential",
		"secret",
		"token",
		"api key",
		"apikey",
		"credit card",
		"card number",
		"cvv",
		"cvc",
		"2fa",
		"mfa",
		"otp",
	],
	permission: ["permission", "allow", "grant", "authorize", "approve", "confirm", "ok", "yes", "trust", "accessibility", "screen recording"],
};

const DESTRUCTIVE_SUBCOMMANDS = new Set([
	"close",
	"quit",
	"force-quit",
	"forcequit",
	"kill",
	"terminate",
	"remove",
	"delete",
	"dismiss",
	"reset",
	"restart",
	"shutdown",
	"logout",
	"uninstall",
]);

const SAFE_APP_SUBCOMMANDS = new Set([
	"list",
	"status",
	"focus",
	"switch",
	"show",
	"hide",
	"unhide",
	"launch",
	"move",
	"resize",
	"set-bounds",
	"maximize",
	"minimize",
]);

const PEEKABOO_GUIDANCE = `
Peekaboo desktop automation is enabled for this session.

Use the peekaboo tool to run the Peekaboo macOS CLI with argv arrays, for example:
- {"args":["tools","--json"]}
- {"args":["see","--json","--annotate","--path","/tmp/peekaboo-see.png"]}
- {"args":["click","--on","<element-id>"]}

Peekaboo usage rules:
- Prefer observation before action: run "see --json --path ..." or "inspect-ui --json" before clicking/typing.
- Prefer element IDs from a fresh "see"/"inspect-ui" result over labels; prefer labels over coordinates; use coordinates only as a last resort.
- Re-observe after UI changes before issuing another targeted action.
- Pass "--json" for commands that support it.
- Pass "--path" for screenshot-producing commands when the image should be accessible later.
- Routine Peekaboo observation and UI actions (click/scroll/type) are allowed by default.
- High-risk actions (submits, sends, deletes, purchases, password/secret fields, permission dialogs, shell, destructive app/window operations) require user approval; the Peekaboo permission gate will prompt when detected.
- Do not use "peekaboo agent" unless the user explicitly asks to delegate to Peekaboo's own nested agent.
`.trim();

type RiskLevel = "low" | "medium" | "high";
type RiskCategory =
	| "observation"
	| "routineUi"
	| "submitSend"
	| "destructive"
	| "credential"
	| "permission"
	| "purchase"
	| "shell"
	| "appWindowDestructive"
	| "aiNetwork"
	| "system"
	| "unknown";
type PermissionDecision = "allow" | "ask" | "deny";

type ClassifiedCall = {
	command: string;
	level: RiskLevel;
	category: RiskCategory;
	reason: string;
	summary: string;
	app?: string;
	blocked?: boolean;
	blockReason?: string;
};

type Rule = {
	id: string;
	decision: PermissionDecision;
	tool: string; // subcommand, category:<RiskCategory>, level:<RiskLevel>, or *
	app: string; // app name or *
	risk: RiskCategory | "*";
	level: RiskLevel | "*";
	label: string;
	createdAt: string;
};

type SessionGrants = {
	allowAll: boolean;
	rules: Rule[];
};

type PeekabooConfig = {
	version: 1;
	defaultPolicy: Record<RiskLevel, PermissionDecision>;
	toolExposure: {
		deny: string[];
	};
	rules: Rule[];
};

type RecentDecision = {
	id: string;
	timestamp: string;
	action: string;
	decision: string;
	call: ClassifiedCall;
	ruleCandidate: Rule;
};

type UiLike = {
	hasUI: boolean;
	ui: {
		select: (message: string, options: string[]) => Promise<string | undefined>;
		confirm: (title: string, message?: string) => Promise<boolean>;
		input?: (message: string, placeholder?: string) => Promise<string | undefined>;
		notify: (message: string, level?: "info" | "warning" | "error") => void;
		setStatus?: (key: string, value?: string) => void;
	};
};

type PeekabooState = {
	active: boolean;
	registered: boolean;
	config: PeekabooConfig;
	session: SessionGrants;
	recent: RecentDecision[];
};

function defaultConfig(): PeekabooConfig {
	return {
		version: 1,
		defaultPolicy: {
			low: "allow",
			medium: "allow",
			high: "ask",
		},
		toolExposure: { deny: [] },
		rules: [],
	};
}

function makeId(prefix: string): string {
	return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeCommand(args: string[]): string {
	const first = args.find((arg) => arg.trim().length > 0) ?? "--help";
	return first.trim().toLowerCase();
}

function argPresent(args: string[], ...names: string[]): boolean {
	const wanted = new Set(names.map((name) => name.toLowerCase()));
	return args.some((arg) => wanted.has(arg.toLowerCase()));
}

function readFlagValue(args: string[], ...names: string[]): string | undefined {
	const wanted = new Set(names.map((name) => name.toLowerCase()));
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] ?? "";
		const lower = arg.toLowerCase();
		if (wanted.has(lower)) return args[i + 1];
		const eq = lower.indexOf("=");
		if (eq > 0 && wanted.has(lower.slice(0, eq))) return arg.slice(eq + 1);
	}
	return undefined;
}

function extractApp(args: string[]): string | undefined {
	const explicit = readFlagValue(args, "--app", "--app-target", "--target-app");
	if (explicit?.trim()) return explicit.trim();
	const pid = readFlagValue(args, "--pid");
	if (pid?.trim()) return `PID:${pid.trim()}`;
	const pidArg = args.find((arg) => /^PID:\d+/i.test(arg));
	if (pidArg) return pidArg;
	return undefined;
}

function combinedArgsText(args: string[]): string {
	return args.join(" ").toLowerCase().replace(/[\-_]+/g, " ");
}

function findKeywordCategory(text: string): RiskCategory | undefined {
	for (const [category, keywords] of Object.entries(HIGH_RISK_KEYWORDS) as Array<[RiskCategory, string[]]>) {
		if (keywords.some((keyword) => text.includes(keyword))) return category;
	}
	return undefined;
}

function hasSensitiveTokenShape(text: string): boolean {
	return /\b(sk-[a-z0-9_-]{12,}|xox[baprs]-[a-z0-9-]{12,}|gh[pousr]_[a-z0-9_]{20,})\b/i.test(text);
}

function classifyActionCommand(command: string, args: string[]): ClassifiedCall {
	const text = combinedArgsText(args);
	const app = extractApp(args);
	const keywordCategory = findKeywordCategory(text);
	if (keywordCategory) {
		return {
			command,
			level: "high",
			category: keywordCategory,
			reason: `Target or arguments look like a ${keywordCategory} action.`,
			summary: `peekaboo ${command}`,
			app,
		};
	}
	if ((command === "type" || command === "paste" || command === "set-value" || command === "set_value") && hasSensitiveTokenShape(args.join(" "))) {
		return {
			command,
			level: "high",
			category: "credential",
			reason: "Typed or pasted text appears to contain a secret/token.",
			summary: `peekaboo ${command}`,
			app,
		};
	}
	if ((command === "hotkey" || command === "press") && /\b(cmd|command|meta|control|ctrl)\b.*\b(q|w|delete|backspace)\b/i.test(args.join(" "))) {
		return {
			command,
			level: "high",
			category: "appWindowDestructive",
			reason: "This shortcut may close, quit, or delete content.",
			summary: `peekaboo ${command}`,
			app,
		};
	}
	return {
		command,
		level: "medium",
		category: "routineUi",
		reason: `peekaboo ${command} is a routine UI action.`,
		summary: `peekaboo ${command}`,
		app,
	};
}

function classifyAppCommand(command: string, args: string[]): ClassifiedCall {
	const app = extractApp(args);
	const subcommand = (args[1] ?? "").toLowerCase();
	const text = combinedArgsText(args);

	if (command === "dialog") {
		return {
			command,
			level: "high",
			category: "permission",
			reason: "Dialog interaction can confirm destructive or permission prompts.",
			summary: "peekaboo dialog",
			app,
		};
	}

	if (DESTRUCTIVE_SUBCOMMANDS.has(subcommand) || findKeywordCategory(text) === "destructive") {
		return {
			command,
			level: "high",
			category: "appWindowDestructive",
			reason: `peekaboo ${command} ${subcommand || ""}`.trim() + " may close, quit, delete, or otherwise destructively change app/window state.",
			summary: `peekaboo ${command}${subcommand ? ` ${subcommand}` : ""}`,
			app,
		};
	}

	if (SAFE_APP_SUBCOMMANDS.has(subcommand) || !subcommand) {
		return {
			command,
			level: "medium",
			category: "routineUi",
			reason: `peekaboo ${command} ${subcommand || ""}`.trim() + " can manipulate app/window focus or layout.",
			summary: `peekaboo ${command}${subcommand ? ` ${subcommand}` : ""}`,
			app,
		};
	}

	return {
		command,
		level: "high",
		category: "unknown",
		reason: `Unknown or potentially sensitive ${command} subcommand "${subcommand}".`,
		summary: `peekaboo ${command}${subcommand ? ` ${subcommand}` : ""}`,
		app,
	};
}

function classifyPeekabooCall(args: string[]): ClassifiedCall {
	const command = normalizeCommand(args);
	const app = extractApp(args);

	if (command === "mcp") {
		return {
			command,
			level: "high",
			category: "system",
			reason: "peekaboo mcp is a long-running server, not a one-shot tool call.",
			summary: "peekaboo mcp",
			blocked: true,
			blockReason: "peekaboo mcp is a long-running server, not a one-shot tool call.",
		};
	}

	if (AI_NETWORK_COMMANDS.has(command)) {
		return {
			command,
			level: "high",
			category: "aiNetwork",
			reason: `peekaboo ${command} may call external AI providers or delegate to another agent.`,
			summary: `peekaboo ${command}`,
			app,
		};
	}

	if (command === "image" && argPresent(args, "--analyze", "--question", "question")) {
		return {
			command,
			level: "high",
			category: "aiNetwork",
			reason: "peekaboo image analysis may send a screenshot to a configured external AI provider.",
			summary: "peekaboo image --analyze",
			app,
		};
	}

	if (command === "see" && argPresent(args, "--analyze")) {
		return {
			command,
			level: "high",
			category: "aiNetwork",
			reason: "peekaboo see analysis may send a screenshot to a configured external AI provider.",
			summary: "peekaboo see --analyze",
			app,
		};
	}

	if (command === "permissions") {
		const subcommand = (args[1] ?? "status").toLowerCase();
		return subcommand === "status"
			? { command, level: "low", category: "observation", reason: "Permission status is observational.", summary: "peekaboo permissions status", app }
			: { command, level: "high", category: "permission", reason: "peekaboo permissions can open/request macOS privacy permission flows.", summary: `peekaboo permissions ${subcommand}`, app };
	}

	if (command === "daemon" || command === "bridge") {
		const subcommand = (args[1] ?? "status").toLowerCase();
		return subcommand === "status"
			? { command, level: "low", category: "observation", reason: `${command} status is observational.`, summary: `peekaboo ${command} status`, app }
			: { command, level: "high", category: "system", reason: `peekaboo ${command} changes automation runtime behavior.`, summary: `peekaboo ${command} ${subcommand}`, app };
	}

	if (command === "clipboard") {
		return {
			command,
			level: "high",
			category: "credential",
			reason: "Clipboard access can expose or overwrite sensitive data.",
			summary: "peekaboo clipboard",
			app,
		};
	}

	if (command === "shell" || command === "run") {
		return {
			command,
			level: "high",
			category: "shell",
			reason: "Shell execution can run arbitrary commands.",
			summary: `peekaboo ${command}`,
			app,
		};
	}

	if (SYSTEM_COMMANDS.has(command)) {
		return {
			command,
			level: "high",
			category: "system",
			reason: `peekaboo ${command} can change Peekaboo/system state or start long-running behavior.`,
			summary: `peekaboo ${command}`,
			app,
		};
	}

	if (APP_COMMANDS.has(command)) return classifyAppCommand(command, args);
	if (ROUTINE_UI_COMMANDS.has(command)) return classifyActionCommand(command, args);

	if (OBSERVATION_COMMANDS.has(command)) {
		return {
			command,
			level: "low",
			category: "observation",
			reason: `peekaboo ${command} is observational.`,
			summary: `peekaboo ${command}`,
			app,
		};
	}

	return {
		command,
		level: "high",
		category: "unknown",
		reason: `Unknown Peekaboo subcommand "${command}".`,
		summary: `peekaboo ${command}`,
		app,
	};
}

function ruleLabel(rule: Rule): string {
	const scope = [
		rule.tool === "*" ? "all tools" : rule.tool,
		rule.level === "*" ? undefined : `${rule.level} risk`,
		rule.risk === "*" ? undefined : rule.risk,
		rule.app === "*" ? "all apps" : `app: ${rule.app}`,
	]
		.filter(Boolean)
		.join(" · ");
	return `${rule.decision.toUpperCase()} ${scope}`;
}

function buildRule(params: {
	decision: PermissionDecision;
	tool?: string;
	app?: string;
	risk?: RiskCategory | "*";
	level?: RiskLevel | "*";
	label?: string;
}): Rule {
	const rule: Rule = {
		id: makeId("rule"),
		decision: params.decision,
		tool: params.tool ?? "*",
		app: params.app ?? "*",
		risk: params.risk ?? "*",
		level: params.level ?? "*",
		label: params.label ?? "",
		createdAt: new Date().toISOString(),
	};
	rule.label = rule.label || ruleLabel(rule);
	return rule;
}

function similarRule(call: ClassifiedCall, decision: PermissionDecision): Rule {
	return buildRule({
		decision,
		tool: call.command,
		app: call.app ?? "*",
		risk: call.category,
		level: call.level,
		label: `${decision.toUpperCase()} similar ${call.summary}${call.app ? ` in ${call.app}` : ""}`,
	});
}

function appMatches(ruleApp: string, callApp?: string): boolean {
	if (ruleApp === "*") return true;
	if (!callApp) return false;
	return ruleApp.toLowerCase() === callApp.toLowerCase();
}

function toolMatches(ruleTool: string, call: ClassifiedCall): boolean {
	if (ruleTool === "*") return true;
	if (ruleTool === call.command) return true;
	if (ruleTool === `category:${call.category}`) return true;
	if (ruleTool === `level:${call.level}`) return true;
	return false;
}

function ruleMatches(rule: Rule, call: ClassifiedCall): boolean {
	if (!appMatches(rule.app, call.app)) return false;
	if (!toolMatches(rule.tool, call)) return false;
	if (rule.risk !== "*" && rule.risk !== call.category) return false;
	if (rule.level !== "*" && rule.level !== call.level) return false;
	return true;
}

function normalizeToolName(name: string): string {
	return name.trim().toLowerCase().replace(/_/g, "-");
}

function isToolDeniedByExposure(config: PeekabooConfig, command: string): boolean {
	const normalized = normalizeToolName(command);
	return config.toolExposure.deny.map(normalizeToolName).includes(normalized);
}

function evaluatePermission(state: PeekabooState, call: ClassifiedCall): { decision: PermissionDecision; reason: string; rule?: Rule } {
	if (call.blocked) return { decision: "deny", reason: call.blockReason ?? call.reason };
	if (isToolDeniedByExposure(state.config, call.command)) return { decision: "deny", reason: `peekaboo ${call.command} is disabled in /peekaboo config.` };

	const persistentDeny = state.config.rules.find((rule) => rule.decision === "deny" && ruleMatches(rule, call));
	if (persistentDeny) return { decision: "deny", reason: `Denied by rule: ${persistentDeny.label}`, rule: persistentDeny };

	const sessionDeny = state.session.rules.find((rule) => rule.decision === "deny" && ruleMatches(rule, call));
	if (sessionDeny) return { decision: "deny", reason: `Denied by session rule: ${sessionDeny.label}`, rule: sessionDeny };

	if (state.session.allowAll) return { decision: "allow", reason: "All Peekaboo actions are allowed for this session." };

	const sessionAllow = state.session.rules.find((rule) => rule.decision === "allow" && ruleMatches(rule, call));
	if (sessionAllow) return { decision: "allow", reason: `Allowed by session rule: ${sessionAllow.label}`, rule: sessionAllow };

	const persistentAsk = state.config.rules.find((rule) => rule.decision === "ask" && ruleMatches(rule, call));
	if (persistentAsk) return { decision: "ask", reason: `Asked by rule: ${persistentAsk.label}`, rule: persistentAsk };

	const persistentAllow = state.config.rules.find((rule) => rule.decision === "allow" && ruleMatches(rule, call));
	if (persistentAllow) return { decision: "allow", reason: `Allowed by rule: ${persistentAllow.label}`, rule: persistentAllow };

	return { decision: state.config.defaultPolicy[call.level], reason: `Default ${call.level}-risk policy.` };
}

async function loadConfig(): Promise<PeekabooConfig> {
	try {
		const raw = await readFile(CONFIG_PATH, "utf8");
		const parsed = JSON.parse(raw) as Partial<PeekabooConfig>;
		const defaults = defaultConfig();
		return {
			version: 1,
			defaultPolicy: { ...defaults.defaultPolicy, ...(parsed.defaultPolicy ?? {}) },
			toolExposure: { deny: [...new Set(parsed.toolExposure?.deny ?? defaults.toolExposure.deny)] },
			rules: Array.isArray(parsed.rules) ? (parsed.rules as Rule[]) : [],
		};
	} catch {
		return defaultConfig();
	}
}

async function saveConfig(config: PeekabooConfig): Promise<void> {
	await mkdir(dirname(CONFIG_PATH), { recursive: true });
	await writeFile(CONFIG_PATH, `${JSON.stringify(config, null, "\t")}\n`, "utf8");
}

function addRecentDecision(state: PeekabooState, call: ClassifiedCall, decision: string) {
	state.recent.unshift({
		id: makeId("recent"),
		timestamp: new Date().toISOString(),
		action: call.summary,
		decision,
		call,
		ruleCandidate: similarRule(call, decision.startsWith("Deny") ? "deny" : "allow"),
	});
	state.recent = state.recent.slice(0, MAX_RECENT_DECISIONS);
}

function normalizedChoice(choice: string): string {
	return choice.trim().toLowerCase();
}

function isDismissChoice(choice: string | undefined): choice is undefined {
	if (!choice) return true;
	// Some RPC clients expose dialog dismissal as a literal choice value instead of
	// an undefined/cancelled response. Treat it as cancellation so config menus do
	// not reopen forever after the user clicks Dismiss.
	return ["dismiss", "dismissed", "close", "closed", "cancelled", "canceled"].includes(normalizedChoice(choice));
}

function isExitChoice(choice: string | undefined, ...labels: string[]): choice is undefined {
	if (isDismissChoice(choice)) return true;
	const normalized = normalizedChoice(choice!);
	return labels.some((label) => normalized === normalizedChoice(label));
}

function acknowledgeHandledCommand(pi: ExtensionAPI) {
	// Paseo's Pi adapter represents every prompt as an active turn and waits for
	// a session event to settle it. Pure extension commands (for example a config
	// menu dismissed without sending a follow-up user message) do not otherwise
	// emit agent events, so send an invisible custom message as an ack.
	pi.sendMessage({ customType: "peekaboo", content: "", display: false });
}

function describeCallForPrompt(call: ClassifiedCall, args: string[], evaluationReason: string): string {
	const lines = [
		`${call.reason}`,
		`Risk: ${call.level} / ${call.category}`,
		`Policy: ${evaluationReason}`,
		`Tool: peekaboo ${call.command}`,
	];
	if (call.app) lines.push(`Target app: ${call.app}`);
	lines.push("", `Command: peekaboo ${args.map((arg) => JSON.stringify(arg)).join(" ")}`);
	return lines.join("\n");
}

async function enforcePeekabooPolicy(pi: ExtensionAPI, args: string[], state: PeekabooState, ctx: UiLike): Promise<void> {
	const call = classifyPeekabooCall(args);

	while (true) {
		const evaluation = evaluatePermission(state, call);
		if (evaluation.decision === "allow") return;
		if (evaluation.decision === "deny") throw new Error(evaluation.reason);

		if (process.env.PI_PEEKABOO_ALLOW_ACTIONS === "1") return;
		if (!ctx.hasUI) {
			throw new Error(
				`Peekaboo action blocked in non-interactive mode. ${call.reason} Set PI_PEEKABOO_ALLOW_ACTIONS=1 to override.`,
			);
		}

		const similarScope = call.app ? ` in ${call.app}` : "";
		const choice = await ctx.ui.select("Allow Peekaboo high-risk desktop action?", [
			"Allow once",
			`Allow similar actions${similarScope} for this session`,
			"Allow all Peekaboo actions this session",
			"Deny once",
			`Deny similar actions${similarScope} for this session`,
			"Configure…",
			"Details…",
		]);

		if (isDismissChoice(choice)) throw new Error("Peekaboo action cancelled by user.");
		if (choice === "Allow once") {
			addRecentDecision(state, call, "Allow once");
			return;
		}
		if (choice.startsWith("Allow similar")) {
			const rule = similarRule(call, "allow");
			state.session.rules.unshift(rule);
			addRecentDecision(state, call, "Allow similar this session");
			return;
		}
		if (choice === "Allow all Peekaboo actions this session") {
			state.session.allowAll = true;
			addRecentDecision(state, call, "Allow all this session");
			ctx.ui.setStatus?.("peekaboo", "Peekaboo allowed this session");
			ctx.ui.notify("Peekaboo allowed for this session. Revoke from /peekaboo config.", "warning");
			return;
		}
		if (choice === "Deny once") {
			addRecentDecision(state, call, "Deny once");
			throw new Error("Peekaboo action cancelled by user.");
		}
		if (choice.startsWith("Deny similar")) {
			const rule = similarRule(call, "deny");
			state.session.rules.unshift(rule);
			addRecentDecision(state, call, "Deny similar this session");
			throw new Error("Peekaboo action denied by session rule.");
		}
		if (choice === "Configure…") {
			await runConfigUi(pi, ctx, state);
			continue;
		}
		if (choice === "Details…") {
			await ctx.ui.confirm("Peekaboo action details", describeCallForPrompt(call, args, evaluation.reason));
			continue;
		}
	}
}

function clampTimeout(timeoutMs: number | undefined): number {
	if (!Number.isFinite(timeoutMs ?? NaN)) return DEFAULT_TIMEOUT_MS;
	return Math.max(1_000, Math.min(MAX_TIMEOUT_MS, Math.floor(timeoutMs!)));
}

async function formatToolOutput(stdout: string, stderr: string, code: number): Promise<{ text: string; fullOutputPath?: string }> {
	const sections: string[] = [];
	sections.push(`exit code: ${code}`);
	if (stdout.trim()) sections.push(`stdout:\n${stdout}`);
	if (stderr.trim()) sections.push(`stderr:\n${stderr}`);
	const full = sections.join("\n\n");

	const truncation = truncateHead(full, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});

	if (!truncation.truncated) return { text: truncation.content };

	const tempDir = await mkdtemp(join(tmpdir(), "pi-peekaboo-"));
	const fullOutputPath = join(tempDir, "output.txt");
	await writeFile(fullOutputPath, full, "utf8");

	let text = truncation.content;
	text += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
	text += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
	text += ` Full output saved to: ${fullOutputPath}]`;

	return { text, fullOutputPath };
}

async function chooseDecision(ctx: UiLike, title = "Decision"): Promise<PermissionDecision | undefined> {
	const choice = await ctx.ui.select(title, ["Allow", "Ask", "Deny", "Cancel"]);
	if (isExitChoice(choice, "Cancel")) return undefined;
	return normalizedChoice(choice!) as PermissionDecision;
}

async function chooseToolScope(ctx: UiLike): Promise<string | undefined> {
	const choice = await ctx.ui.select("Tool scope", [
		"All Peekaboo tools",
		"High-risk actions",
		"Observation tools",
		"Routine UI actions",
		"click",
		"scroll",
		"type",
		"hotkey",
		"paste",
		"app/window/dialog",
		"shell/system/agent",
		"Cancel",
	]);
	if (isExitChoice(choice, "Cancel")) return undefined;
	if (choice === "All Peekaboo tools") return "*";
	if (choice === "High-risk actions") return "level:high";
	if (choice === "Observation tools") return "category:observation";
	if (choice === "Routine UI actions") return "category:routineUi";
	if (choice === "app/window/dialog") return "category:appWindowDestructive";
	if (choice === "shell/system/agent") return "category:system";
	return choice;
}

async function chooseRiskScope(ctx: UiLike): Promise<{ risk: RiskCategory | "*"; level: RiskLevel | "*" } | undefined> {
	const choice = await ctx.ui.select("Risk scope", [
		"Any risk",
		"High risk only",
		"Observation",
		"Routine UI",
		"Submit/send",
		"Delete/destructive",
		"Credentials/secrets",
		"Permission dialogs",
		"Purchases/payments",
		"Shell",
		"AI/network",
		"Unknown",
		"Cancel",
	]);
	if (isExitChoice(choice, "Cancel")) return undefined;
	if (choice === "Any risk") return { risk: "*", level: "*" };
	if (choice === "High risk only") return { risk: "*", level: "high" };
	const map: Record<string, RiskCategory> = {
		Observation: "observation",
		"Routine UI": "routineUi",
		"Submit/send": "submitSend",
		"Delete/destructive": "destructive",
		"Credentials/secrets": "credential",
		"Permission dialogs": "permission",
		"Purchases/payments": "purchase",
		Shell: "shell",
		"AI/network": "aiNetwork",
		Unknown: "unknown",
	};
	return { risk: map[choice] ?? "*", level: "*" };
}

async function chooseAppScope(ctx: UiLike): Promise<string | undefined> {
	const choice = await ctx.ui.select("App scope", ["All apps", "Specific app…", "Cancel"]);
	if (isExitChoice(choice, "Cancel")) return undefined;
	if (choice === "All apps") return "*";
	const app = await ctx.ui.input?.("App name or bundle id", "Paseo");
	return app?.trim() || undefined;
}

async function createPersistentRuleUi(ctx: UiLike, state: PeekabooState, seed?: Rule): Promise<void> {
	const decision = seed?.decision ?? (await chooseDecision(ctx, "Create persistent rule: decision"));
	if (!decision) return;
	const tool = seed?.tool ?? (await chooseToolScope(ctx));
	if (!tool) return;
	const riskScope = seed ? { risk: seed.risk, level: seed.level } : await chooseRiskScope(ctx);
	if (!riskScope) return;
	const app = seed?.app ?? (await chooseAppScope(ctx));
	if (!app) return;

	const rule = buildRule({ decision, tool, app, risk: riskScope.risk, level: riskScope.level });
	const ok = await ctx.ui.confirm(
		"Save persistent Peekaboo rule?",
		`${rule.label}\n\nThis is a persistent rule. You can remove it later from /peekaboo config.`,
	);
	if (!ok) return;
	state.config.rules.unshift(rule);
	await saveConfig(state.config);
	ctx.ui.notify("Persistent Peekaboo rule saved.", "info");
}

async function sessionGrantsUi(ctx: UiLike, state: PeekabooState): Promise<void> {
	while (true) {
		const options = [
			`Allow all this session: ${state.session.allowAll ? "ON" : "off"}`,
			"Revoke all session grants",
			...state.session.rules.map((rule) => `Revoke: ${rule.label}`),
			"Back",
		];
		const choice = await ctx.ui.select("Peekaboo current session grants", options);
		if (isExitChoice(choice, "Back")) return;
		if (choice.startsWith("Allow all this session")) {
			if (state.session.allowAll && (await ctx.ui.confirm("Revoke allow-all session grant?"))) {
				state.session.allowAll = false;
				ctx.ui.setStatus?.("peekaboo", undefined);
				ctx.ui.notify("Allow-all session grant revoked.", "info");
			}
			continue;
		}
		if (choice === "Revoke all session grants") {
			if (await ctx.ui.confirm("Revoke all Peekaboo session grants?")) {
				state.session.allowAll = false;
				state.session.rules = [];
				ctx.ui.setStatus?.("peekaboo", undefined);
				ctx.ui.notify("Peekaboo session grants revoked.", "info");
			}
			continue;
		}
		const index = options.indexOf(choice) - 2;
		if (index >= 0 && state.session.rules[index]) {
			state.session.rules.splice(index, 1);
			ctx.ui.notify("Session rule revoked.", "info");
		}
	}
}

async function defaultPolicyUi(ctx: UiLike, state: PeekabooState): Promise<void> {
	while (true) {
		const choice = await ctx.ui.select("Peekaboo default permission policy", [
			`Low risk: ${state.config.defaultPolicy.low}`,
			`Medium risk: ${state.config.defaultPolicy.medium}`,
			`High risk: ${state.config.defaultPolicy.high}`,
			"Restore recommended defaults",
			"Back",
		]);
		if (isExitChoice(choice, "Back")) return;
		if (choice === "Restore recommended defaults") {
			state.config.defaultPolicy = defaultConfig().defaultPolicy;
			await saveConfig(state.config);
			ctx.ui.notify("Default policy restored.", "info");
			continue;
		}
		const level = choice.toLowerCase().startsWith("low") ? "low" : choice.toLowerCase().startsWith("medium") ? "medium" : "high";
		const decision = await chooseDecision(ctx, `${level} risk default`);
		if (!decision) continue;
		state.config.defaultPolicy[level] = decision;
		await saveConfig(state.config);
		ctx.ui.notify(`${level} risk now defaults to ${decision}.`, "info");
	}
}

async function toolExposureUi(ctx: UiLike, state: PeekabooState): Promise<void> {
	while (true) {
		const denied = new Set(state.config.toolExposure.deny.map(normalizeToolName));
		const options = [
			...TOOL_EXPOSURE_COMMANDS.map((tool) => `${denied.has(normalizeToolName(tool)) ? "Disabled" : "Enabled"}: ${tool}`),
			"Enable all tools",
			"Back",
		];
		const choice = await ctx.ui.select("Peekaboo tool exposure", options);
		if (isExitChoice(choice, "Back")) return;
		if (choice === "Enable all tools") {
			state.config.toolExposure.deny = [];
			await saveConfig(state.config);
			ctx.ui.notify("All Peekaboo subcommands enabled in extension policy.", "info");
			continue;
		}
		const tool = choice.split(": ")[1];
		if (!tool) continue;
		const normalized = normalizeToolName(tool);
		if (denied.has(normalized)) {
			state.config.toolExposure.deny = state.config.toolExposure.deny.filter((item) => normalizeToolName(item) !== normalized);
		} else {
			state.config.toolExposure.deny.push(tool);
		}
		await saveConfig(state.config);
	}
}

async function persistentRulesUi(ctx: UiLike, state: PeekabooState): Promise<void> {
	while (true) {
		const options = ["Create persistent rule…", ...state.config.rules.map((rule) => `Delete: ${rule.label}`), "Back"];
		const choice = await ctx.ui.select("Peekaboo persistent rules", options);
		if (isExitChoice(choice, "Back")) return;
		if (choice === "Create persistent rule…") {
			await createPersistentRuleUi(ctx, state);
			continue;
		}
		const index = options.indexOf(choice) - 1;
		const rule = state.config.rules[index];
		if (rule && (await ctx.ui.confirm("Delete persistent Peekaboo rule?", rule.label))) {
			state.config.rules.splice(index, 1);
			await saveConfig(state.config);
			ctx.ui.notify("Persistent rule deleted.", "info");
		}
	}
}

async function recentDecisionsUi(ctx: UiLike, state: PeekabooState): Promise<void> {
	while (true) {
		const options = [
			...state.recent.map((item) => `${item.decision}: ${item.action} (${new Date(item.timestamp).toLocaleTimeString()})`),
			"Clear recent decisions",
			"Back",
		];
		const choice = await ctx.ui.select("Peekaboo recent decisions", options);
		if (isExitChoice(choice, "Back")) return;
		if (choice === "Clear recent decisions") {
			state.recent = [];
			ctx.ui.notify("Recent Peekaboo decisions cleared.", "info");
			continue;
		}
		const index = options.indexOf(choice);
		const recent = state.recent[index];
		if (!recent) continue;
		const action = await ctx.ui.select(`Recent: ${recent.action}`, ["Create persistent rule from this…", "Details", "Back"]);
		if (isExitChoice(action, "Back")) continue;
		if (action === "Create persistent rule from this…") await createPersistentRuleUi(ctx, state, recent.ruleCandidate);
		if (action === "Details") await ctx.ui.confirm("Recent Peekaboo decision", `${recent.decision}\n${recent.call.reason}\nRisk: ${recent.call.level}/${recent.call.category}`);
	}
}

async function resetUi(ctx: UiLike, state: PeekabooState): Promise<void> {
	const choice = await ctx.ui.select("Reset Peekaboo config", [
		"Reset persistent config to defaults",
		"Revoke session grants only",
		"Reset everything",
		"Cancel",
	]);
	if (isExitChoice(choice, "Cancel")) return;
	if (choice === "Revoke session grants only" || choice === "Reset everything") {
		state.session.allowAll = false;
		state.session.rules = [];
		ctx.ui.setStatus?.("peekaboo", undefined);
	}
	if (choice === "Reset persistent config to defaults" || choice === "Reset everything") {
		state.config = defaultConfig();
		await saveConfig(state.config);
	}
	ctx.ui.notify("Peekaboo config reset complete.", "info");
}

async function runConfigUi(_pi: ExtensionAPI, ctx: UiLike, state: PeekabooState): Promise<void> {
	if (!ctx.hasUI) {
		throw new Error("/peekaboo config requires an interactive UI.");
	}
	state.config = await loadConfig();
	while (true) {
		const choice = await ctx.ui.select("Peekaboo config", [
			"Current session grants",
			"Default permission policy",
			"Tool exposure",
			"Persistent rules",
			"Recent decisions",
			"Reset",
			"Done",
		]);
		if (isExitChoice(choice, "Done")) return;
		if (choice === "Current session grants") await sessionGrantsUi(ctx, state);
		if (choice === "Default permission policy") await defaultPolicyUi(ctx, state);
		if (choice === "Tool exposure") await toolExposureUi(ctx, state);
		if (choice === "Persistent rules") await persistentRulesUi(ctx, state);
		if (choice === "Recent decisions") await recentDecisionsUi(ctx, state);
		if (choice === "Reset") await resetUi(ctx, state);
	}
}

function ensurePeekabooTool(pi: ExtensionAPI, state: PeekabooState) {
	if (state.registered) return;
	state.registered = true;

	pi.registerTool({
		name: TOOL_NAME,
		label: "Peekaboo",
		description: `Run the Peekaboo macOS automation CLI with argv arguments. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; full output is saved to a temp file when truncated.`,
		promptSnippet: "Run Peekaboo macOS desktop automation commands with argv arguments",
		promptGuidelines: [
			"Use the peekaboo tool only after the user enables Peekaboo with /peekaboo.",
			"Use peekaboo with argv arrays; do not construct shell strings for Peekaboo commands.",
		],
		parameters: Type.Object({
			args: Type.Array(Type.String(), {
				description: "Arguments passed after the `peekaboo` executable, for example [\"see\",\"--json\",\"--path\",\"/tmp/see.png\"].",
			}),
			timeoutMs: Type.Optional(Type.Number({ description: "Timeout in milliseconds. Defaults to 30000; clamped to 10 minutes." })),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const args = params.args.map(String);
			await enforcePeekabooPolicy(pi, args, state, ctx as UiLike);

			const timeout = clampTimeout(params.timeoutMs);
			const result = await pi.exec("peekaboo", args, { signal, timeout });
			const formatted = await formatToolOutput(result.stdout, result.stderr, result.code);

			return {
				content: [{ type: "text", text: formatted.text }],
				details: {
					args,
					timeout,
					code: result.code,
					killed: result.killed,
					fullOutputPath: formatted.fullOutputPath,
				},
			};
		},
	});
}

export default function peekabooExtension(pi: ExtensionAPI) {
	const state: PeekabooState = {
		active: false,
		registered: false,
		config: defaultConfig(),
		session: { allowAll: false, rules: [] },
		recent: [],
	};

	const enable = () => {
		ensurePeekabooTool(pi, state);
		state.active = true;
		pi.setActiveTools([...new Set([...pi.getActiveTools(), TOOL_NAME])]);
	};

	const disable = () => {
		state.active = false;
		pi.setActiveTools(pi.getActiveTools().filter((name) => name !== TOOL_NAME));
	};

	pi.registerCommand("peekaboo", {
		description: "Enable Peekaboo macOS desktop automation, or open /peekaboo config",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const lower = trimmed.toLowerCase();

			if (lower === "config" || lower.startsWith("config ")) {
				try {
					if (lower.startsWith("config ")) ctx.ui.notify("/peekaboo config is fully interactive and has no subcommands.", "info");
					await runConfigUi(pi, ctx as UiLike, state);
				} finally {
					acknowledgeHandledCommand(pi);
				}
				return;
			}

			if (["off", "disable", "disabled"].includes(lower)) {
				disable();
				ctx.ui.notify("Peekaboo disabled for this session.", "info");
				acknowledgeHandledCommand(pi);
				return;
			}

			enable();
			ctx.ui.notify("Peekaboo enabled for this session. Use /peekaboo off to disable it or /peekaboo config to manage permissions.", "info");

			if (trimmed) {
				pi.sendUserMessage(trimmed);
			} else {
				acknowledgeHandledCommand(pi);
			}
		},
	});

	pi.on("session_start", async () => {
		state.config = await loadConfig();
		state.session = { allowAll: false, rules: [] };
		state.recent = [];
	});

	pi.on("before_agent_start", (event) => {
		if (!state.active) return undefined;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${PEEKABOO_GUIDANCE}`,
		};
	});

	pi.on("session_shutdown", () => {
		state.active = false;
		state.session = { allowAll: false, rules: [] };
	});
}
