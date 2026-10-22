/**
 * air-pixel-liquid-glass — host half.
 *
 * The whole theme lives in `./client.js`: it runs inside the Web GUI renderer,
 * where it injects the stylesheet, swaps the cursors and drives the click
 * ripples. This host half exists for two reasons:
 *
 *  1. Durable storage. Anything the user picks in the settings panel (on/off,
 *     tint, intensity …) has to survive a restart and be shared by every GUI
 *     window connected to this Harness instance, so it is persisted here rather
 *     than kept in the renderer's localStorage alone. The renderer mirrors the
 *     same document into localStorage only so the theme can be applied before
 *     the first paint of the next launch.
 *  2. Reporting whether the client was patched for window transparency. See
 *     "Window-material detection" below — this is the one fact about the app
 *     that lives outside the renderer, and 透出桌面 is unusable without it.
 *  3. Forwarding the one setting that is not CSS. 窗口模糊 is
 *     `win.setBackgroundMaterial("acrylic")` on the shell window — an API that
 *     exists only in the main process, which this half is NOT (measured:
 *     `require("electron")` fails here). So this half writes the request to a
 *     file in the install's resources directory and the patched main process
 *     applies it and writes a report back. See `applyWindowBlur`.
 *
 * Storage: `~/.dsh/plugins/air-pixel-liquid-glass/config.json`
 * (`$DSH_HOME` wins over `~/.dsh`, same precedence the harness-home package uses).
 *
 * HTTP surface (registered on the Harness web server):
 *   GET  /api/theme-liquid-glass/config  -> ThemeConfig & { material, windowBlurReport }
 *   POST /api/theme-liquid-glass/config  <- Partial<ThemeConfig>
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

export const name = 'air-pixel-liquid-glass';

/** The Harness web server is the only service this half needs. */
export const inject = ['webServer'];

const PLUGIN_ID = 'air-pixel-liquid-glass';
const ROUTE = '/api/theme-liquid-glass/config';

/** Largest accepted request body. The payload is a handful of scalars. */
const MAX_BODY_BYTES = 64 * 1024;

/** Tint presets baked into the stylesheet. Keep in sync with TINTS in client.js. */
const TINTS = ['ice', 'slate', 'dusk', 'mono'];

/**
 * Preset ids that existed in an earlier version, and where they went. Mirrors
 * `TINT_ALIASES` in client.js.
 *
 * This list said `aurora` for a while after the client renamed that preset to
 * `slate`, so the host kept persisting an id the renderer had to translate on
 * every read. Harmless while both halves agree — and a silent reset of the
 * user's preset the moment the client drops the alias.
 */
const TINT_ALIASES = { aurora: 'slate' };

/** Shipped defaults — also the fallback for any unreadable or partial config. */
export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  surface: true,
  cursor: true,
  desktop: false,
  ripple: true,
  intensity: 1,
  /** Multiplier on the ripple's diameter, 0.5 … 2. */
  rippleSize: 1,
  /**
   * Frost in CSS px, or `null` for "follow the intensity curve".
   *
   * `null` is a value, not a missing one, and it is what makes this control
   * additive: the theme behaves exactly as it did before the key existed until
   * the user drags the slider. Nothing in this file needs to know the curve —
   * the renderer owns it — so the host only has to preserve the distinction
   * between "follow" and "a number".
   */
  frost: null,
  /**
   * Ask DWM to draw a blurred copy of the desktop behind the window.
   *
   * This is the only setting in this document that the renderer cannot apply
   * itself, and that is the whole reason the host half exists beyond storage:
   * `backgroundMaterial` belongs to the BrowserWindow, which lives in this
   * process. The renderer stores the preference and reads the result back; this
   * half is what actually calls `setBackgroundMaterial`.
   *
   * Applied at runtime rather than at patch time, and measured working before it
   * was wired here: `tools/materialprobe.py`'s `switch` recipe creates a window
   * with `none` and flips it to `acrylic` while it is on screen, and the capture
   * comes back blurred (0.010 / luma 100.0) exactly like a window created with
   * `acrylic` (0.011 / 100.0) rather than sharp like `none` (0.875 / 129.0). So
   * the choice costs a click instead of a re-patch and a restart.
   *
   * Default false — see the renderer's own note. `asarpatch.py` deliberately
   * installs `none` for the same reason: a blurred desktop that arrives whether
   * or not it was asked for is what air rejected twice.
   */
  windowBlur: false,
  /** Per-message plate switch; see `plateLevel` for the strength. */
  plate: false,
  plateLevel: 0.5,
  tint: 'ice'
});

function resolveStoreDir() {
  let home = '';
  try {
    const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : '';
    home = fromEnv.length > 0 ? fromEnv : path.join(os.homedir(), '.dsh');
  } catch {
    home = '';
  }
  return path.join(home.length > 0 ? home : os.tmpdir(), 'plugins', PLUGIN_ID);
}

