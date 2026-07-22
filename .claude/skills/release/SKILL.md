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

## Which kind of release is this?

| You want to... | Do this |
|---|---|
| Ship whatever's on master right now | Nothing — merge as normal. deploy.yml auto-bumps the patch (`0.7.10` -> `0.7.11`) on its own. |
| Mark a meaningful feature/release boundary (backwards-compatible) | **Minor bump**: increment MINOR, reset PATCH to `0` (e.g. `0.7.10` -> `0.8.0`). This skill. |
| Mark a breaking change or a 1.0 milestone | **Major bump**: increment MAJOR, reset MINOR and PATCH to `0` (e.g. `0.7.10` -> `1.0.0`). This skill. |

Standard semver reset rule: bumping a more-significant number always zeroes
out everything less significant. Don't hand-pick an arbitrary PATCH for a
minor/major release (e.g. `0.8.10` instead of `0.8.0`) — that just confuses
the next auto-bump's starting point.

## Step 0 — determine the new version

If the user passed a version as an argument (e.g. `/release 0.8.0`), use it.
Otherwise ask: "What version? (current is X.Y.Z from package.json) — minor or
major bump?" and compute it yourself per the reset rule above rather than
asking the user to do arithmetic.

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

## Step 4 — commit and open a PR

Commit just `package.json` and `package-lock.json` (plus anything else you
updated in step 3) with a message like:

```
chore(release): bump to v0.8.0
```

`master` has a branch ruleset requiring every change to go through a pull
request — a direct `git push origin master` will be rejected unless you're
authenticated as a bypass-listed actor (repo admin, or the release deploy
key). Open a PR and merge it rather than assuming a direct push will work.

Once the merge commit lands, deploy.yml's auto-bump step will see that
`package.json`'s version already differs from the latest git tag and will
respect it as-is — tagging and deploying `v0.8.0` — instead of incrementing
the patch on top of it.

## What's automatic now (no skill needed)

- **App/pages patch releases**: every deploy (any push to master, or the
  chained redeploy after an engine rebuild) auto-bumps the patch version,
  updates `mkdocs-docs/status.md`, commits (via the `release_deploy_key`
  deploy key, marked `[skip actions]` so it doesn't retrigger itself — and
  deliberately not `[skip ci]`, which would also stop the Cloudflare mirror
  and leave it a bump behind; see the comment in deploy.yml), and tags — see
  deploy.yml's "Auto-bump app version" step. Nothing to run manually for a
  routine patch.
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
