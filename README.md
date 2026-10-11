# AIR-pixel Liquid Glass

A configurable Liquid Glass theme plugin for DeepSeek Harness. It adds translucent interface surfaces, an optional wallpaper, desktop transparency, window blur, custom cursors, click ripples, and per-side conversation contrast controls.

## Features

- Frosted surfaces with adjustable strength, blur, tint, and wallpaper.
- Optional transparent desktop and Windows window material controls. Desktop transparency requires the included client patch helper; the setting reports when the patch is unavailable.
- Custom cursors and click ripples, each independently configurable.
- Separate contrast settings for human and assistant messages.
- English and Chinese settings UI.

## Install

Install `air-pixel-liquid-glass` as a DeepSeek Harness bundle, then enable **Liquid Glass** in Settings. The desktop transparency and window blur controls need their host-side patch; the theme and other visual options do not.

## Development

Requires Node.js. Run the syntax and behavior checks with:

```powershell
node tools/preflight.mjs
node tools/verify.mjs
node tools/patcheck.mjs
node tools/mutationaudit.mjs
```

Some visual inspection scripts need Python with Pillow. See [DEVELOPMENT.md](DEVELOPMENT.md) for architecture, checks, and rename migration details.

## Compatibility

Designed for DeepSeek Harness on Windows and the web GUI. Desktop transparency and window blur depend on the installed Harness build and supported Windows compositor APIs.

## License

MIT. See [LICENSE](LICENSE).
