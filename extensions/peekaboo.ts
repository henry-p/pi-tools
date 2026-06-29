import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TOOL_NAME = "peekaboo";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 10 * 60_000;

const READ_ONLY_COMMANDS = new Set([
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

const HIGH_RISK_COMMANDS = new Set([
	"agent",
	"analyze",
	"mcp",
	"run",
	"config",
	"clipboard",
	"dialog",
	"app",
	"open",
	"window",
	"space",
	"menu",
	"menubar",
	"dock",
	"clean",
]);

const ACTION_COMMANDS = new Set([
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
- Ask the user before destructive actions, submitting forms, clicking permission dialogs, purchases, sends, deletes, or typing sensitive data.
- Do not use "peekaboo agent" unless the user explicitly asks to delegate to Peekaboo's own nested agent.
`.trim();

type Risk = "allow" | "confirm" | "block";

type RiskDecision = {
	risk: Risk;
	reason?: string;
};

function normalizeCommand(args: string[]): string {
	const first = args.find((arg) => arg.trim().length > 0) ?? "--help";
	return first.trim().toLowerCase();
}

function argPresent(args: string[], ...names: string[]): boolean {
	const wanted = new Set(names.map((name) => name.toLowerCase()));
	return args.some((arg) => wanted.has(arg.toLowerCase()));
}

function classifyPeekabooCall(args: string[]): RiskDecision {
	const command = normalizeCommand(args);

	if (command === "mcp") {
		return { risk: "block", reason: "peekaboo mcp is a long-running server, not a one-shot tool call." };
	}

	if (command === "agent") {
		return {
			risk: "confirm",
			reason: "peekaboo agent delegates to Peekaboo's own nested AI agent and may call external AI providers.",
		};
	}

	if (command === "analyze") {
		return { risk: "confirm", reason: "peekaboo analyze may send an image to a configured external AI provider." };
	}

	if (command === "image" && argPresent(args, "--analyze", "--question", "question")) {
		return { risk: "confirm", reason: "peekaboo image analysis may send a screenshot to a configured external AI provider." };
	}

	if (command === "see" && argPresent(args, "--analyze")) {
		return { risk: "confirm", reason: "peekaboo see analysis may send a screenshot to a configured external AI provider." };
	}

	if (command === "permissions") {
		const subcommand = (args[1] ?? "status").toLowerCase();
		return subcommand === "status"
			? { risk: "allow" }
			: { risk: "confirm", reason: "peekaboo permissions can open or request macOS privacy permission flows." };
	}

	if (command === "daemon") {
		const subcommand = (args[1] ?? "status").toLowerCase();
		return subcommand === "status"
			? { risk: "allow" }
			: { risk: "confirm", reason: "peekaboo daemon can start/stop a long-lived local automation daemon." };
	}

	if (command === "bridge") {
		const subcommand = (args[1] ?? "status").toLowerCase();
		return subcommand === "status" ? { risk: "allow" } : { risk: "confirm", reason: "peekaboo bridge changes automation runtime behavior." };
	}

	if (READ_ONLY_COMMANDS.has(command)) {
		return { risk: "allow" };
	}

	if (HIGH_RISK_COMMANDS.has(command)) {
		return { risk: "confirm", reason: `peekaboo ${command} can inspect or manipulate apps/system state.` };
	}

	if (ACTION_COMMANDS.has(command)) {
		return { risk: "confirm", reason: `peekaboo ${command} can interact with the desktop.` };
	}

	return { risk: "confirm", reason: `Unknown Peekaboo subcommand "${command}".` };
}

async function maybeConfirmRisk(args: string[], decision: RiskDecision, ctx: { hasUI: boolean; ui: { confirm: (title: string, message?: string) => Promise<boolean> } }) {
	if (decision.risk === "allow") return;
	if (decision.risk === "block") {
		throw new Error(decision.reason ?? "This Peekaboo call is blocked.");
	}

	if (process.env.PI_PEEKABOO_ALLOW_ACTIONS === "1") return;

	if (!ctx.hasUI) {
		throw new Error(
			`Peekaboo action blocked in non-interactive mode. ${decision.reason ?? "Action requires confirmation."} Set PI_PEEKABOO_ALLOW_ACTIONS=1 to override.`,
		);
	}

	const ok = await ctx.ui.confirm(
		"Allow Peekaboo desktop action?",
		`${decision.reason ?? "This may interact with your desktop."}\n\npeekaboo ${args.map((arg) => JSON.stringify(arg)).join(" ")}`,
	);
	if (!ok) throw new Error("Peekaboo action cancelled by user.");
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

function ensurePeekabooTool(pi: ExtensionAPI, state: { registered: boolean }) {
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
			const decision = classifyPeekabooCall(args);
			await maybeConfirmRisk(args, decision, ctx);

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
	const state = {
		active: false,
		registered: false,
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
		description: "Enable Peekaboo macOS desktop automation for this session: /peekaboo [task]",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (["off", "disable", "disabled"].includes(trimmed.toLowerCase())) {
				disable();
				ctx.ui.notify("Peekaboo disabled for this session.", "info");
				return;
			}

			enable();
			ctx.ui.notify("Peekaboo enabled for this session. Use /peekaboo off to disable it.", "info");

			if (trimmed) {
				pi.sendUserMessage(trimmed);
			}
		},
	});

	pi.on("before_agent_start", (event) => {
		if (!state.active) return undefined;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${PEEKABOO_GUIDANCE}`,
		};
	});

	pi.on("session_shutdown", () => {
		state.active = false;
	});
}
