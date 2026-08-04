#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const UPSTREAM_REPOSITORY = "https://github.com/pbakaus/impeccable.git";
const UPSTREAM_ARCHIVE_BASE = "https://github.com/pbakaus/impeccable/archive";
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const VENDOR_ROOT = join(PACKAGE_ROOT, "vendor");
const VENDOR_SKILL_DIR = join(VENDOR_ROOT, "impeccable");
const THIRD_PARTY_LICENSE_DIR = join(PACKAGE_ROOT, "THIRD_PARTY_LICENSES");
const THIRD_PARTY_LICENSE_PATH = join(THIRD_PARTY_LICENSE_DIR, "IMPECCABLE-APACHE-2.0.txt");
const METADATA_PATH = join(PACKAGE_ROOT, "UPSTREAM.json");

function fail(message) {
  throw new Error(message);
}

function validateTag(tag) {
  if (!/^skill-v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(tag)) {
    fail(`expected a skill release tag such as skill-v4.0.4, received ${JSON.stringify(tag)}`);
  }
}

function resolveTag(tag) {
  let output;
  try {
    output = execFileSync(
      "git",
      ["ls-remote", "--tags", UPSTREAM_REPOSITORY, `refs/tags/${tag}`, `refs/tags/${tag}^{}`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
    );
  } catch {
    fail(`could not resolve ${tag} from ${UPSTREAM_REPOSITORY}`);
  }

  const refs = new Map(
    output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [commit, ref] = line.split(/\s+/, 2);
        return [ref, commit];
      }),
  );
  const commit = refs.get(`refs/tags/${tag}^{}`) || refs.get(`refs/tags/${tag}`);
  if (!commit || !/^[0-9a-f]{40}$/.test(commit)) fail(`tag ${tag} was not found`);
  return commit;
}

async function downloadArchive(commit, destination) {
  const url = `${UPSTREAM_ARCHIVE_BASE}/${commit}.tar.gz`;
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) fail(`archive download failed with HTTP ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  await writeFile(destination, archive);
  return {
    url,
    sha256: createHash("sha256").update(archive).digest("hex"),
  };
}

function extractArchive(archive, destination) {
  const result = spawnSync("tar", ["-xzf", archive, "-C", destination], { stdio: "inherit" });
  if (result.error) fail(`could not run tar: ${result.error.message}`);
  if (result.status !== 0) fail(`tar exited with status ${result.status}`);
}

function skillVersion(source) {
  const match = source.match(/^version:\s*([^\s]+)\s*$/m);
  return match?.[1];
}

async function main() {
  let current = {};
  try {
    current = JSON.parse(await readFile(METADATA_PATH, "utf8"));
  } catch {
    // First import has no metadata yet.
  }

  const tag = process.argv[2] || current.tag;
  if (!tag) fail("pass an upstream skill tag, for example: npm run update:upstream -- skill-v4.0.4");
  validateTag(tag);

  console.log(`Resolving ${tag}…`);
  const commit = resolveTag(tag);
  const workDir = await mkdtemp(join(tmpdir(), "pi-impeccable-upstream-"));

  try {
    const archivePath = join(workDir, "upstream.tar.gz");
    const extractedDir = join(workDir, "extracted");
    await mkdir(extractedDir);

    console.log(`Downloading ${commit}…`);
    const archive = await downloadArchive(commit, archivePath);
    extractArchive(archivePath, extractedDir);

    const sourceRoot = join(extractedDir, `impeccable-${commit}`);
    const sourceSkillDir = join(sourceRoot, ".pi", "skills", "impeccable");
    const sourceSkill = await readFile(join(sourceSkillDir, "SKILL.md"), "utf8");
    const expectedVersion = tag.slice("skill-v".length);
    const actualVersion = skillVersion(sourceSkill);
    if (actualVersion !== expectedVersion) {
      fail(`tag ${tag} contains skill version ${actualVersion || "(missing)"}, expected ${expectedVersion}`);
    }

    await rm(VENDOR_SKILL_DIR, { recursive: true, force: true });
    await mkdir(VENDOR_ROOT, { recursive: true });
    await cp(sourceSkillDir, VENDOR_SKILL_DIR, { recursive: true });

    await mkdir(THIRD_PARTY_LICENSE_DIR, { recursive: true });
    await cp(join(sourceRoot, "LICENSE"), THIRD_PARTY_LICENSE_PATH);

    const metadata = {
      repository: "https://github.com/pbakaus/impeccable",
      tag,
      version: actualVersion,
      commit,
      archiveUrl: archive.url,
      archiveSha256: archive.sha256,
      license: "Apache-2.0",
      importedAt: new Date().toISOString(),
    };
    await writeFile(METADATA_PATH, `${JSON.stringify(metadata, null, 2)}\n`);

    console.log(`Imported Impeccable ${actualVersion} (${commit.slice(0, 12)}).`);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  console.error(`update-upstream: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
