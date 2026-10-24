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
import { createReadStream, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
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
 * Shipped defaults. `surface` is the 透出 (surface opacity) base for the main
 * content area; the left sidebar renders at `surface + sidebarDelta`, i.e. more
 * opaque so less wallpaper bleeds through it. The top bar needs no value: it is
 * not page content (a preload-injected shadow-DOM strip over a shell-painted
 * floor), and the client pins that floor to a fully opaque colour.
 */
export const DEFAULT_SETTINGS = {
  version: 1,
  enabled: false,
  folder: '',
  file: '',
  dim: 0,
  blur: 0,
  surface: 66,
  sidebarDelta: 15,
  disableSkin: true,
};

/**
 * Sentinel folder name for the wallpapers shipped inside this package
 * (`wallpapers/`). The panel's folder field accepts it verbatim, so the plugin
 * can be used with zero configuration — no folder to pick first.
 */
export const BUILTIN_FOLDER = '@builtin';

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

/** List the wallpaper files of a folder (bitmaps + videos), in natural name order. */
export function listImages(folder) {
  if (typeof folder !== 'string' || folder.trim() === '')
    return { ok: false, error: '还没有选择壁纸文件夹' };
  const absolute = folder.trim() === BUILTIN_FOLDER ? BUILTIN_DIR : resolve(folder);
  let stats;
  try {
    stats = statSync(absolute);
  }
  catch {
    return { ok: false, error: `文件夹不存在或无法访问：${absolute}` };
  }
  if (!stats.isDirectory())
    return { ok: false, error: `不是文件夹：${absolute}` };
  let entries;
  try {
    entries = readdirSync(absolute, { withFileTypes: true });
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
      size = statSync(join(absolute, entry.name)).size;
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
  images.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }));
  return { ok: true, folder: absolute, images };
}

/**
 * Resolve one wallpaper file inside a folder, refusing anything that is not a
 * plain media name directly inside it (no separators, no traversal, no symlink
 * escapes through `..`).
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
  const base = folder.trim() === BUILTIN_FOLDER ? BUILTIN_DIR : resolve(folder);
  const full = resolve(join(base, fileName));
  if (full !== join(base, fileName) || !full.startsWith(base + sep))
    return null;
  try {
    const stats = statSync(full);
    if (!stats.isFile())
      return null;
    return { path: full, mime, size: stats.size, name: fileName };
  }
  catch {
    return null;
  }
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
    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout?.on('data', (chunk) => { stdoutChunks.push(toBuffer(chunk)); });
    child.stderr?.on('data', (chunk) => { stderrChunks.push(toBuffer(chunk)); });
    child.on('error', (error) => {
      const message = error instanceof Error ? error.message : String(error);
      resolvePromise({ ok: false, error: `无法启动 ${executable}：${message}` });
    });
    child.on('close', (code) => {
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
