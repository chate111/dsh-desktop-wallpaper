# Changelog

本插件的所有值得记录的改动。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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
  把整块表面 token 调成半透明后，遮罩终点也变成"透明"，于是滚过的正文从输入框里透出来。
  现在把输入区（`[class*="composer"]` 作用域）的表面 token 钉回**主题原色**，
  窗口其余部分照旧透出壁纸。
- **内容区左上角圆角露出半透明缝隙**：frame 背景保持半透明（侧栏背后的壁纸要透出来），
  而内容列那唯一的 16px 圆角会把它露成一块与不透明顶栏对不上的小角。
  现在用应用自己发布的变量 `--dsh-windows-content-radius` 把该角改成直角，与其余三角一致。

[0.1.0]: https://github.com/OWNER/REPO/releases/tag/v0.1.0
