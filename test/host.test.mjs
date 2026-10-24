/**
 * dsh-desktop-wallpaper — 宿主半区测试（node:test，零依赖）。
 *
 * 覆盖：
 *   1. 纯函数 —— sanitizeSettings / listImages / resolveWallpaper（含路径穿越拒绝）
 *   2. 用假 cordis ctx 驱动**真实 handler** —— 5 条路由的注册、设置往返、
 *      原图流式返回，以及 405 / 403 / 400 / 404 / 413 与 disposer 清理。
 *
 * 全程只碰临时目录：DSH_HOME 也指向临时目录，绝不读写机器上真实的设置文件。
 * `/pick` 路由只断言"注册了" —— 真调它会弹出原生目录对话框。
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { after, before, describe, it } from 'node:test';

const sandbox = mkdtempSync(join(tmpdir(), 'dwp-host-'));
process.env.DSH_HOME = join(sandbox, 'dsh-home');

const host = await import('../lib/index.js');

/** 中文目录名 —— 正是曾经因为 GBK / UTF-8 混淆而整库读不出来的那种路径。 */
const library = join(sandbox, '壁纸库');
const settingsFile = join(sandbox, 'dsh-home', 'dsh-desktop-wallpaper.settings.json');

before(() => {
  mkdirSync(library, { recursive: true });
  writeFileSync(join(library, 'b.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
  writeFileSync(join(library, 'a.png'), Buffer.alloc(32, 7));
  writeFileSync(join(library, 'c.mp4'), Buffer.alloc(64, 1));
  writeFileSync(join(library, 'd.webm'), Buffer.alloc(40, 2));
  writeFileSync(join(library, 'note.txt'), 'not an image');
  mkdirSync(join(library, 'subfolder'), { recursive: true });
});

after(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

/** 够真的请求对象：handler 用 `for await` 读 body，用 `req.headers.origin` 判来源。 */
function makeRequest({ method = 'GET', url = '/', headers = {}, body } = {}) {
  return {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined)
        yield Buffer.from(JSON.stringify(body), 'utf8');
    },
  };
}

/** 可写响应对象：既能接 JSON（res.end），也能接 createReadStream().pipe(res)。 */
class MockResponse extends Writable {
  constructor() {
    super();
    this.chunks = [];
    this.status = 0;
    this.headers = {};
  }

  writeHead(status, headers) {
    this.status = status;
    this.headers = headers ?? {};
    return this;
  }

  _write(chunk, _encoding, callback) {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }

  get text() {
    return Buffer.concat(this.chunks).toString('utf8');
  }

  get json() {
    return JSON.parse(this.text);
  }
}

/** 调一次 handler 并等响应写完。 */
async function call(handler, options) {
  const res = new MockResponse();
  const finished = new Promise((resolve) => res.on('finish', resolve));
  await handler(makeRequest(options), res);
  await finished;
  return res;
}

/** 假 cordis ctx：只实现宿主半区真正用到的那几样。 */
function fakeContext({ withWebServer = true } = {}) {
  const routes = new Map();
  const warnings = [];
  let dispose;
  const ctx = {
    get(name) {
      if (name !== 'webServer' || !withWebServer)
        return undefined;
      return {
        register(route) {
          routes.set(route.path, route.handler);
          return () => routes.delete(route.path);
        },
      };
    },
    effect(callback) {
      dispose = callback();
      return dispose;
    },
    logger: { warn: (message) => warnings.push(String(message)), info() {} },
  };
  return { ctx, routes, warnings, dispose: () => dispose };
}

describe('sanitizeSettings', () => {
  it('空输入回落到默认设置', () => {
    assert.deepEqual(host.sanitizeSettings({}), host.DEFAULT_SETTINGS);
  });

  it('越界数值被夹到合法区间', () => {
    const settings = host.sanitizeSettings({ dim: 999, blur: -5, surface: 500, sidebarDelta: -1 });
    assert.equal(settings.dim, 80);
    assert.equal(settings.blur, 0);
    assert.equal(settings.surface, 100);
    assert.equal(settings.sidebarDelta, 0);
  });

  it('类型不对的字段不采纳', () => {
    const settings = host.sanitizeSettings({ enabled: 'yes', folder: 42, disableSkin: 'nope' });
    assert.equal(settings.enabled, host.DEFAULT_SETTINGS.enabled);
    assert.equal(settings.folder, host.DEFAULT_SETTINGS.folder);
    assert.equal(settings.disableSkin, host.DEFAULT_SETTINGS.disableSkin);
  });
});

describe('listImages', () => {
  it('列出位图与视频，跳过非媒体文件与子目录', () => {
    const result = host.listImages(library);
    assert.equal(result.ok, true);
    assert.deepEqual(result.images.map((image) => image.name), ['a.png', 'b.jpg', 'c.mp4', 'd.webm']);
  });

  it('每项带 kind，视频与静态图能区分开', () => {
    const kinds = Object.fromEntries(host.listImages(library).images.map((image) => [image.name, image.kind]));
    assert.equal(kinds['a.png'], 'image');
    assert.equal(kinds['c.mp4'], 'video');
    assert.equal(kinds['d.webm'], 'video');
  });

  it('中文目录名不会被破坏（回归：GBK/UTF-8 混淆）', () => {
    const result = host.listImages(library);
    assert.equal(result.folder, library);
    assert.equal(result.folder.includes('\uFFFD'), false);
  });

  it('空路径、不存在的目录、指向文件的路径都返回错误而不是抛异常', () => {
    assert.equal(host.listImages('').ok, false);
    assert.equal(host.listImages('   ').ok, false);
    assert.equal(host.listImages(join(library, 'nope')).ok, false);
    assert.equal(host.listImages(join(library, 'note.txt')).ok, false);
  });
});

describe('resolveWallpaper', () => {
  it('解析目录内的位图并给出真实大小', () => {
    const target = host.resolveWallpaper(library, 'a.png');
    assert.equal(target?.mime, 'image/png');
    assert.equal(target?.size, statSync(join(library, 'a.png')).size);
  });

  it('视频给出 video/* MIME（客户端据此走 <video>）', () => {
    assert.equal(host.resolveWallpaper(library, 'c.mp4')?.mime, 'video/mp4');
    assert.equal(host.resolveWallpaper(library, 'd.webm')?.mime, 'video/webm');
  });

  const refusals = [
    ['路径穿越', '../secret.jpg'],
    ['子目录', join('subfolder', 'x.jpg')],
    ['非位图', 'note.txt'],
    ['空文件名', ''],
    ['无扩展名', 'a'],
  ];
  for (const [label, name] of refusals) {
    it(`拒绝${label}：${JSON.stringify(name)}`, () => {
      assert.equal(host.resolveWallpaper(library, name), null);
    });
  }
});

describe('内置壁纸库（@builtin）', () => {
  it('@builtin 解析到包内的 wallpapers/ 并列出示例图', () => {
    const result = host.listImages(host.BUILTIN_FOLDER);
    assert.equal(result.ok, true, result.ok ? '' : result.error);
    assert.ok(result.images.length > 0, '包内应带示例壁纸');
    assert.ok(result.folder.endsWith('wallpapers'), `解析到了 ${result.folder}`);
  });

  it('@builtin 里的图能被解析并给出位图 MIME', () => {
    const first = host.listImages(host.BUILTIN_FOLDER).images[0];
    const target = host.resolveWallpaper(host.BUILTIN_FOLDER, first.name);
    assert.notEqual(target, null);
    assert.ok(target.mime.startsWith('image/'), target.mime);
  });

  it('@builtin 一样受目录约束：拒绝穿越与子目录', () => {
    assert.equal(host.resolveWallpaper(host.BUILTIN_FOLDER, '../package.json'), null);
    assert.equal(host.resolveWallpaper(host.BUILTIN_FOLDER, 'sub/x.jpg'), null);
  });
});

describe('HTTP 路由（假 ctx 驱动真 handler）', () => {
  const { ctx, routes, warnings, dispose } = fakeContext();
  host.apply(ctx);

  it('注册了全部 5 条路由', () => {
    assert.deepEqual(
      [...routes.keys()].sort(),
      [host.LOAD_ROUTE, host.SAVE_ROUTE, host.PICK_ROUTE, host.LIST_ROUTE, host.IMG_ROUTE].sort(),
    );
  });

  it('GET /load 返回设置对象', async () => {
    const res = await call(routes.get(host.LOAD_ROUTE), { url: host.LOAD_ROUTE });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(typeof res.json.settings, 'object');
  });

  it('POST /save 落盘，且回读与提交值一致', async () => {
    const res = await call(routes.get(host.SAVE_ROUTE), {
      method: 'POST',
      url: host.SAVE_ROUTE,
      body: { settings: { enabled: true, folder: library, surface: 42 } },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.settings.surface, 42);
    const onDisk = JSON.parse(readFileSync(settingsFile, 'utf8'));
    assert.equal(onDisk.settings.folder, library);
    assert.equal(onDisk.settings.enabled, true);
  });

  it('GET /list 用已保存的文件夹', async () => {
    const res = await call(routes.get(host.LIST_ROUTE), { url: host.LIST_ROUTE });
    assert.equal(res.status, 200);
    assert.equal(res.json.images.length, 4);
  });

  it('GET /list?folder=… 覆盖已保存的文件夹', async () => {
    const other = join(sandbox, '另一个库');
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, 'only.webp'), Buffer.alloc(8));
    const res = await call(routes.get(host.LIST_ROUTE), {
      url: `${host.LIST_ROUTE}?folder=${encodeURIComponent(other)}`,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.images.map((image) => image.name), ['only.webp']);
  });

  it('GET /list 指向不存在的目录 → 400', async () => {
    const res = await call(routes.get(host.LIST_ROUTE), {
      url: `${host.LIST_ROUTE}?folder=${encodeURIComponent(join(library, 'nope'))}`,
    });
    assert.equal(res.status, 400);
    assert.equal(res.json.ok, false);
  });

  it('GET /img 流式返回原图字节与 MIME', async () => {
    const res = await call(routes.get(host.IMG_ROUTE), { url: `${host.IMG_ROUTE}?name=a.png` });
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'image/png');
    assert.equal(res.headers['content-length'], '32');
    assert.equal(res.headers['accept-ranges'], 'bytes');
    assert.equal(Buffer.concat(res.chunks).length, 32);
  });

  it('GET /img 视频支持 Range → 206 + Content-Range（拖动/续播的前提）', async () => {
    const res = await call(routes.get(host.IMG_ROUTE), {
      url: `${host.IMG_ROUTE}?name=c.mp4`,
      headers: { range: 'bytes=0-9' },
    });
    assert.equal(res.status, 206);
    assert.equal(res.headers['content-type'], 'video/mp4');
    assert.equal(res.headers['content-range'], 'bytes 0-9/64');
    assert.equal(res.headers['content-length'], '10');
    const body = Buffer.concat(res.chunks);
    assert.equal(body.length, 10);
    assert.deepEqual([...body], Array.from({ length: 10 }, () => 1));
  });

  it('GET /img 开区间 Range（bytes=N-）返回尾部', async () => {
    const res = await call(routes.get(host.IMG_ROUTE), {
      url: `${host.IMG_ROUTE}?name=c.mp4`,
      headers: { range: 'bytes=54-' },
    });
    assert.equal(res.status, 206);
    assert.equal(res.headers['content-range'], 'bytes 54-63/64');
    assert.equal(Buffer.concat(res.chunks).length, 10);
  });

  it('GET /img 越界 Range → 416，且带 bytes */size', async () => {
    const res = await call(routes.get(host.IMG_ROUTE), {
      url: `${host.IMG_ROUTE}?name=c.mp4`,
      headers: { range: 'bytes=999-' },
    });
    assert.equal(res.status, 416);
    assert.equal(res.headers['content-range'], 'bytes */64');
  });

  it('GET /img 非法/多段 Range 退回整段 200，不报错', async () => {
    for (const range of ['bytes=0-1,5-6', 'items=0-1', 'bytes=abc']) {
      const res = await call(routes.get(host.IMG_ROUTE), {
        url: `${host.IMG_ROUTE}?name=c.mp4`,
        headers: { range },
      });
      assert.equal(res.status, 200, `应退回整段：${range}`);
      assert.equal(Buffer.concat(res.chunks).length, 64);
    }
  });

  it('GET /img 拒绝穿越与越界名 → 404', async () => {
    for (const name of ['../secret.jpg', 'subfolder/x.jpg', 'note.txt']) {
      const res = await call(routes.get(host.IMG_ROUTE), {
        url: `${host.IMG_ROUTE}?name=${encodeURIComponent(name)}`,
      });
      assert.equal(res.status, 404, `应拒绝 ${name}`);
    }
  });

  it('方法不匹配 → 405', async () => {
    const res = await call(routes.get(host.LOAD_ROUTE), { method: 'POST', url: host.LOAD_ROUTE });
    assert.equal(res.status, 405);
  });

  it('跨站来源 → 403', async () => {
    const res = await call(routes.get(host.LOAD_ROUTE), {
      url: host.LOAD_ROUTE,
      headers: { origin: 'https://evil.example' },
    });
    assert.equal(res.status, 403);
  });

  it('回环来源照常放行', async () => {
    const res = await call(routes.get(host.LOAD_ROUTE), {
      url: host.LOAD_ROUTE,
      headers: { origin: 'http://127.0.0.1:19387' },
    });
    assert.equal(res.status, 200);
  });

  it('超大 body → 413', async () => {
    const res = await call(routes.get(host.SAVE_ROUTE), {
      method: 'POST',
      url: host.SAVE_ROUTE,
      body: { settings: { folder: 'x'.repeat(300 * 1024) } },
    });
    assert.equal(res.status, 413);
  });

  it('缺 settings 字段 → 400', async () => {
    const res = await call(routes.get(host.SAVE_ROUTE), {
      method: 'POST',
      url: host.SAVE_ROUTE,
      body: { nope: true },
    });
    assert.equal(res.status, 400);
  });

  it('disposer 会注销全部路由', () => {
    assert.equal(routes.size, 5);
    dispose()();
    assert.equal(routes.size, 0);
  });

  it('没有 webServer 服务时只警告、不抛异常', () => {
    const bare = fakeContext({ withWebServer: false });
    assert.doesNotThrow(() => host.apply(bare.ctx));
    assert.equal(bare.routes.size, 0);
    assert.equal(bare.warnings.length, 1);
  });
});
