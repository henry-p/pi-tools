import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import impeccablePiExtension, {
  getImpeccableCompletions,
  rewriteImpeccableScriptPaths,
} from "../extensions/impeccable.js";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"));
const upstream = JSON.parse(readFileSync(join(PACKAGE_ROOT, "UPSTREAM.json"), "utf8"));
const skill = readFileSync(join(PACKAGE_ROOT, "vendor", "impeccable", "SKILL.md"), "utf8");

describe("Pi package", () => {
  it("declares the extension and vendored skill", () => {
    assert.equal(pkg.keywords.includes("pi-package"), true);
    assert.deepEqual(pkg.pi, {
      extensions: ["./extensions/impeccable.js"],
      skills: ["./vendor"],
    });
    assert.equal(pkg.files.includes("vendor"), true);
    assert.equal(pkg.files.includes("THIRD_PARTY_LICENSES"), true);
  });

  it("pins a released upstream skill and its license", () => {
    assert.match(upstream.tag, /^skill-v\d+\.\d+\.\d+/);
    assert.match(upstream.commit, /^[0-9a-f]{40}$/);
    assert.match(upstream.archiveSha256, /^[0-9a-f]{64}$/);
    assert.match(skill, new RegExp(`^version:\\s*${upstream.version}\\s*$`, "m"));
    assert.equal(upstream.tag, `skill-v${upstream.version}`);
    assert.equal(
      existsSync(join(PACKAGE_ROOT, "THIRD_PARTY_LICENSES", "IMPECCABLE-APACHE-2.0.txt")),
      true,
    );
  });
});

describe("script path compatibility", () => {
  it("rewrites bundled script calls when a project has no local skill", () => {
    const rewritten = rewriteImpeccableScriptPaths(
      "node .pi/skills/impeccable/scripts/context.mjs --target src",
      { scriptsDir: "/tmp/impeccable package/vendor/impeccable/scripts", hasLocalScripts: false },
    );

    assert.equal(
      rewritten,
      "node '/tmp/impeccable package/vendor/impeccable/scripts'/context.mjs --target src",
    );
  });

  it("preserves quoted paths and project-local installs", () => {
    assert.equal(
      rewriteImpeccableScriptPaths('node ".pi/skills/impeccable/scripts/context.mjs"', {
        scriptsDir: "/tmp/package/vendor/impeccable/scripts",
        hasLocalScripts: false,
      }),
      'node "/tmp/package/vendor/impeccable/scripts/context.mjs"',
    );

    const command = "node .pi/skills/impeccable/scripts/context.mjs";
    assert.equal(
      rewriteImpeccableScriptPaths(command, { hasLocalScripts: true }),
      command,
    );
  });
});

describe("/impeccable command", () => {
  it("completes subcommands", () => {
    const completions = getImpeccableCompletions("au", {
      audit: { description: "Run checks", argumentHint: "[target]" },
      polish: { description: "Final pass", argumentHint: "[target]" },
    });

    assert.deepEqual(completions?.map((item) => item.value), ["audit "]);
    assert.equal(getImpeccableCompletions("audit src"), null);
  });

  it("forwards to the skill and installs the bash rewrite hook", async () => {
    const commands = new Map();
    const handlers = new Map();
    const sentMessages = [];
    const pi = {
      registerCommand(name, definition) {
        commands.set(name, definition);
      },
      on(name, handler) {
        handlers.set(name, handler);
      },
      sendUserMessage(message, options) {
        sentMessages.push({ message, options });
      },
    };

    impeccablePiExtension(pi);
    assert.equal(commands.has("impeccable"), true);
    assert.equal(handlers.has("tool_call"), true);

    await commands.get("impeccable").handler("audit src", { isIdle: () => true });
    assert.deepEqual(sentMessages, [
      { message: "/skill:impeccable audit src", options: undefined },
    ]);
  });
});