const STORE_DIR = resolveStoreDir();
const CONFIG_FILE = path.join(STORE_DIR, 'config.json');

/** In-memory mirror; always a valid, normalized document. */
let currentConfig = { ...DEFAULT_CONFIG };

/** Coerce a stored value onto the defaults. Unknown keys are dropped. */
function normalizeConfig(raw) {
  const next = { ...DEFAULT_CONFIG };
  if (raw === null || typeof raw !== 'object') return next;

  for (const key of ['enabled', 'surface', 'cursor', 'desktop', 'ripple', 'plate', 'windowBlur']) {
    if (typeof raw[key] === 'boolean') next[key] = raw[key];
  }
  if (typeof raw.intensity === 'number' && Number.isFinite(raw.intensity)) {
    // Clamp instead of reject: a slider that drifted out of range should not
    // be able to wedge the theme into an unusable state.
    next.intensity = Math.min(2, Math.max(0.2, Math.round(raw.intensity * 10) / 10));
  }
  if (typeof raw.rippleSize === 'number' && Number.isFinite(raw.rippleSize)) {
    // Same shape of clamp as `intensity`, same reason. Kept in step with the
    // renderer's copy in `normalizeDocument` — the two are separate
    // implementations on purpose (they run in different processes) and the
    // previous pair drifted, which showed up as a visible flicker on launch.
    next.rippleSize = Math.min(2, Math.max(0.5, Math.round(raw.rippleSize * 10) / 10));
  }
  // A `null` test rather than a typeof test, because `null` is the meaningful
  // value here and the spread above only supplies it by coincidence. Keeping
  // the two apart matters more than usual in this pair of functions: the host
  // is the durable copy, so folding "follow" into "a number" here would make the
  // renderer's follow state un-restorable after a restart.
  if (raw.frost === null) {
    next.frost = null;
  } else if (typeof raw.frost === 'number' && Number.isFinite(raw.frost)) {
    next.frost = Math.min(40, Math.max(0, Math.round(raw.frost)));
  }
  if (typeof raw.plateLevel === 'number' && Number.isFinite(raw.plateLevel)) {
    // 0.85, and it has to be the same number as the renderer's `PLATE_MAX`:
    // the ceiling air asked for after 0.6, because at the top the plate is
    // meant to read as a panel rather than as a wash. The two clamps are
    // separate implementations on purpose (different processes), and a pair
    // that drifted already showed up as a value flickering on launch.
    next.plateLevel = Math.min(0.85, Math.max(0, Math.round(raw.plateLevel * 100) / 100));
  }
  if (typeof raw.tint === 'string') {
    const id = TINT_ALIASES[raw.tint] ?? raw.tint;
    if (TINTS.includes(id)) next.tint = id;
  }

  return next;
}

function readConfigFile() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return { ...DEFAULT_CONFIG };
    return normalizeConfig(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')));
  } catch (error) {
    console.warn('[liquid-glass] failed to read config, using defaults:', error?.message ?? error);
    return { ...DEFAULT_CONFIG };
  }
}

/** Write through a temp file + rename so a crash mid-write cannot truncate it. */
function writeConfigFile() {
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    const temp = `${CONFIG_FILE}.tmp-${process.pid}`;
    fs.writeFileSync(temp, `${JSON.stringify(currentConfig, null, 2)}\n`, 'utf-8');
    fs.renameSync(temp, CONFIG_FILE);
    return true;
  } catch (error) {
    console.warn('[liquid-glass] failed to write config:', error?.message ?? error);
    return false;
  }
}

currentConfig = readConfigFile();

// ---------------------------------------------------------------------------
// Window-material detection
// ---------------------------------------------------------------------------
//
// The window's backdrop is a main-process option with no renderer-visible
// counterpart: from inside the page there is no way to ask "is the window base
// actually open behind me, or am I painting onto Electron's default white".
// That matters, because the two cases look identical while the theme is opaque
// and are *opposites* once 透出桌面 opens the window base — one shows the
// desktop, the other shows a blank surface that is worse than the shell it
// replaced.
//
// This half runs in the node process with fs access, so it can just look at the
// archive the app is actually running from. The marker it looks for is the
// comment line `tools/asarpatch.py` inserts and nothing else in the archive
// contains, so the answer is about *this* patch rather than about the string
// `acrylic`, which already appears in the shipped file's welcome-window branch.
// That marker now also names the material the patch asked for, which is the
// difference between "patched" and "patched so the desktop is not blurred";
// this scan deliberately matches the prefix, so every variant answers yes here
// and the material itself stays a fact `asarpatch.py --check` reports.
//
// The probe is also self-maintaining: the updater replaces resources/app.asar
// wholesale, so after an auto-update this quietly goes back to 'stock' and the
// switch stops doing anything instead of breaking the window.

