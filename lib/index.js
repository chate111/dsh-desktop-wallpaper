/**
 * dsh-desktop-wallpaper — host half.
 *
 * Responsibilities (all of them loopback-only HTTP routes registered on the
 * `webServer` service):
 *
 *   GET  /dsh-desktop-wallpaper/load    read the durable settings copy
 *   POST /dsh-desktop-wallpaper/save    atomically persist the settings copy
 *   POST /dsh-desktop-wallpaper/pick    native "choose folder" dialog → absolute path
 *   GET  /dsh-desktop-wallpaper/list    scan a wallpaper folder for bitmap images
 *   GET  /dsh-desktop-wallpaper/img     stream one wallpaper at full resolution
 *
 * Serving images from the host (instead of re-encoding them into data URLs in
 * the browser) is what makes a whole folder usable as a wallpaper library: the
 * originals keep their resolution, nothing has to fit in localStorage, and the
 * folder path alone is enough state to restore the library after a restart.
 */
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { TextDecoder } from 'node:util';
import { fileURLToPath } from 'node:url';

export const name = 'dsh-desktop-wallpaper';

/** Services required before the routes can be registered. */
export const inject = ['webServer'];

/** Route paths served by the host half (outside /api, matching the /dsh-* convention). */
export const LOAD_ROUTE = '/dsh-desktop-wallpaper/load';
export const SAVE_ROUTE = '/dsh-desktop-wallpaper/save';
export const PICK_ROUTE = '/dsh-desktop-wallpaper/pick';
export const LIST_ROUTE = '/dsh-desktop-wallpaper/list';
export const IMG_ROUTE = '/dsh-desktop-wallpaper/img';
/** One-click import of the local Wallpaper Engine library. */
export const IMPORT_ROUTE = '/dsh-desktop-wallpaper/import-we';

/** Settings here are a folder path plus a few numbers — far smaller than image data URLs. */
const MAX_SAVE_BYTES = 256 * 1024;

const LOOPBACK_ORIGINS = ['http://127.0.0.1', 'http://localhost', 'http://[::1]'];

/**
 * Extensions accepted as wallpaper-library entries: bitmaps plus the two video
 * containers the renderer plays natively (H.264/AAC mp4, VP8/VP9 webm).
 */
const MEDIA_MIME = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.bmp', 'image/bmp'],
  ['.avif', 'image/avif'],
  ['.mp4', 'video/mp4'],
  ['.webm', 'video/webm'],
]);

/** Containers that carry video instead of a still frame. */
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm']);

/**
 * Sentinel folder name for the wallpapers shipped inside this package
 * (`wallpapers/`). The panel's folder field accepts it verbatim, so the plugin
 * can be used with zero configuration — no folder to pick first.
 */
export const BUILTIN_FOLDER = '@builtin';

/**
 * Shipped defaults. `folder` starts on the built-in library: a fresh install
 * shows the nine bundled samples in the panel immediately, so nobody has to
 * discover `@builtin` or pick a folder before the wallpaper can be switched.
 *
 * `surface` is the 透出 (surface opacity) base for the main content area; the
 * left sidebar renders at `surface + sidebarDelta`, i.e. more opaque so less
 * wallpaper bleeds through it. The top bar needs no value: it is not page
 * content (a preload-injected shadow-DOM strip over a shell-painted floor), and
 * the client pins that floor to a fully opaque colour.
 */
export const DEFAULT_SETTINGS = {
  version: 1,
  enabled: false,
  folder: BUILTIN_FOLDER,
  file: '',
  dim: 0,
  blur: 0,
  surface: 66,
  sidebarDelta: 15,
  disableSkin: true,
};

/** `lib/index.js` → `../wallpapers`. */
const BUILTIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'wallpapers');

/** The DSH home directory ($DSH_HOME, else ~/.dsh). */
function resolveDshHome() {
  const env = process.env.DSH_HOME;
  if (env !== undefined && env.trim() !== '')
    return env;
  return join(homedir(), '.dsh');
}

/** Durable settings file path — one shared copy per machine. */
function settingsPath() {
  return join(resolveDshHome(), 'dsh-desktop-wallpaper.settings.json');
}

//#region Wallpaper Engine import
/** Wallpaper Engine's Steam AppID; workshop content lives under `content/<id>/`. */
const WE_APP_ID = '431960';

