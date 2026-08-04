# pi-impeccable-skill

[Impeccable](https://github.com/pbakaus/impeccable) design workflows packaged for [Pi](https://pi.dev/).

This independently maintained adapter is not affiliated with or endorsed by the Impeccable project. It vendors the generated Pi skill from an exact upstream skill release and adds a small Pi extension that provides `/impeccable` command completion and makes bundled script paths work outside a project-local `.pi` directory.

## Install

From npm after publication:

```bash
pi install npm:pi-impeccable-skill
```

For local development from this monorepo:

```bash
pi install ./packages/pi-impeccable-skill
```

Restart Pi or run `/reload`, then invoke a workflow:

```text
/impeccable init
/impeccable critique src
/impeccable audit src
/impeccable polish src
```

The original skill command remains available as `/skill:impeccable`.

## How it works

- `vendor/impeccable/` is an unmodified copy of `.pi/skills/impeccable/` from the pinned upstream release recorded in [`UPSTREAM.json`](./UPSTREAM.json).
- `extensions/impeccable.js` registers `/impeccable`, forwards it to the vendored skill, and rewrites project-relative script calls to the package copy when the project does not have its own Impeccable installation.
- A real project-local `.pi/skills/impeccable/scripts` directory takes precedence, preserving Impeccable's normal project install behavior.

## Update from upstream

Import a released upstream skill tag:

```bash
npm run update:upstream --workspace pi-impeccable-skill -- skill-v4.0.4
npm test --workspace pi-impeccable-skill
```

The updater:

1. Resolves the exact Git commit behind the tag.
2. Downloads the archive by commit rather than by a moving branch.
3. Verifies that `SKILL.md` reports the tag's version.
4. Replaces only the vendored skill and upstream license.
5. Records the commit and archive SHA-256 in `UPSTREAM.json`.

Review the vendored diff before committing an update. Upstream's skill, references, scripts, and agents are executable instructions and must be treated as trusted code.

## Development

```bash
npm test --workspace pi-impeccable-skill
npm pack --workspace pi-impeccable-skill --dry-run
```

## Licensing

The Pi adapter is MIT licensed. Vendored Impeccable files remain under the upstream Apache-2.0 license, included at [`THIRD_PARTY_LICENSES/IMPECCABLE-APACHE-2.0.txt`](./THIRD_PARTY_LICENSES/IMPECCABLE-APACHE-2.0.txt).