/**
 * Inserted by tools/asarpatch.py; the prefix of every variant of that patch.
 *
 * Matched as a prefix on purpose: the marker itself now carries the material
 * (`…(material: none)`), and this scan's only question is whether *a* patch is
 * present. Reporting which material is installed is `asarpatch.py --check`'s
 * job, where it can also say what to do about it.
 */
const PATCH_MARKER = 'air-pixel-liquid-glass: the recipe';

/**
 * Every prefix a patch has ever written, current first.
 *
 * The plugin was renamed from `dsh-theme-liquid-glass`, and `tools/asarpatch.py`
 * kept the old prefix in `LEGACY_MARKER_PREFIXES` so an archive patched before
 * the rename is still recognised (and revertable). This half has to accept the
 * same set: scanning for the new prefix alone reported `stock` against an
 * archive the renamed tool had just patched — the switch then refused to work
 * while the window was, in fact, already transparent.
 */
const PATCH_MARKERS = [PATCH_MARKER, 'dsh-theme-liquid-glass: the recipe'];
const SCAN_CHUNK = 4 * 1024 * 1024;

/** Where tools/asarpatch.py records the archive it patched. */
const POINTER_FILE = path.join(STORE_DIR, 'asar-pointer.json');

/**
 * The path tools/asarpatch.py patched, or '' if it never wrote one.
 *
 * Treated as a hint, never as the answer: the caller still has to find the
 * marker inside whatever comes back. A pointer that outlived its archive (an
 * auto-update replaces `resources/app.asar` wholesale) resolves to nothing and
 * costs one failed probe — which is the correct outcome, because the answer
 * would be `stock` anyway.
 */
function readAsarPointer() {
  try {
    if (!fs.existsSync(POINTER_FILE)) return '';
    const parsed = JSON.parse(fs.readFileSync(POINTER_FILE, 'utf-8'));
    return typeof parsed?.asar === 'string' ? parsed.asar : '';
  } catch {
    // A corrupt pointer must not take the derived paths down with it — those may
    // well succeed, so this returns '' and lets the walk carry on.
    return '';
  }
}

/** First existing candidate wins. A dev checkout simply finds none. */
function resolveAsarPath() {
  return resolveAsarPathDetailed().file;
}

/**
 * Every candidate, in the order they were tried, with why each was rejected.
 *
 * Returned as a list rather than a single value because the one failure that
 * actually happened was opaque: both obvious candidates missed, and the panel
 * could only say `unknown`, so there was no way to tell "wrong path" from
 * "found it but could not read it". That distinction is what the `materialWhy`
 * field on the route response now carries.
 *
 * @returns {{ file: string|null, tried: Array<{ path: string, why: string }> }}
 */