/** Per-file and per-run ceilings for the importer (one run can be repeated). */
const IMPORT_MAX_FILE_BYTES = 120 * 1024 * 1024;
const IMPORT_MAX_TOTAL_BYTES = 1536 * 1024 * 1024;
/** Skip thumbnails/trailers that are not worth a wallpaper slot. */
const IMPORT_MIN_FILE_BYTES = 16 * 1024;

/**
 * Where imported wallpapers land.
 *
 * Deliberately outside the package: the shipped `wallpapers/` folder is part of
 * the npm tarball, and copying a user's 14 GB workshop library into it would put
 * third-party Steam content into the next publish. The panel lists both folders
 * as one "built-in" library, so the user still sees a single grid.
 */
export function importedDir() {
  const override = process.env.DSH_WALLPAPER_IMPORT_DIR;
  if (override !== undefined && override.trim() !== '')
    return override.trim();
  return join(resolveDshHome(), 'dsh-desktop-wallpaper', 'imported');
}

/** `SteamPath` from the registry, or null when Steam is installed elsewhere/nowhere. */
function registrySteamPath() {
  try {
    const output = execFileSync('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 4000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const match = /SteamPath\s+REG_SZ\s+(.+)/.exec(output);
    return match === null ? null : match[1].trim();
  }
  catch {
    return null;
  }
}

/** Steam root plus every extra library declared in `libraryfolders.vdf`. */
function libraryFoldersFrom(steamPath) {
  const libraries = [steamPath];
  try {
    const text = readFileSync(join(steamPath, 'steamapps', 'libraryfolders.vdf'), 'utf8');
    for (const match of text.matchAll(/"path"\s+"([^"]+)"/g)) {
      const value = match[1].replace(/\\\\/g, '\\');
      if (value !== '')
        libraries.push(value);
    }
  }
  catch {
    /* no library file — the root itself is all we know */
  }
  return [...new Set(libraries)];
}

/**
 * Find every library that actually holds Wallpaper Engine content.
 * @param extra additional Steam roots to consider (tests, or a hand-picked path).
 * @param options `{ registry: false }` skips the registry probe so callers can pin
 *   the search space (tests must never touch the developer's own Steam install).
 */
export function discoverWallpaperEngineRoots(extra = [], options = {}) {
  const candidates = new Set();
  const registry = options.registry === false ? null : registrySteamPath();
  if (registry !== null)
    candidates.add(registry);
  // `defaults: false` pins the search space to `extra` — tests must never scan
  // the developer's own Steam library.
  if (options.defaults !== false) {
    for (const base of [process.env['ProgramFiles(x86)'], process.env.ProgramFiles]) {
      if (base !== undefined && base !== '')
        candidates.add(join(base, 'Steam'));
    }
    for (const drive of ['C', 'D', 'E', 'F'])
      candidates.add(`${drive}:\\Steam`);
  }
  for (const candidate of extra)
    candidates.add(candidate);

  // D:\Steam and D:\steam are the same library on Windows; dedupe case-insensitively
  // or every item gets scanned (and imported) twice.
  const libraries = new Map();
  for (const candidate of candidates) {
    if (!existsSync(candidate))
      continue;
    for (const library of libraryFoldersFrom(candidate)) {
      const absolute = resolve(library);
      const key = absolute.toLowerCase();
      if (!libraries.has(key))
        libraries.set(key, absolute);
    }
  }

  const roots = [];
  for (const library of libraries.values()) {
    const workshop = join(library, 'steamapps', 'workshop', 'content', WE_APP_ID);
    const projects = join(library, 'steamapps', 'common', 'wallpaper_engine', 'projects');
    if (!existsSync(workshop) && !existsSync(projects))
      continue;
    roots.push({
      library,
      workshop: existsSync(workshop) ? workshop : null,
      projects: existsSync(projects) ? projects : null,
    });
  }
  return roots;
}

/** Steam thumbnails and the textures of a scene project are not wallpapers. */
const IMPORT_SKIP_NAME = /^preview\.(jpg|jpeg|png|gif|webm|mp4)$/i;

