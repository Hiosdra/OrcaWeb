---
name: release
description: >
  Cut a new OrcaWeb app release: bumps the version in package.json, updates
  mkdocs-docs/status.md (Ostatnia aktualizacja date + wersja aplikacji), commits,
  and pushes. Use whenever the user says "/release", "cut a release", "bump to
  vX.Y.Z", "release version X", or "tag a new release". Always invoke this skill
  before doing any manual release steps — it covers the full checklist.
---

# OrcaWeb Release Skill

Handles the full release checklist for OrcaWeb. The release surface is small and
well-defined — follow these steps in order.

## Step 0 — determine the new version

If the user passed a version as an argument (e.g. `/release 0.5.0`), use it.
Otherwise ask: "What version? (current is X.Y.Z from package.json)"

Read the current version from `package.json` to confirm what you're bumping from.

## Step 1 — update package.json

Edit the `"version"` field in `package.json` from the old value to the new one.

```json
"version": "0.5.0"
```

## Step 2 — update mkdocs-docs/status.md

Line 5 of `mkdocs-docs/status.md` is the canonical release metadata line. It looks like:

```
Ostatnia aktualizacja: **2026-06-13** · wersja silnika: **OrcaSlicer v2.3.2** (własny build, wdrożony na produkcji) · wersja aplikacji: **PR #12 merged**
```

Update exactly two values in that line:
- **Ostatnia aktualizacja** date → today's date in `YYYY-MM-DD` format
- **wersja aplikacji** → `v{new_version}` (e.g. `v0.5.0`)

Leave "wersja silnika" and the rest of the line untouched — it tracks the WASM
engine version, which is independent of the app version.

## Step 3 — verify nothing else needs updating

Grep for the old version string to catch any other references:

```bash
grep -r "0.4.0" --include="*.json" --include="*.md" --include="*.ts" .
```

Update any additional references you find (e.g. docs, changelogs).

> Note: `vite.config.ts` reads version from `package.json` dynamically and
> `VITE_RELEASE_DATE` falls back to today's ISO date at build time — neither
> file needs manual editing.

## Step 4 — commit

Stage the changed files and commit with:

```
chore(release): bump to v{new_version}
```

Only stage `package.json`, `mkdocs-docs/status.md`, and any other version-reference
files you updated. Do not stage unrelated changes.

## Step 5 — push + GitHub release tag (ask first)

Ask: "Push to master and create a GitHub release tag?"

If yes:
1. `git push origin master` (or the current branch if not on master)
2. Create an annotated tag and push it:

```bash
git tag -a "v{new_version}" -m "Release v{new_version}"
git push origin "v{new_version}"
```

> Pushing to master triggers the `deploy.yml` CI workflow, which rebuilds and
> deploys the app to GitHub Pages automatically. No further action needed for
> deployment.

## What this skill does NOT handle

- WASM engine version bumps (`wersja silnika` in status.md, `WASM_TAG` in
  `.github/workflows/`, `scripts/download-wasm.mjs`) — those are separate and
  require triggering `build-wasm.yml` manually with the new OrcaSlicer tag.