function resolveAsarPathDetailed() {
  const tried = [];
  const seen = new Set();

  const consider = (candidate) => {
    if (typeof candidate !== 'string') return false;
    const trimmed = candidate.trim();
    if (trimmed === '') return false;
    let key;
    try {
      key = path.resolve(trimmed);
    } catch {
      key = trimmed;
    }
    if (seen.has(key)) return false;
    seen.add(key);
    try {
      if (fs.existsSync(trimmed)) {
        tried.push({ path: trimmed, why: 'exists' });
        return true;
      }
      tried.push({ path: trimmed, why: 'missing' });
    } catch (error) {
      tried.push({ path: trimmed, why: `unreadable: ${error?.code ?? 'unknown'}` });
    }
    return false;
  };

  // 1. An explicit override always wins. This is how a relocated install gets
  //    pointed at without a rebuild.
  const override = typeof process.env.DSH_ASAR === 'string' ? process.env.DSH_ASAR.trim() : '';
  if (consider(override)) return { file: override, tried };

  // 2. The pointer file, written by tools/asarpatch.py when it patches.
  //
  //    This is the only candidate known to be readable from this process no
  //    matter how the harness was launched: it lives beside the config this
  //    half has been reading and rewriting all along. Tried before the derived
  //    paths because it is a recorded fact rather than an inference — but still
  //    only a candidate, because the marker scan decides the answer either way.
  const pointer = readAsarPointer();
  if (consider(pointer)) return { file: pointer, tried };

  // 3. `resources/app.asar`, resolved by walking up from every root that could
  //    plausibly sit inside or beside the install.
  //
  //    process.resourcesPath covers the ordinary Electron case. It is not
  //    enough on its own: the harness loads plugins into its own node-side
  //    process, and there `resourcesPath` does not exist while `execPath`
  //    points into the runtime's bundled node — neither of the two original
  //    candidates would name the install directory at all. Measured on this
  //    machine: from such a process both originals miss and say nothing, while
  //    the archive sits there fully patched the whole time.
  const roots = [];
  const addRoot = (value) => {
    if (typeof value === 'string' && value.trim() !== '' && !roots.includes(value)) {
      roots.push(value);
    }
  };
  addRoot(typeof process.resourcesPath === 'string' ? process.resourcesPath : '');
  if (typeof process.execPath === 'string' && process.execPath !== '') {
    addRoot(path.dirname(process.execPath));
  }
  try {
    addRoot(process.cwd());
  } catch {
    /* cwd throws if the directory was removed under us */
  }

  for (const root of roots) {
    let dir = path.resolve(root);
    // Bounded at five levels: that covers <install>/resources, <install>, and a
    // couple of symlink hops, while stopping a malformed root from walking to
    // the drive root probing hundreds of directories.
    for (let level = 0; level < 5; level += 1) {
      const withResources = path.join(dir, 'resources', 'app.asar');
      if (consider(withResources)) return { file: withResources, tried };
      const direct = path.join(dir, 'app.asar');
      if (consider(direct)) return { file: direct, tried };
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  return { file: null, tried };
}

/**
 * An `fs` whose open/read calls reach the archive as a plain file.
 *
 * The harness patches Node's `fs` the way Electron does, so a `.asar` path is
 * treated as a *virtual directory* rather than as a file. `fs.existsSync` still
 * answers (it stats the same path, and a stat of the archive succeeds), but
 * `fs.openSync` is one of the calls Electron rewrites to unpack the target into
 * a temp file first — and asking it to unpack the archive itself cannot work.
 * That asymmetry is exactly what the panel reported: path resolved, `exists`,
 * and then `scan-failed`.
 *
 * Official docs (ASAR Archives → "Treating an ASAR Archive as a Normal File")
 * name two supported doors, both tried here:
 *
 *   1. `original-fs` — the built-in module that ships the same fs APIs *without*
 *      asar support. Preferred, because it is local to this call: nothing else
 *      in the process can observe it.
 *   2. `process.noAsar = true` — a process-wide switch. It is flipped only for
 *      the duration of one synchronous scan and restored in a `finally`, so no
 *      other module can ever run while it is on.
 *
 * Plain Node has neither, and does not need them: `require('original-fs')`
 * throws, the resolver returns null, and the unmodified `fs` is used.
 */
let rawFsResolved = false;
let rawFsModule = null;

function originalFs() {
  if (rawFsResolved) return rawFsModule;
  rawFsResolved = true;
  try {
    const require_ = createRequire(import.meta.url);
    rawFsModule = require_('original-fs');
  } catch {
    // Not Electron, or the module is gone. Either way `fs` is already the plain
    // one and there is nothing to work around.
    rawFsModule = null;
  }
  return rawFsModule ?? null;
}

/**
 * Each way of reaching the archive, best first. Each entry arms itself and
 * returns the function that puts the process back the way it found it.
 *
 * @returns {Array<{ label: string, io: typeof fs, arm: null | (() => () => void) }>}
 */
function archiveReaders() {
  const readers = [];
  const raw = originalFs();
  if (raw !== null && typeof raw.openSync === 'function') {
    readers.push({ label: 'original-fs', io: raw, arm: null });
  }
  readers.push({
    label: 'noAsar',
    io: fs,
    arm: () => {
      // `delete` rather than assigning undefined: on plain Node the property
      // does not exist at all, and leaving a stray `noAsar: undefined` behind
      // would be a small, permanent change to the process it was told to leave
      // alone.
      const had = Object.prototype.hasOwnProperty.call(process, 'noAsar');
      const before = had ? process.noAsar : undefined;
      process.noAsar = true;
      return () => {
        if (had) process.noAsar = before;
        else delete process.noAsar;
      };
    }
  });
  return readers;
}

/**
 * Streaming substring search with one particular fs.
 *
 * Chunked rather than `readFileSync` because the archive is 121 MB and this
 * runs at plugin load; the tail of each chunk is carried into the next read so
 * a marker straddling a boundary is still found.
 *
 * `marker` may be a list — see `PATCH_MARKERS`. One pass answers for all of
 * them, so accepting the legacy prefix costs no extra read of the archive.
 *
 * @returns {{ found: boolean|null, error: { code: string, syscall: string }|null }}
 */
function scanWith(io, file, marker) {
  let fd = null;
  try {
    if (typeof io.openSync !== 'function') {
      return { found: null, error: { code: 'ENOSYS', syscall: 'openSync' } };
    }
    fd = io.openSync(file, 'r');
    const wanted = Array.isArray(marker) ? marker : [marker];
    const needles = wanted
      .filter((entry) => typeof entry === 'string' && entry !== '')
      .map((entry) => Buffer.from(entry, 'utf8'));
    if (needles.length === 0) return { found: false, error: null };
    const longest = needles.reduce((max, needle) => Math.max(max, needle.length), 0);
    const buf = Buffer.alloc(SCAN_CHUNK + longest);
    let carry = 0;
    let at = 0;
    for (;;) {
      const read = io.readSync(fd, buf, carry, SCAN_CHUNK, at);
      if (read <= 0) return { found: false, error: null };
      const total = carry + read;
      const window = buf.subarray(0, total);
      if (needles.some((needle) => window.indexOf(needle) !== -1)) {
        return { found: true, error: null };
      }
      carry = Math.min(longest - 1, total);
      buf.copy(buf, 0, total - carry, total);
      at += read;
    }
  } catch (error) {
    return {
      found: null,
      error: {
        code: typeof error?.code === 'string' ? error.code : (error?.name ?? 'ERROR'),
        syscall: typeof error?.syscall === 'string' ? error.syscall : 'openSync'
      }
    };
  } finally {
    if (fd !== null) {
      try {
        io.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}

/**
 * What kind of host this is, gathered only when the scan fails.
 *
 * `scan-failed` on a path that `existsSync` calls present is a specific and
 * confusing shape, so two facts are collected to name it outright:
 *
 *   · `noAsar` — whether the process carries the `process.noAsar` switch that
 *     only an asar-patched runtime defines at all.
 *   · `listsAsDirectory` — the archive path read through `fs.readdirSync`. A
 *     plain Node process gets `ENOTDIR` (it is a file). An asar-patched one gets
 *     an array of the archive's own members, because it is pretending the
 *     archive is a folder. That single call separates the two cases, and it is
 *     the check that would have turned this whole investigation into one line.
 *
 * @returns {{ electron: string|null, noAsar: boolean, listsAsDirectory: boolean|null }}
 */
function hostFacts(file) {
  let listsAsDirectory = null;
  if (typeof file === 'string') {
    try {
      listsAsDirectory = Array.isArray(fs.readdirSync(file));
    } catch {
      listsAsDirectory = false;
    }
  }
  return {
    electron: typeof process.versions?.electron === 'string' ? process.versions.electron : null,
    noAsar: Object.prototype.hasOwnProperty.call(process, 'noAsar'),
    listsAsDirectory
  };
}

/**
 * Try each reader until one returns an answer rather than an error.
 *
 * A reader that throws is not a failure of the *question* — it is a failure of
 * one way of asking it — so the next one gets a turn before the answer becomes
 * `unknown`. The attempts are kept so the response can say which doors were
 * tried and why each closed.
 *
 * @returns {{ found: boolean|null, via: string|null, attempts: Array<object> }}
 */
function scanForMarkerDetailed(file, marker) {
  const attempts = [];
  for (const reader of archiveReaders()) {
    let disarm = null;
    try {
      if (typeof reader.arm === 'function') disarm = reader.arm();
      const result = scanWith(reader.io, file, marker);
      if (result.error === null) {
        return { found: result.found, via: reader.label, attempts };
      }
      attempts.push({ via: reader.label, code: result.error.code, syscall: result.error.syscall });
    } catch (error) {
      attempts.push({
        via: reader.label,
        code: typeof error?.code === 'string' ? error.code : 'ERROR',
        syscall: 'arm'
      });
    } finally {
      if (disarm !== null) disarm();
    }
  }
  return { found: null, via: null, attempts };
}

/**
 * @returns {boolean|null} true/false, or null when every reader failed.
 */
function scanForMarker(file, marker) {
  return scanForMarkerDetailed(file, marker).found;
}

/**
 * Mirrors MATERIAL_STATES in client.js. Never throws; unknown is the floor.
 *
 * The result is memoised together with its diagnosis, because the archive is
 * 121 MB and the route is polled by every open window. `why` is what turns a
 * dead switch into a solvable problem: without it, `unknown` covered both
 * "the archive is somewhere else" and "the archive is there but unreadable",
 * and the two need completely different fixes.
 */
let materialCache = null;
let diagnosisCache = null;
function detectWindowMaterialDetailed() {
  if (materialCache !== null) {
    return { material: materialCache, ...diagnosisCache };
  }

  const { file, tried } = resolveAsarPathDetailed();
  if (file === null) {
    materialCache = 'unknown';
    diagnosisCache = {
      materialPath: null,
      materialWhy: 'no-candidate-found',
      materialScanVia: null,
      materialScanError: null,
      materialHost: null,
      materialTried: tried
    };
    return { material: materialCache, ...diagnosisCache };
  }

  const scan = scanForMarkerDetailed(file, PATCH_MARKERS);
  materialCache = scan.found === null ? 'unknown' : scan.found ? 'patched' : 'stock';
  diagnosisCache = {
    materialPath: file,
    materialWhy: scan.found === null ? 'scan-failed' : scan.found ? 'marker-found' : 'marker-absent',
    // Which door worked, and — when none did — what each one said. Both are only
    // interesting in the failure cases, and the failure case is the entire
    // reason this field exists: "the path resolves, existsSync agrees, and the
    // open still throws" is unguessable from the outside.
    materialScanVia: scan.via,
    materialScanError: scan.attempts.length === 0 ? null : scan.attempts,
    materialHost: scan.found === null ? hostFacts(file) : null,
    materialTried: tried
  };
  return { material: materialCache, ...diagnosisCache };
}

function detectWindowMaterial() {
  return detectWindowMaterialDetailed().material;
}

/** Shared response preamble. Returns true when a preflight was already answered. */
function prepareResponse(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return true;
  }
  return false;
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    let body = '';
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        done({ error: 'request body too large', statusCode: 413 });
        req.resume();
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (settled) return;
      try {
        const parsed = JSON.parse(body || '{}');
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          done({ error: 'request body must be a JSON object', statusCode: 400 });
          return;
        }
        done({ value: parsed });
      } catch {
        done({ error: 'invalid JSON', statusCode: 400 });
      }
    });
    req.on('error', () => done({ error: 'request body could not be read', statusCode: 400 }));
  });
}