/** Collect every supported media file under `dir` (nested one or two levels deep). */
function collectMedia(dir, depth, itemId, title, out, includeImages) {
  if (depth < 0)
    return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  }
  catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectMedia(full, depth - 1, itemId, title, out, includeImages);
      continue;
    }
    if (!entry.isFile())
      continue;
    if (IMPORT_SKIP_NAME.test(entry.name))
      continue;
    const extension = extname(entry.name).toLowerCase();
    if (!MEDIA_MIME.has(extension))
      continue;
    // Default is video-only: in a Wallpaper Engine item the images are either the
    // Steam thumbnail (already skipped) or raw textures of a `.pkg` scene
    // (`bg.png`, `screen.png`, …) — neither is a wallpaper.
    if (!includeImages && !VIDEO_EXTENSIONS.has(extension))
      continue;
    let size = 0;
    try {
      size = statSync(full).size;
    }
    catch {
      continue;
    }
    out.push({ source: full, name: entry.name, size, extension, itemId, title });
  }
}

/** `project.json` → `title`, when the item ships one. */
function projectTitle(dir) {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
    return typeof parsed?.title === 'string' ? parsed.title.trim() : '';
  }
  catch {
    return '';
  }
}

/** File-name-safe version of a workshop title. */
function safeBase(text) {
  return text
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

/** Enumerate importable candidates without copying anything. */
export function scanWallpaperEngine(options = {}) {
  const {
    roots = discoverWallpaperEngineRoots(),
    maxFileBytes = IMPORT_MAX_FILE_BYTES,
    includeImages = false,
  } = options;
  const candidates = [];
  for (const root of roots) {
    if (root.workshop !== null) {
      let items = [];
      try {
        items = readdirSync(root.workshop, { withFileTypes: true }).filter((entry) => entry.isDirectory());
      }
      catch {
        items = [];
      }
      for (const item of items) {
        const dir = join(root.workshop, item.name);
        collectMedia(dir, 2, item.name, projectTitle(dir), candidates, includeImages);
      }
    }
    if (root.projects !== null) {
      for (const group of ['myprojects', 'defaultprojects']) {
        const dir = join(root.projects, group);
        if (existsSync(dir))
          collectMedia(dir, 2, group, '', candidates, includeImages);
      }
    }
  }
  return candidates.filter((candidate) => candidate.size >= IMPORT_MIN_FILE_BYTES && candidate.size <= maxFileBytes);
}

/**
 * Copy the compatible part of the local Wallpaper Engine library into the
 * imported folder. Idempotent: files already present at the same size are
 * skipped, so clicking again continues where the last run stopped (the per-run
 * byte ceiling is what keeps a 14 GB library from being copied in one go).
 */
export async function importWallpaperEngine(options = {}) {
  const {
    roots = discoverWallpaperEngineRoots(),
    targetDir = importedDir(),
    maxFileBytes = IMPORT_MAX_FILE_BYTES,
    maxTotalBytes = IMPORT_MAX_TOTAL_BYTES,
    includeImages = false,
  } = options;

  const candidates = scanWallpaperEngine({ roots, maxFileBytes, includeImages });
  mkdirSync(targetDir, { recursive: true });

  const plan = [];
  const used = new Set();
  let bytes = 0;
  let skipped = 0;
  let failed = 0;
  let truncated = false;

  // Smallest first: a per-run budget then fills up instead of dying on one big file.
  const ordered = [...candidates].sort((a, b) => a.size - b.size);
  for (const candidate of ordered) {
    const base = safeBase(candidate.title) || safeBase(candidate.name.replace(candidate.extension, ''));
    // Workshop ids keep names unique; the bare title alone would collide across items.
    const stem = candidate.itemId === '' || candidate.itemId === undefined
      ? base
      : `${base}-${candidate.itemId}`;
    let name = `${stem}${candidate.extension}`;
    if (used.has(name.toLowerCase())) {
      name = `${stem}-${candidate.size}${candidate.extension}`;
      if (used.has(name.toLowerCase()))
        continue;
    }
    const target = join(targetDir, name);

    // Already imported? Count it and move on WITHOUT touching the budget — otherwise
    // a second click re-plans the first run's files, burns the whole allowance on
    // them and reports "imported 0, skipped N" forever.
    let existing = -1;
    try {
      existing = statSync(target).size;
    }
    catch {
      existing = -1;
    }
    if (existing === candidate.size) {
      used.add(name.toLowerCase());
      skipped += 1;
      continue;
    }

    if (bytes + candidate.size > maxTotalBytes) {
      // Skip, do not break: a bigger file should not block the smaller ones behind it.
      truncated = true;
      continue;
    }
    used.add(name.toLowerCase());
    bytes += candidate.size;
    plan.push({ ...candidate, target, name });
  }

  let copiedBytes = 0;
  let copied = 0;
  for (const item of plan) {
    try {
      await copyFile(item.source, item.target);
      copied += 1;
      copiedBytes += item.size;
    }
    catch {
      failed += 1; // unreadable / locked source: counted, never thrown
    }
  }

  return {
    ok: true,
    targetDir,
    scanned: candidates.length,
    copied,
    skipped,
    failed,
    truncated,
    bytes: copiedBytes,
  };
}
//#endregion

/** Whether a request may reach the host routes: loopback origin only. */
function isLoopbackRequest(req) {
  const origin = req.headers.origin;
  if (origin === undefined)
    return true; // same-origin fetch omits Origin
  return LOOPBACK_ORIGINS.some((base) => origin === base || origin.startsWith(`${base}:`));
}

/** Send a JSON response. */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

/** Read a bounded JSON body to a plain object, or null when absent/invalid/oversized. */
async function readJsonBody(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk;
    size += buffer.byteLength;
    if (size > maxBytes)
      return null;
    chunks.push(buffer);
  }
  if (chunks.length === 0)
    return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed !== null && typeof parsed === 'object' ? parsed : null;
  }
  catch {
    return null;
  }
}

