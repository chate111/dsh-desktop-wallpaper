/**
 * dsh-desktop-wallpaper — 浏览器半区测试（node:test，零依赖）。
 *
 * 手法：把 `window.__ModuleLoader__` 换成桩，捕获 factory 的返回值；
 * 再给一个刚好够 `captureOriginals()` / `detectSidebarScope()` 用的最小 DOM，
 * 于是可以在 Node 里直接断言**真实生成的样式表**。
 *
 * 不调用 `apply()` —— 那会真的去改 DOM、请求宿主路由并挂 MutationObserver。
 *
 * 这里锁住的是三件曾经踩过的事：
 *   1. 表面 token 必须整块重复声明（在 body 与侧栏绘制元素上各一遍）；
 *   2. 顶部 `[class*="frame"]::before` 必须被压回**不透明**，否则壁纸从菜单栏渗出；
 *   3. 内容列左上角圆角必须改成直角，否则露出与顶栏对不上的缝。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/** 主题里那些表面 token 的“采样值”。 */
const THEME_COLOR = 'rgb(24, 28, 42)';
/** 故意让一个 token 不是颜色，用来验证会被跳过。 */
const NON_COLOR_TOKEN = '--dsw-specific-sidebar-fill-shadow';

let client;
let sampledTokens;

/** 采样式：宿主半区读的是 `window.getComputedStyle`，全局那个也一并挂上以防万一。 */
const computedStyleStub = {
  getPropertyValue: (token) => (token === NON_COLOR_TOKEN ? '12px' : THEME_COLOR),
};

globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      assert.equal(id, 'dsh-desktop-wallpaper');
      client = factory();
    },
  },
  getComputedStyle: () => computedStyleStub,
};

/** 可被 `element.matches()` 识别的假侧栏元素。 */
const fakeSidebar = {
  matches: (selector) => /sidebar/i.test(String(selector)),
  getAttribute: () => null,
  setAttribute() {},
  querySelector: () => null,
};

globalThis.document = {
  documentElement: {
    attributes: {},
    setAttribute() {},
    removeAttribute() {},
    hasAttribute: () => true,
  },
  head: { appendChild() {} },
  body: { appendChild() {}, removeChild() {} },
  createElement() {
    return {
      style: {},
      textContent: '',
      setAttribute() {},
      remove() {},
      appendChild() {},
    };
  },
  querySelector: (selector) => (/sidebar/i.test(String(selector)) ? fakeSidebar : null),
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
};

globalThis.getComputedStyle = () => computedStyleStub;

await import('../lib/client.js');

const internals = client.__internals;

describe('模块契约', () => {
  it('导出 apply / inject，且不硬依赖任何服务', () => {
    assert.equal(typeof client.apply, 'function');
    assert.deepEqual(client.inject, []);
  });

  it('暴露测试用的内部成员', () => {
    for (const key of ['DEFAULT_SETTINGS', 'SURFACE_TOKENS', 'SIDEBAR_DARKEN', 'sanitize', 'sidebarSurface', 'translucent', 'darken', 'kindOf', 'VIDEO_LAYER_CSS', 'pageCount', 'PAGE_SIZE', 'buildStylesheet'])
      assert.ok(key in internals, `缺少 ${key}`);
  });

  it('默认文件夹是内置示例图（装完打开面板就有图可点）', () => {
    assert.equal(internals.DEFAULT_SETTINGS.folder, '@builtin');
    assert.equal(internals.sanitize({}).folder, '@builtin');
  });
});

describe('pageCount', () => {
  it('每页 3 列 × 5 行 = 15 个', () => {
    assert.equal(internals.PAGE_SIZE, 15);
  });

  it('空库算 1 页，正好一页不多算', () => {
    assert.equal(internals.pageCount(0), 1);
    assert.equal(internals.pageCount(1), 1);
    assert.equal(internals.pageCount(15), 1);
    assert.equal(internals.pageCount(16), 2);
  });

  it('127 个（9 自带 + 118 索引）→ 9 页', () => {
    assert.equal(internals.pageCount(127), 9);
  });
});