/**
 * The materials this control can ask for, and the only two that were measured.
 *
 * `acrylic` is the blurred one (0.011 edge energy through the window / luma
 * 100), `auto` is the desktop itself (0.875 / 129). Electron also accepts
 * `mica` and `tabbed`, and neither is offered here because neither has been
 * measured on this machine through this probe — and a material this file cannot
 * describe is a material whose failure the panel cannot explain either.
 *
 * OFF IS `auto`, AND IT IS NOT `none`. This looks like the same string choice
 * the archive makes and it is not: the archive picks its material once, at
 * window creation, where `none` is correct. This half asks for a change at
 * RUNTIME, on a window that already carries a material, and there `none` is a
 * trap — measured on Electron 44 / win32, `setBackgroundMaterial("none")` on a
 * live acrylic window turns it into an opaque white surface (probe `unswitch`:
 * edge ratio 0.025, luma 254.9) instead of taking the material away. `auto`
 * does take it away (0.875 / 129.0, identical to a window created with `none`).
 * air's report — 关掉窗口模糊后整个界面变成纯白色 — is that trap firing.
 *
 * Keep in step with `lgMaterials` in tools/asarpatch.py's watcher: the two
 * halves have to agree on what OFF means, or the panel asks for one thing and
 * the main process applies another.
 */
