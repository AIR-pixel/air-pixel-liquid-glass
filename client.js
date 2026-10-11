/**
 * air-pixel-liquid-glass — browser half.
 *
 * Runs inside the Web GUI renderer. Four responsibilities, in order of when
 * they matter:
 *
 *  1. Theme stylesheet — one <style> tag re-appended last in <head> so it wins
 *     the cascade against the sheets the Harness appends while booting. It only
 *     touches `--dsw-*` design tokens (the official alias layer) plus a fixed
 *     wallpaper pseudo-element, so no fragile hashed class name is referenced.
 *  2. Cursors — Liquid Glass pointers injected through the same sheet.
 *  3. Click ripples — a capture-phase `pointerdown` listener that spawns a
 *     frosted disc + expanding ring at the pointer, then removes itself.
 *  4. Settings page — a "Liquid Glass" row in the Settings modal.
 *
 * Config lives on the host (see index.js). localStorage is only a mirror so the
 * theme can be applied before the first paint of the next launch.
 */

window.__ModuleLoader__.load({
  id: 'air-pixel-liquid-glass',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;

    const React = require('react');

    const NS = 'liquid-glass';
    /** Settings nav slot + this section's own content slot. */
    const SECTION_SLOT = 'settings.section';
    const ITEM_SLOT = 'dsh.liquid-glass.item';
    /** id of the injected <style> element; also the head-order guard selector. */
    const STYLE_ID = 'dsl-theme-style';
    /** id of the wallpaper layer, referenced from the generated stylesheet. */
    const WALLPAPER_ID = 'dsl-wallpaper';
    const SECTION_STYLE_ID = 'dsl-section-style';
    const CACHE_KEY = 'dsh_liquid_glass_config';
    /**
     * Mirror of the host's answer to "was the client patched for window
     * transparency". Not a setting, which is why it is not in DEFAULT_CONFIG —
     * but it has to be cached for the same reason the settings are: it is read
     * during the first paint, long before the host replies.
     */
    const MATERIAL_KEY = 'dsh_liquid_glass_material';
    /**
     * Mirror of the host's answer to "did the 窗口模糊 switch actually take".
     *
     * Cached for exactly the same reason as the material state: the renderer
     * cannot observe a window material, so without the mirror the panel would
     * read 「未生效」 for the first frames of every launch even when the window is
     * already blurred — a false negative on the one row whose whole job is to
     * report a fact the page has no way to check for itself.
     */
    const WINDOW_BLUR_KEY = 'dsh_liquid_glass_window_blur';
    const API = '/api/theme-liquid-glass/config';
    const SAVE_DEBOUNCE_MS = 400;
    /** Hard cap on live ripple nodes — a frosted disc is not free to composite. */
    const MAX_RIPPLES = 6;
    /** 磨砂模糊 slider range, and the ceiling `blurOf` clamps to. */
    const FROST_MAX = 40;
    /**
     * 每段对话底板 ceiling. 0.6 was what WCAG AA asks for (4.5:1 for the dark
     * scheme over a white desktop) — and it lasted exactly one version before air
     * reported the top of the slider still not solid enough over a busy desktop.
     * 0.85 is the ceiling now: still visibly translucent (15% of the row shows
     * through), but a real surface rather than a tint. The 4.5:1 argument now
     * describes the DEFAULT level (0.5), not the top of the slider.
     */
    const PLATE_MAX = 0.85;
    /**
     * The DOM contract the 每段对话底板 rides on, read out of the shipped
     * archive rather than guessed.
     *
     * `[data-chat-flow]` is the conversation column and `[data-chat-flow-key]`
     * is one flow row inside it — the app's own stylesheet writes
     * `.flowItem[data-chat-flow-kind=turn-process]` against exactly these, and
     * the rows also carry `data-chat-turn` (the turn number) and
     * `data-chat-flow-kind` (`user` / `steering` / `turn-process` /
     * `turn-trigger`). The child combinator is load-bearing: grouped seats
     * carry `data-chat-flow-key` too and contain further flow rows, so a
     * descendant selector would paint a plate inside a plate.
     */
    const PLATE_SELECTOR = '[data-chat-flow] > [data-chat-flow-key]';

    /**
     * Which side of the conversation a flow row belongs to, by the app's own
     * `data-chat-flow-kind`.
     *
     * Read out of the shipped archive, not guessed — the full list is
     * `system-prompt / user / steering / turn-trigger / turn-process /
     * turn-error / turn-max-tokens / turn-tail`, lifted from the same
     * `FLOW_KINDS` set the app itself filters on. The split is not "user vs
     * everything else": `steering` is a message the human typed mid-turn, so it
     * is theirs, and `turn-trigger` is the label for what started a turn, which
     * belongs to whoever initiated it — the human. `turn-process` is the model
     * working, and `turn-error` / `turn-max-tokens` / `turn-tail` are all
     * outcomes of that same turn, so they read with the model.
     *
     * Named as an explicit pair of lists rather than a boolean test, because the
     * failure mode of getting a new kind wrong is silent: a kind missing from
     * both lists simply gets no distinction, which looks exactly like the bug
     * this whole feature exists to fix.
     */
    const HUMAN_KINDS = ['user', 'steering', 'turn-trigger'];
    const MODEL_KINDS = ['turn-process', 'turn-error', 'turn-max-tokens', 'turn-tail'];

    /**
     * 对话辨识 modes. `side` and `halo` are mutually exclusive by construction:
     * they answer the same question (how do I tell the two sides apart) with
     * incompatible means, and enabling both would put a plate under text that is
     * also haloed — two contrast devices fighting on one glyph.
     */
    const PLATE_SIDES = ['side', 'halo', 'off'];

    /**
     * Text effect budget, in CSS px, for `halo`.
     *
     * The halo is two shadows, not one, and the asymmetry is the point: a dark
     * rim below and around the glyph does the contrast work on a light desktop,
     * and a light bloom above it does the same on a dark one. A single shadow
     * only ever helps on one of the two, so a single-shadow halo would look
     * fixed on air's machine and broken on the next person's.
     *
     * 1px is not a style choice — it is measured against the same 4.5:1 target
     * the plate uses, and it is the largest value that stays a rim rather than
     * becoming a smear. Values above ~2px start closing the counters of small
     * text (the gaps in `e`, `a`, `8`), which costs more legibility than the
     * contrast buys back.
     */
    const HALO_RIM = 1;

    /**
     * The mode buttons, in order, with their label keys.
     *
     * Ordered by how much they cost the user: `side` keeps the glass fully open
     * and adds nothing to the text, `halo` keeps the glass open and puts the
     * work on the glyphs, `off` is the escape hatch. A menu ordered by anything
     * else — alphabetically, or by implementation — would make the reader work
     * out the trade-off instead of reading it off the order.
     */
    const PLATE_SIDE_VIEW = [
      { id: 'side', label: 'plateSideSide' },
      { id: 'halo', label: 'plateSideHalo' },
      { id: 'off', label: 'plateSideOff' }
    ];

    const DEFAULT_CONFIG = {
      enabled: true,
      surface: true,
      cursor: true,
      // 透出桌面. Off by default because it is the one switch that only does
      // anything on a patched client — see `revealOf`. Turning it on against a
      // stock archive would paint the window onto Electron's default white
      // canvas, which is strictly worse than the shell it replaces.
      desktop: false,
      ripple: true,
      intensity: 1,
      // Multiplier on the ripple's diameter. Its own control rather than a
      // consequence of `intensity`, because the two are genuinely independent
      // questions: how strong the glass is, and how big a press reads as. The
      // intensity slider already scales the disc (64px → 140px), which is enough
      // for the material to feel consistent and not nearly enough to make a
      // 70px-radius disc right for a 4K window or wrong for a dense toolbar.
      rippleSize: 1,
      // 磨砂模糊, in CSS px, or `null` for "follow the transparency curve".
      //
      // These were one axis until now, and merging them was the mistake. "How
      // much of the desktop reaches the eye" and "how much of it is still sharp"
      // are two questions, and a single slider can only answer one of them — so
      // at the top of its range it was answering both, which is why "拉满" meant
      // "透明 + 顺带把字也糊掉可读性". `null` rather than a duplicated number is
      // deliberate: a stored default of 16 would be a second copy of a value the
      // curve already owns, and the two would drift the first time the curve was
      // retuned. Because `null` resolves to the old curve, the default look is
      // unchanged to the pixel and dragging this control is the only thing that
      // can change it.
      frost: null,
      // 窗口模糊 — the only control in this theme that produces a real
      // Gaussian blur, and the only one whose effect lives outside the page.
      //
      // Every other blur here is a CSS `backdrop-filter`, which filters the
      // *document's* backdrop. What is behind the window on a patched client is
      // the desktop, and the desktop is not part of the document — so no amount
      // of CSS reaches it. This switch asks DWM for `backgroundMaterial:
      // "acrylic"`, which is the compositor drawing a blurred copy of the
      // desktop into the window.
      //
      // This is the layer air remembered as "之前那个高斯模糊的效果". It was
      // turned off on purpose in an earlier round — the patch used to install
      // `acrylic`, and at the top of the intensity range it was the single
      // loudest thing between the desktop and the eye, which is why the patch
      // moved to `none`. Making it a switch rather than a constant is what
      // settles that: it stops being "on whether you want it or not" and
      // becomes a thing the user asks for. Measured both ways on this machine
      // (tools/materialprobe.py, checkerboard behind the window, edge energy
      // that survives): `none` 0.875 / luma 129 = the desktop, sharp;
      // `acrylic` 0.011 / 100 = smoothed to a flat field.
      //
      // Off by default, because it is the one control that reaches outside the
      // theme's own pixels.
      windowBlur: false,
      // 每段对话底板 — a translucent plate under each conversation block, so
      // the shell can stay fully open without the body copy following it down.
      //
      // It was a floor on the text-carrying tiers' alpha until this round, and
      // air's verdict on that version was exact: "这俩选项效果和降低效果强度
      // 基本没区别". He was not describing a similarity, he was describing an
      // identity — `alpha = max(curve, floor)` and "lower the intensity" both
      // raise the same numbers on the same axis, so the control was a relabelled
      // duplicate no matter how the curve was tuned. It cannot be fixed by
      // tuning; it has to stop being a token and become a real surface.
      //
      // So the plate is now its own background, on its own element, with its own
      // geometry — see PLATE_SELECTOR. It is local by construction: it can only
      // ever cover the blocks it names, which is what "只显示在每段对话的文字
      // 下方，而不是全局变白" asks for, and there is no code path by which it
      // could tint the sidebar.
      //
      // Off by default, and that is not timidity: it is the one control whose
      // whole job is to take transparency away, so turning it on for the user
      // would silently undo "拉满后几乎完全透明". It exists because those two
      // requirements genuinely collide on the same pixels — measured, not
      // argued: at the current top of the transparent range the surfaces sit at
      // alpha 0.03–0.07, which composites body text to ~1.04:1 against a
      // mismatched desktop. 0.5 is the smallest round value that clears 4.5:1
      // for the light scheme over a black desktop.
      plate: false,
      plateLevel: 0.5,
      // 对话辨识 — how the two sides of a conversation are told apart.
      //
      // The plate alone could not do this. One colour under every row means the
      // question and the answer arrive on the same surface, and air's report —
      // "ai的消息和用户的消息都一个颜色，辨识度太低" — is the predictable
      // result: the plate solved *readability* (text against a busy desktop) and
      // did nothing for *identity* (which side am I looking at). Those are two
      // different problems that happened to share one surface, and one surface
      // can only answer one of them.
      //
      // Three modes, because the two solutions genuinely suit different setups
      // and forcing either would repeat the mistake the plate's first version
      // made (one axis answering two questions):
      //
      //   · `side`       — two plates. Split by `data-chat-flow-kind`: the human
      //                    side and the model side each get their own hue and
      //                    their own weight. Works over any desktop, costs
      //                    nothing when the shell is opaque.
      //   · `halo`       — no plates at all; the text carries its own contrast.
      //                    A dark rim plus a light bloom around the glyphs, so
      //                    the copy is legible over a fully open shell while the
      //                    page stays completely unplated. This is the mode for
      //                    someone who wants the glass to stay glass.
      //   · `off`        — neither. The stock single-colour plate behaviour is
      //                    gone rather than kept as a fourth option: it is the
      //                    state air reported as unusable, and leaving it on a
      //                    menu would be offering the bug back.
      //
      // Default `side` rather than `off`: the plate itself still defaults off, so
      // a user who never touches this sees no plate and no halo, exactly as
      // before. This only decides what happens once they ask for distinction.
      plateSide: 'side',
      tint: 'ice'
    };

    /**
     * Can this window composite a desktop backdrop behind itself?
     *
     *   'patched' — the main process was patched with `backgroundColor:
     *               "#00000000"` + `backgroundMaterial: "none"`, so the window
     *               base is genuinely open and what reaches it is the desktop
     *               itself, unfiltered. `none` rather than `acrylic` at
     *               patch time: acrylic is DWM's blurred material, and a blurred
     *               desktop arriving whether or not it was asked for is what air
     *               rejected twice as "高斯模糊" — `tools/materialprobe.py`
     *               measures the difference. It is still available, but now as
     *               the 窗口模糊 switch, which the host applies at runtime, so
     *               the choice belongs to the user instead of to the patch.
     *   'stock'   — `resources/app.asar` still has the original
     *               `createWindow()` options. The window has an opaque surface
     *               of its own; clearing the shell would reveal that instead.
     *   'unknown' — the host could not find the archive (a dev checkout, a
     *               different layout). Treated exactly like 'stock': the
     *               fail-safe direction is the one that keeps the window
     *               looking like the thing we shipped.
     */
    const MATERIAL_STATES = ['patched', 'stock', 'unknown'];
    /** @type {'patched' | 'stock' | 'unknown'} */
    let windowMaterial = 'unknown';
    /**
     * Why the host reached that answer, when it was willing to say.
     *
     * `unknown` used to be a dead end: the panel said "cannot detect" and the
     * user had no way to learn whether the archive was in the wrong place or
     * simply unreadable, which are unrelated fixes. The host now reports both a
     * reason code and the path it settled on, and they are surfaced verbatim.
     * @type {{ why: string, path: string|null } | null}
     */
    let windowMaterialWhy = null;

    /**
     * What the 窗口模糊 switch actually achieved, as reported by the host.
     *
     * The switch is the one control in this panel whose effect the renderer
     * cannot observe: it asks the *main process* to set a window material, and
     * the result is decided by Electron and DWM. So the panel reads the answer
     * back from the host instead of assuming the click worked — the same reason
     * the 透出桌面 row reports the material rather than trusting its own toggle.
     *
     * `active` is the host's readback of `win.getBackgroundMaterial()` after the
     * call, not an echo of the request. That distinction is the whole point: an
     * API that returned without throwing and a window that is now blurred are
     * two different facts, and only the second one is worth showing the user.
     *
     * Which leaves the case the readback cannot cover. Measured on the client
     * this ships to: Electron 44.0.0 / win32 exposes `setBackgroundMaterial`
     * but no `getBackgroundMaterial`, on any window however it was created. On
     * that build the watcher reports `applied: true, verified: false, why:
     * "no-getter"` — and "not verified" is neither "in effect" nor "did not
     * take". Rendering it as the latter would put a failure on screen next to a
     * desktop that is in fact blurred, which is the exact lie this readback
     * exists to prevent, facing the other way.
     *
     * @type {{ active: boolean, why: string|null, material: string|null, applied: boolean, verified: boolean }}
     */
    let windowBlurReport = { active: false, why: null, material: null, applied: false, verified: false };

    function normalizeWindowBlur(value) {
      if (value === null || typeof value !== 'object') {
        return { active: false, why: null, material: null, applied: false, verified: false };
      }
      return {
        active: value.active === true,
        why: typeof value.why === 'string' ? value.why : null,
        material: typeof value.material === 'string' ? value.material : null,
        applied: value.applied === true,
        verified: value.verified === true
      };
    }

    function normalizeMaterial(value) {
      return MATERIAL_STATES.includes(value) ? value : 'unknown';
    }

    // Preset ids are the *temperature* of the backdrop, not a hue — see the
    // TINTS comment. `aurora` was the old teal preset; `migrate()` folds it
    // into `slate` so a config written by the previous version still resolves.
    const TINT_IDS = ['ice', 'slate', 'dusk', 'mono'];

    // -----------------------------------------------------------------------
    // Cursors
    // -----------------------------------------------------------------------

    /**
     * Liquid Glass pointers, drawn as inline SVG.
     *
     * They are URL-encoded at runtime into `data:` URIs instead of being
     * shipped as files: a plugin directory is not on the web root, so a
     * relative `url(...)` inside the stylesheet would 404. Every pointer keeps
     * a dark stroke under a light core so it stays legible on both wallpapers.
     */
    const CURSORS = {
      default: {
        hotspot: [2, 1.5],
        svg:
          '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20">' +
          '<path d="M2 1.5 L2 17.5 L5.6 13.9 L7.9 19.1 L10.1 18.1 L7.8 13 L12.5 12.7 Z" ' +
          'fill="rgba(255,255,255,0.42)" stroke="rgba(8,16,30,0.72)" stroke-width="2.2" stroke-linejoin="round"/>' +
          '<path d="M2 1.5 L2 17.5 L5.6 13.9 L7.9 19.1 L10.1 18.1 L7.8 13 L12.5 12.7 Z" ' +
          'fill="none" stroke="rgba(255,255,255,0.96)" stroke-width="1" stroke-linejoin="round"/>' +
          '<path d="M3.2 4.4 L3.2 14.4" stroke="rgba(255,255,255,0.8)" stroke-width="0.75" stroke-linecap="round"/>' +
          '</svg>'
      },
      pointer: {
        hotspot: [10, 10],
        svg:
          '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20">' +
          '<circle cx="10" cy="10" r="6.2" fill="rgba(255,255,255,0.26)" stroke="rgba(8,16,30,0.70)" stroke-width="2.2"/>' +
          '<circle cx="10" cy="10" r="6.2" fill="none" stroke="rgba(255,255,255,0.95)" stroke-width="1"/>' +
          '<circle cx="7.9" cy="7.6" r="1.9" fill="rgba(255,255,255,0.78)"/>' +
          '</svg>'
      },
      text: {
        hotspot: [10, 10],
        svg:
          '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20">' +
          '<path d="M7.7 5.6 H12.3 M10 5.6 V14.4 M7.7 14.4 H12.3" fill="none" ' +
          'stroke="rgba(8,16,30,0.72)" stroke-width="2.9" stroke-linecap="round"/>' +
          '<path d="M7.7 5.6 H12.3 M10 5.6 V14.4 M7.7 14.4 H12.3" fill="none" ' +
          'stroke="rgba(255,255,255,0.96)" stroke-width="1.35" stroke-linecap="round"/>' +
          '</svg>'
      },
      grab: {
        hotspot: [10, 6.6],
        // One closed silhouette, not four stacked rounded rects. The old version
        // stroked each finger separately; at a 0.6-unit finger gap against a
        // 1.9-unit stroke the outlines bled together and the glyph read as a
        // smudge at any size. A single path can only ever draw one outline.
        // The fill is also more opaque than the other pointers (0.62 vs 0.42)
        // because the thinner stroke no longer supplies the solid silhouette.
        svg:
          '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20">' +
          '<path d="M6.6 17.5c-1.8 0-3-1.3-3-3.2v-3.5c0-.62.42-1.05.98-1.05s.97.43.97 1.05v1.4-6.3' +
          'c0-.62.42-1.05.98-1.05s.97.43.97 1.05v5.2-7.1c0-.62.42-1.05.98-1.05s.97.43.97 1.05v7.1-6.6' +
          'c0-.62.42-1.05.98-1.05s.97.43.97 1.05v6.6-4.3c0-1.7 1.05-2.75 2.5-2.75s2.3 1.05 2.3 2.65v5.5' +
          'c0 3.5-2.35 5.95-5.6 5.95H6.6z" ' +
          'fill="rgba(255,255,255,0.62)" stroke="rgba(8,16,30,0.72)" stroke-width="1.25" stroke-linejoin="round"/>' +
          '<path d="M6.6 17.5c-1.8 0-3-1.3-3-3.2v-3.5c0-.62.42-1.05.98-1.05s.97.43.97 1.05v1.4-6.3' +
          'c0-.62.42-1.05.98-1.05s.97.43.97 1.05v5.2-7.1c0-.62.42-1.05.98-1.05s.97.43.97 1.05v7.1-6.6' +
          'c0-.62.42-1.05.98-1.05s.97.43.97 1.05v6.6-4.3c0-1.7 1.05-2.75 2.5-2.75s2.3 1.05 2.3 2.65v5.5' +
          'c0 3.5-2.35 5.95-5.6 5.95H6.6z" ' +
          'fill="none" stroke="rgba(255,255,255,0.95)" stroke-width="0.55" stroke-linejoin="round"/>' +
          '</svg>'
      },
      forbidden: {
        hotspot: [10, 10],
        svg:
          '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20">' +
          '<circle cx="10" cy="10" r="6.2" fill="rgba(255,255,255,0.24)" stroke="rgba(176,42,55,0.9)" stroke-width="1.25"/>' +
          '<path d="M5.7 5.7 L14.3 14.3" stroke="rgba(176,42,55,0.9)" stroke-width="1.25" stroke-linecap="round"/>' +
          '</svg>'
      }
    };

    const CURSOR_RULES = [
      ['*', 'default'],
      ['a, a *, [role="link"], [role="button"], button, summary, [role="tab"], [role="menuitem"], [role="option"], [role="switch"], [role="checkbox"], [role="radio"], [data-dsh-clickable]', 'pointer'],
      // Verified against the shipped bundle: `switch`/`checkbox`/`radio`/`tab`/
      // `menuitem`/`option`/`textbox` all occur, so none of these rules is dead.
      // An earlier revision also matched `[data-conversation-scroll] .md-text`
      // — that class does not exist in this build (0 occurrences), so the clause
      // was removed rather than left looking meaningful.
      ['input, textarea, [contenteditable="true"], [role="textbox"]', 'text'],
      ['[draggable="true"], [data-dockkit-tab], [data-window-drag]', 'grab']
    ];

    /**
     * The 每段对话底板 stylesheet: one translucent plate per conversation block.
     *
     * WHY IT IS A SURFACE AND NOT A FLOOR
     *
     * The first version of this control was `alpha = Math.max(tierAlpha, plate)`
     * on the glass tokens that carry text. That is arithmetically the same move
     * as dragging 效果强度 down — both lift the same tier alphas along the same
     * axis — so no amount of retuning could stop it reading as a duplicate
     * control, and it was global for the same reason: tokens have no idea what a
     * conversation is, so a floor on them necessarily tints the sidebar and the
     * dock too. air reported both symptoms in one sentence: "我希望只显示在每段
     * 对话的文字下方，而不是全局变白。现在你这俩选项效果和降低效果强度基本没区别".
     *
     * A plate is both of those things fixed at once. It is a background on the
     * conversation rows and on nothing else, so it is local *by construction*
     * rather than by tuning — there is no code path from here to the sidebar —
     * and it is a different mechanism from the transparency slider rather than
     * the same one with a different name.
     *
     * WHY PADDING PLUS AN EQUAL NEGATIVE MARGIN
     *
     * A plate needs room around the text, and room around text means padding,
     * and padding moves things. The theme's standing rule is that glass must not
     * change what it is sitting on, so the padding is cancelled by a negative
     * margin of the same size: the border box grows by 6px top and bottom, the
     * margin box does not grow at all, and every glyph stays exactly where the
     * app put it. The rounded corners are what keep adjacent plates readable as
     * separate objects — verified against the app's own sheet, which lays the
     * flow rows out as a flex column with `--dsh-chat-flow-gap`, so negative
     * margins resolve against a gap and cannot collapse into each other.
     *
     * Deliberately vertical only. Extending the plate sideways would mean
     * negative inline margins, and whether those overflow the conversation
     * column depends on that column's own gutter — which is a guess this file is
     * not allowed to make, because a guess that is wrong shows up as a
     * horizontal scrollbar on the whole app. The plate spans the row's own
     * width, which is already inset by the column.
     */
    /**
     * The row selectors for one side, as a comma-joined list.
     *
     * `:is()` rather than three separate rules: the app puts its own stylesheet
     * on `.flowItem[data-chat-flow-kind=...]` with equal specificity, so a list
     * of plain selectors would need the whole pair repeated for every child
     * rule below. One `:is()` keeps the specificity at (0,1,1) — the same as the
     * app's own — while letting the plate rule stay a single declaration.
     */
    function kindSelector(kinds) {
      return kinds.map((kind) => `${PLATE_SELECTOR}[data-chat-flow-kind="${kind}"]`).join(',\n');
    }

    /**
     * The plate — and, in `halo` mode, the thing that replaces it.
     *
     * THE OLD VERSION WAS ONE RULE AND THAT WAS THE BUG. It painted one
     * `rgba(canvas, plate)` under every row, which made the copy readable and the
     * two speakers identical. Colour is the only channel available here that can
     * carry "who is talking" — position and alignment belong to the app, not to a
     * theme — so the distinction has to be spent on hue, and a single rule has
     * nowhere to put a second hue.
     *
     * Both sides keep the same `--dsl-plate` alpha. That is deliberate: the
     * question "how solid is the plate" is one control and it must not become
     * two, or the level slider would be lying about half the rows. Only the RGB
     * splits, and it splits along the *accent* rather than toward two arbitrary
     * colours, so the distinction follows the 色调 preset the user picked
     * instead of fighting it.
     */
    function plateCss(mode) {
      if (mode === 'off') return '';

      if (mode === 'halo') {
        // No plate at all. The text gets its own contrast instead, which is what
        // someone who turned the plate off was asking for in the first place.
        //
        // `text-shadow` rather than `-webkit-text-stroke`: a stroke is centred on
        // the glyph outline, so half of it eats into the letterform and the other
        // half spills out, which visibly thins the strokes of small text. A
        // shadow is drawn entirely outside the glyph and costs the letterform
        // nothing.
        //
        // Scoped to the row, not to `body`: a halo on the sidebar, the toolbar
        // and the settings panel would be a contrast device applied where nobody
        // asked for one, and it would fight the plate's own geometry.
        return `/* 对话辨识 · 描边 — the copy carries its own contrast; nothing is plated. */
${PLATE_SELECTOR} {
  text-shadow:
    0 ${HALO_RIM}px ${HALO_RIM}px var(--dsl-halo-dark),
    0 -${HALO_RIM}px ${HALO_RIM}px var(--dsl-halo-light),
    ${HALO_RIM}px 0 ${HALO_RIM}px var(--dsl-halo-dark),
    -${HALO_RIM}px 0 ${HALO_RIM}px var(--dsl-halo-dark);
}
/* The blurred rim must not bleed onto inline code and links, which already carry
   a background of their own — a shadow under a filled chip reads as dirt. */
${PLATE_SELECTOR} :is(code, pre, a) {
  text-shadow: none;
}`;
      }

      // `side` — two plates, one per speaker.
      return `/* 对话辨识 · 双侧 — one plate per conversation block, tinted by who is speaking. */
${kindSelector(HUMAN_KINDS)} {
  background-color: rgba(var(--dsl-plate-human-rgb), var(--dsl-plate));
  border-radius: 14px;
}
${kindSelector(MODEL_KINDS)} {
  background-color: rgba(var(--dsl-plate-model-rgb), var(--dsl-plate));
  border-radius: 14px;
}
/* Padding and the negative margin that cancels it are on the shared rule, not
   on the two coloured ones: they are geometry, and duplicating geometry per hue
   is how the two sides drift apart by a pixel the first time one is retuned. */
${PLATE_SELECTOR} {
  padding-block: 6px;
  margin-block: -6px;
}`;
    }

    function svgToDataUri(svg) {
      return 'url("data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg) + '")';
    }

    function cursorDeclarations() {
      const out = [];
      for (const [selector, key] of CURSOR_RULES) {
        const spec = CURSORS[key];
        if (spec === undefined) continue;
        const [x, y] = spec.hotspot;
        out.push(`${selector} { cursor: ${svgToDataUri(spec.svg)} ${x} ${y}, ${key} !important; }`);
      }
      // Disabled controls keep the forbidden pointer; it must come after `*`.
      // The hotspot is read from the spec — never hardcoded, or it silently
      // drifts out of range whenever the viewBox changes.
      const [fx, fy] = CURSORS.forbidden.hotspot;
      out.push(
        '[disabled], [aria-disabled="true"], [data-disabled="true"] ' +
          `{ cursor: ${svgToDataUri(CURSORS.forbidden.svg)} ${fx} ${fy}, not-allowed !important; }`
      );
      return out.join('\n');
    }

    // -----------------------------------------------------------------------
    // Official palette harvest
    // -----------------------------------------------------------------------
    //
    // The first working version hand-listed which --dsw-* tokens to override and
    // guessed their opacity. That is why the real window looked nothing like the
    // previews: the shell paints its large surfaces with tokens that were never
    // on the list (--dsw-specific-sidebar-fill carried both the sidebar AND the
    // top bar, measured at #1b1b1c with the plugin fully loaded), so those areas
    // stayed stock grey while the main frame went translucent.
    //
    // Instead of extending the list by hand, read the official values out of the
    // live stylesheets. Rules are read directly (not via getComputedStyle), so
    // both the light and the dark block can be harvested at once no matter which
    // scheme is active right now, and no value is ever hardcoded to a DSH
    // version. If a sheet is unreadable the harvest is simply empty and the
    // hand-tuned fallback still renders.

    function parseColor(input) {
      const value = String(input).trim();
      const hex = /^#([0-9a-fA-F]{3,8})$/.exec(value);
      if (hex !== null) {
        let body = hex[1];
        if (body.length === 3 || body.length === 4) {
          body = body.split('').map((c) => c + c).join('');
        }
        if (body.length !== 6 && body.length !== 8) return null;
        const n = parseInt(body.slice(0, 6), 16);
        const a = body.length === 8 ? parseInt(body.slice(6, 8), 16) / 255 : 1;
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a];
      }
      const fn = /^rgba?\(([^)]+)\)$/.exec(value);
      if (fn !== null) {
        const parts = fn[1].split(/[\s,/]+/).filter((p) => p !== '');
        if (parts.length < 3) return null;
        const chan = (p) => {
          const f = parseFloat(p);
          if (!Number.isFinite(f)) return null;
          return p.indexOf('%') !== -1 ? Math.round((f / 100) * 255) : Math.round(f);
        };
        const r = chan(parts[0]);
        const g = chan(parts[1]);
        const b = chan(parts[2]);
        if (r === null || g === null || b === null) return null;
        const a = parts.length > 3 ? parseFloat(parts[3]) : 1;
        return [r, g, b, Number.isFinite(a) ? a : 1];
      }
      return null;
    }

    /** Follow `var(--x, fallback)` chains, then parse. */
    function resolveColor(value, palette, depth) {
      const level = depth === undefined ? 0 : depth;
      if (level > 8 || typeof value !== 'string') return null;
      const text = value.trim();
      const ref = /^var\(\s*(--[\w-]+)\s*(?:,\s*([^]*))?\)$/.exec(text);
      if (ref !== null) {
        const hit = palette[ref[1]];
        if (hit !== undefined && hit !== text) return resolveColor(hit, palette, level + 1);
        if (ref[2] !== undefined) return resolveColor(ref[2], palette, level + 1);
        return null;
      }
      return parseColor(text);
    }

    /** Flatten @media / @supports so nested rules are visited too. */
    function walkRules(list, out) {
      for (const rule of list) {
        if (rule.cssRules !== undefined && rule.cssRules !== null) {
          walkRules(rule.cssRules, out);
        } else {
          out.push(rule);
        }
      }
      return out;
    }

    /**
     * Which scheme a rule belongs to. `body` is the light alias block and
     * `body[data-ds-dark-theme]` the dark one — same two selectors the official
     * sheet uses, verified against the shipped stylesheet.
     */
    function schemeOf(selectorText) {
      const found = { light: false, dark: false };
      for (const raw of selectorText.split(',')) {
        const sel = raw.trim();
        if (sel === 'body') found.light = true;
        else if (sel === 'body[data-ds-dark-theme]') found.dark = true;
        else if (sel === ':root' || sel === 'html') {
          found.light = true;
          found.dark = true;
        }
      }
      if (found.light && found.dark) return ['light', 'dark'];
      if (found.dark) return ['dark'];
      if (found.light) return ['light'];
      return [];
    }

    function harvestOfficialPalette() {
      const palette = { light: Object.create(null), dark: Object.create(null) };
      if (typeof document.styleSheets === 'undefined') return palette;
      for (const sheet of Array.from(document.styleSheets)) {
        const owner = sheet.ownerNode;
        // Never re-read our own overrides, or a re-harvest would fold the
        // already-glassed values back in as if they were official.
        if (owner !== null && owner !== undefined &&
            owner.dataset !== undefined &&
            owner.dataset.plugin === 'air-pixel-liquid-glass') continue;
        let rules;
        try {
          rules = sheet.cssRules;
        } catch {
          continue; // cross-origin sheet
        }
        if (rules === undefined || rules === null) continue;
        for (const rule of walkRules(rules, [])) {
          if (typeof rule.selectorText !== 'string' || rule.style === undefined) continue;
          const schemes = schemeOf(rule.selectorText);
          if (schemes.length === 0) continue;
          for (let i = 0; i < rule.style.length; i += 1) {
            const name = rule.style[i];
            if (name.slice(0, 6) !== '--dsw-') continue;
            const value = rule.style.getPropertyValue(name).trim();
            if (value === '') continue;
            for (const scheme of schemes) palette[scheme][name] = value;
          }
        }
      }
      return palette;
    }

    /**
     * Surface tokens worth glassing, and how see-through each depth becomes.
     *
     * `[stock end, glass end]` — the pair is interpolated by the slider, so the
     * bottom of the range reproduces the official value and the top end is a
     * fully open shell. Depth exists so hierarchy survives: the backdrop goes
     * almost clear while menus and tooltips keep a little body.
     *
     * The four values are spaced as a geometric-ish ladder (0.02 → 0.04 → 0.07
     * → 0.16, roughly ×1.9 each step) on purpose. Apple's rule for glass
     * hierarchy is that opacity encodes depth — 透明度越低层次越高 — and a
     * ladder that steps by a constant factor reads as four distinct planes,
     * where an additive one reads as three copies of the same plane.
     *
     * RETUNED DOWN FROM 0.08 / 0.12 / 0.20 / 0.40, and the reason is a
     * measurement rather than a taste. air: "现在强度拉满，透明度还是不高，像是
     * 高斯模糊". `tools/deskcheck.mjs` reads the resolved tokens out of each
     * frame's own engine, and at 2.0x it was reporting blur(10px) with a 12%
     * sidebar, a 20% content layer and a 40% menu — i.e. at the one slider
     * position whose entire job is "整个窗口透明", every surface was still
     * wearing a dark film. The blur was the loudest part of that (see
     * `variantBlock`) and the 40% menu was the second loudest.
     *
     * The old comment defended 0.40 as a legibility floor, and it was one — the
     * mistake was applying a floor tuned for a *photographic* wallpaper to a
     * slider whose top end is defined as the clearest state. What survives is a
     * legibility *ordering* rather than a legibility floor: menus are still the
     * most opaque tier, by 8x, so text on a menu still sits on something. What
     * is gone is the claim that any of these numbers is readable over arbitrary
     * content, which was never true at the top of the slider anyway.
     */
    const GLASS_TIERS = {
      back: [1.0, 0.03],
      panel: [1.0, 0.04],
      raised: [1.0, 0.07],
      float: [1.0, 0.16]
    };

    const GLASS_TOKENS = [
      ['--dsw-alias-bg-base', 'back'],
      ['--dsw-alias-bg-document-preview', 'back'],
      ['--dsw-alias-bg-layer-1', 'panel'],
      ['--dsw-alias-bg-layer-2', 'raised'],
      ['--dsw-alias-bg-layer-3', 'raised'],
      ['--dsw-alias-bg-overlay', 'raised'],
      ['--dsw-alias-bg-module-platform', 'panel'],
      ['--dsw-alias-bg-multi-select', 'panel'],
      ['--dsw-specific-sidebar-fill', 'panel'],
      ['--dsw-specific-sidebar-nav-item-active', 'raised'],
      ['--dsw-specific-sidebar-nav-item-hover', 'raised'],
      ['--dsw-specific-selector', 'raised'],
      ['--dsw-specific-input-major', 'raised'],
      ['--dsw-specific-login-input', 'raised'],
      ['--dsw-specific-tip', 'raised'],
      ['--dsw-specific-bubble', 'raised'],
      ['--dsw-specific-bubble-highlight', 'raised'],
      ['--dsw-menu-surface-fill', 'float'],
      ['--dsw-specific-menu', 'float'],
      ['--dsw-alias-button-floating-fill', 'float'],
      ['--dsw-alias-button-elevated-fill', 'float'],
      ['--dsw-alias-button-ghost-active-fill', 'raised'],
      ['--dsw-alias-interactive-bg-hover-solid', 'raised'],
      ['--dsw-alias-menu-group-header-fill', 'float'],
      ['--dsw-alias-tooltip-bg', 'float'],
      ['--dsw-alias-toast-bg', 'float']
    ];

    function mixRgb(a, b, weight) {
      return [
        Math.round(a[0] + (b[0] - a[0]) * weight),
        Math.round(a[1] + (b[1] - a[1]) * weight),
        Math.round(a[2] + (b[2] - a[2]) * weight)
      ];
    }

    function rgbaOf(rgb, alpha) {
      return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${Number(alpha.toFixed(3))})`;
    }

    /**
     * Resolved alpha for one tier.
     *
     * Extracted because two callers need the identical number and they used to
     * mirror each other: `glassedValue` for tokens the harvest resolved, and
     * `variantBlock`'s fallback for tokens it could not. The two drifted once
     * before over the `reveal` endpoint.
     *
     * This carried the 内容底板 floor until this round, and the floor was
     * removed rather than retuned. It was `Math.max(alpha, plate)` on every tier
     * except `back`, which is arithmetically the same operation as pushing the
     * intensity slider down — both raise the same tier alphas along the same
     * axis — so the control could not look like anything except a second copy of
     * 效果强度, which is exactly what air reported. A plate that is supposed to
     * sit under one conversation block cannot be expressed as a floor on the
     * window-wide tokens at all; see PLATE_SELECTOR for where it went.
     *
     * `back` still owns its own endpoint, and that is the one tier `reveal`
     * moves: it is the app canvas — the tier 透出桌面 opens — so it is the one
     * surface whose alpha has to fall as the slider rises.
     */
    function alphaOf(tier, start, glass, reveal) {
      const band = GLASS_TIERS[tier];
      // Only `back` follows the reveal. It is the app canvas — the tier 透出桌面
      // opens — so it is the one surface whose alpha has to fall to 0 as the
      // slider rises, or the material ends up behind a grey film and the whole
      // point of opening the window is lost.
      const end = tier === 'back' ? band[1] * (1 - reveal) : band[1];
      return start + (end - start) * glass;
    }

    /**
     * One glassed value for `name`, or null when the token cannot be resolved
     * (missing from the harvest, a `color-mix()`, a keyword).
     *
     * The official alpha is the bottom end of the range, not a reason to bail
     * out. A menu surface ships at 45% opacity; treating that as opaque would
     * make the slider start out MORE solid than stock and slide the wrong way,
     * which is exactly the kind of inversion that makes a control feel broken.
     *
     * @param {number} reveal 0 … 1 from `revealOf`; only `back` reacts to it.
     */
    function glassedValue(name, tier, palette, canvasRgb, tintWeight, glass, reveal) {
      const official = palette[name];
      if (official === undefined) return null;
      const rgb = resolveColor(official, palette);
      if (rgb === null) return null;
      const alpha = alphaOf(tier, rgb[3], glass, reveal);
      // Hue identity fades in with the effect: at the stock end the colour is
      // the official one to the byte, so "low intensity looks native" is true
      // rather than approximately true.
      const weight = tintWeight * glass;
      return rgbaOf(mixRgb(canvasRgb, [rgb[0], rgb[1], rgb[2]], weight), alpha);
    }


    // -----------------------------------------------------------------------
    // Tints — one backdrop + one accent per preset, light and dark variants.
    //
    // The backdrop is NEUTRAL TO THE POINT OF BEING GREY, and that is a
    // correction rather than a style. The first version painted four saturated
    // colour blobs and air's verdict was exact: "你现在只不过是加了个彩虹壁纸".
    // He was right about the material, not just the taste. Apple's Liquid Glass
    // is a *neutral* material — "its color is informed by surrounding content"
    // — so colour is supposed to arrive *through* the glass, not be painted
    // behind it. Painting saturated fields puts the most colour exactly where
    // the glass is least visible, which is backwards.
    //
    // An intermediate version kept the four presets but moved them to
    // blue/teal/orange/grey "colour temperatures". That was still four hues,
    // and four hues behind four panes is four hues on screen. The rule now is
    // absolute: the backdrop carries NO hue. Every preset is a grey ramp, and
    // the presets differ only in temperature (cool / neutral / warm / dead
    // flat) plus the accent. The accent is the only saturated thing in the
    // theme, and it appears on exactly two kinds of surface: the primary
    // button and the focus ring.
    //
    // Why keep a lit ramp at all rather than a flat fill: glass only reads
    // where the backdrop has *luminance structure* for the lens to bend and the
    // rim to catch. A flat field makes the most perfect lens invisible. A
    // luminance ramp does the job without competing with the UI for attention,
    // which a coloured one always does.
    // -----------------------------------------------------------------------

    const TINTS = {
      ice: {
        light: {
          lights: ['rgba(255,255,255,0.62)', 'rgba(178,190,208,0.34)'],
          wash: 'linear-gradient(160deg, #eef0f4 0%, #dcdfe6 46%, #e9ebef 100%)',
          shell: '#e8eaee',
          base: 'rgba(250,251,253,0.60)',
          accent: '#2f6df0'
        },
        dark: {
          lights: ['rgba(186,198,216,0.30)', 'rgba(80,90,106,0.40)'],
          wash: 'linear-gradient(160deg, #0c0e12 0%, #20262f 44%, #0b0d11 100%)',
          shell: '#0b0c0f',
          base: 'rgba(15,17,21,0.50)',
          accent: '#8ab4f8'
        }
      },
      slate: {
        light: {
          lights: ['rgba(255,255,255,0.62)', 'rgba(168,176,188,0.32)'],
          wash: 'linear-gradient(160deg, #eef0f0 0%, #dcdfe0 46%, #e9ebeb 100%)',
          shell: '#e8eaea',
          base: 'rgba(250,251,251,0.60)',
          accent: '#0f9d76'
        },
        dark: {
          lights: ['rgba(176,184,196,0.29)', 'rgba(74,82,90,0.39)'],
          wash: 'linear-gradient(160deg, #0c0d0d 0%, #1f2324 44%, #0b0c0c 100%)',
          shell: '#0b0c0c',
          base: 'rgba(15,17,18,0.50)',
          accent: '#5ee0b0'
        }
      },
      dusk: {
        light: {
          lights: ['rgba(255,255,255,0.62)', 'rgba(186,174,164,0.32)'],
          wash: 'linear-gradient(160deg, #f1efee 0%, #e0dad6 46%, #ebe7e4 100%)',
          shell: '#eae7e4',
          base: 'rgba(252,250,249,0.60)',
          accent: '#d2603a'
        },
        dark: {
          lights: ['rgba(198,186,174,0.29)', 'rgba(88,80,70,0.39)'],
          wash: 'linear-gradient(160deg, #0e0d0c 0%, #26211d 44%, #0d0c0b 100%)',
          shell: '#0d0c0b',
          base: 'rgba(18,16,15,0.50)',
          accent: '#f0a071'
        }
      },
      mono: {
        light: {
          lights: ['rgba(255,255,255,0.62)', 'rgba(170,174,180,0.30)'],
          wash: 'linear-gradient(160deg, #f1f2f3 0%, #e0e2e4 46%, #ebedee 100%)',
          shell: '#eaecee',
          base: 'rgba(251,252,253,0.62)',
          accent: '#4a5568'
        },
        dark: {
          lights: ['rgba(178,182,188,0.28)', 'rgba(80,82,86,0.38)'],
          wash: 'linear-gradient(160deg, #0d0e0f 0%, #232527 44%, #0c0d0e 100%)',
          shell: '#0c0d0e',
          base: 'rgba(16,17,18,0.52)',
          accent: '#a9b6c8'
        }
      }
    };

    /** How far a glassed surface is pulled towards the preset's own hue, at full glass. */
    const HARVEST_TINT_WEIGHT = 0.6;

    /**
     * The single curve every part of the theme reads the slider through.
     *
     * Deliberately convex (exponent < 1): a linear mapping left the middle of
     * the slider looking like stock-with-a-tint, which is the "效果完全不行"
     * complaint. Surfaces, wallpaper and ripples all measure the slider with
     * this one function — when they each had their own curve the parts drifted
     * apart and the window stopped reading as one material.
     *
     * @param {number} intensity 0.2 … 2 (the slider's own range)
     * @returns {number} 0 … 1
     */
    function glassOf(intensity) {
      return Math.min(1, Math.max(0, Math.pow(Math.min(1, Math.max(0, intensity / 2)), 0.75)));
    }

    /**
     * The frost curve with no override — i.e. what the transparency slider
     * alone produces.
     *
     * Split out of `blurOf` because the settings panel has to display the number
     * the theme would use while the control is in follow mode. A panel that
     * showed the last *stored* value there would be showing the user a number
     * that is not the number on screen, which is the same lie as a badge that
     * always reads "ready".
     */
    function autoFrostOf(intensity) {
      const glass = glassOf(intensity);
      return Math.round(24 * (1 - Math.pow(glass, 2.2)));
    }

    /**
     * Frost in CSS px, from the two independent axes.
     *
     * `frost === null` follows `autoFrostOf`, so the default look is unchanged
     * to the pixel; a number means the user has taken the axis over, and the
     * frost then holds still while the transparency moves. That second state is
     * the one this control exists for: it is the only way to have a fully open
     * shell *and* a frosted one, because on a single axis "拉满" could only ever
     * mean "no frost".
     *
     * @param {number|null} frost normalized explicit px, or null to follow the curve.
     */
    function blurOf(intensity, frost) {
      if (typeof frost !== 'number' || !Number.isFinite(frost)) return autoFrostOf(intensity);
      // Every config ingress is normalized before it reaches the renderer.
      // Keep this calculation focused on choosing the axis, not sanitizing it
      // a second time and masking a missing normalization check elsewhere.
      return frost;
    }

    /**
     * The 每段对话底板 alpha actually in force: 0 when the switch is off.
     *
     * One reader for both halves of the control, so the switch and the level
     * cannot disagree — a level that applied while the switch was off would be
     * the same "control that lies" failure the 透出桌面 row exists to document.
     * Returning 0 rather than "off" also gives the stylesheet a single test:
     * the plate rules are emitted at all only when this is above zero, which is
     * what keeps the geometry they add out of the layout while the switch is off.
     */
    function plateOf(config) {
      if (config.plate !== true) return 0;
      const level = typeof config.plateLevel === 'number' && Number.isFinite(config.plateLevel)
        ? config.plateLevel
        : DEFAULT_CONFIG.plateLevel;
      return Math.min(PLATE_MAX, Math.max(0, level));
    }

    /**
     * How far the window base is opened up, 0 … 1 — i.e. how much of the
     * desktop behind the window is allowed to show.
     *
     * This is the second half of the window recipe and it is not optional. The
     * asar patch opens the window base; this function is the only thing that
     * stops the theme painting over it. Without it the desktop is behind a
     * fully opaque `html` colour and a full-viewport gradient, and the patch is
     * invisible — which is exactly the state air described as
     * "你只不过是加了个彩虹壁纸". Neither half does anything alone, and that
     * cuts both ways: the patch landing in the archive is not a reason to skip
     * this, and this reaching 1 is not a reason to skip the patch.
     *
     * Three gates, in order of how likely each is to be the reason it is zero:
     *
     *   · `desktop`   — the user has to ask for it.
     *   · `surface`   — with no glass there is nothing to thin out, and
     *                   `paintWallpaper()` drops the backdrop layer entirely,
     *                   so a slider that was supposed to fade 0.2 → 2.0 would
     *                   instead be a switch from "opaque" to "wide open".
     *   · `patched`   — see MATERIAL_STATES. On a stock archive "transparent"
     *                   means Electron's default white, which is worse than
     *                   the shell it replaces, so the safe answer is no.
     *
     * The curve is `glass²`, not `glass`, and that is a deliberate deviation
     * from the rule that every other effect measures the slider with `glassOf`.
     * `glassOf(0.2)` is already 0.178; feeding that straight in would make the
     * bottom of the slider 18% desktop, which contradicts "0.2 几乎与原生外观
     * 没有区别" for a feature whose whole job is to be visible. Squaring costs
     * nothing at the top — it is still exactly 1.0 at intensity 2, so the stated
     * requirement ("强度最高时整个窗口透明") is met to the digit — and buys a
     * bottom end of 3% and a default position of 35%.
     */
    function revealOf(config) {
      if (config.desktop !== true || config.surface !== true) return 0;
      if (windowMaterial !== 'patched') return 0;
      const glass = glassOf(config.intensity);
      return glass * glass;
    }

    /**
     * Peak displacement, in CSS px, of the edge lens at a given slider position.
     *
     * 3px at the stock end is deliberately indistinguishable from no lens at
     * all — the bottom of the slider has to look native. 32px at full glass is
     * the largest value that still reads as *thickness*: the lab render at 46px
     * starts bending the interior enough to look like a funhouse mirror rather
     * than a pane with a thick rim.
     *
     * Extracted rather than inlined because two callers need the identical
     * number: `ensureLiquidDefs` (which builds the filter) and `variantBlock`
     * (which publishes it as `--dsl-lens-scale` so the regression suite can
     * assert the slider moves it). When these were separate expressions the
     * published value was a lie waiting to happen.
     */
    function lensScaleOf(intensity) {
      return Math.round(3 + 26 * glassOf(intensity));
    }

    /**
     * Peak displacement of the click ripple's radial lens, in CSS px.
     *
     * Lower than the edge lens on purpose. The first render at a flat 46px shifted
     * text by roughly three characters, which reads as double vision rather than
     * as a press — the eye sees glyphs from 46px away pulled in beside the real
     * ones. 26px at full glass is enough to bend a one-pixel rule into a visible
     * arc (the specimen render shows exactly that) while leaving letters legible.
     *
     * It tracks the slider because the ripple used to change only in *size*,
     * which meant a low-intensity click produced the same violent warp as a
     * high-intensity one — the strength control silently did not apply.
     *
     * It also tracks `rippleSize`, and that is not decoration either. The lens is
     * a displacement map stretched over the element's box, so a bigger disc with
     * an unchanged 26px peak is the same lens seen through a magnifier: the
     * curvature per unit area falls and a doubled ripple reads as "bigger and
     * flatter" rather than as the same press at twice the scale. Scaling the
     * displacement with the diameter is what keeps the size control a size
     * control instead of a strength control.
     */
    function dropScaleOf(intensity, rippleSize) {
      return Math.round((6 + 20 * glassOf(intensity)) * rippleSize);
    }

    /**
     * Multiply the alpha channel of an `rgba()` string. Anything that is not a
     * plain rgba literal (a `var()` fallback, a hex) is returned untouched.
     *
     * Used for the backdrop's light pools only — panels derive their opacity
     * from GLASS_TIERS, which is what makes the slider's top end a real glass
     * shell.
     *
     * The 0.62 ceiling is a legibility limit, not a taste one. At 0.92 a lit
     * pool composited to a luminance around 0.33, which puts light body text on
     * it at roughly 2.3:1 — well under the 4.5:1 a blurred surface has to hold.
     */
    function scaleAlpha(color, factor) {
      const m = /^rgba\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)$/.exec(color);
      if (m === null) return color;
      const a = Math.min(0.62, Math.max(0.02, Number(m[4]) * factor));
      // Compact, no spaces: the palette literals are written that way and the
      // regression suite matches on them.
      return `rgba(${m[1]},${m[2]},${m[3]},${Number(a.toFixed(3))})`;
    }

    /**
     * Two soft light pools over the wash.
     *
     * Two, not four. Four lights of comparable weight read as a row of circles
     * however soft each one is, because the eye is extremely good at counting
     * equally-weighted things. Two read as *light* — which is all a neutral
     * backdrop is allowed to be once the material is doing the work. They are
     * also deliberately unequal: one broad and dim, one tighter and brighter.
     * A single dominant light source is what gives a flat field a direction.
     */
    function lightsToCss(lights) {
      const stops = [
        ['78% 70% at 12% -6%', lights[0]],
        ['52% 46% at 88% 104%', lights[1]]
      ];
      // 96% falloff, i.e. the pools never announce an edge — they only have to
      // give the glass a gradient to bend.
      return stops.map(([pos, color]) => `radial-gradient(${pos}, ${color}, transparent 96%)`).join(', ');
    }

    /**
     * The backdrop as one `background-image` value.
     *
     * Layer order is top-to-bottom, so the vignette is written first and the
     * opaque wash last: the wash is what makes the layer self-contained and
     * stops the window ever falling through to the Electron surface.
     */
    function backdropImage(variant, intensity) {
      const glass = glassOf(intensity);
      const lightScale = 0.5 + 0.5 * glass;

      const shell = parseColor(variant.shell);
      const isDark =
        shell !== null && shell[0] * 0.299 + shell[1] * 0.587 + shell[2] * 0.114 < 110;
      const vigRgb = isDark ? '3,5,10' : '22,36,64';
      const vigAlpha = (isDark ? 0.10 : 0.05) + (isDark ? 0.30 : 0.20) * glass;
      const vignette =
        `radial-gradient(134% 102% at 50% 34%, ` +
        `rgba(${vigRgb},0) 30%, rgba(${vigRgb},${Number(vigAlpha.toFixed(3))}) 100%)`;

      return `${vignette}, ${lightsToCss(variant.lights.map((c) => scaleAlpha(c, lightScale)))}, ${variant.wash}`;
    }

    // -----------------------------------------------------------------------
    // Refraction — the part that makes this glass rather than tinted plastic
    // -----------------------------------------------------------------------

    /** The SVG filter every refractive surface points at. */
    const REFRACT_FILTER_ID = 'dsl-refract';
    /** The map's own id, so a hot reload can replace it without piling up. */
    const DEFS_ID = 'dsl-liquid-defs';

    /**
     * A lens displacement map, as a base64 PNG.
     *
     * `feDisplacementMap` reads its offsets out of an *image*: the red channel
     * is the X offset, green is Y, and 128 means "leave this pixel alone". That
     * one sentence is the whole trick — and it is why a blur can never be liquid
     * glass. A blur *averages* the backdrop; a displacement map *moves* it,
     * which is what a lens physically does to light.
     *
     * The map has to be shaped like a lens, not like noise:
     *
     *   · dead neutral across the middle, so content inside the pane stays
     *     crisp — a warp that reaches the interior is a distortion, not glass;
     *   · a smoothstep ramp confined to the outer band, growing towards the rim,
     *     so the bend is strongest exactly where a real pane is thickest.
     *
     * The X and Y ramps are computed independently, which is what produces the
     * rounded, box-shaped warp you see at the four edges of a real pane. The
     * shortcut most CSS demos take — driving the map from `feTurbulence` — gives
     * a rippled shower-door texture instead: wrong material, and it reads as
     * decoration rather than as glass.
     *
     * @param {number} size square map edge in px
     * @returns {string|null} data URI, or null when canvas is unavailable
     */
    function lensMapDataUrl(size) {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const g = canvas.getContext('2d');
        if (g === null) return null;

        const img = g.createImageData(size, size);
        const d = img.data;
        // The map is stretched over the *filter region*, which is 140% of the
        // element box (see ensureLiquidDefs), so a ramp starting at 0.10 of the
        // map reaches roughly 14% of the box inwards — the bezel you actually
        // see on screen.
        //
        // 0.30 was the first guess and it was badly wrong: it put the warp 42%
        // of the way into the pane, so the neutral interior — the part that has
        // to stay crisp or the pane stops being a window onto anything — was
        // only the middle 16%. The measured result was a uniform funhouse
        // distortion rather than an edge. A bezel has to be a *rim*.
        const bezel = size * 0.1;
        const ramp = (dist) => {
          if (dist >= bezel) return 0;
          const t = 1 - dist / bezel;
          return t * t * (3 - 2 * t); // smoothstep: no seam where the ramp ends
        };
        for (let y = 0; y < size; y += 1) {
          const dy = Math.round(127 * (ramp(y) - ramp(size - 1 - y)));
          for (let x = 0; x < size; x += 1) {
            const dx = Math.round(127 * (ramp(x) - ramp(size - 1 - x)));
            const i = (y * size + x) * 4;
            d[i] = 128 + dx;
            d[i + 1] = 128 + dy;
            d[i + 2] = 128;
            d[i + 3] = 255;
          }
        }
        g.putImageData(img, 0, 0);
        return canvas.toDataURL('image/png');
      } catch (error) {
        console.warn('[liquid-glass] displacement map unavailable:', error);
        return null;
      }
    }

    /** The ripple's own map. */
    const DROP_FILTER_ID = 'dsl-drop';

    /**
     * A radial ("droplet") displacement map, as a base64 PNG.
     *
     * This is what replaced the drawn ripple, and the replacement is the whole
     * point of the redesign. Every previous version — the annulus, the bloom —
     * put *a picture of a ripple* on screen, and a picture of a ripple is a
     * drawn circle no matter how soft its edges are. Air's verdict on both was
     * the same: "依旧像是手绘" / "更差了". He was describing the technique, not
     * the tuning.
     *
     * A droplet draws nothing. It bends the light already there, so there is no
     * graphic to judge as drawn — only a piece of the window that behaves
     * differently from the rest of it. That is also why the ripple now survives
     * being over text: it warps the text instead of hiding it under a glow.
     *
     * The profile is a *dimple*, i.e. minification, because that is what a
     * finger actually does to glass:
     *
     *   · sampling is pushed OUTWARD from the centre (`px/r`, `py/r` point away
     *     from the middle), which makes the disc show content from further out
     *     — the signature of a pressed-in surface. A dimple is thin in the
     *     middle, so it diverges, so what is behind it shrinks;
     *   · magnitude RISES with radius and is killed off over the outer fifth, so
     *     the centre of the press is left alone and the bending lives in a band
     *     near the rim.
     *
     * That second point is the difference between a lens and a smear, and the
     * first version got it wrong. It used `4r(1-r)`, which peaks at half the
     * radius: maximum displacement spread across the entire middle of the disc.
     * The render showed exactly that — text inside the press was pulled from
     * somewhere else over the whole interior and read as fog, with a visible
     * circular edge where the profile finally fell away. Physically the
     * deflection of a ray through a curved surface is proportional to the
     * *slope* of that surface, and for a dimple the slope grows with r; the
     * interior of a real pressing is flat, so it must stay legible.
     *
     * (`1 - r²`, the version before that, peaked at the centre. `feDisplacement
     * Map` takes direction from the encoded vector, and at the exact centre that
     * vector is 0/0 — the encoder writes a unit vector that is numerically
     * arbitrary and flips between neighbouring pixels. That gave a pinwheel
     * swirl, which reads as a kaleidoscope rather than as a press.)
     *
     * @param {number} size square map edge in px
     * @returns {string|null} data URI, or null when canvas is unavailable
     */
    function dropMapDataUrl(size) {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const g = canvas.getContext('2d');
        if (g === null) return null;
        const img = g.createImageData(size, size);
        const d = img.data;
        const half = (size - 1) / 2;

        const mag = (r) => {
          // Taper the last 22% of the radius to zero. A lens whose rim stops
          // abruptly draws a circle even with no colour in it, because the eye
          // reads the discontinuity in the warp as an edge.
          const t = Math.min(1, Math.max(0, (1 - r) / 0.22));
          const fade = t * t * (3 - 2 * t); // smoothstep
          return r * fade;
        };

        // Normalise so the ramp's peak lands on full displacement. Computing it
        // rather than hardcoding a constant keeps the strength independent of
        // where the peak happens to fall, so retuning the taper cannot silently
        // also retune how hard the lens pushes.
        let peak = 0;
        for (let y = 0; y < size; y += 1) {
          for (let x = 0; x < size; x += 1) {
            const px = (x - half) / half;
            const py = (y - half) / half;
            const r = Math.sqrt(px * px + py * py);
            if (r < 1) peak = Math.max(peak, mag(r));
          }
        }
        if (peak <= 0) peak = 1;

        for (let y = 0; y < size; y += 1) {
          for (let x = 0; x < size; x += 1) {
            const px = (x - half) / half;
            const py = (y - half) / half;
            const r = Math.sqrt(px * px + py * py);
            const i = (y * size + x) * 4;
            if (r >= 1 || r < 1e-4) {
              d[i] = 128;
              d[i + 1] = 128;
            } else {
              const m = mag(r) / peak;
              d[i] = 128 + Math.round(127 * m * (px / r));
              d[i + 1] = 128 + Math.round(127 * m * (py / r));
            }
            d[i + 2] = 128;
            d[i + 3] = 255;
          }
        }
        g.putImageData(img, 0, 0);
        return canvas.toDataURL('image/png');
      } catch (error) {
        console.warn('[liquid-glass] droplet map unavailable:', error);
        return null;
      }
    }

    /**
     * Inject (or refresh) the shared `<defs>` that the refraction hangs off.
     *
     * Two filters live here, and they are different objects because they solve
     * different problems:
     *
     *   · `dsl-refract` — an *edge* lens. Neutral across the interior, ramping
     *     only in the outer band. Used on floating surfaces, where the job is to
     *     give a pane the sense of thickness at its rim while leaving whatever
     *     it displays perfectly undistorted. The displacement is scaled to the
     *     box, so it works on a 120px tooltip and a 600px dialog alike.
     *   · `dsl-drop` — a *radial* lens. Used by the click ripple, where the job
     *     is the opposite: a local, whole-disc distortion that grows.
     *
     * Details that are load-bearing rather than decorative:
     *
     *   · `color-interpolation-filters="sRGB"` is mandatory. The filter graph
     *     defaults to linearRGB, in which the map's 128-neutral does not decode
     *     back to neutral — the entire backdrop visibly shifts sideways.
     *   · The filter region is grown to 140% so displaced pixels are not clipped
     *     at the element bounds.
     *   · The SVG itself is 0x0 and absolutely positioned, because an inline SVG
     *     left in flow adds a mystery gap at the top of the document.
     *   · `feImage` needs the map *inlined*. Pointing it at a URL silently fails
     *     from a zero-sized SVG, which looks exactly like "refraction is not
     *     supported" while actually meaning "the map never loaded".
     *
     * @param {number} scale peak displacement in CSS px for the edge lens
     * @returns {boolean} whether a real refraction filter is available
     */
    function ensureLiquidDefs(scale, dropScale) {
      const map = lensMapDataUrl(192);
      let svg = document.getElementById(DEFS_ID);
      if (svg === null) {
        svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('id', DEFS_ID);
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('width', '0');
        svg.setAttribute('height', '0');
        svg.style.position = 'absolute';
        svg.style.width = '0';
        svg.style.height = '0';
        svg.style.overflow = 'hidden';
        document.body.appendChild(svg);
      }

      const dropMap = dropMapDataUrl(160);
      // Cache on the container: `ensureLiquidDefs` runs on every slider tick and
      // every scheme flip, and rebuilding two base64 `feImage`s each time is
      // pure waste. The signature is the edge-lens scale (the only thing that
      // changes) plus a prefix of the map (the only other thing that can).
      const sig = `${scale}|${dropScale}|${map === null ? 'none' : map.slice(0, 48)}`;
      const want = [REFRACT_FILTER_ID, DROP_FILTER_ID];
      if (svg.dataset.sig === sig && want.every((id) => document.getElementById(id) !== null)) {
        return true;
      }
      svg.dataset.sig = sig;
      for (const id of want) {
        const stale = document.getElementById(id);
        if (stale !== null) stale.remove();
      }

      if (dropMap !== null) {
        // Fixed scale: the ripple grows because the element scales up, which
        // drags the map wider with it. Animating the filter itself would need
        // SMIL or a JS tick per frame, and neither buys anything the transform
        // does not already give.
        svg.appendChild(buildDisplacementFilter(DROP_FILTER_ID, dropMap, dropScale));
      }
      if (map === null) {
        // No canvas: drop the edge lens and let the blur fallback carry it.
        return false;
      }

      svg.appendChild(buildDisplacementFilter(REFRACT_FILTER_ID, map, scale));
      return true;
    }

    /**
     * One `feImage` → `feDisplacementMap` pair, wired R→X and G→Y.
     *
     * Extracted because there are now two callers and the channel selectors are
     * the single easiest thing to get wrong silently: swapping them produces a
     * plausible-looking warp that is rotated 90°, which reads as "the map is
     * odd" rather than "the channels are swapped".
     */
    function buildDisplacementFilter(id, map, scale) {
      const NS = 'http://www.w3.org/2000/svg';
      const filter = document.createElementNS(NS, 'filter');
      filter.setAttribute('id', id);
      filter.setAttribute('filterUnits', 'objectBoundingBox');
      filter.setAttribute('x', '-20%');
      filter.setAttribute('y', '-20%');
      filter.setAttribute('width', '140%');
      filter.setAttribute('height', '140%');
      filter.setAttribute('color-interpolation-filters', 'sRGB');

      const feImage = document.createElementNS(NS, 'feImage');
      feImage.setAttribute('href', map);
      feImage.setAttribute('preserveAspectRatio', 'none');
      feImage.setAttribute('result', 'map');

      const feDisplace = document.createElementNS(NS, 'feDisplacementMap');
      feDisplace.setAttribute('in', 'SourceGraphic');
      feDisplace.setAttribute('in2', 'map');
      feDisplace.setAttribute('scale', String(scale));
      feDisplace.setAttribute('xChannelSelector', 'R');
      feDisplace.setAttribute('yChannelSelector', 'G');

      filter.appendChild(feImage);
      filter.appendChild(feDisplace);
      return filter;
    }

    /** Drop the refraction scaffolding — used when surfaces or the theme go off. */
    function dropLiquidDefs() {
      const svg = document.getElementById(DEFS_ID);
      if (svg !== null) svg.remove();
    }

    // -----------------------------------------------------------------------
    // Stylesheet
    // -----------------------------------------------------------------------

    /**
     * One variant block (light or dark) of the token overrides.
     *
     * Every curve is written against `glass` (0 at intensity 0, 1 at intensity
     * 2) so the two ends of the slider are meaningful states: the bottom end is
     * meant to be hard to tell from stock, the top end is a fully see-through
     * shell where the wallpaper carries the whole window.
     */
    function variantBlock(selector, opts) {
      const { t, surface, intensity, palette, reveal, rippleSize, frost, plate } = opts;
      const dark = selector.indexOf('dark') !== -1;
      // `glassOf` owns the curve — see its comment for why it is convex.
      const glass = glassOf(intensity);
      // Frost goes to ZERO as the slider goes up, and the last stretch of that
      // is the whole point of the control.
      //
      // The previous curve ran 24px → 10px. It was already "the wrong way round"
      // once (8px → 34px, where the top of the range hid the backdrop most) and
      // flattening it to 10px ended the inversion without ending the problem:
      // air's verdict on the corrected version was "强度拉满……更像是高斯模糊效果，
      // 我希望拉满后应当是几乎完全透明的", which is exact. 10px of blur is not a
      // subtly frosted shell — it is a Gaussian blur applied to the entire app,
      // and it was the single loudest thing standing between the desktop and the
      // eye at 2.0x. `deskcheck.mjs` prints it as `模糊 blur(10px)`.
      //
      // ONE CORRECTION, ADDED LATER, AND IT MATTERS: the blur air was looking at
      // in that round was only partly this one. The asar patch installed
      // `backgroundMaterial: "acrylic"` at the time, and acrylic is DWM drawing a
      // blurred copy of the desktop — a second blur, in the compositor, that no
      // amount of CSS work could reach or reduce. So "拉满还是高斯模糊" was two
      // causes stacked, and flattening this curve could only ever have removed
      // one of them. The other one is now the 窗口模糊 switch, where it belongs:
      // explicit, off by default, and orthogonal to intensity.
      //
      // So the top of the range is 0px, and the shape of the approach matters as
      // much as the endpoint. `1 - glass^2.2` keeps the bottom of the slider
      // within a pixel of where it was (23px at 0.2x, i.e. still "0.2 几乎与原
      // 生外观没有区别"), reproduces the old value at the default position (16px
      // at 1.0x), and then collapses over the top ~third of the travel. A linear
      // 24 → 0 would have taken 10px off the bottom of the range, which would
      // have broken the one thing the low end is for.
      //
      // That curve is now the *default* of a control rather than the whole
      // story: `blurOf` returns it while `frost` is null, and returns the user's
      // number once they have taken the axis over. Whatever the source, this is
      // the only place the value is resolved, so the three tokens below can
      // never disagree about how frosted the window is.
      const blur = blurOf(intensity, frost);
      const sat = Math.round(126 + 74 * glass);
      const sheen = 0.35 + 0.65 * glass;

      const canvas = parseColor(t.base) || (dark ? [13, 20, 36, 1] : [250, 252, 255, 1]);
      const canvasRgb = [canvas[0], canvas[1], canvas[2]];
      // Mirrors `glassedValue`'s shape for tokens the harvest could not resolve:
      // same `end`, same curve. If the two disagreed the window base would stay
      // 8% opaque on exactly the tokens nobody was watching.
      const alphaAt = (tier) => alphaOf(tier, GLASS_TIERS[tier][0], glass, reveal);
      const lines = [`  --dsl-tint-accent: ${t.accent};`];
      const put = (name, value) => lines.push(`  ${name}: ${value};`);

      // ---- colour identity -------------------------------------------------
      put('--dsw-alias-brand-primary', t.accent);
      put('--dsw-alias-link', t.accent);
      put('--dsw-alias-button-primary-fill', t.accent);

      // ---- surfaces --------------------------------------------------------
      if (surface) {
        for (const [name, tier] of GLASS_TOKENS) {
          // Prefer the official value for that exact token; a token the harvest
          // could not resolve still gets the tier's translucency so no surface
          // is left opaque by accident.
          const value =
            glassedValue(name, tier, palette, canvasRgb, HARVEST_TINT_WEIGHT, glass, reveal) ||
            rgbaOf(canvasRgb, alphaAt(tier));
          put(name, value);
        }

        // ---- specular edges ------------------------------------------------
        // Glass only reads as glass if its rim catches light, and the published
        // consensus on that rim is narrow: a 1px `rgba(255,255,255,0.10…0.15)`
        // hairline is what sells the physicality, and anything hotter stops
        // looking like a lit edge and starts looking like a drawn outline.
        // Only the colour lives here — the app owns every border-width — so the
        // ramp is written to land inside that band at full glass (0.14) and
        // within a hair of the stock separators at the bottom of the slider.
        const edge = dark
          ? rgbaOf([255, 255, 255], 0.05 + 0.09 * glass)
          : rgbaOf([255, 255, 255], 0.50 + 0.30 * glass);
        const edgeSoft = dark
          ? rgbaOf([255, 255, 255], 0.035 + 0.055 * glass)
          : rgbaOf([15, 30, 60], 0.09 + 0.03 * glass);
        put('--dsw-alias-border-l1', edgeSoft);
        put('--dsw-alias-border-l2', edgeSoft);
        put('--dsw-alias-border-l3', edge);
        put('--dsw-alias-border-l4', edge);

        // ---- washes and raised chrome --------------------------------------
        put('--dsw-alias-interactive-bg-hover', rgbaOf(dark ? [255, 255, 255] : [15, 30, 60], dark ? 0.06 + 0.06 * sheen : 0.05 + 0.04 * sheen));
        put('--dsw-alias-interactive-bg-active', rgbaOf(dark ? [255, 255, 255] : [15, 30, 60], dark ? 0.10 + 0.08 * sheen : 0.08 + 0.06 * sheen));
        put('--dsw-alias-markdown-code-block', rgbaOf(dark ? [255, 255, 255] : [15, 30, 60], dark ? 0.05 + 0.03 * glass : 0.05 + 0.02 * glass));
        put('--dsw-alias-markdown-inline-code', rgbaOf(dark ? [255, 255, 255] : [15, 30, 60], dark ? 0.08 + 0.04 * glass : 0.07 + 0.02 * glass));
        put('--dsw-alias-markdown-tag', rgbaOf(dark ? [255, 255, 255] : [15, 30, 60], dark ? 0.09 + 0.05 * glass : 0.07 + 0.03 * glass));
        put('--dsw-alias-scrollbar-bg-l2', rgbaOf(dark ? [255, 255, 255] : [15, 30, 60], dark ? 0.10 + 0.06 * sheen : 0.13 + 0.04 * sheen));
        put('--dsw-alias-scrollbar-hover-l2', rgbaOf(dark ? [255, 255, 255] : [15, 30, 60], dark ? 0.20 + 0.10 * sheen : 0.24 + 0.06 * sheen));
      }

      // ---- blur + glass lighting -------------------------------------------
      put('--dsw-menu-backdrop-filter', `blur(${blur}px) saturate(${sat}%)`);
      put('--dsw-mask-blur', `blur(${Math.round(blur / 2)}px)`);
      put('--dsl-blur', `blur(${blur}px) saturate(${sat}%)`);
      // The refraction hook, kept as a bare url() so the frosted-surface rules
      // can either concatenate it onto the blur list or leave it off entirely.
      // Chromium is the only engine that honours url() inside backdrop-filter;
      // everywhere else this token simply resolves to a reference nobody reads,
      // which is why the fallback is declared as its own separate rule.
      put('--dsl-refract', `url(#${REFRACT_FILTER_ID})`);
      put('--dsl-sheen-top', rgbaOf([255, 255, 255], dark ? 0.12 + 0.22 * sheen : 0.70 + 0.25 * sheen));
      put(
        '--dsl-edge-side',
        rgbaOf([255, 255, 255], dark ? 0.05 + 0.09 * sheen : 0.34 + 0.24 * sheen)
      );
      put('--dsl-sheen-bottom', rgbaOf(dark ? [0, 0, 0] : [20, 40, 80], dark ? 0.20 + 0.14 * sheen : 0.05 + 0.04 * sheen));
      put('--dsl-shadow-lift', `${Math.round(8 + 20 * glass)}px`);
      put('--dsl-glass', Number(glass.toFixed(3)));
      // The 每段对话底板's alpha and its colours, published as `rgba()` halves
      // for a reason: the plate is one background on one element, but its alpha
      // is the only part the user controls while its colour has to follow the
      // scheme. Splitting them means the plate rules contain no colour logic and
      // therefore cannot drift from the surface tokens — they read whatever this
      // block already decided the canvas colour is.
      //
      // `--dsl-plate` being 0 while the switch is off is what the stylesheet
      // tests on, and it is read rather than recomputed so the switch and the
      // level cannot disagree about whether the plate is on.
      put('--dsl-plate', Number(plate.toFixed(3)));
      // TWO COLOURS, ONE PER SIDE. Both are the canvas hue pulled toward the
      // preset's accent by a fixed weight — the human side further, the model
      // side less — so the pair reads as "related but distinct" on every preset
      // rather than as two colours someone picked for the ice preset and forgot
      // to retune for slate. Keeping both anchored to `canvasRgb` also means
      // neither can come out brighter than the surface it sits on in the light
      // scheme, which is the failure that would make one side look like a
      // selection highlight instead of a plate.
      //
      // The weights are far apart on purpose (0.30 vs 0.10). At the low end the
      // two plates were indistinguishable in the preview once the level slider
      // was under 0.4, which is exactly the setting a user reaches for when they
      // want subtlety — so the difference has to be legible at LOW alpha, not
      // just at the top of the slider where everything is legible anyway.
      const accentRgb = parseColor(t.accent);
      if (accentRgb !== null) {
        // TWO COLOURS, ONE PER SIDE, and the pair is built differently per
        // scheme because one rule does not survive both.
        //
        // The obvious rule — canvas pulled toward the preset's accent, more for
        // the human side than the model side — was the first attempt, and it
        // measured fine on the dark scheme and badly on the light one. The
        // reason is headroom: the light canvas is (250,252,255), so there are
        // barely five levels of room in any direction. Anchoring BOTH sides to
        // it puts a hard ceiling on how far apart they can get, no matter which
        // way each one travels.
        //
        // So the light scheme does not anchor to the canvas. It mixes from the
        // accent toward black, at two weights far enough apart to survive the
        // plate's own alpha; the canvas then contributes only through that
        // alpha when the plate composites. The dark scheme keeps the canvas
        // anchor, because its canvas is (13,20,36) and pulling up toward a light
        // accent is the direction with room in it.
        //
        // Same shape as the 浅色模式玻璃感偏弱 entry in the README: a light
        // scheme has less room to move, so a curve that is pure arithmetic on
        // the dark scheme has to change shape on the light one.
        const accent = [accentRgb[0], accentRgb[1], accentRgb[2]];
        // Light: both travel from the accent toward black — 0.28 keeps a
        // visible colour cast, 0.72 is nearly the ink itself.
        put('--dsl-plate-human-rgb', dark
          ? mixRgb(canvasRgb, accent, 0.30).join(', ')
          : mixRgb(accent, [0, 0, 0], 0.28).join(', '));
        put('--dsl-plate-model-rgb', dark
          ? mixRgb(canvasRgb, accent, 0.10).join(', ')
          : mixRgb(accent, [0, 0, 0], 0.72).join(', '));
      } else {
        // The harvest could not read the accent. Fall back to the canvas colour
        // for both rather than to a hardcoded pair: identical plates are a
        // visible bug, but a wrong hue under every message is a worse one, and
        // the canvas colour is at least the colour this scheme is built on.
        put('--dsl-plate-human-rgb', canvasRgb.join(', '));
        put('--dsl-plate-model-rgb', canvasRgb.join(', '));
      }
      // The halo's two shadows. Spelled in the scheme rather than derived from
      // the accent: a halo's entire job is contrast against the *desktop*, which
      // is not part of any palette, so it has to be black-or-white by
      // construction. The light-scheme rim is a dark ink and the dark-scheme rim
      // is a deep black-plus-glow pair; both are statically derived from the
      // scheme so the halo cannot end up coloured on one scheme and neutral on
      // the other.
      put('--dsl-halo-dark', dark ? 'rgba(0, 0, 0, 0.72)' : 'rgba(0, 0, 0, 0.50)');
      put('--dsl-halo-light', dark ? 'rgba(255, 255, 255, 0.20)' : 'rgba(255, 255, 255, 0.85)');
      // Published for the same reason `--dsl-lens-scale` is: on a stock client
      // — or with 透出桌面 off — every visible trace of the feature resolves to
      // the same pixels as before, so a slider that silently stopped opening
      // the window would look identical in every other assertion.
      put('--dsl-reveal', Number(reveal.toFixed(3)));
      // Published purely so the lens can be asserted: it is the one part of the
      // theme that lives in an SVG filter rather than in this sheet, and a
      // filter whose scale silently stopped tracking the slider would be
      // invisible in every CSS-level check.
      put('--dsl-lens-scale', String(lensScaleOf(intensity)));
      put('--dsl-drop-scale', String(dropScaleOf(intensity, rippleSize)));

      return `${selector} {\n${lines.join('\n')}\n}`;
    }

    /**
     * @param {object} config
     * @param {object} palette harvested official tokens
     * @param {{ edge: boolean, drop: boolean }} lenses which displacement
     *   filters actually made it into the document. Threaded in because this
     *   function cannot know: it is a pure string builder, and a `url()` that
     *   points at a filter which does not exist computes to `none` — silently
     *   taking the blur down with it.
     */
    function buildCss(config, palette, lenses) {
      const tint = TINTS[config.tint] || TINTS.ice;
      const intensity = config.intensity;
      const surface = config.surface;
      const reveal = revealOf(config);
      const plate = plateOf(config);
      // Read straight through, with NO second fallback here, and that is a
      // deliberate removal rather than an omission.
      //
      // `normalizeDocument` already enforces the closed set at both entry points
      // (the localStorage mirror and the host response), so a fallback here could
      // never fire — and a branch that can never fire is a branch no test can
      // reach. This file had exactly that shape for one commit: two guards, and
      // mutating either one left the suite green, because the other one was
      // still standing behind it. `tools/teeth.mjs` reports mutations that no
      // assertion notices, so a redundant guard does not buy safety here — it
      // buys a blind spot.
      //
      // What it costs to remove: `buildCss` now trusts its caller for this one
      // field. That is already true of `plate`, `reveal` and `intensity`, all of
      // which read straight from the normalized document.
      const plateSide = config.plateSide;
      const refracts = surface && lenses.edge === true;
      const drop = lenses.drop === true;
      const parts = [];

      // ---- design tokens: shape + motion -----------------------------------
      parts.push(`:root {
  --dsw-radius-xs: 6px;
  --dsw-radius-sm: 10px;
  --dsw-radius-md: 14px;
  --dsw-radius-lg: 20px;
  --dsw-radius-xl: 26px;
  --dsw-radius-panel: 34px;
  --dsl-ease: cubic-bezier(0.22, 0.68, 0.36, 1);
}`);

      // ---- per-scheme token overrides --------------------------------------
      parts.push(
        variantBlock('body', {
          t: tint.light,
          surface,
          intensity,
          palette: palette.light,
          reveal,
          rippleSize: config.rippleSize,
          frost: config.frost,
          plate
        })
      );
      parts.push(
        variantBlock('body[data-ds-dark-theme]', {
          t: tint.dark,
          surface,
          intensity,
          palette: palette.dark,
          reveal,
          rippleSize: config.rippleSize,
          frost: config.frost,
          plate
        })
      );

      // ---- wallpaper --------------------------------------------------------
      // The wallpaper is a real fixed element, not a background on html/body.
      //
      // Two reasons, both measured on the live window rather than reasoned about:
      //
      //  1. The official sheet paints the canvas with a *shorthand*,
      //     `body { background: var(--dsw-alias-bg-base, #fff) }`. A shorthand
      //     resets background-image to none, and because that declaration is not
      //     !important it silently won for background-image while losing for
      //     background-color — the reason the shell showed tinted-but-flat
      //     panels at exactly the composite of the overridden base over the
      //     desktop, with no gradient anywhere.
      //  2. Even with !important everywhere, body paints its background in the
      //     same step as its children, so a positioned child at z-index -1 is
      //     covered by it. Killing body's background entirely and letting the
      //     child own the wallpaper removes the ordering question.
      //
      // `html` normally keeps an opaque colour so the window never falls through
      // to the Electron surface — that fall-through was the original bug, and it
      // is still the right default. 透出桌面 inverts it, because on a patched
      // client what is behind the window is no longer a blank surface, it is the
      // desktop itself, and reaching it is the entire point.
      //
      // The fade deliberately does NOT happen here. Flipping this colour to
      // `transparent` is a switch, but an invisible one: `#dsl-wallpaper` covers
      // `html` completely at every reveal below 1, and that layer's own `opacity`
      // is what carries the fade — continuously, across the whole slider.
      // Rewriting the colour literals inside `tint.wash` stop by stop would have
      // been the other way to do it, and it would have moved the fade into a
      // string the regression suite already matches on as a fixture.
      parts.push(reveal > 0
        ? `html {
  background-color: transparent !important;
}`
        : `html {
  background-color: ${tint.light.shell} !important;
}
html:has(body[data-ds-dark-theme]) {
  background-color: ${tint.dark.shell} !important;
}`);
      parts.push(`body {
  background: transparent !important;
}
/* z-index -1 puts the wallpaper above the canvas and below every in-flow box,
   which is exactly the layer a glass shell needs to have behind it. */
#dsl-wallpaper {
  position: fixed;
  inset: 0;
  z-index: -1;
  pointer-events: none;
  background-repeat: no-repeat;
  background-size: cover;
  background-attachment: fixed;
}
/* Large smooth gradients band badly on 8-bit panels, and visible banding is one
   of the fastest ways a gradient starts looking cheap. A little film grain
   breaks the steps up. It is also the only fine texture anywhere in the theme,
   which matters because blurring a perfectly uniform surface just returns a
   uniform blur — the glass has nothing to refract otherwise. */
#dsl-wallpaper::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  opacity: ${Number((0.006 + 0.013 * glassOf(intensity)).toFixed(3))};
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='180' height='180' filter='url(%23n)'/%3E%3C/svg%3E");
  background-size: 180px 180px;
}`);

      // ---- frosted surfaces -------------------------------------------------
      if (surface) {
        // Only containers we can address by stable hooks: ARIA roles and the
        // dockkit data attributes the shell itself owns. Hashed CSS-module
        // class names are deliberately avoided — they change every build.
        //
        // Two tiers, on purpose:
        //   · every glass surface gets the blur;
        //   · only the *floating* ones get refraction. The lens is an edge
        //     effect whose strength is a fraction of the surface, so on a
        //     full-height pane the rim would be hundreds of px wide and read as
        //     a warp instead of as thickness. Apple's guidance points the same
        //     way: controls float above content, content does not float.
        //
        // The fallback and the override are deliberately two separate rules
        // rather than one rule with two values. An engine that cannot parse
        // url() inside backdrop-filter drops the *whole declaration*, so
        // keeping the plain blur in its own earlier rule means those engines
        // land on frosted glass instead of on no filter at all.
        const panes = `[data-dockkit-pane],
[data-dockkit-dock-zone],
[data-dockkit-column],
[data-dockkit-host] > *`;
        const floats = `[role="dialog"],
[role="alertdialog"],
[role="menu"],
[role="listbox"],
[role="tooltip"],
[data-dockkit-float]`;
        parts.push(`${panes},
${floats} {
  backdrop-filter: var(--dsl-blur);
  -webkit-backdrop-filter: var(--dsl-blur);
}
${refracts
            ? `/* Chromium only: the backdrop is *bent* at the rim rather than averaged.
   Emitted only when the SVG filter is actually in the document — a url()
   pointing at a missing filter computes to \`none\`, which would take the blur
   down with it. */
${floats} {
  backdrop-filter: var(--dsl-blur) var(--dsl-refract);
  -webkit-backdrop-filter: var(--dsl-blur) var(--dsl-refract);
}`
            : ''}
/* Specular rim + the sense of thickness. Written as inset shadows instead of a
   border, because border-width would move the layout of whatever the app put
   there — glass must not change what it is sitting on.
   The top inset highlight is the one detail that decides whether a pane reads
   as a lit object or as a flat translucent rectangle; without it the glass
   looks paper-thin no matter how good the blur or the refraction are. */
${floats} {
  box-shadow:
    inset 0 1px 1px var(--dsl-sheen-top),
    inset 0 -1px 1px var(--dsl-sheen-bottom),
    inset 1px 0 1px var(--dsl-edge-side),
    inset -1px 0 1px var(--dsl-edge-side),
    0 var(--dsl-shadow-lift) calc(var(--dsl-shadow-lift) * 2.4) -20px rgba(0, 0, 0, 0.5);
}`);
      }

      // ---- 对话辨识 ---------------------------------------------------------
      // Two modes, two gates, and the gates are not the same one.
      //
      // `side` rides on the 每段对话底板 switch and is emitted only while that
      // switch is on and the level is above zero, because the geometry it adds
      // is the one part of this theme that touches layout and it must cost
      // nothing while the control is off. `plateOf` collapses the switch and the
      // level into one number precisely so that cannot be got wrong here.
      //
      // `halo` must NOT be gated on the plate: the whole point of that mode is
      // "no plate, and still readable", so tying it to the plate switch would
      // make it unreachable for the one user who wants it. It is gated on
      // `surface` alone — with no glass there is no translucent shell and
      // therefore nothing for a halo to rescue.
      if (surface && plateSide === 'halo') parts.push(plateCss('halo'));
      else if (surface && plate > 0 && plateSide === 'side') parts.push(plateCss('side'));

      // ---- cursors ----------------------------------------------------------
      if (config.cursor) parts.push(cursorDeclarations());

      // ---- ripple -----------------------------------------------------------
      if (config.ripple) parts.push(rippleCss(intensity, drop, config.rippleSize));

      return parts.join('\n\n');
    }

    /**
     * Ripple stylesheet.
     *
     * Third rewrite, and the first two attempts shared one mistake that no amount
     * of tuning was going to fix: they drew a picture. The first painted a
     * radial-gradient *annulus* with area under it; the second a single
     * off-centre specular bloom. Air's verdicts were "依旧像是手绘" and then
     * "涟漪的画面做得更差了" — and both times he was describing the technique
     * rather than the parameters. A filled mark, however soft, is a shape, and a
     * shape laid on top of glass is a sticker.
     *
     * So the third version drew NOTHING: no background, no border, no gradient,
     * only a `backdrop-filter` that bends the pixels underneath through a radial
     * displacement map. The failure mode of drawing became unreachable.
     *
     * It also became invisible, and that is the correction this revision makes.
     * "A lens with nothing behind it shows nothing" is correct physics and it was
     * stated as the price at the time, but the price turned out to be higher than
     * it looked: air's verdict on the result was "效果完全不行 … 因为背景基本都是
     * 纯色". The app's large surfaces are near-uniform tokens, so the press landed
     * on something with nothing to bend more often than not — measured at Δ ≤ 5
     * per channel, which is to say not at all.
     *
     * The fix is not to put back a fill. It is to add the part of a glass edge
     * that does not need structure to exist: the specular rim. Apple's own
     * documentation of the material says this outright — "specular highlights are
     * the bright glints along the rims of Liquid Glass elements … glass has no
     * solid fill, so the bright rim is often the strongest cue for where a
     * control begins and ends" — and notes that on interaction the material
     * "illuminates from within". So the earlier ban was right about *area* and
     * wrong as a blanket ban on *edges*. The distinction is the whole design:
     *
     *   · the disc has no fill, so nothing draws a circle in the value channel;
     *   · the rim is a 2–4px annulus at the disc's own edge, so the only thing it
     *     can outline is the shape the lens already has;
     *   · it is modulated by a conic mask with its bright lobe toward the upper
     *     left, matching the direction the theme's backdrop lights already come
     *     from — a rim lit evenly all the way round reads as a stroke, and the
     *     same rim with a far side reads as a lit wall.
     *
     * It lives on `::after`, and that placement is load-bearing: `mask-image`
     * clips everything the element paints, including the result of its own
     * `backdrop-filter`. Putting the mask on the glint would have masked away the
     * lens along with the rim.
     *
     * Two consequences worth stating plainly, because they are the price:
     *
     *   · Over a flat, featureless surface the LENS is still invisible, by
     *     physics. What is visible there is the rim — which is the point of it,
     *     and is exactly what air asked for.
     *   · `blur()` is still deliberately absent. A lens does not blur; blurring
     *     here only smeared the content and read as a smudge rather than a press.
     *
     * There is also still no `brightness()` on the glint, and it is worth
     * recording why, because it was there and it looked like a harmless
     * legibility crutch. A uniform lift under a `border-radius: 50%` disc is
     * clipped to a disc, and a uniform change in pixel value clipped to a shape
     * IS that shape: wherever the backdrop is darker than the lift amplitude, the
     * circle's edge becomes visible as a soft ring. So the trick for surviving
     * flat areas put back the exact artefact the rewrite existed to remove — a
     * drawn circle, arriving through the value channel instead of the colour
     * channel. The render showed it as a foggy spot with an edge. The rim is the
     * same goal reached a different way: it does not lift the field, it draws the
     * *edge* and leaves the field alone, so there is no boundary to be discovered
     * by subtraction. A mild `saturate()` stays, because Apple's vibrancy
     * materials do saturation-boost the backdrop and 1.06 is far too small to
     * produce a visible boundary on a dark surface.
     *
     * The hold/release choreography is unchanged, because it was never the
     * problem: press → grows and holds while held, release → expands and fades.
     * Both phases stay under the 300ms interaction budget. What the growth is
     * *driven by* did change — see the long note at the return below.
     *
     * @param {number} rippleSize multiplier on the disc's diameter, 0.5 … 2
     */
    function rippleCss(intensity, drop, rippleSize) {
      const glass = glassOf(intensity);
      // The disc's edge at full size. `rippleSize` is applied here rather than in
      // the element's own CSS because the other two sizes are derived from it —
      // one number, three sizes, and no way for them to drift apart.
      const size = Math.round((64 + 76 * glass) * rippleSize);
      // Where the disc starts (invisible, before the hold commits) and how far
      // the dissolve carries it.
      const rest = Math.round(size * 0.34);
      const released = Math.round(size * 1.85);
      const sat = Math.round(102 + 4 * glass);
      // The rim's numbers, and why each is what it is:
      //
      //   · `feather` is the annulus's half-width. Below ~2px it reads as a
      //     hairline stroke rather than as a lit wall; above ~5px it starts to
      //     look like a soft blob sitting on the edge.
      //   · `rim` is the highlight. It has to be visible on a flat dark surface
      //     (air's case) without becoming the brightest thing on screen — a disc
      //     of nothing but rim is exactly the sticker the last two rounds were
      //     rejected for.
      //   · `shade` is the faint dark line just outside the highlight. Two tones
      //     rather than one is what makes the rim work on both schemes: on dark
      //     the white line reads, on light the dark line reads, and neither needs
      //     a scheme query. It is also what a real bevel looks like — light on
      //     the inside face of the wall, shade where it turns away.
      //   · `far` is the conic mask's alpha on the side away from the light.
      //     Fixed, not intensity-driven: the direction light comes from does not
      //     change when the effect gets stronger.
      //
      //     It is also the single number that decides whether this reads as a
      //     lit edge or as a drawn circle, and the first version got it wrong.
      //     At 0.42 the far side kept 42% of the highlight — measured with
      //     dropcheck.py's angular contrast, the brightest sector's mean delta
      //     over the dimmest was only 2.2x, and at 4x zoom the rim was visibly a
      //     complete closed ring of near-even brightness. That is the failure
      //     three earlier designs died for, arriving through the door marked
      //     "specular". Light does not wrap; the far side of a glass wall is
      //     whichever part turns away from the lamp, so it has to go dark. 0.13
      //     takes the ratio to roughly 7x and leaves the darkest sectors under
      //     the change threshold, which is what makes it an arc.
      const feather = Number((1.2 + 1.0 * glass).toFixed(2));
      const rim = Number((0.09 + 0.17 * glass).toFixed(3));
      const shade = Number((0.03 + 0.05 * glass).toFixed(3));
      const far = 0.13;
      const mid = Number((far + 0.15).toFixed(3));
      // Bright lobe at 315deg (upper left), dimmest at 135deg. `from 315deg`
      // puts the gradient's own 0deg there, and the theme's backdrop lights are
      // already at `12% -6%` — so the rim is lit by the same lamp as everything
      // else instead of by a second, invisible one. Measured: the brightest
      // sector lands at 225deg in screen coordinates, off-axis by 0.0deg.
      const lobeMask =
        `conic-gradient(from 315deg, #000 0deg, rgba(0,0,0,${mid}) 90deg, ` +
        `rgba(0,0,0,${far}) 180deg, rgba(0,0,0,${mid}) 270deg, #000 360deg)`;
      // The plain rule must come first and in its own block: an engine that
      // cannot parse url() inside backdrop-filter drops the entire declaration,
      // so bundling both values into one rule would cost those engines the
      // saturation step as well and the ripple would vanish outright.
      //
      // ---------------------------------------------------------------------
      // Why the disc grows by LAYOUT and no longer by `transform: scale()`
      //
      // air: "现在的形状怎么是一个圆形外套一个方圆型" — a circle, with something
      // that is not a circle painting outside it. There is no square anywhere in
      // this plugin's DOM: the root is full-viewport, the holder is 0x0, and the
      // glint is one `border-radius: 50%` box. So if a square is on screen, the
      // *engine* is painting it, and the only thing in the chain that can is the
      // `backdrop-filter`: its filter region is not the border box, and the
      // rounded clip has to be evaluated against whatever space that region
      // ended up in.
      //
      // Before changing anything, that was measured rather than reasoned about —
      // `tools/_preview/lensregion.mjs`, thirteen variants, judging the changed
      // area's extent along sixteen directions against a flat saturated ground
      // plus a displacement-visible cross-hatch. Every single one is a disc:
      // held and released, `saturate` and displacement, filter region at 100% and
      // at 140%, opacity 1 and 0.5, `will-change` on and off, with and without an
      // extra `clip-path: circle(50%)`. `border-radius` clips a `backdrop-filter`
      // correctly in all of them.
      //
      // Which is why the fix is structural rather than a tuned number. Every one
      // of those thirteen captures ran on SwiftShader — `shoot()` passes
      // `--disable-gpu`, and asking for `--use-angle=d3d11` instead produces
      // byte-identical output, so the GPU compositor has *never* been in the
      // picture. The one thing air's screen has that no capture here can have is
      // a compositor-driven `transform` animation: with `transform: scale()`,
      // Blink may rasterise the filtered backdrop once in the element's local
      // space and then hand the layer to the compositor to be scaled, and a clip
      // that is resolved on one side of that handoff and not the other is
      // exactly a shape mismatch between the filter's output and the radius.
      //
      // Removing the transform removes the handoff. The disc now grows by
      // `width`/`height`/`margin`, which is layout: the box, the filter region
      // and the `border-radius` are recomputed together, in one space, on every
      // frame, with nothing left for the compositor to scale.
      //
      // Two visible consequences, both measured on the specimen render and both
      // small enough to accept rather than tune away:
      //
      //   · the displacement is a fixed pixel amount again instead of being
      //     multiplied by the scale, so the dissolve warps slightly less at
      //     1.85x than it used to. The dissolve is a 190ms fade, so this reads
      //     as a gentler exit rather than as a weaker one;
      //   · the rim's `calc(100% - Npx)` stops are absolute again, so the rim is
      //     a constant thickness instead of thinning with the disc at 0.34x and
      //     thickening at 1.85x. Constant thickness is the more physical of the
      //     two — a wall does not get thicker because the drop got bigger.
      return `.dsl-ripple-root {
  position: fixed;
  inset: 0;
  z-index: 2147483000;
  pointer-events: none;
  /* Deliberately no paint containment on this root. The strict value of the
     contain property implies PAINT containment, which clips every descendant
     to this element's box. The root used to be 0x0, so the ripple was created,
     animated and removed without ever painting a single pixel — measured at
     0.00% changed pixels with a max channel delta of 2. Full-viewport plus no
     containment fixes it. */
}
.dsl-ripple-glint {
  position: absolute;
  left: 0;
  top: 0;
  width: ${rest}px;
  height: ${rest}px;
  margin: ${-rest / 2}px 0 0 ${-rest / 2}px;
  border-radius: 50%;
  pointer-events: none;
  will-change: opacity;
  backdrop-filter: saturate(${sat}%);
  -webkit-backdrop-filter: saturate(${sat}%);
  opacity: 0;
  transition:
    opacity 90ms cubic-bezier(0.2, 0.7, 0.3, 1),
    width 170ms cubic-bezier(0.16, 0.9, 0.28, 1),
    height 170ms cubic-bezier(0.16, 0.9, 0.28, 1),
    margin 170ms cubic-bezier(0.16, 0.9, 0.28, 1);
}
/* The specular rim. On a pseudo-element so its mask-image cannot reach the
   glint's own backdrop-filter — a mask clips everything the element paints,
   and putting it on the glint would have masked the lens away with the rim. */
.dsl-ripple-glint::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 50%;
  pointer-events: none;
  background: radial-gradient(closest-side,
    rgba(255,255,255,0) calc(100% - ${(feather * 2).toFixed(2)}px),
    rgba(255,255,255,${rim}) calc(100% - ${feather.toFixed(2)}px),
    rgba(12,18,34,${shade}) calc(100% - 0.5px),
    rgba(12,18,34,0) 100%);
  -webkit-mask-image: ${lobeMask};
  mask-image: ${lobeMask};
}${drop
        ? `
/* Chromium only. The droplet lens: the disc minifies what is beneath it, and
   the magnitude rises with radius and dies out over the outer 22% — so the
   press is crisp in the middle and bends at its wall, instead of smearing its
   whole interior. */
.dsl-ripple-glint {
  backdrop-filter: saturate(${sat}%) url(#${DROP_FILTER_ID});
  -webkit-backdrop-filter: saturate(${sat}%) url(#${DROP_FILTER_ID});
}`
        : ''}
.dsl-ripple-glint[data-held="true"] {
  opacity: 1;
  width: ${size}px;
  height: ${size}px;
  margin: ${-size / 2}px 0 0 ${-size / 2}px;
}
.dsl-ripple-glint[data-releasing="true"] {
  opacity: 0;
  width: ${released}px;
  height: ${released}px;
  margin: ${-released / 2}px 0 0 ${-released / 2}px;
  transition:
    opacity 190ms cubic-bezier(0.16, 0.84, 0.3, 1),
    width 280ms cubic-bezier(0.16, 0.84, 0.3, 1),
    height 280ms cubic-bezier(0.16, 0.84, 0.3, 1),
    margin 280ms cubic-bezier(0.16, 0.84, 0.3, 1);
}
@media (prefers-reduced-motion: reduce) {
  .dsl-ripple-glint { transition-duration: 1ms; }
}`;
    }

    // -----------------------------------------------------------------------
    // State
    // -----------------------------------------------------------------------

    let config = { ...DEFAULT_CONFIG };
    let hydrated = false;
    let loadError = null;
    let saveState = 'idle';
    let saveTimer = null;
    const listeners = new Set();

    function notify() {
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch (error) {
          console.warn('[liquid-glass] listener failed:', error);
        }
      }
    }

    function subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }

    function useConfig() {
      const [, force] = React.useReducer((n) => n + 1, 0);
      React.useEffect(() => subscribe(force), []);
      // `material` rides along even though it is not a setting, because the
      // panel is the only place the user can find out why 透出桌面 refuses to
      // do anything. `loadFromHost` ends with `notify()`, so the badge settles
      // on the host's answer a moment after the panel first paints.
      return {
        config,
        saveState,
        loadError,
        material: windowMaterial,
        materialWhy: windowMaterialWhy,
        windowBlur: windowBlurReport
      };
    }

    // -----------------------------------------------------------------------
    // Applying the theme
    // -----------------------------------------------------------------------

    /**
     * The official palette, harvested once and cached.
     *
     * Cached because harvesting walks every rule of every sheet, and re-done
     * when the first attempt came back empty: at module scope this bundle runs
     * before the Harness has necessarily appended its stylesheet, and an empty
     * palette silently degrades every surface to the fallback colour.
     */
    let paletteCache = null;

    function officialPalette() {
      if (paletteCache !== null && Object.keys(paletteCache.dark).length > 0) {
        return paletteCache;
      }
      try {
        paletteCache = harvestOfficialPalette();
      } catch (error) {
        console.warn('[liquid-glass] palette harvest failed:', error);
        paletteCache = { light: Object.create(null), dark: Object.create(null) };
      }
      return paletteCache;
    }

    /**
     * The wallpaper layer. Created once, kept out of the app's own tree so no
     * React reconciliation can remove it, and given its gradient through
     * inline styles so the cascade cannot interfere with it either.
     */
    function ensureWallpaper() {
      let el = document.getElementById(WALLPAPER_ID);
      if (el === null) {
        el = document.createElement('div');
        el.id = WALLPAPER_ID;
        el.setAttribute('aria-hidden', 'true');
        // Prepended to body rather than appended: later siblings would paint
        // over it, and the shell's own nodes are already there.
        document.body.insertBefore(el, document.body.firstChild);
      }
      return el;
    }

    function dropWallpaper() {
      const el = document.getElementById(WALLPAPER_ID);
      if (el !== null) el.remove();
    }

    function paintWallpaper() {
      if (!config.enabled || !config.surface) {
        dropWallpaper();
        return;
      }
      const tint = TINTS[config.tint] || TINTS.ice;
      const scheme = document.body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light';
      const reveal = revealOf(config);
      // Only touch the DOM when something actually changed: applyTheme runs on
      // every slider tick and on every scheme flip.
      const signature = `${scheme}|${config.tint}|${config.intensity}|${reveal.toFixed(3)}`;
      const el = ensureWallpaper();
      el.dataset.reveal = reveal.toFixed(3);
      if (el.dataset.signature === signature) return;
      el.dataset.signature = signature;
      const variant = scheme === 'dark' ? tint.dark : tint.light;
      el.style.backgroundImage = backdropImage(variant, config.intensity);
      el.style.backgroundColor = variant.shell;
      // 透出桌面 fades the whole backdrop layer rather than any part of its
      // colour, which is the only way the fade can be continuous: the layer is
      // a vignette over two light pools over a hex-stopped linear gradient, and
      // scaling alpha per stop would mean parsing and rewriting all six.
      //
      // `opacity: 0` is left as-is rather than swapping in `display: none`.
      // Nothing is composited at zero alpha, and keeping the element alive means
      // the fade back in is a value change rather than a style recalc plus a
      // fresh layer.
      el.style.opacity = reveal >= 1 ? '0' : String(Number((1 - reveal).toFixed(3)));
    }

    function ensureStyleElement() {
      let tag = document.getElementById(STYLE_ID);
      if (tag === null) {
        tag = document.createElement('style');
        tag.id = STYLE_ID;
        tag.dataset.plugin = 'air-pixel-liquid-glass';
        document.head.appendChild(tag);
      } else if (tag.parentElement !== document.head) {
        document.head.appendChild(tag);
      }
      return tag;
    }

    /**
     * Reflect `config` into the injected sheet. The tag is re-appended on every
     * write so a sheet the Harness appends during boot still loses the cascade.
     */
    function applyTheme() {
      if (!config.enabled) {
        const stale = document.getElementById(STYLE_ID);
        if (stale !== null) stale.textContent = '';
        dropWallpaper();
        dropLiquidDefs();
        return;
      }
      // The lenses have to be built *before* the CSS that references them. A
      // `url()` naming a filter that is not in the document computes to `none`,
      // and because `backdrop-filter` is a single declaration that means the
      // blur in the same value list goes down with it — the surface silently
      // loses its filter altogether rather than degrading to frosted.
      const lenses = {
        edge:
          config.surface &&
          ensureLiquidDefs(lensScaleOf(config.intensity), dropScaleOf(config.intensity, config.rippleSize)),
        drop: document.getElementById(DROP_FILTER_ID) !== null
      };
      const css = buildCss(config, officialPalette(), lenses);
      const tag = ensureStyleElement();
      if (tag.textContent !== css) tag.textContent = css;
      if (tag !== document.head.lastElementChild) document.head.appendChild(tag);
      paintWallpaper();
    }

    // -----------------------------------------------------------------------
    // Click ripples
    // -----------------------------------------------------------------------

    let rippleRoot = null;
    let liveRipples = 0;
    /** The glint currently held down, if any. Only one press is tracked: a
     *  second pointer landing mid-press should not steal the release event from
     *  the first, which would leave it stuck at full opacity forever. */
    let heldGlint = null;

    function ensureRippleRoot() {
      if (rippleRoot !== null && rippleRoot.isConnected) return rippleRoot;
      const root = document.createElement('div');
      root.className = 'dsl-ripple-root';
      root.setAttribute('aria-hidden', 'true');
      document.body.appendChild(root);
      rippleRoot = root;
      return root;
    }

    function spawnRipple(clientX, clientY) {
      if (liveRipples >= MAX_RIPPLES) return null;
      const root = ensureRippleRoot();
      const holder = document.createElement('div');
      holder.style.position = 'absolute';
      holder.style.left = `${clientX}px`;
      holder.style.top = `${clientY}px`;
      holder.style.width = '0';
      holder.style.height = '0';

      const glint = document.createElement('div');
      glint.className = 'dsl-ripple-glint';
      holder.appendChild(glint);
      root.appendChild(holder);

      liveRipples += 1;
      let reclaimed = false;
      const reclaim = () => {
        if (reclaimed) return;
        reclaimed = true;
        holder.remove();
        liveRipples = Math.max(0, liveRipples - 1);
      };
      glint.__reclaim = reclaim;

      // Let the initial (opacity 0, scale 0.34) state commit before flipping to
      // held, otherwise the browser coalesces both writes into one style pass
      // and the glint appears instantly instead of growing.
      //
      // rAF is the canonical way to obtain that commit, but it is a *frame-based*
      // signal, and there are real contexts that never produce a frame. The one
      // that caught this: a headless capture with `--virtual-time-budget`, where
      // timers advanced but no animation frame ever arrived, so the held state
      // was never applied and the ripple simply failed to appear. Anything that
      // renders without a compositor — a capture pipeline, a background tab
      // being painted, a plugin host that draws offscreen — has the same shape.
      //
      // The timer fallback is a no-op in a normal browser, because by 32ms the
      // rAF has already landed. Both writers are idempotent, so the worst case
      // is the same attribute being set to the same value twice.
      const hold = () => {
        if (glint.isConnected) glint.dataset.held = 'true';
      };
      window.requestAnimationFrame(hold);
      window.setTimeout(hold, 32);

      // Safety net: a press that never reports a release (window lost focus, a
      // drag that ended outside) must not hold the concurrency slot forever.
      window.setTimeout(() => {
        if (holder.isConnected) {
          releaseRipple(glint);
          window.setTimeout(reclaim, 700);
        }
      }, 900);

      return glint;
    }

    function releaseRipple(glint) {
      if (glint === null || !glint.isConnected) return;
      glint.dataset.held = 'false';
      glint.dataset.releasing = 'true';
      const reclaim = glint.__reclaim;
      if (typeof reclaim !== 'function') return;
      // 340ms = the 260ms dissolve plus a few frames of slack. The old 620ms
      // padding kept a fully transparent node in the tree for a third of a
      // second after it had stopped being visible, for no benefit.
      window.setTimeout(reclaim, 340);
    }

    function onPointerDown(event) {
      if (!config.ripple || !config.enabled) return;
      // Primary button / touch / pen only — a right-click should not sparkle.
      if (event.button !== undefined && event.button !== 0) return;
      if (event.pointerType === 'mouse' && event.buttons !== 1) return;
      heldGlint = spawnRipple(event.clientX, event.clientY);
    }

    function onPointerUp() {
      if (heldGlint === null) return;
      releaseRipple(heldGlint);
      heldGlint = null;
    }

    /** @returns {() => void} disposer */
    function installRipples() {
      document.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true });
      document.addEventListener('pointerup', onPointerUp, { capture: true, passive: true });
      document.addEventListener('pointercancel', onPointerUp, { capture: true, passive: true });
      window.addEventListener('blur', onPointerUp);
      return () => {
        document.removeEventListener('pointerdown', onPointerDown, { capture: true });
        document.removeEventListener('pointerup', onPointerUp, { capture: true });
        document.removeEventListener('pointercancel', onPointerUp, { capture: true });
        window.removeEventListener('blur', onPointerUp);
        heldGlint = null;
        if (rippleRoot !== null) {
          rippleRoot.remove();
          rippleRoot = null;
        }
        liveRipples = 0;
      };
    }

    // -----------------------------------------------------------------------
    // Host persistence
    // -----------------------------------------------------------------------

    /** The config keys whose only legal values are `true` and `false`. */
    const BOOLEAN_KEYS = ['enabled', 'surface', 'cursor', 'desktop', 'ripple', 'plate', 'windowBlur'];

    /**
     * Coerce a stored or received document onto the defaults.
     *
     * Used by BOTH the localStorage mirror and the host response, and that is
     * the point. They were separate implementations until this round, and the
     * two had already drifted: the mirror's version was a plain spread, so a
     * hand-edited `intensity: 99` painted at 99 until the host answered and
     * snapped it back to 2 — a visible flicker on every launch, from a value
     * the host would never have written.
     *
     * (`coerceBooleans` is still separate because it is the one part both paths
     * need verbatim, and an earlier attempt to make the mirror's version *only*
     * that silently dropped `intensity` and `tint` — the spread it replaced was
     * doing real work that was easy to miss.)
     */
    function normalizeDocument(raw) {
      const next = { ...DEFAULT_CONFIG };
      if (raw === null || typeof raw !== 'object') return next;
      coerceBooleans(next, raw);
      if (typeof raw.intensity === 'number' && Number.isFinite(raw.intensity)) {
        // Same clamp and the same 1-decimal rounding the host applies, so the
        // mirror and the host can never disagree about a value.
        next.intensity = Math.min(2, Math.max(0.2, Math.round(raw.intensity * 10) / 10));
      }
      if (typeof raw.rippleSize === 'number' && Number.isFinite(raw.rippleSize)) {
        next.rippleSize = Math.min(2, Math.max(0.5, Math.round(raw.rippleSize * 10) / 10));
      }
      // `null` is a legal value here, not a missing one: it is "follow the
      // curve". So this branch is written as an explicit null test rather than
      // as a typeof check — a document that says `frost: null` must keep the
      // follow behaviour, and the `{ ...DEFAULT_CONFIG }` spread above only
      // makes that true by accident. A junk value (a string, NaN) resolves to
      // the default instead, which is also follow.
      if (raw.frost === null) {
        next.frost = null;
      } else if (typeof raw.frost === 'number' && Number.isFinite(raw.frost)) {
        next.frost = Math.min(FROST_MAX, Math.max(0, Math.round(raw.frost)));
      }
      if (typeof raw.plateLevel === 'number' && Number.isFinite(raw.plateLevel)) {
        next.plateLevel = Math.min(PLATE_MAX, Math.max(0, Math.round(raw.plateLevel * 100) / 100));
      }
      // A closed set, so an unrecognised value resolves to the default rather
      // than being carried through to `buildCss`. That matters more here than
      // for a numeric field: a bad number still renders *something*, while a bad
      // mode string renders nothing at all — see the note on `plateSide` there.
      if (PLATE_SIDES.includes(raw.plateSide)) next.plateSide = raw.plateSide;
      const tint = normalizeTint(raw.tint);
      if (tint !== null) next.tint = tint;
      return next;
    }

    /**
     * Read the values a document does not spell out as booleans.
     *
     * @param {object} target
     * @param {object} source
     */
    function coerceBooleans(target, source) {
      if (source === null || typeof source !== 'object') return target;
      for (const key of BOOLEAN_KEYS) {
        if (typeof source[key] === 'boolean') target[key] = source[key];
      }
      return target;
    }

    function readCache() {
      try {
        const raw = window.localStorage.getItem(CACHE_KEY);
        if (raw === null) return null;
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object') return null;
        // The cache is read at module scope, before the host answers, so a
        // stale preset id would be live for the whole first paint. Folding it
        // here as well as in normalizeFromHost is what `normalizeDocument`
        // exists to make impossible to forget.
        return normalizeDocument(parsed);
      } catch {
        return null;
      }
    }

    function readMaterialCache() {
      try {
        return normalizeMaterial(JSON.parse(window.localStorage.getItem(MATERIAL_KEY)));
      } catch {
        return 'unknown';
      }
    }

    function readWindowBlurCache() {
      try {
        return normalizeWindowBlur(JSON.parse(window.localStorage.getItem(WINDOW_BLUR_KEY)));
      } catch {
        return { active: false, why: null, material: null };
      }
    }

    function writeCache() {
      try {
        window.localStorage.setItem(CACHE_KEY, JSON.stringify(config));
        window.localStorage.setItem(MATERIAL_KEY, JSON.stringify(windowMaterial));
        window.localStorage.setItem(WINDOW_BLUR_KEY, JSON.stringify(windowBlurReport));
      } catch {
        /* private mode / quota — the host remains the durable copy */
      }
    }

    /** Preset ids that existed in an earlier version and where they went. */
    const TINT_ALIASES = { aurora: 'slate' };

    function normalizeTint(value) {
      if (typeof value !== 'string') return null;
      const id = TINT_ALIASES[value] ?? value;
      return TINT_IDS.includes(id) ? id : null;
    }

    function normalizeFromHost(data) {
      // Deliberately the same function the mirror goes through: the host is the
      // source of truth for what was *saved*, not for what is legal.
      return normalizeDocument(data);
    }

    async function loadFromHost() {
      try {
        const response = await fetch(API, { headers: { Accept: 'application/json' }, cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        // The material report rides along on the config response but is not part
        // of the config: it is not settable, and POSTing it back would be a
        // client asserting a fact about its own process that it cannot know.
        // This is also the reason the setting lives here and not in the main
        // process — see `revealOf`.
        windowMaterial = normalizeMaterial(data?.material);
        // Likewise not a setting: this is what the main process managed to do
        // about `windowBlur` on the last round trip. It rides on both the GET
        // and the POST response, so flipping the switch updates it without a
        // reload.
        //
        // Read from `windowBlurReport`, not from `windowBlur`. The response is
        // the config spread with the host's own fields on top, so a report filed
        // under the config's key *overwrites* the saved boolean with an object —
        // and `coerceBooleans` skips anything that is not a boolean, so the key
        // would fall back to `false` silently at every launch. The two facts
        // need two names.
        windowBlurReport = normalizeWindowBlur(data?.windowBlurReport);
        // Kept only for the failure state: `patched` and `stock` are already fully
        // explained by their own copy, and showing a reason code next to a
        // working switch would just be noise.
        windowMaterialWhy = (() => {
          if (windowMaterial !== 'unknown') return null;
          const why = typeof data?.materialWhy === 'string' ? data.materialWhy : null;
          if (why === null) return null;
          // "scan-failed" on a path that exists is the shape with no obvious
          // cause from the outside: the runtime rewrites `fs.openSync` for
          // archive paths, so the file is there and the open refuses anyway.
          // Naming each reader and its errno turns that into something the user
          // can act on — or paste into a bug report.
          const attempts = Array.isArray(data?.materialScanError) ? data.materialScanError : [];
          const errors = attempts
            .filter((entry) => entry !== null && typeof entry === 'object')
            .map((entry) => `${entry.via ?? '?'}=${entry.code ?? '?'}(${entry.syscall ?? '?'})`)
            .join(' · ');
          return {
            why,
            path: typeof data?.materialPath === 'string' ? data.materialPath : null,
            errors: errors === '' ? null : errors
          };
        })();
        config = normalizeFromHost(data);
        loadError = null;
        writeCache();
        applyTheme();
      } catch (error) {
        loadError = error?.message ?? String(error);
        console.warn('[liquid-glass] failed to load config from host:', error);
      } finally {
        hydrated = true;
        notify();
      }
    }

    async function saveToHost() {
      saveState = 'saving';
      notify();
      try {
        const response = await fetch(API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(config)
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        // Read the answer back rather than assuming the write landed. 窗口模糊
        // is applied by the main process *while handling this request*, so the
        // response is the first place its result exists — and for every other
        // setting this is also where the host's own normalization becomes
        // visible, which is why the payload is parsed instead of ignored.
        const data = await response.json();
        if (data === null || typeof data !== 'object' || Array.isArray(data)) {
          throw new Error('Invalid save response');
        }
        if (data.saved !== true) throw new Error('The host could not save the configuration');
        windowMaterial = normalizeMaterial(data.material);
        windowBlurReport = normalizeWindowBlur(data.windowBlurReport);
        saveState = 'saved';
        loadError = null;
      } catch (error) {
        saveState = 'error';
        console.warn('[liquid-glass] failed to save config to host:', error);
      }
      notify();
    }

    function scheduleSave() {
      if (saveTimer !== null) window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => {
        saveTimer = null;
        void saveToHost();
      }, SAVE_DEBOUNCE_MS);
    }

    /** Apply immediately, persist in the background. */
    function commit(patch) {
      config = normalizeDocument({ ...config, ...patch });
      writeCache();
      applyTheme();
      notify();
      scheduleSave();
    }

    // -----------------------------------------------------------------------
    // Locale
    // -----------------------------------------------------------------------

    const zh = {
      nav: '液态玻璃',
      heading: '液态玻璃主题',
      intro: '毛玻璃质感的面板、自定义指针与点击涟漪。全部效果都可以单独关掉。',
      masterLabel: '启用主题',
      masterHint: '关闭后立即还原 Harness 的默认外观。',
      surfaceLabel: '毛玻璃面板',
      surfaceHint: '让边栏、面板、弹窗与菜单变成半透明玻璃，壁纸从面板下面透出来。关闭后所有面板恢复不透明。',
      desktopLabel: '透出桌面',
      desktopHint: '放开窗口底板，让桌面本身透出来；效果强度 2.0 时桌面原样透出。桌面要不要模糊由下面的「窗口模糊」单独决定，和强度无关。',
      patchReady: '已就绪',
      patchMissing: '客户端未打补丁',
      patchUnknown: '无法检测客户端',
      patchNoticeTitle: '透出桌面已开启，但不会生效',
      patchNoticeStock: '它依赖客户端主进程的窗口材质，而当前的 app.asar 还没有打补丁 —— 窗口底板依然是不透明的，这个开关只是被记下来了。',
      patchNoticeUnknown: '读不到客户端的 app.asar，无法确认是否已打过补丁，所以不敢放开窗口底板 —— 万一材质没就位，透出来的会是 Electron 的白色画布，比现在更糟。',
      patchNoticeWhyLabel: '宿主自报：',
      patchNoticeHow: '关闭 DSH → 运行 tools/asarpatch.py --apply-staged → 重新启动',
      cursorLabel: '自定义指针',
      cursorHint: '替换默认箭头、手型、文本与拖拽指针。',
      rippleLabel: '点击涟漪',
      rippleHint: '按下时在光点处亮起镜面反光，松开向外扩散消失。',
      rippleSizeLabel: '涟漪大小',
      rippleSizeHint: '涟漪的直径倍数。100% 是默认尺寸，与「效果强度」无关 —— 强度决定玻璃有多透，这一项只决定一次按压看起来多大。',
      intensityLabel: '效果强度',
      intensityHint: '0.2 几乎与原生外观没有区别；拉到 2.0 面板近乎全透、壁纸与桌面完全透出（开了「透出桌面」时，这一档决定桌面透出多少）。',
      // 模糊这一组有三行，顺序就是「哪一层」的顺序：窗口（桌面）→ 主题自己的背景 → 正文底板。
      // 写提示文案时的原则：说清它作用在哪一层，而不是说它能做到什么 ——
      // air 上一轮就是因为分不清这两根滑杆各自作用在哪一层，才判定「没什么效果」。
      windowBlurLabel: '窗口模糊',
      windowBlurHint: '真正的背景高斯模糊：请系统合成器把窗口背后的桌面整片糊掉。页面里的 CSS 够不到窗口背后的东西，所以这项只能由客户端主进程来做。只在「透出桌面」打开时才看得见，和「效果强度」完全无关 —— 关掉它就回到现在的样子。',
      windowBlurIdle: '已关闭',
      windowBlurOn: '已生效',
      windowBlurOff: '未生效',
      windowBlurNeedsDesktop: '需先开「透出桌面」',
      // 「已开启」而不是「已请求·无法自证」。
      //
      // 这一档曾经读作「已请求·无法自证」，并且配一块黄色警告。那是把一件
      // 环境事实说成了用户的问题：这个客户端的 Electron 44.0.0 / win32 只有
      // setBackgroundMaterial、没有 getBackgroundMaterial，所以「读不回来」
      // 描述的是**这个构建永远如此**，不是这次请求出了岔子。air 的原话是
      // 「透明和窗口模糊效果做得都挺好」—— 效果在屏幕上，警告却说他没法确认，
      // 一块永远亮着的黄牌只是噪音。
      //
      // 「读不回来」这件事没有被丢掉，它搬进了标题和 hint 里 —— 那是它该在的
      // 地方（一个持久的能力说明），而不是一次需要用户处理的故障。
      windowBlurUnverified: '已开启',
      windowBlurUnverifiedTitle: '窗口模糊已开启（这个构建读不回材质名）',
      windowBlurUnverifiedBody: '材质已经交给系统合成器了。这个 Electron 构建只提供设置接口、没有读取接口，所以没法自动回读确认——这是构建本身的限制，不影响效果。桌面在屏幕上的样子就是结果；要用独立量具复核就跑 tools/materialprobe.py 真截屏量一次。',
      windowBlurNoticeTitle: '窗口模糊已开启，但没有生效',
      windowBlurNoticeBody: '主进程没有回执，或回执说明材质没有生效——屏幕上现在还是清晰的桌面。最常见的原因：客户端归档还没用本项目的 asarpatch.py 重新打补丁（窗口监听是补丁的一部分）。',
      windowBlurNoticeWhyLabel: '宿主自报：',
      frostFollowLabel: '模糊跟随强度',
      frostFollowHint: '打开时模糊量由「效果强度」决定，越低越糊。关掉后可单独设定，让外壳全透而背景仍是磨砂的。',
      frostLabel: '磨砂模糊',
      frostHint: '像素半径，只作用于主题自己画的那层背景：面板与弹窗会把它背后的东西糊掉。它够不到真桌面 —— 强度拉满时那层壁纸已经淡出，这一项就会看不出变化，那种情况要用上面的「窗口模糊」。',
      frostAuto: '· 自动',
      plateLabel: '每段对话底板',
      plateHint: '在每一条对话消息下面铺一层半透明底板，只覆盖消息本身、不会让整个窗口变白。外壳保持全透时，正文依然读得清。',
      plateLevelLabel: '底板不透明度',
      plateLevelHint: '底板本身的不透明度。约 50% 就够 4.5:1 的正文对比度；拉到顶（85%）是一块只透 15% 的实面板，压得住任何桌面。',
      plateSideLabel: '对话辨识',
      plateSideHint: '怎么分清哪句是你说的、哪句是 AI 说的。底板解决「读得清」，辨识解决「看得出是谁」—— 这是两件事，同一个颜色回答不了两个问题。',
      plateSideSide: '双侧底色',
      plateSideHalo: '只加文字描边',
      plateSideOff: '不区分',
      tintLabel: '色调',
      tintHint: '壁纸与主色调，跟随浅色 / 深色自动切换。',
      tintIce: '冷灰',
      tintSlate: '石板',
      tintDusk: '暖灰',
      tintMono: '素墨',
      stateOn: '已启用',
      stateOff: '已关闭',
      saving: '保存中',
      saved: '已保存',
      saveError: '无法保存到主机，本次仅在本机浏览器生效',
      loadError: '无法读取主机上保存的设置',
      reset: '恢复默认',
      styleHint: '样式通过覆盖 --dsw-* 设计令牌生效，不依赖任何构建期哈希类名，Harness 升级后依然有效。'
    };

    const en = {
      nav: 'Liquid Glass',
      heading: 'Liquid Glass theme',
      intro: 'Frosted panels, custom cursors and click ripples. Every effect can be turned off on its own.',
      masterLabel: 'Enable theme',
      masterHint: 'Turning this off restores the stock Harness look immediately.',
      surfaceLabel: 'Frosted panels',
      surfaceHint: 'Turns sidebars, panels, dialogs and menus into translucent glass with the wallpaper showing through. Off restores every surface to opaque.',
      desktopLabel: 'Show the desktop',
      desktopHint: 'Opens the window base so the desktop itself shows through; Intensity 2.0 lets it through untouched. Whether that desktop is blurred is decided by Window blur below, not by Intensity.',
      patchReady: 'Ready',
      patchMissing: 'Client not patched',
      patchUnknown: 'Client undetectable',
      patchNoticeTitle: 'Show the desktop is on, but it cannot work yet',
      patchNoticeStock: 'It depends on window material owned by the client\'s main process, and this app.asar is not patched yet - the window base is still opaque, so the switch has only been remembered.',
      patchNoticeUnknown: 'The client\'s app.asar could not be read, so there is no way to confirm it was patched - and opening the window base on a guess would reveal Electron\'s white canvas, which is worse than the shell it replaces.',
      patchNoticeWhyLabel: 'Host reports:',
      patchNoticeHow: 'Quit DSH → run tools/asarpatch.py --apply-staged → start it again',
      cursorLabel: 'Custom cursors',
      cursorHint: 'Replaces the default arrow, pointer, text and grab cursors.',
      rippleLabel: 'Click ripples',
      rippleHint: 'A specular glint lights up where you press, then expands and dissolves on release.',
      rippleSizeLabel: 'Ripple size',
      rippleSizeHint: 'Diameter multiplier for the ripple. 100% is the default size and is independent of Intensity - that decides how clear the glass is, this only decides how big one press looks.',
      intensityLabel: 'Intensity',
      intensityHint: '0.2 is almost indistinguishable from stock; 2.0 makes the panels nearly transparent and lets the wallpaper and desktop through (with Show the desktop on, this decides how much).',
      // Three rows, in the order of the layers they act on: the window (the
      // desktop) → the theme's own backdrop → the body-copy plate. Each hint
      // names its layer rather than its ambition, because "which layer does this
      // one touch" is the exact question that made the previous pair read as two
      // copies of the same control.
      windowBlurLabel: 'Window blur',
      windowBlurHint: 'The real backdrop Gaussian blur: the system compositor smears the whole desktop behind the window. CSS in the page cannot reach what is behind a window, so only the client\'s main process can do this. Visible only with Show the desktop on, and completely independent of Intensity - turn it off and you are back to what you have now.',
      windowBlurIdle: 'Off',
      windowBlurOn: 'In effect',
      windowBlurOff: 'Not applied',
      windowBlurNeedsDesktop: 'Needs Show the desktop',
      // Requested, unverifiable — neither "in effect" nor "not applied".
      // Measured: Electron 44.0.0 / win32 ships setBackgroundMaterial and no
      // getBackgroundMaterial, so the material was handed to the compositor and
      // nobody can read it back. Printing that as "not applied" would put a
      // failure next to a desktop that is in fact blurred.
      windowBlurUnverified: 'On',
      windowBlurUnverifiedTitle: 'Window blur is on (this build cannot read the material name back)',
      windowBlurUnverifiedBody: 'The material was handed to the system compositor. This Electron build offers a setter and no getter, so it cannot be read back to confirm - a limitation of the build, not of the effect. The desktop on screen is the result; to verify independently, measure it with tools/materialprobe.py.',
      windowBlurNoticeTitle: 'Window blur is on, but it did not take',
      windowBlurNoticeBody: 'The main process did not answer, or its report says the material did not take - so the desktop on screen is still sharp. Most common cause: the client archive has not been re-patched with this project asarpatch.py, which is what installs the window watcher.',
      windowBlurNoticeWhyLabel: 'Host reports:',
      frostFollowLabel: 'Frost follows Intensity',
      frostFollowHint: 'On, Intensity decides the frost - lower is foggier. Off, it is set below, so the shell can be fully open and still frosted.',
      frostLabel: 'Frost blur',
      frostHint: 'Pixel radius, applied to the backdrop the theme paints itself: panels and floats blur what is behind them. It cannot reach the real desktop - at full Intensity that backdrop has faded out, which is exactly when this row looks like it does nothing; Window blur above is the control for that case.',
      frostAuto: '· auto',
      plateLabel: 'Per-message plate',
      plateHint: 'A translucent plate under each conversation block, covering the message and nothing else - it cannot whiten the whole window. Keeps body copy readable while the shell stays fully open.',
      plateLevelLabel: 'Plate opacity',
      plateLevelHint: 'The plate\'s own opacity. About 50% already holds 4.5:1; the top (85%) is a nearly solid panel that holds over any desktop.',
      plateSideLabel: 'Speaker distinction',
      plateSideHint: 'How you tell your messages from the model\'s. The plate solves "can I read it"; this solves "whose is it" - two questions, and one colour cannot answer both.',
      plateSideSide: 'Two plate colours',
      plateSideHalo: 'Text outline only',
      plateSideOff: 'No distinction',
      tintLabel: 'Tint',
      tintHint: 'Wallpaper and accent colour, switching with light / dark.',
      tintIce: 'Ice',
      tintSlate: 'Slate',
      tintDusk: 'Dusk',
      tintMono: 'Mono',
      stateOn: 'Enabled',
      stateOff: 'Disabled',
      saving: 'Saving',
      saved: 'Saved',
      saveError: 'Could not save to the host - applied in this browser only',
      loadError: 'Could not read the saved settings from the host',
      reset: 'Restore defaults',
      styleHint: 'Applies by overriding --dsw-* design tokens - no build-hashed class names, so it survives Harness upgrades.'
    };

    // -----------------------------------------------------------------------
    // Settings section chrome
    // -----------------------------------------------------------------------

    function ensureSectionStyles() {
      if (document.getElementById(SECTION_STYLE_ID) !== null) return;
      const tag = document.createElement('style');
      tag.id = SECTION_STYLE_ID;
      tag.dataset.plugin = 'air-pixel-liquid-glass';
      tag.textContent = `
.dsl-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 760px;
  color: var(--dsw-alias-label-primary);
}
.dsl-heading { margin: 0; font-size: 18px; font-weight: 600; line-height: 1.4; }
.dsl-intro { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 13px; line-height: 1.5; }
.dsl-card {
  border: 0.5px solid var(--dsw-alias-border-l4);
  background: var(--dsw-alias-bg-layer-2);
  border-radius: 16px;
  padding: 6px 16px;
  display: flex;
  flex-direction: column;
}
.dsl-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 0;
  border-top: 0.5px solid var(--dsw-alias-border-l1);
}
.dsl-row:first-child { border-top: 0; }
.dsl-row-text { display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1; }
.dsl-row-title { font-size: 14px; font-weight: 500; line-height: 1.5; }
.dsl-hint { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 1.5; }
.dsl-actions { display: flex; align-items: center; gap: 10px; flex: none; }
.dsl-switch {
  box-sizing: border-box; position: relative; flex: none;
  width: 40px; height: 22px; padding: 2px; border: 0; border-radius: 11px;
  background: var(--dsw-alias-border-l3, rgba(255,255,255,0.22));
  cursor: pointer; transition: background 0.16s ease;
}
.dsl-switch[data-on="true"] { background: var(--dsw-alias-brand-primary, #3b82f6); }
.dsl-switch:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #3b82f6); outline-offset: 2px; }
.dsl-switch[disabled] { opacity: 0.45; cursor: not-allowed; }
.dsl-thumb {
  display: block; width: 18px; height: 18px; border-radius: 50%;
  background: var(--dsw-alias-label-primary-foreground, #fff);
  box-shadow: 0 1px 3px rgba(0,0,0,0.35);
  transition: transform 0.14s ease;
}
.dsl-switch[data-on="true"] .dsl-thumb { transform: translate(18px); }
.dsl-status {
  flex: none; white-space: nowrap; border-radius: 999px; padding: 2px 8px;
  font-size: 11px; font-weight: 500; line-height: 17px;
  background: var(--dsw-alias-bg-module-platform, rgba(255,255,255,0.08));
  color: var(--dsw-alias-label-secondary);
}
.dsl-status[data-on="true"] { color: var(--dsw-alias-state-business-primary, #60a5fa); }
.dsl-slider { flex: none; width: 190px; accent-color: var(--dsw-alias-brand-primary, #3b82f6); }
/* A disabled slider now carries meaning rather than only indicating that the
   theme is off: 磨砂模糊 is disabled exactly while it is following the intensity
   slider. Without this it looks like any other live control, so "the theme
   decided this number" and "you set this number" render identically — the same
   failure the .dsl-switch[disabled] rule was added for. */
.dsl-slider[disabled] { opacity: 0.55; cursor: not-allowed; }
.dsl-value[data-auto="true"] { color: var(--dsw-alias-label-tertiary); }
.dsl-value {
  flex: none; min-width: 34px; text-align: right; font-size: 12px;
  color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums;
}
.dsl-tints { display: flex; gap: 8px; flex: none; }
/* The 对话辨识 mode picker. A segmented control rather than a dropdown, because
   three short options with a visible order are faster to read as a row than as a
   menu that has to be opened — and because the order itself carries meaning
   (see PLATE_SIDE_VIEW), which a dropdown hides until it is open. */
.dsl-modes {
  display: flex; gap: 2px; flex: none; padding: 3px; border-radius: 10px;
  background: var(--dsw-alias-bg-layer-3, rgba(0,0,0,0.04));
}
.dsl-mode {
  padding: 5px 11px; border: 0; border-radius: 8px; background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-size: 11px; line-height: 1.4; white-space: nowrap; cursor: pointer;
  transition: background-color 0.16s ease, color 0.16s ease;
}
.dsl-mode:hover:not([disabled]) { color: var(--dsw-alias-label-primary); }
.dsl-mode[data-active="true"] {
  background: var(--dsw-alias-bg-layer-1, rgba(255,255,255,0.9));
  color: var(--dsw-alias-label-primary);
  font-weight: 500;
}
/* Disabled shares the slider's opacity floor so the two controls read as the
   same kind of "not yours to change right now". */
.dsl-mode[disabled] { opacity: 0.55; cursor: not-allowed; }
.dsl-tint {
  box-sizing: border-box; display: flex; flex-direction: column; align-items: center; gap: 4px;
  padding: 7px 9px; border-radius: 12px; border: 1px solid transparent;
  background: var(--dsw-alias-bg-layer-3, rgba(0,0,0,0.04));
  color: var(--dsw-alias-label-secondary);
  font-size: 11px; line-height: 1.2; cursor: pointer;
  transition: border-color 0.16s ease, color 0.16s ease;
}
.dsl-tint:hover { border-color: var(--dsw-alias-border-l4); }
.dsl-tint[data-active="true"] {
  border-color: var(--dsw-alias-brand-primary, #3b82f6);
  color: var(--dsw-alias-label-primary);
}
.dsl-swatch { display: flex; gap: 2px; }
.dsl-swatch i { display: block; width: 9px; height: 16px; border-radius: 3px; }
.dsl-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.dsl-error { margin: 0; color: var(--dsw-alias-label-error, #f87171); font-size: 12px; line-height: 1.5; }
/* The one place in this panel that raises its voice.
   It exists because a switch that turns on and changes nothing is
   indistinguishable from a broken switch — air turned 透出桌面 on, saw nothing,
   and asked why. The badge that already said "客户端未打补丁" was doing its job
   and was still too quiet to be the only answer.
   The amber is a literal rather than a token on purpose: it has to be readable
   as a warning in all four tints and under both schemes, which is exactly what a
   palette-derived colour cannot promise. It is also deliberately not one of the
   four tint accents, so a notice can never be mistaken for a selected preset. */
.dsl-notice {
  display: flex; align-items: stretch; gap: 10px;
  margin: 4px 0 14px;
  padding: 10px 12px 10px 10px;
  border-radius: 12px;
  background: rgba(245, 158, 11, 0.10);
}
.dsl-notice-mark { flex: none; width: 3px; border-radius: 999px; background: #f59e0b; }
.dsl-notice-text { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.dsl-notice-title { font-size: 13px; font-weight: 600; line-height: 1.5; color: var(--dsw-alias-label-primary); }
.dsl-notice-body { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }
.dsl-notice-how {
  margin: 0; font-size: 12px; line-height: 1.5;
  color: var(--dsw-alias-label-tertiary);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  overflow-wrap: anywhere;
}
/* The host's diagnosis. Monospace and wrapped because these are values to paste
   into a terminal, not prose to read — a wrapped absolute path in a proportional
   font is genuinely hard to transcribe. */
.dsl-notice-why { margin: 0; display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.dsl-notice-why-code {
  font-size: 11px; line-height: 1.5;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--dsw-alias-label-secondary);
}
/* One line per fact the host could supply — the path it settled on, and each
   reader that refused with its errno. Monospace and wrapped because these are
   values to paste into a terminal, not prose; a wrapped absolute path in a
   proportional font is genuinely hard to transcribe. */
.dsl-notice-why-detail {
  font-size: 11px; line-height: 1.5;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--dsw-alias-label-tertiary);
  overflow-wrap: anywhere;
}.dsl-reset {
  flex: none; border: 0.5px solid var(--dsw-alias-border-l4);
  background: var(--dsw-alias-bg-layer-3, transparent);
  color: var(--dsw-alias-label-secondary);
  border-radius: 999px; padding: 4px 12px; font-size: 12px; cursor: pointer;
}
.dsl-reset:hover { color: var(--dsw-alias-label-primary); }
`;
      document.head.appendChild(tag);
    }

    // -----------------------------------------------------------------------
    // Settings UI
    // -----------------------------------------------------------------------

    const { useState, useCallback } = React;
    const h = React.createElement;

    function Toggle({ on, onToggle, disabled, label }) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': on ? 'true' : 'false',
        'aria-label': label,
        className: 'dsl-switch',
        'data-on': on ? 'true' : 'false',
        disabled: disabled === true,
        onClick: onToggle
      }, h('span', { className: 'dsl-thumb' }));
    }

    function Row({ title, hint, children }) {
      return h('div', { className: 'dsl-row' }, [
        h('div', { className: 'dsl-row-text', key: 'text' }, [
          h('span', { className: 'dsl-row-title', key: 't' }, title),
          h('p', { className: 'dsl-hint', key: 'h' }, hint)
        ]),
        h('div', { className: 'dsl-actions', key: 'act' }, children)
      ]);
    }

    function LiquidGlassSection({ renderSlot }) {
      return h('div', { className: 'dsl-section' }, renderSlot(ITEM_SLOT, {}));
    }

    function LiquidGlassPanel({ t }) {
      const { config: current, saveState: state, loadError: error, material, materialWhy, windowBlur } = useConfig();
      const off = !current.enabled;

      const set = useCallback((patch) => commit(patch), []);
      const onIntensity = useCallback((event) => {
        commit({ intensity: Number(event.target.value) });
      }, []);
      const onRippleSize = useCallback((event) => {
        commit({ rippleSize: Number(event.target.value) });
      }, []);
      const onFrost = useCallback((event) => {
        commit({ frost: Number(event.target.value) });
      }, []);
      const onPlateLevel = useCallback((event) => {
        commit({ plateLevel: Number(event.target.value) });
      }, []);

      // 透出桌面 is the one control whose effect is not fully in this window:
      // the material behind it is main-process-owned, so the panel reports what
      // the host found instead of pretending the switch always works. The dot
      // tracks "is this doing anything right now", which is the question a
      // user has, not "is it switched on" — that is what the toggle shows.
      //
      // Exactly one thing here says each thing, and it took a screenshot to see
      // why that matters. The hint used to append `（客户端未打补丁）` as well,
      // so a user looking at an unpatched client read the same fact three times
      // — inside the hint, on the badge, and in the notice below — and the row
      // grew to three lines with the badge floating in the middle of them.
      // The hint now states what the control does. The badge states whether it
      // is working. The notice explains the mismatch and how to fix it.
      const live = material === 'patched';
      const patchLabel = live ? t('patchReady') : material === 'stock' ? t('patchMissing') : t('patchUnknown');

      // The frost row has to display the number the theme is *using*, not the
      // number it has stored. In follow mode those are different values, and a
      // panel that showed the stored one would be displaying a frost level that
      // is not on screen — the same class of lie as a badge that always says
      // "ready". So the auto value is computed from the same function the
      // stylesheet uses, and the slider thumb rides it while the switch is on.
      const followFrost = current.frost === null;
      const autoFrost = autoFrostOf(current.intensity);
      const shownFrost = followFrost ? autoFrost : current.frost;

      // 窗口模糊 is the second control in this panel whose effect is not in this
      // window, and unlike 透出桌面 it has three distinct ways to be unavailable
      // and two distinct ways to be on-but-inert — so the row's badge answers
      // "is it working right now" and the notice only appears for the one case
      // the badge cannot explain on its own.
      //
      // The gating order matters: a stock client cannot do it at all, and that
      // subsumes 透出桌面 being off. Reporting the smaller reason first would
      // tell a user to flip a switch that still would not help.
      const blurReady = live && current.surface && current.desktop;
      const blurLive = current.windowBlur && windowBlur.active;
      // Applied but unreadable. It is not a fourth badge so much as it is a
      // refusal to pick between the two that exist: see the comment on
      // `windowBlurReport` for the measurement behind it.
      const blurUnverified = windowBlur.why === 'no-getter';
      const blurLabel = !live
        ? patchLabel
        : !current.surface || !current.desktop
          ? t('windowBlurNeedsDesktop')
          : blurLive
            ? t('windowBlurOn')
            : current.windowBlur && blurUnverified
              ? t('windowBlurUnverified')
              : current.windowBlur
                ? t('windowBlurOff')
                : t('windowBlurIdle');

      let statusText = current.enabled ? (state === 'saving' ? t('saving') : t('stateOn')) : t('stateOff');
      let footnote = t('styleHint');
      let footnoteClass = 'dsl-hint';
      if (error !== null && !hydrated) {
        footnote = t('loadError');
        footnoteClass = 'dsl-error';
      } else if (state === 'error') {
        footnote = t('saveError');
        footnoteClass = 'dsl-error';
      }

      const tintKeys = { ice: 'tintIce', slate: 'tintSlate', dusk: 'tintDusk', mono: 'tintMono' };

      return h(React.Fragment, null, [
        h('div', { className: 'dsl-card', key: 'card' }, [
          h(Row, { key: 'master', title: t('masterLabel'), hint: t('masterHint') }, [
            h('span', {
              className: 'dsl-status',
              key: 'st',
              'data-on': current.enabled ? 'true' : 'false'
            }, statusText),
            h(Toggle, {
              key: 'sw',
              on: current.enabled,
              label: t('masterLabel'),
              onToggle: () => set({ enabled: !current.enabled })
            })
          ]),
          h(Row, { key: 'surface', title: t('surfaceLabel'), hint: t('surfaceHint') }, [
            h(Toggle, {
              key: 'sw',
              on: current.surface,
              disabled: off,
              label: t('surfaceLabel'),
              onToggle: () => set({ surface: !current.surface })
            })
          ]),
          h(Row, { key: 'desktop', title: t('desktopLabel'), hint: t('desktopHint') }, [
            h('span', {
              className: 'dsl-status',
              key: 'st',
              'data-on': live && current.desktop ? 'true' : 'false'
            }, patchLabel),
            h(Toggle, {
              key: 'sw',
              on: current.desktop,
              // `surface` gates it in the stylesheet as well — a switch that is
              // on while `revealOf` returns 0 regardless would be a control that
              // lies. Disabling it here makes the dependency visible instead.
              disabled: off || !current.surface,
              label: t('desktopLabel'),
              onToggle: () => set({ desktop: !current.desktop })
            })
          ]),
          // The switch stays operable when the archive is unpatched: it is a
          // stored preference, and refusing the click would read as a second,
          // different malfunction. What it must not do is stay silent — hence a
          // full-width notice rather than another 11px badge.
          current.desktop && !live
            ? h('div', { className: 'dsl-notice', key: 'patch' }, [
              h('span', { className: 'dsl-notice-mark', key: 'mark', 'aria-hidden': 'true' }),
              h('div', { className: 'dsl-notice-text', key: 'text' }, [
                h('strong', { className: 'dsl-notice-title', key: 'title' }, t('patchNoticeTitle')),
                h('p', { className: 'dsl-notice-body', key: 'body' },
                  material === 'stock' ? t('patchNoticeStock') : t('patchNoticeUnknown')),
                // The host's own diagnosis, verbatim. Without it `unknown` is a
                // dead end — "cannot detect" cannot be acted on, because the
                // archive being in the wrong place and the archive being
                // unreadable are unrelated problems with unrelated fixes.
                materialWhy === null
                  ? null
                  : h('p', { className: 'dsl-notice-why', key: 'why' }, [
                      h('span', { className: 'dsl-notice-why-code', key: 'code' },
                        t('patchNoticeWhyLabel') + ' ' + materialWhy.why),
                      materialWhy.path === null
                        ? null
                        : h('span', { className: 'dsl-notice-why-detail', key: 'path' }, materialWhy.path),
                      materialWhy.errors === null
                        ? null
                        : h('span', { className: 'dsl-notice-why-detail', key: 'errors' }, materialWhy.errors)
                    ]),
                h('p', { className: 'dsl-notice-how', key: 'how' }, t('patchNoticeHow'))
              ])
            ])
            : null,
          h(Row, { key: 'cursor', title: t('cursorLabel'), hint: t('cursorHint') }, [
            h(Toggle, {
              key: 'sw',
              on: current.cursor,
              disabled: off,
              label: t('cursorLabel'),
              onToggle: () => set({ cursor: !current.cursor })
            })
          ]),
          h(Row, { key: 'ripple', title: t('rippleLabel'), hint: t('rippleHint') }, [
            h(Toggle, {
              key: 'sw',
              on: current.ripple,
              disabled: off,
              label: t('rippleLabel'),
              onToggle: () => set({ ripple: !current.ripple })
            })
          ]),
          // Shown as a percentage rather than the intensity row's `1.0x`, and the
          // two are deliberately not styled alike: they sit next to each other,
          // both are multipliers, and a panel that shows `1.0x` twice invites the
          // reading that they are the same control. A diameter reads as a
          // percentage; a strength reads as a multiple.
          h(Row, { key: 'rippleSize', title: t('rippleSizeLabel'), hint: t('rippleSizeHint') }, [
            h('input', {
              key: 'sl',
              className: 'dsl-slider',
              type: 'range',
              min: '0.5',
              max: '2',
              step: '0.1',
              value: String(current.rippleSize),
              disabled: off,
              'aria-label': t('rippleSizeLabel'),
              onChange: onRippleSize
            }),
            h('span', { className: 'dsl-value', key: 'v' }, `${Math.round(current.rippleSize * 100)}%`)
          ]),
          h(Row, { key: 'intensity', title: t('intensityLabel'), hint: t('intensityHint') }, [
            h('input', {
              key: 'sl',
              className: 'dsl-slider',
              type: 'range',
              min: '0.2',
              max: '2',
              step: '0.1',
              value: String(current.intensity),
              disabled: off,
              'aria-label': t('intensityLabel'),
              onChange: onIntensity
            }),
            h('span', { className: 'dsl-value', key: 'v' }, `${current.intensity.toFixed(1)}x`)
          ]),
          // 窗口模糊 leads this group because it acts on the outermost layer —
          // the desktop behind the window — and because it is the answer to
          // "where do I get a real Gaussian blur". The two rows under it act
          // progressively further inside: the theme's own backdrop, then the
          // body-copy plate. Reading order = layer order.
          //
          // The switch stays operable in every state, exactly like 透出桌面's
          // does and for the same reason: it is a stored preference, and a
          // control that refuses the click reads as a second, unrelated
          // malfunction. What it must not do is stay silent about not working —
          // the badge says which state it is in, and the notice below is
          // reserved for the one case the badge cannot explain.
          h(Row, { key: 'windowBlur', title: t('windowBlurLabel'), hint: t('windowBlurHint') }, [
            h('span', {
              className: 'dsl-status',
              key: 'st',
              'data-on': blurLive ? 'true' : 'false'
            }, blurLabel),
            h(Toggle, {
              key: 'sw',
              on: current.windowBlur,
              disabled: off,
              label: t('windowBlurLabel'),
              onToggle: () => set({ windowBlur: !current.windowBlur })
            })
          ]),
          // Only for "set up correctly and still did not take". The other two
          // failure modes are already named by the badge (未打补丁 / 需先开透出
          // 桌面), and the unpatched one is explained in full by the 透出桌面
          // notice above — a second copy of that paragraph would be the same
          // fact printed twice, which is the mistake the 透出桌面 row's own
          // comment documents. What is left is the case with no visible cause
          // from the renderer at all, and that one has to be said out loud
          // because the alternative is a switch that is on and does nothing.
          //
          // AND `no-getter` IS NOT ONE OF THOSE CASES. It used to be, and that
          // was wrong in a way air paid for: this build never has a getter, so
          // the condition was true on every single frame the switch was on, and
          // the panel showed a permanent yellow warning over a feature that was
          // working. A warning that cannot go away carries no information — it
          // teaches the reader to ignore warnings. The fact itself is real, but
          // it belongs in the row's own copy (see `windowBlurUnverified`), which
          // is where a permanent property of the build is described. What is
          // left here is failure: the request went out and the window did not
          // take it, which is a thing to act on.
          current.windowBlur && blurReady && !windowBlur.active && !blurUnverified
            ? h('div', { className: 'dsl-notice', key: 'blur' }, [
              h('span', { className: 'dsl-notice-mark', key: 'mark', 'aria-hidden': 'true' }),
              h('div', { className: 'dsl-notice-text', key: 'text' }, [
                h('strong', { className: 'dsl-notice-title', key: 'title' },
                  t('windowBlurNoticeTitle')),
                h('p', { className: 'dsl-notice-body', key: 'body' },
                  t('windowBlurNoticeBody')),
                windowBlur.why === null
                  ? null
                  : h('p', { className: 'dsl-notice-why', key: 'why' },
                      h('span', { className: 'dsl-notice-why-code', key: 'code' },
                        t('windowBlurNoticeWhyLabel') + ' ' + windowBlur.why))
              ])
            ])
            : null,
          // The frost pair, in the order you ask about them: how much blur, then
          // whether you set it yourself. The switch
          // is the "auto" state rather than a separate feature — that is why it
          // sits above the slider it governs instead of beside it, and why the
          // slider is *disabled* rather than hidden while it is on: the thumb
          // riding the intensity slider is the clearest possible statement of
          // what "跟随强度" means.
          h(Row, { key: 'frostFollow', title: t('frostFollowLabel'), hint: t('frostFollowHint') }, [
            h(Toggle, {
              key: 'sw',
              on: followFrost,
              disabled: off,
              label: t('frostFollowLabel'),
              // Turning follow off pins the number that is on screen right now,
              // so nothing jumps at the moment the control changes hands. A
              // naive `frost: 0` would snap the window from frosted to sharp,
              // which reads as a malfunction rather than as a setting.
              onToggle: () => set({ frost: followFrost ? autoFrost : null })
            })
          ]),
          h(Row, { key: 'frost', title: t('frostLabel'), hint: t('frostHint') }, [
            h('input', {
              key: 'sl',
              className: 'dsl-slider',
              type: 'range',
              min: '0',
              max: String(FROST_MAX),
              step: '1',
              value: String(shownFrost),
              disabled: off || followFrost,
              'aria-label': t('frostLabel'),
              onChange: onFrost
            }),
            h('span', { className: 'dsl-value', key: 'v', 'data-auto': followFrost ? 'true' : 'false' },
              followFrost ? `${shownFrost}px ${t('frostAuto')}` : `${shownFrost}px`)
          ]),
          // 对话辨识 comes FIRST, before the plate it governs, because it is the
          // question a reader actually has ("how do I tell who is talking") and
          // the plate is only one of the two answers. Putting the mode below the
          // plate would present the plate as the feature and the mode as a
          // setting on it, which is backwards.
          h(Row, { key: 'plateSide', title: t('plateSideLabel'), hint: t('plateSideHint') },
            h('div', { className: 'dsl-modes', role: 'radiogroup', 'aria-label': t('plateSideLabel') },
              PLATE_SIDE_VIEW.map(({ id, label }) => h('button', {
                type: 'button',
                key: id,
                className: 'dsl-mode',
                role: 'radio',
                'aria-checked': current.plateSide === id ? 'true' : 'false',
                'data-active': current.plateSide === id ? 'true' : 'false',
                disabled: off || !current.surface,
                onClick: () => set({ plateSide: id })
              }, t(label))))),
          // The plate switch and its level are disabled — not hidden — while a
          // mode that does not use plates is selected. Hiding them would move
          // every control below by their height the moment the user clicks a
          // mode, which is the same "the panel jumped" defect the layout section
          // already documents; disabling them states the relationship without
          // moving anything.
          h(Row, { key: 'plate', title: t('plateLabel'), hint: t('plateHint') }, [
            h(Toggle, {
              key: 'sw',
              on: current.plate,
              disabled: off || current.plateSide !== 'side',
              label: t('plateLabel'),
              onToggle: () => set({ plate: !current.plate })
            })
          ]),
          h(Row, { key: 'plateLevel', title: t('plateLevelLabel'), hint: t('plateLevelHint') }, [
            h('input', {
              key: 'sl',
              className: 'dsl-slider',
              type: 'range',
              min: '0',
              max: String(PLATE_MAX),
              step: '0.05',
              value: String(current.plateLevel),
              disabled: off || !current.plate || current.plateSide !== 'side',
              'aria-label': t('plateLevelLabel'),
              onChange: onPlateLevel
            }),
            h('span', { className: 'dsl-value', key: 'v' }, `${Math.round(current.plateLevel * 100)}%`)
          ]),
          h(Row, { key: 'tint', title: t('tintLabel'), hint: t('tintHint') },
            h('div', { className: 'dsl-tints' }, TINT_IDS.map((id) => {
              // The swatch shows the backdrop and the accent, because those are
              // now the only two things a preset actually decides. It used to
              // show the four blobs, which is exactly the thing that made this
              // theme look like a colour picker rather than a material.
              const pre = [TINTS[id].dark.shell, TINTS[id].dark.lights[0], TINTS[id].dark.accent];
              return h('button', {
                type: 'button',
                key: id,
                className: 'dsl-tint',
                'data-active': current.tint === id ? 'true' : 'false',
                'aria-pressed': current.tint === id,
                disabled: off,
                onClick: () => set({ tint: id })
              }, [
                h('span', { className: 'dsl-swatch', key: 'sw' },
                  pre.map((color, i) => h('i', { key: i, style: { background: color } }))),
                h('span', { key: 'lb' }, t(tintKeys[id]))
              ]);
            })))
        ]),
        h('div', { className: 'dsl-foot', key: 'foot' }, [
          h('p', { className: footnoteClass, key: 'fn' }, footnote),
          h('button', {
            type: 'button',
            key: 'rs',
            className: 'dsl-reset',
            onClick: () => commit({ ...DEFAULT_CONFIG })
          }, t('reset'))
        ])
      ]);
    }

    // -----------------------------------------------------------------------
    // Plugin entry
    // -----------------------------------------------------------------------

    const inject = ['slots', 'locale'];

    function apply(ctx) {
      ensureSectionStyles();

      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'liquid-glass: dictionaries');
      const t = ctx.locale.bind(NS);

      ctx.effect(() => {
        applyTheme();
        // The wallpaper is a single layer whose gradient is scheme-specific, so
        // a light/dark flip has to repaint it. Watching the attribute is cheaper
        // and far more reliable than listening for whatever toggles the theme.
        const observer = new MutationObserver(() => {
          const el = document.getElementById(WALLPAPER_ID);
          if (el !== null) delete el.dataset.signature;
          paintWallpaper();
        });
        observer.observe(document.body, {
          attributes: true,
          attributeFilter: ['data-ds-dark-theme']
        });
        return () => {
          observer.disconnect();
          const tag = document.getElementById(STYLE_ID);
          if (tag !== null) tag.remove();
          dropWallpaper();
          dropLiquidDefs();
        };
      }, 'liquid-glass: theme sheet');

      ctx.effect(() => installRipples(), 'liquid-glass: click ripples');

      ctx.slots.inject(SECTION_SLOT, () =>
        ctx.slots.register({
          name: SECTION_SLOT,
          id: 'liquid-glass',
          order: 42,
          label: () => t('nav'),
          locale: NS,
          children: { [ITEM_SLOT]: { kind: 'list', scope: 'root' } }
        }, LiquidGlassSection)
      );

      ctx.slots.inject(ITEM_SLOT, () =>
        ctx.slots.register({
          name: ITEM_SLOT,
          id: 'panel',
          order: 0,
          locale: NS
        }, LiquidGlassPanel)
      );

      void loadFromHost();
    }

    // Apply the mirrored config synchronously so the theme is on before the
    // first paint of this bundle — otherwise the stock look flashes. The
    // material report is mirrored for the same reason: without it, every launch
    // with 透出桌面 on would paint one opaque frame and then open the window.
    const cached = readCache();
    if (cached !== null) config = cached;
    windowMaterial = readMaterialCache();
    // Same reasoning, one level further out: the switch's own state is in the
    // cached config, but whether it *took* is not, so the panel would show the
    // switch on and the badge contradictory for the first frames.
    windowBlurReport = readWindowBlurCache();
    try {
      ensureSectionStyles();
      applyTheme();
    } catch (error) {
      console.warn('[liquid-glass] failed to apply the cached theme:', error);
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});

