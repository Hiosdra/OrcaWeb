---
name: release
description: >
  Cut a deliberate minor/major OrcaWeb version bump (e.g. v0.7.0 -> v0.8.0 or
  v1.0.0). Routine patch releases no longer need this skill — deploy.yml
  auto-bumps the patch version on every merge to master. Use this skill only
  when the user explicitly wants to jump to a specific minor/major version
  ("/release 0.8.0", "bump to v1.0.0", "cut a minor release").
---

# OrcaWeb Release Skill

Patch-level app releases and WASM engine releases are both fully automated —
see "What's automatic now" below. This skill only covers the case where a
human deliberately wants to jump to a *specific* version (typically a minor
or major bump) rather than letting CI auto-increment the patch number.

## Step 0 — determine the new version

If the user passed a version as an argument (e.g. `/release 0.8.0`), use it.
Otherwise ask: "What version? (current is X.Y.Z from package.json)"

Read the current version from `package.json` to confirm what you're bumping from.

## Step 1 — update package.json

Edit the `"version"` field in `package.json` from the old value to the new one.

```json
"version": "0.8.0"
```

## Step 2 — update package-lock.json

`package-lock.json` mirrors the version in two places — the top-level
`"version"` field and `.packages[""].version`. Update both to match.

## Step 3 — verify nothing else needs updating

Grep for the old version string to catch any other references:

```bash
grep -r "0.7.0" --include="*.json" --include="*.md" --include="*.ts" .
```

Update any additional references you find (e.g. docs, changelogs).

> Note: `vite.config.ts` reads the version from `package.json` dynamically, and
> `mkdocs-docs/status.md`'s date/version line is rewritten automatically by
> deploy.yml's "Auto-bump app version" step on every deploy — neither needs
> manual editing.

## Step 4 — commit and push

Commit just `package.json` and `package-lock.json` (plus anything else you
updated in step 3) with a message like:

```
chore(release): bump to v0.8.0
```

Push to master (or open a PR, per this repo's usual flow). Once it lands,
deploy.yml's auto-bump step will see that `package.json`'s version already
differs from the latest git tag and will respect it as-is — tagging and
deploying `v0.8.0` — instead of incrementing the patch on top of it.

## What's automatic now (no skill needed)

- **App/pages patch releases**: every deploy (any push to master, or the
  chained redeploy after an engine rebuild) auto-bumps the patch version,
  updates `mkdocs-docs/status.md`, commits, and tags — see deploy.yml's
  "Auto-bump app version" step. Nothing to run manually for a routine patch.
- **Engine releases**: any master push touching `orca-wasm/**` (or
  `build-wasm.yml` itself) automatically triggers `build-wasm.yml`, which
  builds and publishes a new `wasm-v2.4.0-patchN` release, and deploy.yml
  automatically redeploys once that finishes (via `workflow_run`). No manual
  `workflow_dispatch` needed for routine bridge/patch changes.
- **Engine header label**: the app header's "engine vX.Y.Z" text reflects the
  actually-resolved WASM release tag automatically (deploy.yml's
  `ENGINE_LABEL`) — nothing to edit for that either.

## What this skill still does NOT handle

- **Upstream OrcaSlicer version upgrades** (bumping `ORCA_VERSION` itself,
  e.g. targeting a new OrcaSlicer v2.5.0) — that's a deliberate change to
  `ORCA_VERSION` in both `deploy.yml` and `build-wasm.yml`, plus whatever
  patch/override work the new upstream version needs. Not something to
  automate; do it by hand and review the diff carefully.