const WINDOW_MATERIALS = { on: 'acrylic', off: 'auto' };

/**
 * Where the main-process half of this control lives, and how it is reached.
 *
 * THE HOST CANNOT CALL ELECTRON. This half runs in the harness' plain node
 * process — measured on the real machine: `require("electron")` fails there,
 * and the panel honestly reported `no-electron` over a switch that was on.
 * `setBackgroundMaterial` exists only in the main process, and the one channel
 * to it this project owns is a patched `lib/main.js` (tools/asarpatch.py, which
 * appends a watcher alongside the transparency recipe). So the request travels
 * through a file:
 *
 *   this half writes  <resources>/liquid-glass-window-material.json
 *   the watcher applies it to the largest visible window and writes
 *                     <resources>/liquid-glass-window-report.json
 *   this half reads the report back
 *
 * Both halves name the directory the archive itself lives in — the host via
 * `resourcesDir()` below, the watcher via `process.resourcesPath` — so neither
 * has to guess where the other is.
 *
 * The materials are the same two `WINDOW_MATERIALS` already declares below:
 * `on` is the blurred one, `off` the sharp one.
 */
const WINDOW_BLUR_FILES = {
  wanted: 'liquid-glass-window-material.json',
  report: 'liquid-glass-window-report.json'
};

/**
 * How long one request will hold open waiting for the main process to answer.
 *
 * The watcher answers in single-digit milliseconds (a directory watch plus one
 * setter call), so the wait is what an UNPATCHED main process costs, not what
 * a patched one does. It is paid at most once per material change — see
 * `windowBlurState.gaveUp`.
 */
const WINDOW_BLUR_WAIT_MS = 900;
const WINDOW_BLUR_POLL_MS = 50;

/** Where the archive — and therefore the watcher's two files — live. */
function resourcesDir() {
  const resolved = resolveAsarPathDetailed();
  if (resolved.file === null) return null;
  return path.dirname(resolved.file);
}

/**
 * One request's position in the file protocol.
 *
 * `seq` exists because a report that does not say WHICH request it answered is
 * indistinguishable from a stale one: the report file survives restarts, and a
 * host that trusted any report it found would show 已生效 for a window the new
 * session never touched. `writtenMaterial` is what makes the write lazy — this
 * runs on every config read, and rewriting the same request would make the
 * watcher work on every panel poll. `gaveUp` is the unpatched-main memo: after
 * one full wait with no receipt, later requests read once and answer instead
 * of paying the deadline again. It resets the moment the material changes,
 * because that is the moment a working watcher has something new to say.
 *
 * `seeded` closes a hole in that first sentence. Counting from 0 in every
 * process means a new session's first request is `1` — which is also the
 * number the previous session's report is carrying, because the report file
 * survives restarts and most sessions only ever issue one. So the guard
 * against a stale report was defeated by the one event that makes reports
 * stale. The first request of a session is numbered above whatever the report
 * on disk already answered.
 */
const windowBlurState = { seq: 0, writtenMaterial: null, gaveUp: false, seeded: false };

