# Changelog

本插件的所有值得记录的改动。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.2.0] — 2026-10-25

### 新增

- **视频壁纸**：`mp4` / `webm` 现在和图片一样能当壁纸。
  - 背景层多一个 `<video muted loop playsinline autoplay>`（同样 `inset:-40px` 过扫描），
    `暗化` 走 scrim、`模糊` 走 `filter`，和图片的行为一致。
  - 只有 `src` 真的换了才重新加载 —— `applyVisuals()` 在切主题时也会跑，
    否则每次切主题都会把视频重启一遍。
  - 关闭壁纸 / 切回图片时 `pause()` 并清掉 `src`，不留在后台解码。
- **宿主 `/img` 支持 `Range`**：206 分段、416 越界（带 `bytes */size`）、
  后缀区间（`bytes=-512`）、非法或多段请求退回整段 200，一律带 `accept-ranges: bytes`。
  视频拖进度、快速起播、不整段读进内存都靠它。
- **`/list` 每项带 `kind`**（`image` / `video`），客户端据此决定用 CSS 背景还是 `<video>`。
- **面板**：视频显示为 ▶ 磁贴（刻意不预加载 —— Wallpaper Engine 库里动辄上百个视频，
  一格一个 `<video>` 会立刻发几百个请求）；选中后在预览区直接播放，标题带文件大小。

### 测试

- 56 项（宿主 36 + 浏览器 20）。新增：视频 MIME、`kind` 分流、`Range` 四类分支、
  `kindOf` 的扩展名边界（大写、无扩展名、`v1.2.mp4`）。
- 另做过一次真实文件集成验证：拿 Wallpaper Engine 库里真实的 mp4/webm 起真 HTTP 服务，
  逐段比对字节与 `Content-Range`。

### 文档

- README 补「支持的壁纸格式」表：能播的（H.264 mp4 / VP8·VP9 webm）、
  需要系统编解码器的（HEVC）、以及明确**不支持**的（WE 的 `.pkg` 场景包）。

## [0.1.1] — 2026-10-24

### 修复

- **设置面板 / 弹窗跟着透出壁纸**：壁纸打开后整个窗口的表面 token 都被换成半透明，
  而这些弹层是 portal 到 `#root` 之外的，于是继承了同一套 token —— 设置页正对着聊天记录，
  底下的字透上来基本没法读。现在给弹层（`settingsModal` / `*Dialog` / `[role="dialog"]` / `*modal` 等）
  单独写回主题的**原始不透明值**，且只作用于弹层作用域，主区的透出不受影响。
- **测试**：补一条回归断言，锁住「弹层规则存在、是不透明原色、不含 `color-mix`」（47 → 48 项）。

### 文档

- npm 页面上的安装说明换成真实可用的一种：`dsh plugin --profile desktop add dsh-desktop-wallpaper`
  （0.1.0 的 tarball 里那份 README 还停留在「粘贴本机绝对路径」的开发版说明，照着做必然失败）。
- 界面预览的两张截图随本版进入 npm 页面（此前只在 GitHub 仓库里）。

## [0.1.0] — 2026-10-15

首次发布。以下为发布前完成的全部工作。

### 新增

- **侧栏入口**：插在「新会话」正下方，找不到时依次降级到「侧边对话」上方、设置面板内。
  挂载点用 `MutationObserver` 自愈重挂，侧栏重渲染后不丢。
- **壁纸库 = 本地文件夹**：`选择文件夹` 走 Windows 原生目录对话框（`FolderBrowserDialog`，
  PowerShell `-STA`），也可直接粘贴绝对路径。支持 jpg / jpeg / png / webp / gif / bmp / avif。
- **手动点选**：面板内缩略图网格，点哪张用哪张，当前选中显示大图预览。
- **三条滑杆**：暗化 0–80% / 模糊 0–24px / 透出 0–100%，拖动即时生效。
- **分区透出**：顶部原生菜单栏恒定完全不透；左侧栏比主内容区少透出（默认 +15%）并额外压暗 20%。
- **自动关闭皮肤**：启用壁纸时隐藏 `dsh-wx-skin` 的背景层，避免两层背景打架（可关）。
- **宿主直供原图**：`/list` 扫描文件夹、`/img` 按原名流式返回原图，
  因此整个壁纸库的状态只是「一个文件夹路径」——不失真、不限数量、不占浏览器存储。
- **9 张内置示例壁纸**（`wallpapers/`，**原图**，最长边最高 7680 / 单张最大 8.6 MB）：
  文件夹输入框填 `@builtin` 即用，宿主把该哨兵值解析到包内目录，一样按原分辨率流式返回。
- **持久化**：`$DSH_HOME/dsh-desktop-wallpaper.settings.json` 为准，`localStorage` 作镜像兜底。
- **零依赖、零构建**：纯 ESM + 纯 JS，`lib/` 即源码，无 peerDependencies。

### 修复（发布前实测发现）

- **中文路径乱码导致壁纸库读不出来**：目录对话框的输出沿用 Windows PowerShell 5.1 的
  OEM 码页（中文机为 CP936/GBK），宿主却按 UTF-8 解码，`D:\dsh背景` 变成 `D:\dsh????`，
  之后 `/list` 必然 400。现在两头都治：选择器脚本先把控制台输出编码切到 UTF-8，
  宿主再对子进程输出做容错解码（UTF-8 出现替换字符时用 gb18030/gbk/big5 重解）。
- **侧栏入口与原生行错位**：入口的 `margin`/`padding`/`border`/字号自成一套，
  内容左边距 19px，而宿主原生行是 10px。现按原生行数值对齐
  （`min-height:36px`、`margin:0 2px`、`padding:7px 8px`、`border:none`、`font:inherit`）。
- **正文滚到输入框下面看不清**：shell 本来在输入区上方画了一条渐变遮罩
  （`linear-gradient`，终点色是 `--dsw-alias-bg-base`），让正文在到达输入框前淡出。
  把整块表面 token 调成半透明后，输入卡片的底色也变透了，滚过的正文从输入框里透出来。
  现在**只把输入卡片**（`--dsw-specific-input-major`）钉回主题原色 ——
  遮罩本身保持半透明（它的任务就是淡出正文，同时让壁纸在输入区后面继续可见）。
- **内容区左上角圆角露出半透明缝隙**：frame 背景保持半透明（侧栏背后的壁纸要透出来），
  而内容列那唯一的 16px 圆角会把它露成一块与不透明顶栏对不上的小角。
  现在用应用自己发布的变量 `--dsh-windows-content-radius` 把该角改成直角，与其余三角一致。

[0.1.0]: https://github.com/chate111/dsh-desktop-wallpaper/releases/tag/v0.1.0
