<!-- FrameForge — instructions for coding agents. -->
# FrameForge — agent notes

## Releasing: after every change to the app

The owner wants the release shipped, not just the code. After any change that ships to users:

1. Raise the version in `package.json` and `package-lock.json`:
   `npm version <x.y.z> --no-git-tag-version`
2. Put what's new at the **top** of `release-notes.md`, above `## Previous release`. Keep the old entries.
3. Run the checks that cover the change: `node --check` on edited JS, plus the relevant
   `node --test tests/<name>.test.js` files (the whole non-UI suite is a good default).
4. Commit everything and `git push origin main`.
5. The `Release` GitHub Actions workflow builds the NSIS installer on `windows-latest` and publishes the
   GitHub release. It only runs when `package.json` changed on `main`; its assets are
   `FrameForge-Setup-<version>.exe`, `latest.yml` and the blockmap.
6. Watch it with `gh run list --workflow=release.yml` / `gh run watch <run-id>`, then confirm the release and
   assets with `gh release view v<version> --repo toer15/frameforge`.

The in-app updater reads that GitHub release, so the release is what makes existing installs see the update.
Never leave a shipped change committed but unreleased.

## Tests

- Versions that matter for the release: the workflow runs the Game Booster, Fix Mode, sensor, overlay and
  gamewatch tests on a real Windows runner before building.
- Demo mode: `FRAMEFORGE_DEMO=1 npm start`; it needs the Electron binary from `npm ci` (do not use
  `--ignore-scripts` for a build).