/** Bounded synchronous-free pause between report polls. */
const windowBlurWait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Apply `windowBlur` through the file protocol and report what actually
 * happened.
 *
 * The report is a READBACK, not an echo — but the readback now happens in
 * another process, so "what actually happened" arrives as a report that must
 * name THIS request's `seq` before it is believed. Every failure path names
 * itself (`no-archive` / `write-failed` / `no-report` / and whatever the
 * watcher reported: `no-window` / `set-failed` / `no-getter` /
 * `material-not-applied`), so the renderer can show a reason instead of a
 * switch that is on and does nothing.
 *
 * @param {boolean} desired
 * @returns {Promise<{ active: boolean, why: string|null, material: string|null }>}
 */
async function applyWindowBlur(desired) {
  const material = desired === true ? WINDOW_MATERIALS.on : WINDOW_MATERIALS.off;
  const failed = (why) => ({ active: false, why, material: null });

  const dir = resourcesDir();
  if (dir === null) return failed('no-archive');

  if (!windowBlurState.seeded) {
    windowBlurState.seeded = true;
    try {
      const carried = JSON.parse(fs.readFileSync(path.join(dir, WINDOW_BLUR_FILES.report), 'utf8'));
      if (typeof carried?.seq === 'number') windowBlurState.seq = carried.seq;
    } catch {
      // No report yet, or one that cannot be read: counting from 0 is right,
      // and the watcher's first answer will be for seq 1.
    }
  }

  if (windowBlurState.writtenMaterial !== material) {
    windowBlurState.seq += 1;
    try {
      fs.writeFileSync(
        path.join(dir, WINDOW_BLUR_FILES.wanted),
        `${JSON.stringify({ seq: windowBlurState.seq, material })}\n`
      );
    } catch {
      return failed('write-failed');
    }
    windowBlurState.writtenMaterial = material;
    windowBlurState.gaveUp = false;
  }

  const readReport = () => {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(dir, WINDOW_BLUR_FILES.report), 'utf8'));
    } catch {
      return null;
    }
    if (parsed === null || typeof parsed !== 'object') return null;
    if (parsed.seq !== windowBlurState.seq) return null;
    return {
      active: parsed.active === true,
      why: typeof parsed.why === 'string' ? parsed.why : null,
      material: typeof parsed.material === 'string' ? parsed.material : null,
      applied: parsed.applied === true,
      verified: parsed.verified === true
    };
  };

  // `no-window` is a transient answer — the watcher reports it for the requests
  // that land before the main window exists, and re-reports the same seq the
  // moment a window is created. So it does not settle a wait, and it does not
  // arm the gave-up memo: the next request after the window exists will find
  // the settled report and answer instantly.
  let report = readReport();
  if ((report === null || report.why === 'no-window') && !windowBlurState.gaveUp) {
    const deadline = Date.now() + WINDOW_BLUR_WAIT_MS;
    while (report === null || report.why === 'no-window') {
      if (Date.now() >= deadline) break;
      await windowBlurWait(WINDOW_BLUR_POLL_MS);
      report = readReport();
    }
    if (report === null) windowBlurState.gaveUp = true;
  }
  if (report === null) return failed('no-report');
  return report;
}

/**
 * Everything the response carries beyond the config itself.
 *
 * `material` rides along to save a round trip; the three diagnosis fields ride
 * along with it because they are the difference between a report the user can
 * act on ("no-candidate-found, and here are the 9 paths that were tried") and a
 * shrug. They are read-only facts about the host, never settable.
 *
 * `windowBlurReport` is the one field here that is a *result* rather than a
 * fact: applying it is this half's job, so the response is also where the
 * attempt's outcome becomes visible to the process that stored the preference.
 *
 * It is NOT called `windowBlur`, and that is the whole subtlety. The response
 * is `{ ...currentConfig, ...materialFields() }`, so a report filed under the
 * config key would overwrite the saved boolean with an object — and the
 * renderer's `coerceBooleans` only copies `typeof === 'boolean'`, so the object
 * would be skipped and the key would quietly fall back to `false` on every
 * launch. The switch would work all session and lose its setting at every
 * restart, with nothing anywhere reporting an error. `material` has no config
 * key to collide with; this one does.
 */
async function materialFields() {
  const detail = detectWindowMaterialDetailed();
  return {
    material: detail.material,
    materialPath: detail.materialPath,
    materialWhy: detail.materialWhy,
    materialScanVia: detail.materialScanVia,
    materialScanError: detail.materialScanError,
    materialHost: detail.materialHost,
    materialTried: detail.materialTried,
    windowBlurReport: await applyWindowBlur(currentConfig.windowBlur)
  };
}

