# Development notes

This concise technical guide documents the current implementation. The earlier long-form development journal was overwritten while preparing the new public README and could not be recovered from either WorkBuddy workspace. This file does not claim to reproduce that journal.

## Architecture

- `client.js` implements the browser theme and its settings panel.
- `index.js` implements configuration storage and the host API.
- `cordis.patch.yml` registers the bundle on the loader boot path.
- `tools/asarpatch.py` applies and verifies the optional Windows host patch used for desktop transparency and window material control.
- The package ID is `air-pixel-liquid-glass`. Keep it identical in `package.json`, the Cordis bundle, and both plugin registrations.

## Checks

Requires Node.js. From the repository root:

```powershell
node tools/preflight.mjs
node tools/verify.mjs
node tools/patcheck.mjs
node tools/mutationaudit.mjs
```

`preflight` checks JavaScript syntax, `verify` exercises client and host behavior against stubs, `patcheck` confirms patch mutation patterns still match, and `mutationaudit` checks that no test mutation was left in a source file. `teeth.mjs` is a slow mutation coverage audit that temporarily edits source files, launches `verify.mjs` repeatedly, and restores them afterward. It reported uncovered assertions in a prior run; its nonzero result is not the same as a functional test failure.

Some visual inspection scripts need Python with Pillow. The local `tools/_probe`, `tools/_preview`, and `tools/_realshot` directories contain generated runtimes, captures, or test data and are excluded from the public repository. `tools/harness.mjs` uses `tools/fixtures/dsh-official.css`; that CSS snapshot has not been included in the staged public files pending confirmation of its redistribution terms.

## Rename migration

The previous package ID was `dsh-theme-liquid-glass`; the new ID is `air-pixel-liquid-glass` because the old ID collides with an existing marketplace package. Existing local installs must be migrated before enabling this version:

1. Replace the old bundle ID in the active DSH profile with `air-pixel-liquid-glass` and update the linked package path if the checkout directory is renamed.
2. Move the prior configuration and `asar-pointer.json` from `~/.dsh/plugins/dsh-theme-liquid-glass/` to `~/.dsh/plugins/air-pixel-liquid-glass/` to preserve settings and the selected client archive.
3. Re-run `tools/asarpatch.py --check`. The old archive marker contains the old package ID; apply the patch again with the new source if the check does not recognize it.
4. Restart or reload DeepSeek Harness, then confirm the theme and desktop controls in Settings.

The repository checkout folder may keep any name; the installed package identity comes from `package.json` and the bundle manifest.
