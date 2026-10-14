# 🖼️ dsh-desktop-wallpaper

[![CI](https://github.com/chate111/dsh-desktop-wallpaper/actions/workflows/ci.yml/badge.svg)](https://github.com/chate111/dsh-desktop-wallpaper/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)

**DSH 桌面端壁纸插件** —— 侧栏「新会话」下方一个「壁纸」入口，点开面板选一个**本地文件夹**当壁纸库、
在里面手动点选图片，并用 **暗化 / 模糊 / 透出** 三条滑杆实时调效果。
表面透明度**按区域分开**：顶部菜单栏完全不透，左侧栏比主内容区少透出 15% 并额外压暗 20%。

**零依赖、零构建**：`lib/` 即源码，没有 `peerDependencies`，不需要打包步骤。

---

## 目录

- [功能](#-功能)
- [安装 / 卸载](#-安装--卸载)
- [使用](#-使用)
- [工作原理](#-工作原理)
- [测试](#-测试)
- [项目结构](#-项目结构)
- [兼容性](#-兼容性)
- [License](#-license)

---

## ✨ 功能

- **侧栏入口**：插在「新会话」按钮正下方（找不到就退到「侧边对话」上方，再不行进设置面板）。
  用 `MutationObserver` 自愈重挂，侧栏重渲染后不会丢。
- **壁纸库 = 本地文件夹**：`选择文件夹` 走 Windows 原生目录对话框；也可以直接把路径粘进输入框
  （例如 `D:\dsh背景`）。文件夹里的 jpg / jpeg / png / webp / gif / bmp / avif 都会被列出。
- **手动点选**：面板里是缩略图网格，点哪张用哪张；当前选中的显示大图预览。
- **三条滑杆**：`暗化 0–80%`、`模糊 0–24px`、`透出 0–100%`，拖动即时生效。
- **分区透出**：

  | 区域 | 透出值 |
  |---|---|
  | ① 顶部「应用 / 编辑」菜单栏 | **不参与**，恒定完全不透 |
  | ② 左侧栏 | 主区 **+15%**（更实、壁纸更少），并再往黑里混 **20%** |
  | ③ 主内容区 | 滑杆基准值（默认 66%） |
  | ④ 底部输入卡片 | **不参与**，恒定完全不透（正文滚过时不会从输入框里透出来） |

- **自动关闭皮肤**：启用壁纸时把 `dsh-wx-skin` 的背景层隐藏，避免两层背景打架（可关掉这个开关）。
- **持久化**：设置写到 `$DSH_HOME/dsh-desktop-wallpaper.settings.json`（`localStorage` 作镜像兜底），
  刷新、重启、换端口都自动恢复。

---

## 📦 安装 / 卸载

插件必须装进**桌面端自己的 profile**（`$DSH_HOME/profiles/desktop`）。

### 方式一：应用内的安装向导（推荐）

1. 打开桌面端 → **设置 → 插件 → 安装**；
2. 粘贴本插件的**绝对路径**（`link:` / `file:` 前缀与裸路径都被接受）：
   ```text
   D:\deepseek harness\dsh-desktop-wallpaper
   ```
   也可以粘贴 npm 包名或 tarball 路径；
3. 向导会把依赖写进 profile 并**同步层栈**（`dsh.profile.bundles`）——
   只声明了 `dsh.bundle.patch` 的依赖才属于层栈。

### 方式二：应用自带的 CLI

桌面端内置了一份放开 desktop profile 的 CLI（普通 `dsh` 会拒绝该 profile）：

```sh
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" `
    plugin --profile desktop add "link:D:\deepseek harness\dsh-desktop-wallpaper"
```

### 方式三：手工两步（等价做法）

```sh
# 1) 装成本地 link 依赖
cd D:\DSH\home\profiles\desktop
pnpm add "link:D:\deepseek harness\dsh-desktop-wallpaper"

# 2) 手动把包名加进 package.json 的 dsh.profile.bundles
#    （少了这一步插件不会被加载：装了但不生效的典型症状）
```

### 生效与验证

宿主半区的路由在**启动时**确定，改完宿主代码要重启应用；只改浏览器半区刷新一次界面（Ctrl+R）即可。

```sh
curl "http://127.0.0.1:19387/dsh-desktop-wallpaper/load"
# {"ok":true,"settings":{...}}      ← 返回 200 就说明插件行已被加载
```

（端口以实际监听的为准，桌面端换端口是正常的。）

### 卸载

```sh
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" `
    plugin --profile desktop remove dsh-desktop-wallpaper
```

---

## 🎛️ 使用

1. 点侧栏的 **「壁纸」** 打开面板；
2. **选库**：点 `选择文件夹`（原生对话框），或把绝对路径粘进输入框后点 `使用`；换过库之后点 `重扫` 刷新列表；
3. **选图**：在缩略图网格里点任意一张 —— 立即铺满窗口，并记住这一张；
4. **调效果**：拖 `暗化` / `模糊` / `透出` 三条滑杆；
5. `恢复默认` 一键还原（包含文件夹路径）。

面板底部那行会实时显示当前的分区数值，例如：

> 主内容区 透出 66% ／ 左侧栏 81%（比主区少透出 15%、再暗 20%）／ 顶部菜单栏保持主题原色、完全不透

---

## ⚙️ 工作原理

### 形态

外部 client 插件（cordis bundle）：

- `dsh.bundle.patch` → `cordis.patch.yml` 往 profile 名单里插一行；
- `dsh.client.platform: "web"` + `exports["./client"]` → 浏览器半区由 client-modules 在
  `/plugins/dsh-desktop-wallpaper/client.js` 提供，模块约定是 `window.__ModuleLoader__.load({ id, factory })`，
  导出 `apply` 与 `inject`；
- `exports["."]` → 宿主半区（普通 ESM），用 `inject: ['webServer']` +
  `ctx.get('webServer').register({ kind: 'exact', path, handler })` 注册 5 条回环路由，包在 `ctx.effect(...)` 里。

### 为什么图片由宿主直接服务，而不是转 data URL

一次把整个文件夹读进浏览器意味着要么全部 base64（几 MB 一张，`localStorage` 必炸），
要么每次启动重新选文件夹。宿主半区改为：

```
GET /dsh-desktop-wallpaper/list?folder=…   扫描文件夹里的位图
GET /dsh-desktop-wallpaper/img?name=…      按原名流式返回**原图**
```

于是「一个文件夹路径」就是全部状态：原图不失真、不限数量、不占浏览器存储，重启后自动恢复。

`/img` 只服务目录直属的位图文件名（不含分隔符、不含 `..`、扩展名在白名单内），
其余一律 404 —— 这条路由无法被当成任意文件读取用。

### 分区透明度是怎么做的

DSH 主题把 `--dsw-alias-bg-*` / `--dsw-specific-*` 这组表面 token 声明在 **`body`** 上。
CSS 自定义属性在**声明它的那个元素上就完成 `var()` 替换**，后代继承的是替换好的颜色 ——
所以**在侧栏容器上改一个「透明度标量」是没用的**。

本插件的做法是把**整块 token 声明重复两遍**（在 `document.body` 上采样主题原色，
再用 `color-mix(in srgb, <原色> N%, transparent)` 现算，因此不硬编码明暗两套色板）：

```css
html[data-dwp-active] body                  { --dsw-…: color-mix(in srgb, … 66%, transparent) !important; }
html[data-dwp-active] [class*="sidebarCol"] { --dsw-…: color-mix(in srgb, color-mix(in srgb, … 81%, transparent) 80%, #000) !important; }
```

侧栏那一条落在**真正绘制侧栏背景的元素**上（`[class*="sidebarCol"]`，其背景消费
`--dsw-specific-sidebar-fill`），子树里的表面因此各自拿到自己的 alpha。
外层 `color-mix(… 80%, #000)` 就是「比主区再黑 20%」。

五个必须注意的坑（都是实测踩出来的）：

1. **采样前必须先清空自己的样式表**，否则读到的是自己上一次写入的半透明值，每次重建都会累积透明度。
2. **token 在 `body` 上，不在 `:root`** —— 读 `documentElement` 会得到空字符串，功能静默失效。
3. **顶部 `[class*="frame"]::before` 也用 `--dsw-specific-sidebar-fill`**（Windows 上那条 40px 拖拽条的底色）。
   一旦把这个 token 调成半透明，壁纸就会从顶部菜单栏渗出来 —— 所以插件把这条 `::before` 显式压回**不透明**。
4. **内容列左上角那唯一的 16px 圆角**会把 frame 的半透明背景露成一块小角，
   与不透明的顶栏对不上。frame 必须保持半透明（侧栏背后的壁纸要透出来），
   所以插件改用应用自己发布的 `--dsh-windows-content-radius` 把那个角改成直角，与其余三角一致。
5. **底部输入区上方有一条官方渐变遮罩**（`.composerSeat` 的 `linear-gradient`，终点色是
   `--dsw-alias-bg-base`），用来让正文在到达输入框前淡出。整块 token 变半透明后，
   **输入卡片**（`.card` 的 `background: var(--dsw-specific-input-major)`）也跟着变透，
   滚过的正文就从输入框里透出来 —— 所以只把**这一个 token**钉回主题原色，
   遮罩保持半透明（它的任务就是淡出正文，同时让壁纸在输入区后面继续可见）。
   这与顶栏是同一种手法：照抄官方已经用上的元素作用域与 token，而不是另写一套。

### 入口位置

桌面端 0.2.0-rc.2 里 **没有 `[data-pane="sidebar"]`**（皮肤插件的 README 仍这么写，但那选择器在该版本是死的）。
插件用实测有效的钩子定位：

```js
[class*="sidebarCol"] → [class*="logoRow"] 的父元素 → button[class*="newSession"] → insertBefore(entry, anchor.nextElementSibling)
```

入口的盒模型按宿主原生行的数值写死（`min-height:36px` / `margin:0 2px` / `padding:7px 8px` /
`border:none` / `font:inherit`），否则会和原生行错位（内容左边距 19px vs 10px）。

---

## 🧪 测试

零依赖，只用 `node:test`：

```sh
npm run check   # 两个半区的语法检查
npm test        # 44 项断言（宿主 27 + 浏览器 17）
```

- **宿主半区**：纯函数（`sanitizeSettings` / `listImages` / `resolveWallpaper`）＋
  用假 cordis ctx 驱动**真实 handler** —— 5 条路由注册、设置往返落盘、原图流式返回与 MIME、
  路径穿越拒绝、`405 / 403 / 400 / 404 / 413`、disposer 注销、缺 `webServer` 时只警告不抛异常。
  `/pick` 只断言"注册了" —— 真调它会弹出原生对话框。
- **浏览器半区**：`window.__ModuleLoader__` 与最小 DOM 桩，捕获 factory 返回值后断言
  `translucent` / `darken` / `sidebarSurface` / `sanitize`，
  以及**真实生成的样式表**（分区 alpha、侧栏压暗、顶栏不透明、圆角直角、`#root` 抬升、皮肤图层隐藏）。
  不调用 `apply()` —— 那会真的改 DOM 并请求宿主。

两个测试文件都把 `DSH_HOME` 指向临时目录，**不会读写机器上真实的设置文件**。

> 本机若在受限沙箱里跑 `npm test`（`node --test` 需要 spawn 子进程拿管道），可能报 `spawn EPERM`；
> 此时直接跑文件即可：`node test/host.test.mjs && node test/client.test.mjs`。

---

## 📁 项目结构

```
dsh-desktop-wallpaper/
├── package.json            # dsh.bundle.patch + dsh.client.platform，无 peerDependencies
├── cordis.patch.yml        # 往 profile 名单插入 ui-dsh-desktop-wallpaper 一行
├── lib/
│   ├── index.js            # 宿主半区：5 条回环路由 + 原生目录对话框 + 原子写设置
│   └── client.js           # 浏览器半区：侧栏入口 / 面板 / 背景层 / 分区 token
├── test/
│   ├── host.test.mjs       # 宿主：纯函数 + 假 ctx 驱动真 handler
│   └── client.test.mjs     # 浏览器：模块与 DOM 桩 + 生成的样式表断言
├── .github/workflows/ci.yml
├── CHANGELOG.md
├── LICENSE
└── README.md
```

---

## ⚠️ 兼容性

针对 **DSH desktop profile 0.2.0-rc.2** 实测。

侧栏入口依赖 shell 的 class 钩子（`sidebarCol` / `logoRow` / `newSession`）—— 这些是**哈希类名的一部分，
版本升级可能变化**。若某次升级后入口不出现，插件只会在控制台记一条 warn，不影响 GUI，
改 `SIDEBAR_COLUMN_SELECTORS` / `NEW_SESSION_SELECTORS` 即可。

分区透明度依赖 `--dsw-*` 表面 token 的**名称**；若上游改名，token 采样会拿不到值，
此时插件会警告并保持主题原样（不会写出无效 CSS）。

---

## 📄 License

[MIT](LICENSE) © 2026 chate111