/**
 * GET / POST the theme config.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
async function handleConfig(req, res) {
  if (prepareResponse(req, res)) return;

  if (req.method === 'GET') {
    res.statusCode = 200;
    // `material` is not part of the config: it is not settable, and a client
    // POSTing it back would be asserting a fact about its own process that it
    // cannot observe. It rides on the same response only to save a round trip.
    res.end(JSON.stringify({ ...currentConfig, ...(await materialFields()) }));
    return;
  }

  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.end(JSON.stringify({ error: 'method not allowed' }));
    return;
  }

  const body = await readJsonBody(req);
  if (body.error) {
    res.statusCode = body.statusCode;
    res.end(JSON.stringify({ error: body.error }));
    return;
  }
  const payload = body.value;
  currentConfig = normalizeConfig({ ...currentConfig, ...payload });
  const saved = writeConfigFile();

  res.statusCode = 200;
  res.end(JSON.stringify({ ...currentConfig, saved, ...(await materialFields()) }));
}

/**
 * @param {object} ctx plugin context; needs the `webServer` service.
 */
export function apply(ctx) {
  const detail = detectWindowMaterialDetailed();
  ctx.logger?.info?.(`[liquid-glass] config file: ${CONFIG_FILE}`);
  // Logged eagerly even though the route would probe it lazily: ~80 ms once, and
  // "why does 透出桌面 do nothing" is otherwise a question with no visible
  // answer anywhere — the renderer cannot see this at all.
  ctx.logger?.info?.(
    `[liquid-glass] window material: ${detail.material}` +
      ` (${detail.materialWhy}` +
      (detail.materialPath === null ? '' : `, ${detail.materialPath}`) +
      (detail.materialScanVia === null ? '' : `, via ${detail.materialScanVia}`) +
      ')'
  );
  if (detail.materialScanError !== null) {
    // The one line that makes "scan-failed" actionable: which reader was tried,
    // and the errno it came back with. Without it the report is "the file is
    // there and I cannot open it", which is a dead end.
    ctx.logger?.info?.(
      `[liquid-glass] readers tried: ` +
        detail.materialScanError
          .map((entry) => `${entry.via} -> ${entry.code} (${entry.syscall})`)
          .join(' | ')
    );
  }
  if (detail.materialPath === null) {
    // The failed candidates are the whole diagnosis, so they are logged rather
    // than summarised — this line is the only place the real paths show up.
    ctx.logger?.info?.(
      `[liquid-glass] app.asar candidates tried: ` +
        detail.materialTried.map((entry) => `${entry.why} ${entry.path}`).join(' | ')
    );
  }
  if (detail.materialHost !== null) {
    // The single most decisive fact when a scan fails, and the one that is
    // unguessable without it: a plain Node host answers ENOTDIR for a `.asar`
    // path because it is a file, while a host whose `fs` was rewritten hands
    // back the archive's members because it is pretending it is a directory.
    // Only logged when the scan failed, because that is the only time it is set.
    ctx.logger?.info?.(
      `[liquid-glass] host: electron=${detail.materialHost.electron ?? 'none'}` +
        `, noAsar=${detail.materialHost.noAsar}` +
        `, listsAsDirectory=${detail.materialHost.listsAsDirectory}`
    );
  }
  ctx.webServer.register({ kind: 'exact', path: ROUTE, handler: handleConfig });

  // Logged once, because 窗口模糊 is the one setting whose outcome leaves no
  // trace anywhere the user can look: a wrong value here shows up as "the switch
  // is on and the desktop is still sharp", with nothing on screen to say why.
  // Note this runs before any window necessarily exists, so `no-window` at this
  // point is normal and the route re-applies it later.
  // Async now: the request goes through a file and the answer may take a
  // bounded wait. Logged when it settles rather than blocking apply() — apply()
  // is not a request anybody is waiting on, and the route logs nothing less
  // than the same outcome on every read anyway.
  void applyWindowBlur(currentConfig.windowBlur).then((blur) => {
    ctx.logger?.info?.(
      `[liquid-glass] window blur: wanted=${currentConfig.windowBlur}` +
        `, material=${blur.material ?? 'n/a'}, active=${blur.active}` +
        // `verified: false` with the request still applied is the ordinary
        // outcome on this client (no getter in Electron 44.0.0 / win32), and a
        // log that only says `active=false` there reads like a failure.
        (blur.applied === true ? `, applied=${blur.applied}, verified=${blur.verified}` : '') +
        (blur.why === null ? '' : `, why=${blur.why}`)
    );
  });
}

export {
  CONFIG_FILE,
  ROUTE,
  STORE_DIR,
  PATCH_MARKER,
  PATCH_MARKERS,
  POINTER_FILE,
  detectWindowMaterial,
  detectWindowMaterialDetailed,
  resolveAsarPath,
  resolveAsarPathDetailed,
  readAsarPointer,
  scanForMarker,
  scanForMarkerDetailed,
  archiveReaders,
  originalFs,
  hostFacts,
  resourcesDir,
  applyWindowBlur,
  WINDOW_MATERIALS,
  WINDOW_BLUR_FILES
};