describe('translucent', () => {
  it('100% 原样返回，0% 直接透明', () => {
    assert.equal(internals.translucent(THEME_COLOR, 100), THEME_COLOR);
    assert.equal(internals.translucent(THEME_COLOR, 0), 'transparent');
  });

  it('中间值用 color-mix 现算，不硬编码调色板', () => {
    assert.equal(internals.translucent(THEME_COLOR, 66), `color-mix(in srgb, ${THEME_COLOR} 66%, transparent)`);
  });
});

describe('darken', () => {
  it('0 不改变，20 就是往黑里混 20%', () => {
    assert.equal(internals.darken(THEME_COLOR, 0), THEME_COLOR);
    assert.equal(internals.darken(THEME_COLOR, 20), `color-mix(in srgb, ${THEME_COLOR} 80%, #000)`);
  });

  it('可以套在 translucent 外面（侧栏实际用法）', () => {
    assert.equal(
      internals.darken(internals.translucent(THEME_COLOR, 81), 20),
      `color-mix(in srgb, color-mix(in srgb, ${THEME_COLOR} 81%, transparent) 80%, #000)`,
    );
  });
});

describe('VIDEO_LAYER_CSS', () => {
  const css = internals.VIDEO_LAYER_CSS;

  it('替换元素必须有显式宽高（回归：视频缩在左上角、只显示一部分）', () => {
    assert.match(css, /width:calc\(100% \+ 80px\)/);
    assert.match(css, /height:calc\(100% \+ 80px\)/);
    assert.match(css, /object-fit:cover/);
    assert.match(css, /object-position:center center/);
    assert.doesNotMatch(css, /inset:-40px/, '<video> 是替换元素，只写 inset 会被忽略');
  });

  it('过扫描与图片层一致（-40px），模糊后不留硬边', () => {
    assert.match(css, /left:-40px/);
    assert.match(css, /top:-40px/);
  });
});

describe('posterUrl', () => {
  it('带 #t=0.1 媒体片段（浏览器据此绘制首帧）', () => {
    assert.equal(internals.posterUrl('a.mp4'), '/dsh-desktop-wallpaper/img?name=a.mp4#t=0.1');
  });

  it('中文与空格照常转义，片段在 # 之后', () => {
    const url = internals.posterUrl('我的 视频.webm');
    assert.ok(url.endsWith('#t=0.1'), url);
    assert.equal(url.includes(' '), false, '空格必须被转义');
    assert.ok(url.includes('%E6%88%91'), '中文必须被转义');
  });
});

describe('sidebarSurface', () => {
  it('侧栏 = 主区 + delta（默认 66 + 15）', () => {
    assert.equal(internals.sidebarSurface(), 81);
  });
});

describe('kindOf', () => {
  it('mp4 / webm 走 <video>', () => {
    assert.equal(internals.kindOf('a.mp4'), 'video');
    assert.equal(internals.kindOf('B.WEBM'), 'video');
  });

  it('位图走 CSS 背景，含无扩展名与点号在中间的名字', () => {
    assert.equal(internals.kindOf('a.jpg'), 'image');
    assert.equal(internals.kindOf('动图.gif'), 'image');
    assert.equal(internals.kindOf('no-extension'), 'image');
    assert.equal(internals.kindOf('v1.2.mp4'), 'video');
  });
});

describe('sanitize', () => {
  it('越界值被夹紧', () => {
    const settings = internals.sanitize({ surface: 500, sidebarDelta: -20, dim: 999, blur: 99 });
    assert.equal(settings.surface, 100);
    assert.equal(settings.sidebarDelta, 0);
    assert.equal(settings.dim, 80);
    assert.equal(settings.blur, 24);
  });
});

