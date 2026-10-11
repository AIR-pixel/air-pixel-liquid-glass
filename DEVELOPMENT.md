# Development notes

This file documents the current implementation and summarizes key engineering decisions. The previous long-form development journal (110,097 bytes) was overwritten while preparing the public README and could not be recovered from either WorkBuddy workspace. This summary does not reproduce that journal.

## Architecture

- `client.js` implements the browser theme and its settings panel.
- `index.js` implements configuration storage and the host API.
- `cordis.patch.yml` registers the bundle on the loader boot path.
- `tools/asarpatch.py` applies and verifies the optional Windows host patch used for desktop transparency and window material control.
- The package ID is `air-pixel-liquid-glass`. Keep it identical in `package.json`, the Cordis bundle, and both plugin registrations.
- `package.json` limits the npm package to runtime files, the host patch helper, and user-facing docs. The visual probes and test suite remain in the source repository, not the installed package.
- Every client config ingress (cache, host response, and settings changes) passes through `normalizeDocument`; rendering assumes its values are already normalized.

## Checks

Requires Node.js. From the repository root:

```powershell
node tools/preflight.mjs
node tools/verify.mjs
node tools/patcheck.mjs
node tools/mutationaudit.mjs
```

`preflight` checks JavaScript syntax, `verify` exercises client and host behavior against stubs, `patcheck` confirms patch mutation patterns still match, and `mutationaudit` checks that no test mutation was left in a source file. `verify.mjs` uses `python` when available and falls back to `py -3` on Windows; `DSL_PYTHON` can select a specific interpreter. `teeth.mjs` is a slow mutation coverage audit that temporarily edits source files, launches `verify.mjs` repeatedly, and restores them afterward.

Some visual inspection scripts need Python with Pillow. The local `tools/_probe`, `tools/_preview`, and `tools/_realshot` directories contain generated runtimes, captures, or test data and are excluded from the public repository. `tools/harness.mjs` uses `tools/fixtures/dsh-official.css`; that CSS snapshot has not been included in the staged public files pending confirmation of its redistribution terms.

## Rename migration

The previous package ID was `dsh-theme-liquid-glass`; the new ID is `air-pixel-liquid-glass` because the old ID collides with an existing marketplace package. Existing local installs must be migrated before enabling this version:

1. Replace the old bundle ID in the active DSH profile with `air-pixel-liquid-glass` and update the linked package path if the checkout directory is renamed.
2. Move the prior configuration and `asar-pointer.json` from `~/.dsh/plugins/dsh-theme-liquid-glass/` to `~/.dsh/plugins/air-pixel-liquid-glass/` to preserve settings and the selected client archive.
3. Re-run `tools/asarpatch.py --check`. The patch helper recognizes the old recipe marker and can upgrade an existing recipe to the new marker while adding the current window watcher.
4. Restart or reload DeepSeek Harness, then confirm the theme and desktop controls in Settings.

The repository checkout folder may keep any name; the installed package identity comes from `package.json` and the bundle manifest.

