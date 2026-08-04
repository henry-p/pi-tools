import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import impeccablePiExtension, {
  getImpeccableCompletions,
  locateImpeccableSkill,
  parseLiveTailscaleArgs,
  rewriteImpeccableScriptPaths,
  rewriteLiveScriptOrigin,
} from "../extensions/impeccable.js";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"));

function fixtureSkill() {
  const root = join(tmpdir(), `pi-impeccable-test-${process.pid}-${Date.now()}-${Math.random()}`);
  const skill = join(root, ".agents", "skills", "impeccable");
  mkdirSync(join(skill, "scripts"), { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "---\nname: impeccable\nversion: 9.9.9\n---\n");
  writeFileSync(join(skill, "scripts", "command-metadata.json"), "{}");
  return { root, skill, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("Pi package", () => {
  it("ships only the adapter and depends on the official CLI", () => {
    assert.equal(pkg.version, "0.3.1");
    assert.equal(pkg.keywords.includes("pi-package"), true);
    assert.deepEqual(pkg.pi, { extensions: ["./extensions/impeccable.js"] });
    assert.deepEqual(pkg.dependencies, { impeccable: "^3.5.0" });
    assert.equal(pkg.files.includes("scripts"), true);
    assert.equal(pkg.files.includes("vendor"), false);
    assert.equal(existsSync(join(PACKAGE_ROOT, "scripts", "tailscale-proxy.mjs")), true);
    assert.equal(existsSync(join(PACKAGE_ROOT, "vendor")), false);
  });

  it("finds a project installation of the upstream skill", () => {
    const fixture = fixtureSkill();
    try {
      assert.equal(locateImpeccableSkill(fixture.root, "/tmp/no-home"), fixture.skill);
    } finally {
      fixture.cleanup();
    }
  });
});

describe("script path compatibility", () => {
  it("rewrites Pi and Agents script calls to the discovered installation", () => {
    const options = {
      cwd: "/tmp/project",
      localScriptDirs: [],
      skillRoot: "/tmp/impeccable skill",
    };
    assert.equal(
      rewriteImpeccableScriptPaths(
        "node .pi/skills/impeccable/scripts/context.mjs --target src",
        options,
      ),
      "node '/tmp/impeccable skill/scripts'/context.mjs --target src",
    );
    assert.equal(
      rewriteImpeccableScriptPaths(
        'node ".agents/skills/impeccable/scripts/context.mjs"',
        options,
      ),
      'node "/tmp/impeccable skill/scripts/context.mjs"',
    );
  });

  it("leaves project-local script paths untouched", () => {
    const command = "node .agents/skills/impeccable/scripts/context.mjs";
    const existing = join(tmpdir(), `pi-impeccable-scripts-${process.pid}-${Date.now()}`);
    mkdirSync(existing, { recursive: true });
    try {
      assert.equal(
        rewriteImpeccableScriptPaths(command, { localScriptDirs: [existing] }),
        command,
      );
    } finally {
      rmSync(existing, { recursive: true, force: true });
    }
  });
});

describe("/impeccable command", () => {
  it("completes upstream and management subcommands", () => {
    const completions = getImpeccableCompletions("au", {
      audit: { description: "Run checks", argumentHint: "[target]" },
      polish: { description: "Final pass", argumentHint: "[target]" },
    });
    assert.deepEqual(completions?.map((item) => item.value), ["audit "]);
    assert.deepEqual(getImpeccableCompletions("up")?.map((item) => item.value), ["update"]);
    assert.deepEqual(getImpeccableCompletions("live-t")?.map((item) => item.value), ["live-tailscale "]);
    assert.equal(getImpeccableCompletions("audit src"), null);
  });

  it("parses live-tailscale arguments", () => {
    assert.deepEqual(parseLiveTailscaleArgs("start --target src/pages/index.astro --app-port 4321"), {
      action: "start",
      target: "src/pages/index.astro",
      appPort: 4321,
    });
    assert.deepEqual(parseLiveTailscaleArgs("status"), {
      action: "status",
      target: undefined,
      appPort: 4321,
    });
  });

  it("rewrites only the injected live script tag", () => {
    const root = join(tmpdir(), `pi-impeccable-rewrite-${process.pid}-${Date.now()}`);
    const file = join(root, "index.html");
    mkdirSync(root, { recursive: true });
    writeFileSync(file, '<!-- impeccable-live-start --><script src="http://localhost:8410/live.js?token=secret"></script><!-- impeccable-live-end -->');
    try {
      assert.equal(rewriteLiveScriptOrigin(file, 8410, "http://100.64.0.1:9000"), true);
      assert.match(readFileSync(file, "utf8"), /http:\/\/100\.64\.0\.1:9000\/live\.js\?token=secret/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("discovers the skill, forwards commands, and installs the bash hook", async () => {
    const fixture = fixtureSkill();
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

    try {
      impeccablePiExtension(pi);
      assert.equal(commands.has("impeccable"), true);
      assert.equal(handlers.has("resources_discover"), true);
      assert.equal(handlers.has("tool_call"), true);
      assert.deepEqual(handlers.get("resources_discover")({ cwd: fixture.root }), {
        skillPaths: [fixture.skill],
      });

      await commands.get("impeccable").handler("audit src", {
        cwd: fixture.root,
        hasUI: true,
        isIdle: () => true,
      });
      assert.deepEqual(sentMessages, [
        { message: "/skill:impeccable audit src", options: undefined },
      ]);
    } finally {
      fixture.cleanup();
    }
  });
});