/** Common method + loopback guard for every host route. */
function guard(req, res, method) {
  if (req.method !== method) {
    sendJson(res, 405, { ok: false, error: 'method not allowed' });
    return false;
  }
  if (!isLoopbackRequest(req)) {
    sendJson(res, 403, { ok: false, error: 'forbidden' });
    return false;
  }
  return true;
}

/** Query parameters of a route request (the exact-kind match keeps req.url intact). */
function queryOf(req) {
  try {
    return new URL(req.url ?? '/', 'http://127.0.0.1').searchParams;
  }
  catch {
    return new URLSearchParams();
  }
}

/**
 * Parse a single byte range out of a `Range` header.
 *
 * Returns `null` when the caller should just send the whole file (no header, a
 * multi-range request, or syntax that is not worth interpreting), `'416'` when
 * the range cannot be satisfied, and `{ start, end }` (inclusive, 0-based)
 * otherwise. Video elements seek with these requests, so a host that ignores
 * `Range` makes scrubbing and resume fail.
 */
function parseByteRange(header, size) {
  if (typeof header !== 'string')
    return null;
  const trimmed = header.trim();
  if (!trimmed.toLowerCase().startsWith('bytes='))
    return null;
  const spec = trimmed.slice('bytes='.length).trim();
  if (spec.includes(','))
    return null; // multi-range: unsupported by design, fall back to the full body
  const match = /^(\d*)-(\d*)$/.exec(spec);
  if (match === null)
    return null;
  const [, startText, endText] = match;
  if (startText === '' && endText === '')
    return null;
  if (size <= 0)
    return '416';
  let start;
  let end;
  if (startText === '') {
    // Suffix range: the last N bytes.
    const suffix = Number(endText);
    if (!Number.isFinite(suffix) || suffix <= 0)
      return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  }
  else {
    start = Number(startText);
    end = endText === '' ? size - 1 : Number(endText);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size)
    return '416';
  return { start, end: Math.min(end, size - 1) };
}

function clampNumber(value, min, max, fallback) {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric))
    return fallback;
  return Math.min(max, Math.max(min, Math.round(numeric)));
}

/** Coerce an untrusted settings payload into the shape the client understands. */
export function sanitizeSettings(input, previous = DEFAULT_SETTINGS) {
  const source = input !== null && typeof input === 'object' ? input : {};
  return {
    version: 1,
    enabled: typeof source.enabled === 'boolean' ? source.enabled : previous.enabled,
    folder: typeof source.folder === 'string' ? source.folder.trim() : previous.folder,
    file: typeof source.file === 'string' ? source.file.trim() : previous.file,
    dim: clampNumber(source.dim, 0, 80, previous.dim),
    blur: clampNumber(source.blur, 0, 24, previous.blur),
    surface: clampNumber(source.surface, 0, 100, previous.surface),
    sidebarDelta: clampNumber(source.sidebarDelta, 0, 100, previous.sidebarDelta),
    disableSkin: typeof source.disableSkin === 'boolean' ? source.disableSkin : previous.disableSkin,
  };
}