describe('buildStylesheet', () => {
  const css = internals.buildStylesheet();

  it('所有规则都在插件自己的 gate 下', () => {
    const rules = css.split('\n').filter((line) => line.trim() !== '');
    assert.ok(rules.length >= 4);
    for (const rule of rules)
      assert.ok(rule.startsWith('html[data-dwp-active]'), `规则未加 gate: ${rule.slice(0, 60)}`);
  });

  it('body 与侧栏各自整块重声明表面 token（alpha 不同）', () => {
    assert.ok(css.includes(`html[data-dwp-active] body { --`));
    assert.ok(css.includes(`${THEME_COLOR} 66%, transparent`), '主区应为 66%');
    assert.ok(css.includes(`[class*="sidebarCol"] { --`), '侧栏规则应落在真正绘制的元素上');
    assert.ok(css.includes(`${THEME_COLOR} 81%, transparent`), '侧栏应为 81%');
  });

  it('侧栏额外压暗 20%（回归：本次优化）', () => {
    const sidebarRule = css.split('\n').find((line) => line.includes('[class*="sidebarCol"] {'));
    assert.ok(sidebarRule !== undefined);
    assert.ok(sidebarRule.includes('80%, #000'), '侧栏应混入 20% 纯黑');
    assert.ok(!css.split('\n').find((line) => line.includes('html[data-dwp-active] body { --')).includes('#000'), '主区不应被压暗');
  });

  it('只有输入卡片被钉回不透明（回归：正文透过输入框 / 底部黑幕）', () => {
    const composerRule = css.split('\n').find((line) => line.includes('[class*="composer"] {'));
    assert.ok(composerRule !== undefined, '应有输入区作用域的规则');
    assert.ok(composerRule.includes(`--dsw-specific-input-major: ${THEME_COLOR} !important`), '输入卡片应为主题原色');
    assert.ok(!composerRule.includes('--dsw-alias-bg-base'), '渐变遮罩的终点色不得被钉住，否则输入区上方变成黑板');
    assert.ok(!composerRule.includes('color-mix'), '输入卡片不得半透明');
    assert.ok(!composerRule.includes('#000'), '输入卡片不应被压暗');
  });

  it('设置面板 / 弹窗被压回不透明（回归：设置页透出聊天记录）', () => {
    const overlayRule = css.split('\n').find((line) => line.includes('[role="dialog"]'));
    assert.ok(overlayRule !== undefined, '应有弹层作用域的规则');
    assert.ok(overlayRule.includes(`: ${THEME_COLOR} !important`), '弹层应写回主题原色');
    assert.ok(!overlayRule.includes('color-mix'), '弹层不得半透明');
    assert.ok(!overlayRule.includes('#000'), '弹层不应被压暗');
    // 弹层规则不能污染主区：gate 之后紧跟的是弹层选择器，而不是 body。
    assert.ok(!overlayRule.includes('] body '), '弹层规则不得作用到 body');
  });

  it('顶栏 ::before 被压回不透明（需求①）', () => {
    const strip = css.split('\n').find((line) => line.includes('::before'));
    assert.ok(strip !== undefined);
    assert.ok(strip.includes('background: rgb(24, 28, 42) !important'), '顶栏底色必须是不透明的主题原色');
    assert.ok(!strip.includes('color-mix'), '顶栏不得半透明');
  });

  it('内容列左上角圆角改成直角（回归：小角缝隙）', () => {
    assert.ok(css.includes('--dsh-windows-content-radius: 0px !important'));
  });

  it('抬升 #root 让背景层位于应用之下', () => {
    assert.ok(css.includes('z-index: 1 !important'));
    assert.ok(css.includes('z-index: -1') === false, '不得用负 z-index（DSH 里不绘制）');
  });

  it('启用时隐藏皮肤图层（避免两层背景打架）', () => {
    assert.ok(css.includes('div[data-wx-skin-layer]'));
    assert.ok(css.includes('display: none !important'));
  });

  it('说明文字不带底色（回归：导入按钮下面那块白底）', () => {
    const start = internals.BASE_CSS.indexOf('.dsw-wp-note');
    assert.ok(start >= 0, '缺少 .dsw-wp-note 规则');
    const rule = internals.BASE_CSS.slice(start, internals.BASE_CSS.indexOf('}', start));
    assert.ok(rule.includes('background: none'), rule);
    assert.ok(!rule.includes('panel-soft'), '说明条不得再铺 panel-soft 底色');
  });

  it('面板不再有厚黑投影（回归：四周那圈黑边）', () => {
    assert.ok(internals.BASE_CSS.includes('box-shadow: none'), '面板投影应关掉');
    assert.equal(internals.BASE_CSS.includes('0 18px 48px'), false, '旧的 48px 黑影不得回来');
  });

  it('非颜色的 token 被跳过而不是写进无效 CSS', () => {
    assert.equal(css.includes(NON_COLOR_TOKEN), false);
  });
});