/** Read + sanitize the durable copy; defaults when absent or corrupt. */
function readSettings() {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath(), 'utf8'));
    return sanitizeSettings(parsed?.settings ?? null);
  }
  catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Atomically persist the settings blob. */
function writeSettings(settings) {
  const path = settingsPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ settings }, null, 2), 'utf8');
  renameSync(tmp, path);
}

/** Media files directly inside one folder (no recursion), or a labelled error. */
function listMediaIn(directory) {
  let stats;
  try {
    stats = statSync(directory);
  }
  catch {
    return { ok: false, error: `文件夹不存在或无法访问：${directory}` };
  }
  if (!stats.isDirectory())
    return { ok: false, error: `不是文件夹：${directory}` };
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `无法读取文件夹：${message}` };
  }
  const images = [];
  for (const entry of entries) {
    if (!entry.isFile())
      continue;
    const extension = extname(entry.name).toLowerCase();
    if (!MEDIA_MIME.has(extension))
      continue;
    let size = 0;
    try {
      size = statSync(join(directory, entry.name)).size;
    }
    catch {
      size = 0;
    }
    images.push({
      name: entry.name,
      size,
      kind: VIDEO_EXTENSIONS.has(extension) ? 'video' : 'image',
    });
  }
  return { ok: true, folder: directory, images };
}

/**
 * List the wallpaper files of a folder (bitmaps + videos), in natural name order.
 *
 * `@builtin` is a merged view: the wallpapers shipped in the package plus the
 * ones imported from Wallpaper Engine. Shipped names win on collision, so an
 * import can never shadow a bundled sample.
 */
export function listImages(folder) {
  if (typeof folder !== 'string' || folder.trim() === '')
    return { ok: false, error: '还没有选择壁纸文件夹' };

  let result;
  if (folder.trim() === BUILTIN_FOLDER) {
    result = listMediaIn(BUILTIN_DIR);
    if (!result.ok)
      return result;
    const seen = new Set(result.images.map((image) => image.name));
    const imported = listMediaIn(importedDir());
    if (imported.ok) {
      for (const image of imported.images) {
        if (seen.has(image.name))
          continue;
        seen.add(image.name);
        result.images.push(image);
      }
    }
    result = { ok: true, folder: BUILTIN_DIR, images: result.images };
  }
  else {
    result = listMediaIn(resolve(folder));
    if (!result.ok)
      return result;
  }

  result.images.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }));
  return result;
}

/**
 * Resolve one wallpaper file inside a folder, refusing anything that is not a
 * plain media name directly inside it (no separators, no traversal, no symlink
 * escapes through `..`). For `@builtin` the imported folder is searched too.
 */
export function resolveWallpaper(folder, fileName) {
  if (typeof folder !== 'string' || folder.trim() === '')
    return null;
  if (typeof fileName !== 'string' || fileName === '')
    return null;
  if (fileName.includes('/') || fileName.includes('\\') || fileName.includes('..'))
    return null;
  const extension = extname(fileName).toLowerCase();
  const mime = MEDIA_MIME.get(extension);
  if (mime === undefined)
    return null;
  const bases = folder.trim() === BUILTIN_FOLDER ? [BUILTIN_DIR, importedDir()] : [resolve(folder)];
  for (const base of bases) {
    const full = resolve(join(base, fileName));
    if (full !== join(base, fileName) || !full.startsWith(base + sep))
      continue;
    try {
      const stats = statSync(full);
      if (!stats.isFile())
        continue;
      return { path: full, mime, size: stats.size, name: fileName };
    }
    catch {
      continue;
    }
  }
  return null;
}

/**
 * Folder picker script. `FolderBrowserDialog` is the only folder chooser that is
 * reachable from a plain spawned shell on Windows; on PowerShell 7 (.NET) it
 * renders the modern Vista-style dialog, which is what the desktop app shows.
 *
 * The path is written after switching the console output encoding to UTF-8:
 * Windows PowerShell 5.1 otherwise writes in the OEM code page (CP936 on a
 * zh-CN box) and a Chinese folder name reaches Node as undecodable bytes.
 */
const PICK_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
  '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
  "$dialog.Description = '选择壁纸文件夹'",
  '$dialog.ShowNewFolderButton = $false',
  'try { $dialog.UseDescriptionForTitle = $true } catch { }',
  'try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }',
  'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }',
].join('\n');

/** Normalize a stream chunk to a Buffer (streams may hand over strings). */
function toBuffer(chunk) {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
}

/**
 * Decode a child process' stdout/stderr. The child is asked for UTF-8, but a
 * non-UTF-8 code page can still slip through, so a reading that produced
 * replacement characters is retried against the CJK code pages. Without this a
 * mojibake folder path is persisted and every later `/list` scan fails with
 * "文件夹不存在" behind an HTTP 400.
 */
function decodeChildText(chunks) {
  const buffer = Buffer.concat(chunks);
  if (buffer.length === 0)
    return '';
  const utf8 = buffer.toString('utf8');
  if (!utf8.includes('\uFFFD'))
    return utf8;
  for (const encoding of ['gb18030', 'gbk', 'big5']) {
    try {
      const decoded = new TextDecoder(encoding).decode(buffer);
      if (!decoded.includes('\uFFFD'))
        return decoded;
    }
    catch {
      /* encoding not available in this Node build — keep trying */
    }
  }
  return utf8;
}

/**
 * The picker process that currently owns a visible dialog, if any.
 *
 * The dialog belongs to a spawned PowerShell process, not to the app window, so
 * the app stays clickable while it is open. A second `/pick` therefore has to
 * take the old dialog down before raising a new one — otherwise the user ends up
 * with a stack of dialogs and no way to tell which one wins.
 */
let activePicker = null;

/** One import at a time — a second click while copying answers 409. */
let importRunning = false;

/** Close the in-flight dialog and wait briefly for its process to exit. */
export async function cancelActivePicker() {
  const child = activePicker;
  if (child === null)
    return false;
  activePicker = null;
  // Marks the close that follows as user-driven cancellation, so the first
  // `/pick` answers "cancelled" instead of surfacing a kill as an error.
  child.dwpCancelled = true;
  const closed = new Promise((resolve) => child.once('close', resolve));
  try {
    child.kill();
  }
  catch {
    /* already gone */
  }
  await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 800))]);
  return true;
}

function runPicker(executable, args) {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      resolvePromise({ ok: false, error: `无法启动 ${executable}：${message}` });
      return;
    }
    activePicker = child;
    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout?.on('data', (chunk) => { stdoutChunks.push(toBuffer(chunk)); });
    child.stderr?.on('data', (chunk) => { stderrChunks.push(toBuffer(chunk)); });
    child.on('error', (error) => {
      if (activePicker === child)
        activePicker = null;
      const message = error instanceof Error ? error.message : String(error);
      resolvePromise({ ok: false, error: `无法启动 ${executable}：${message}` });
    });
    child.on('close', (code) => {
      if (activePicker === child)
        activePicker = null;
      if (child.dwpCancelled === true) {
        resolvePromise({ ok: true, folder: null }); // replaced by a newer /pick
        return;
      }
      const folder = decodeChildText(stdoutChunks).trim();
      if (folder !== '') {
        resolvePromise({ ok: true, folder });
        return;
      }
      if (code === 0) {
        resolvePromise({ ok: true, folder: null }); // the user cancelled the dialog
        return;
      }
      const failure = decodeChildText(stderrChunks).trim();
      resolvePromise({ ok: false, error: failure || `${executable} exited with code ${code}` });
    });
  });
}

/** Open the native folder dialog; `folder: null` means the user cancelled. */
async function pickFolder() {
  const attempts = [
    ['pwsh', ['-NoProfile', '-STA', '-Command', PICK_SCRIPT]],
    ['powershell', ['-NoProfile', '-Command', PICK_SCRIPT]],
  ];
  let last = { ok: false, error: '找不到可用的 PowerShell' };
  for (const [executable, args] of attempts) {
    const result = await runPicker(executable, args);
    if (result.ok)
      return result;
    last = result;
  }
  return last;
}

/**
 * Apply the host half: register the wallpaper-library routes.
 * @param ctx - the Cordis context.
 */
export function apply(ctx) {
  const webServer = ctx.get('webServer');
  if (webServer === undefined) {
    ctx.logger.warn('[dsh-desktop-wallpaper] webServer service unavailable; wallpaper library disabled');
    return;
  }
  ctx.effect(() => {
    const disposers = [];
    // GET /load — read the durable copy (raw; the client sanitizes).
    disposers.push(webServer.register({
      kind: 'exact',
      path: LOAD_ROUTE,
      handler: (req, res) => {
        if (!guard(req, res, 'GET'))
          return;
        sendJson(res, 200, { ok: true, settings: readSettings() });
      },
    }));
    // POST /save — sanitize then atomically persist.
    disposers.push(webServer.register({
      kind: 'exact',
      path: SAVE_ROUTE,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST'))
          return;
        const body = await readJsonBody(req, MAX_SAVE_BYTES);
        if (body === null) {
          sendJson(res, 413, { ok: false, error: 'invalid or oversized body' });
          return;
        }
        if (typeof body.settings !== 'object' || body.settings === null) {
          sendJson(res, 400, { ok: false, error: 'missing settings payload' });
          return;
        }
        const settings = sanitizeSettings(body.settings, readSettings());
        try {
          writeSettings(settings);
          sendJson(res, 200, { ok: true, settings });
        }
        catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.logger.warn('[dsh-desktop-wallpaper] save failed: %s', message);
          sendJson(res, 500, { ok: false, error: message });
        }
      },
    }));
    // POST /pick — native folder dialog.
    disposers.push(webServer.register({
      kind: 'exact',
      path: PICK_ROUTE,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST'))
          return;
        try {
          // A repeat click means "I want to choose again", so the dialog that is
          // already open is closed first — no stacked dialogs, no dead button.
          await cancelActivePicker();
          const result = await pickFolder();
          if (!result.ok) {
            sendJson(res, 500, { ok: false, error: result.error });
            return;
          }
          sendJson(res, 200, { ok: true, folder: result.folder });
        }
        catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendJson(res, 500, { ok: false, error: message });
        }
      },
    }));
    // POST /import-we — copy the compatible part of THIS machine's Wallpaper Engine
    // library (Steam registry → libraryfolders.vdf → content/431960) into the
    // imported folder, which the built-in library lists alongside the samples.
    disposers.push(webServer.register({
      kind: 'exact',
      path: IMPORT_ROUTE,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST'))
          return;
        if (importRunning) {
          sendJson(res, 409, { ok: false, error: '已经在导入了，等这一轮结束' });
          return;
        }
        importRunning = true;
        try {
          const result = await importWallpaperEngine();
          sendJson(res, 200, result);
        }
        catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.logger.warn('[dsh-desktop-wallpaper] import failed: %s', message);
          sendJson(res, 500, { ok: false, error: message });
        }
        finally {
          importRunning = false;
        }
      },
    }));
    // GET /list — scan a folder (explicit ?folder=, else the saved one).
    disposers.push(webServer.register({
      kind: 'exact',
      path: LIST_ROUTE,
      handler: (req, res) => {
        if (!guard(req, res, 'GET'))
          return;
        const requested = queryOf(req).get('folder');
        const folder = requested !== null && requested.trim() !== '' ? requested.trim() : readSettings().folder;
        const result = listImages(folder);
        if (!result.ok) {
          sendJson(res, 400, { ok: false, error: result.error });
          return;
        }
        sendJson(res, 200, result);
      },
    }));
    // GET /img?name=… — stream one full-resolution wallpaper (Range-aware for video).
    disposers.push(webServer.register({
      kind: 'exact',
      path: IMG_ROUTE,
      handler: (req, res) => {
        if (!guard(req, res, 'GET'))
          return;
        const target = resolveWallpaper(readSettings().folder, queryOf(req).get('name') ?? '');
        if (target === null) {
          sendJson(res, 404, { ok: false, error: 'wallpaper image not found' });
          return;
        }
        const baseHeaders = {
          'content-type': target.mime,
          'cache-control': 'private, max-age=600',
          'accept-ranges': 'bytes',
        };
        const range = parseByteRange(req.headers.range, target.size);
        if (range === '416') {
          res.writeHead(416, { ...baseHeaders, 'content-range': `bytes */${target.size}` });
          res.end();
          return;
        }
        if (range !== null) {
          res.writeHead(206, {
            ...baseHeaders,
            'content-length': String(range.end - range.start + 1),
            'content-range': `bytes ${range.start}-${range.end}/${target.size}`,
          });
          createReadStream(target.path, { start: range.start, end: range.end }).pipe(res);
          return;
        }
        res.writeHead(200, { ...baseHeaders, 'content-length': String(target.size) });
        createReadStream(target.path).pipe(res);
      },
    }));
    return () => {
      for (const dispose of disposers.splice(0))
        dispose();
    };
  }, 'dsh-desktop-wallpaper: wallpaper library routes');
}
