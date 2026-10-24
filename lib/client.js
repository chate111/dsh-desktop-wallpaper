/**
 * dsh-desktop-wallpaper — browser half.
 *
 * Mounts the wallpaper feature into the DSH GUI:
 *   1. a sidebar button directly below 「新会话」 (fallbacks: above 「侧边对话」,
 *      then the settings surface),
 *   2. a popover panel that picks a local wallpaper folder, lists its images for
 *      manual selection, and exposes 暗化 / 模糊 / 透出 sliders,
 *   3. a full-screen background layer plus per-region surface transparency.
 *
 * Per-region transparency uses CSS custom-property inheritance: the whole block
 * of background-ish `--dsw-*` tokens is re-declared once on `body` at the
 * main-area alpha, then re-declared again on the *sidebar's own painting element*
 * at the sidebar alpha. That repetition is mandatory — the tokens themselves are
 * declared by the theme on `body`, and `var()` substitution happens on the
 * element that declares the value, so merely changing a scalar alpha inside a
 * region would have no effect (descendants inherit the substituted colour, not
 * the expression). Values are sampled from the live theme and re-mixed with
 * `color-mix()`, so no light/dark palette is hardcoded.
 *
 * Region selectors and the token ownership below were verified against the
 * shipped 0.2.0-rc.2 client bundles:
 *   - left sidebar paints with `--dsw-specific-sidebar-fill` on `[class*="sidebarCol"]`
 *   - main content and the shell frame paint with `--dsw-alias-bg-base`
 *   - `[data-pane="sidebar"]` does NOT exist in this version (the skin plugin's
 *     README still documents it, but it only ever matched its `[class*="sidebarCol"]`
 *     fallback)
 *
 * The desktop window's top bar (应用 / 编辑) is a preload-injected shadow-DOM
 * strip whose 40px floor is painted by `[class*="frame"]::before` using the very
 * same `--dsw-specific-sidebar-fill` token, so making that token translucent
 * would leak the wallpaper into the top bar. Requirement ① (top bar fully
 * opaque) is therefore enforced explicitly with an opaque override.
 *
 * All failures are logged, never thrown.
 * @module dsh-desktop-wallpaper/client
 */

window.__ModuleLoader__.load({
	id: "dsh-desktop-wallpaper",
	factory: () => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		//#region constants
		const PLUGIN_ID = "dsh-desktop-wallpaper";
		const BASE = `/${PLUGIN_ID}`;
		const LOAD_ROUTE = `${BASE}/load`;
		const SAVE_ROUTE = `${BASE}/save`;
		const PICK_ROUTE = `${BASE}/pick`;
		const LIST_ROUTE = `${BASE}/list`;
		const IMG_ROUTE = `${BASE}/img`;
		const WE_INDEX_ROUTE = `${BASE}/import-we`;

		const STORAGE_KEY = `${PLUGIN_ID}.settings`;
		const ACTIVE_ATTR = "data-dwp-active";
		const LAYER_ATTR = "data-dsw-wallpaper-layer";
		const PHOTO_ATTR = "data-dsw-wallpaper-photo";
		const VIDEO_ATTR = "data-dsw-wallpaper-video";
		const SCRIM_ATTR = "data-dsw-wallpaper-scrim";
		const ENTRY_ATTR = "data-dsw-wallpaper-entry";
		const PANEL_ATTR = "data-dsw-wallpaper-panel";
		const BODY_ATTR = "data-dsw-wallpaper-body";
		const STYLE_BASE = `${PLUGIN_ID}/base`;
		const STYLE_GLOBAL = `${PLUGIN_ID}/global`;

		/** Sentinel folder that the host resolves to the packaged `wallpapers/`. */
		const BUILTIN_FOLDER = "@builtin";

		/**
		 * `folder` starts on the built-in library: a fresh install opens the panel
		 * on the nine bundled samples, so switching a wallpaper never requires
		 * knowing about `@builtin` or picking a directory first.
		 */
		const DEFAULT_SETTINGS = {
			version: 1,
			enabled: false,
			folder: BUILTIN_FOLDER,
			file: "",
			dim: 0,
			blur: 0,
			surface: 66,
			sidebarDelta: 15,
			disableSkin: true,
		};

		/**
		 * Containers painted with a <video> element instead of a CSS background.
		 * Matches the host half's MEDIA_MIME: mp4 (H.264/AAC) and webm (VP8/VP9)
		 * are what Chromium plays without extra codecs.
		 */
		const VIDEO_EXTENSIONS = new Set(["mp4", "webm"]);

		/**
		 * Style of the background video element.
		 *
		 * `<video>` is a *replaced* element: with `width:auto` the used width is the
		 * intrinsic video width and `right`/`bottom` are ignored (CSS 2.1 §10.3.8,
		 * over-constrained), so `inset:-40px` alone painted the frame at its native
		 * pixel size from the top-left corner. Explicit width/height is what actually
		 * makes it fill the viewport; the -40px overscan keeps a blurred frame from
		 * showing hard edges.
		 */
		const VIDEO_LAYER_CSS = [
			"position:absolute",
			"left:-40px",
			"top:-40px",
			"width:calc(100% + 80px)",
			"height:calc(100% + 80px)",
			"object-fit:cover",
			"object-position:center center",
			"display:none",
			"background:#000",
		].join(";");

		/** Background-ish surface tokens. Deliberately excludes label, border and
		 * state tokens: tinting text or borders with the surface slider would hurt
		 * readability instead of revealing the wallpaper.
		 */
		const SURFACE_TOKENS = [
			"--dsw-alias-bg-base",
			"--dsw-alias-bg-layer-1",
			"--dsw-alias-bg-layer-2",
			"--dsw-alias-bg-layer-3",
			"--dsw-alias-bg-module-platform",
			"--dsw-alias-bg-multi-select",
			"--dsw-alias-bg-overlay",
			"--dsw-alias-interactive-bg-active",
			"--dsw-alias-interactive-bg-hover",
			"--dsw-alias-markdown-citation",
			"--dsw-alias-markdown-code-block",
			"--dsw-alias-markdown-code-block-banner",
			"--dsw-alias-markdown-inline-code",
			"--dsw-alias-markdown-placeholder",
			"--dsw-alias-markdown-tag",
			"--dsw-specific-bubble",
			"--dsw-specific-bubble-highlight",
			"--dsw-specific-input-major",
			"--dsw-specific-selector",
			"--dsw-specific-sidebar-fill",
			"--dsw-specific-tip",
		];

		/**
		 * The element that actually paints the left sidebar. `sidebarCol` is what the
		 * shipped 0.2.0-rc.2 shell renders; `data-pane="sidebar"` is the selector the
		 * older shell documented (kept last so it still helps on an older build).
		 */
		const SIDEBAR_SCOPE_SELECTORS = [
			'[class*="sidebarCol"]',
			'[class*="sidebarColumn"]',
			'[data-pane="sidebar"]',
			'[class*="sideBar"]',
			'[class*="sidebar"]',
			"aside",
		];

		/**
		 * Container candidates for *mounting* — a superset of the painting scopes,
		 * because finding somewhere sensible to put the entry matters more than the
		 * element's own background.
		 */
		const SIDEBAR_COLUMN_SELECTORS = [...SIDEBAR_SCOPE_SELECTORS, "nav"];

		/** Shell class hooks for the sidebar rows. */
		const LOGO_ROW_SELECTORS = ['[class*="logoRow"]', '[class*="logo-row"]', '[class*="brandRow"]'];
		const NEW_SESSION_SELECTORS = [
			'button[class*="newSession"]',
			'[class*="newSession"]',
			'[class*="new-session"]',
			'[data-action="new-session"]',
		];

		/** The skin plugin's background layer, hidden while the wallpaper is on. */
		const SKIN_LAYER_SELECTOR = "div[data-wx-skin-layer]";

		/** The 40px Windows title-bar strip painted by the shell frame. */
		const FRAME_SELECTOR = '[class*="frame"]';
		const FRAME_STRIP_SELECTOR = `${FRAME_SELECTOR}::before`;
		/**
		 * The composer's own seat (the shell sets `data-phase` on it and paints a gradient
		 * scrim above the input there). The scrim may stay translucent — fading the
		 * transcript out is exactly its job, and keeping it translucent leaves the
		 * wallpaper visible behind the input area.
		 */
		const COMPOSER_SELECTOR = '[class*="composer"]';

		/**
		 * Surface token(s) inside the composer that must stay fully opaque: the input
		 * card's own fill. Without this, scrolled text shows through the box the user is
		 * typing in, because the card inherits the window-wide translucent value.
		 */
		const COMPOSER_OPAQUE_TOKENS = new Set(["--dsw-specific-input-major"]);
		const MENU_HOST_SELECTOR = "[data-windows-menu]";

		/**
		 * Overlay surfaces that must stay fully opaque while the wallpaper is on:
		 * the settings sheet and any other modal dialog. They are portalled above
		 * the shell, so they inherit the window-wide translucent surface tokens and
		 * would otherwise render see-through against the chat behind them — the
		 * settings sheet then becomes hard to read.
		 */
		const OPAQUE_OVERLAY_SELECTORS = [
			'[class*="settingsModal"]',
			'[class*="settings-modal"]',
			'[class*="settingsDialog"]',
			'[class*="settings-dialog"]',
			'[class*="settingsPanel"]',
			'[class*="settings-panel"]',
			'[class*="settingsPane"]',
			'[role="dialog"]',
			'[class*="modal"]',
			'[class*="Modal"]',
		];

		const PANEL_WIDTH = 332;
		const PLACEHOLDER_FOLDER = "（还没选择壁纸文件夹）";
		/** Grid is 3 columns (`.dsw-wp-grid`); five rows per page keeps the panel short. */
		const PAGE_COLUMNS = 3;
		const PAGE_ROWS = 5;
		const PAGE_SIZE = PAGE_COLUMNS * PAGE_ROWS;
		//#endregion

		/** How many grid pages `total` wallpapers take. */
		function pageCount(total) {
			if (!Number.isFinite(total) || total <= 0)
				return 1;
			return Math.max(1, Math.ceil(total / PAGE_SIZE));
		}

		/**
		 * What the folder row shows. `@builtin` is an internal sentinel — printing it
		 * verbatim told users nothing and hid the fact that the plugin ships its own
		 * wallpapers.
		 */
		function folderLabel(folder) {
			if (folder === "")
				return PLACEHOLDER_FOLDER;
			if (folder === BUILTIN_FOLDER)
				return images.length > 0 ? `内置示例图（${images.length} 张）` : "内置示例图";
			return folder;
		}

		/** Tooltip companion of {@link folderLabel}. */
		function folderTitle(folder) {
			if (folder === BUILTIN_FOLDER)
				return "@builtin（插件自带，位于包的 wallpapers/ 目录）";
			return folder;
		}

		//#region state
		let settings = { ...DEFAULT_SETTINGS };
		let images = [];
		let panel = null;
		let entry = null;
		let saveTimer = null;
		let healTimer = null;
		let healDelay = 500;
		let domObserver = null;
		let hostReachable = true;
		let lastError = "";
		let disposers = [];
		//#endregion

		//#region utils
		function clamp(value, min, max) {
			const numeric = Number(value);
			if (!Number.isFinite(numeric))
				return min;
			return Math.min(max, Math.max(min, Math.round(numeric)));
		}

		function sanitize(input, previous = DEFAULT_SETTINGS) {
			const source = input !== null && typeof input === "object" ? input : {};
			return {
				version: 1,
				enabled: typeof source.enabled === "boolean" ? source.enabled : previous.enabled,
				folder: typeof source.folder === "string" ? source.folder.trim() : previous.folder,
				file: typeof source.file === "string" ? source.file.trim() : previous.file,
				dim: clamp(source.dim ?? previous.dim, 0, 80),
				blur: clamp(source.blur ?? previous.blur, 0, 24),
				surface: clamp(source.surface ?? previous.surface, 0, 100),
				sidebarDelta: clamp(source.sidebarDelta ?? previous.sidebarDelta, 0, 100),
				disableSkin: typeof source.disableSkin === "boolean" ? source.disableSkin : previous.disableSkin,
			};
		}

		/**
		 * Sidebar surface value derived from the main one. The sidebar is meant to be
		 * *more* opaque than the main area — 少透出 15%, i.e. the wallpaper bleeds
		 * through it less — so the delta is added: 66% main → 81% sidebar.
		 */
		function sidebarSurface() {
			return clamp(settings.surface + settings.sidebarDelta, 0, 100);
		}

		/** Whether the wallpaper is actually painted right now. */
		function isActive() {
			return settings.enabled && settings.folder !== "" && settings.file !== "";
		}

		function imageUrl(name) {
			return `${IMG_ROUTE}?name=${encodeURIComponent(name)}`;
		}

		/**
		 * Thumbnail source for a video: the media fragment asks the element to seek to
		 * ~0.1 s so the browser paints a real first frame instead of a black box.
		 */
		function posterUrl(name) {
			return `${imageUrl(name)}#t=0.1`;
		}

		/**
		 * Stop a media element and drop its source, so its decoder is released.
		 *
		 * Chromium only keeps a handful of video decoders alive; leaving a paused
		 * `<video>` with a loaded source in the grid (hundreds of tiles in a
		 * Wallpaper Engine library) is what makes the renderer go down when the
		 * wallpaper is switched a few times.
		 */
		function releaseMedia(element) {
			if (element === null || element === undefined)
				return;
			try {
				element.pause?.();
			}
			catch {
				/* not a media element */
			}
			if (typeof element.removeAttribute === "function") {
				element.removeAttribute("src");
				element.load?.();
			}
			element.remove?.();
		}

		/** Paint `video` into `context` with cover cropping, like CSS `object-fit: cover`. */
		function drawCover(context, video, width, height) {
			const sourceWidth = video.videoWidth || width;
			const sourceHeight = video.videoHeight || height;
			const scale = Math.max(width / sourceWidth, height / sourceHeight);
			const drawWidth = sourceWidth * scale;
			const drawHeight = sourceHeight * scale;
			context.drawImage(video, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
		}

		/**
		 * Probe a video, paint one frame into `canvas`, then release the probe.
		 *
		 * The wallpaper picker never plays video: a frame is all it shows, and the
		 * decoder goes away immediately. Playback belongs to the desktop background,
		 * where exactly one video runs at a time.
		 */
		function paintVideoFrame(canvas, name, width, height, done) {
			const probe = document.createElement("video");
			probe.muted = true;
			probe.playsInline = true;
			probe.preload = "auto";
			for (const attribute of ["muted", "playsinline"])
				probe.setAttribute(attribute, "");
			let settled = false;
			const finish = () => {
				if (settled)
					return;
				settled = true;
				const context = typeof canvas.getContext === "function" ? canvas.getContext("2d") : null;
				if (context !== null && probe.videoWidth > 0) {
					canvas.width = width;
					canvas.height = height;
					try {
						drawCover(context, probe, width, height);
					}
					catch {
						/* tainted or unsupported frame — the tile keeps its badge */
					}
				}
				releaseMedia(probe);
				done?.();
			};
			probe.addEventListener("error", finish, { once: true });
			probe.addEventListener("loadeddata", () => {
				try {
					probe.currentTime = 0.1;
				}
				catch {
					finish();
				}
			}, { once: true });
			probe.addEventListener("seeked", finish, { once: true });
			// A codec that never reports a frame must not wedge the queue.
			window.setTimeout(finish, 3000);
			probe.src = posterUrl(name);
		}

		/** `"video"` when the file must play in a <video>, `"image"` otherwise. */
		function kindOf(name) {
			const dot = String(name).lastIndexOf(".");
			if (dot < 0)
				return "image";
			return VIDEO_EXTENSIONS.has(String(name).slice(dot + 1).toLowerCase()) ? "video" : "image";
		}

		function log(...args) {
			console.log(`[${PLUGIN_ID}]`, ...args);
		}

		function warn(...args) {
			console.warn(`[${PLUGIN_ID}]`, ...args);
		}

		function describe(error) {
			return error instanceof Error ? error.message : String(error);
		}

		function queryAny(selectors, root = document) {
			for (const selector of selectors) {
				try {
					const found = root.querySelector(selector);
					if (found !== null)
						return found;
				}
				catch {
					/* unsupported selector — try the next one */
				}
			}
			return null;
		}
		//#endregion

		//#region host api
		async function hostJson(path, init) {
			const response = await fetch(path, {
				credentials: "same-origin",
				method: init?.method ?? "GET",
				headers: { "content-type": "application/json" },
				...(init?.body === undefined ? {} : { body: init.body }),
			});
			if (!response.ok)
				throw new Error(`${path} → HTTP ${response.status}`);
			return await response.json();
		}

		async function hostLoad() {
			const body = await hostJson(LOAD_ROUTE, { method: "GET" });
			return body?.settings ?? null;
		}

		async function hostSave(next) {
			const body = await hostJson(SAVE_ROUTE, { method: "POST", body: JSON.stringify({ settings: next }) });
			return body?.settings ?? null;
		}

		async function hostPick() {
			return await hostJson(PICK_ROUTE, { method: "POST", body: "{}" });
		}

		async function hostList(folder) {
			const suffix = folder === undefined || folder === "" ? "" : `?folder=${encodeURIComponent(folder)}`;
			return await hostJson(`${LIST_ROUTE}${suffix}`, { method: "GET" });
		}

		/** Ask the host to copy this machine's Wallpaper Engine wallpapers in. */
		async function hostIndexWe() {
			return await hostJson(WE_INDEX_ROUTE, { method: "POST", body: "{}" });
		}
		//#endregion

		//#region persistence
		function readLocal() {
			try {
				const raw = window.localStorage.getItem(STORAGE_KEY);
				return raw === null ? null : JSON.parse(raw);
			}
			catch {
				return null;
			}
		}

		function writeLocal(next) {
			try {
				window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
			}
			catch {
				/* quota or disabled storage — the host copy is authoritative anyway */
			}
		}

		function scheduleSave() {
			writeLocal(settings);
			if (saveTimer !== null)
				window.clearTimeout(saveTimer);
			saveTimer = window.setTimeout(() => {
				saveTimer = null;
				void flushSave();
			}, 350);
		}

		async function flushSave() {
			if (saveTimer !== null) {
				window.clearTimeout(saveTimer);
				saveTimer = null;
			}
			writeLocal(settings);
			if (!hostReachable)
				return;
			try {
				const persisted = await hostSave(settings);
				if (persisted !== null)
					settings = sanitize(persisted, settings);
			}
			catch (error) {
				hostReachable = false;
				warn("settings could not be persisted to the host:", describe(error));
			}
		}
		//#endregion

		//#region stylesheet
		function globalStyleTag() {
			let tag = document.querySelector(`style[data-plugin-css="${STYLE_GLOBAL}"]`);
			if (tag === null) {
				tag = document.createElement("style");
				tag.setAttribute("data-plugin-css", STYLE_GLOBAL);
				document.head.appendChild(tag);
			}
			return tag;
		}

		/**
		 * Sample the theme's own surface colours. The theme declares them on `body`
		 * (not `:root`), so `body` is what must be measured. Our own override has to
		 * be taken out of the way first, otherwise sampling would read back our own
		 * translucent value and every rebuild would compound the transparency.
		 */
		function captureOriginals() {
			const tag = globalStyleTag();
			const previous = tag.textContent ?? "";
			tag.textContent = "";
			const computed = window.getComputedStyle(document.body);
			const originals = new Map();
			for (const token of SURFACE_TOKENS) {
				const value = computed.getPropertyValue(token).trim();
				if (value !== "")
					originals.set(token, value);
			}
			tag.textContent = previous;
			return originals;
		}

		/** One translucent variant of a surface colour at `percent`% opacity. */
		function translucent(value, percent) {
			if (percent >= 100)
				return value;
			if (percent <= 0)
				return "transparent";
			return `color-mix(in srgb, ${value} ${percent}%, transparent)`;
		}

		/**
		 * How much darker the sidebar surface sits than the main content area, in
		 * percent towards black. This is a colour delta on top of the transparency
		 * delta above: the sidebar is both less see-through and visibly darker, so
		 * a bright wallpaper cannot wash it out.
		 */
		const SIDEBAR_DARKEN = 20;

		/** Mix a surface colour `percent`% of the way to black. */
		function darken(value, percent) {
			if (!(percent > 0))
				return value;
			return `color-mix(in srgb, ${value} ${100 - percent}%, #000)`;
		}

		/** The sidebar element that exists in this build, if any. */
		function detectSidebarScope() {
			return queryAny(SIDEBAR_SCOPE_SELECTORS);
		}

		/**
		 * Whether a token's computed value is a colour we can safely re-mix. Guards
		 * against injecting a declaration that would be invalid at computed-value time
		 * (which would leave the consuming surface transparent) if a theme ever
		 * expresses one of these tokens as something other than a plain colour.
		 */
		function isColorValue(value) {
			try {
				return window.CSS?.supports?.("color", value) ?? true;
			}
			catch {
				return true;
			}
		}

		/**
		 * Sampled token values and the generated CSS, both cached.
		 *
		 * `captureOriginals()` costs a `getComputedStyle` pass plus a style-tag swap,
		 * and it used to run on every `applyVisuals()` — which the theme observer
		 * fires on every body class change, and the sliders fire on every frame of a
		 * drag. Now the sample is taken once per theme and the CSS string is memoised
		 * per (theme, surface, sidebar delta, skin switch).
		 */
		let originalsCache = null;
		let originalsKey = "";
		let stylesheetCache = { key: "", css: "" };
		/** Diagnostics: how many times the CSS was actually rebuilt. */
		let stylesheetBuilds = 0;

		function themeKey() {
			try {
				return document.body?.hasAttribute?.("data-ds-dark-theme") === true ? "dark" : "light";
			}
			catch {
				return "light";
			}
		}

		/** Token samples for the current theme. */
		function sampledOriginals() {
			const key = themeKey();
			if (originalsCache === null || originalsKey !== key) {
				originalsCache = captureOriginals();
				originalsKey = key;
				stylesheetCache = { key: "", css: "" };
			}
			return originalsCache;
		}

		/** Forget the samples so the next build re-reads the theme. */
		function invalidateStylesheet() {
			originalsCache = null;
			originalsKey = "";
			stylesheetCache = { key: "", css: "" };
		}

		function buildStylesheet() {
			const key = `${themeKey()}|${settings.surface}|${sidebarSurface()}|${settings.disableSkin ? 1 : 0}`;
			if (stylesheetCache.key === key)
				return stylesheetCache.css;
			const css = buildStylesheetUncached();
			stylesheetCache = { key, css };
			return css;
		}

		function buildStylesheetUncached() {
			stylesheetBuilds += 1;
			const originals = sampledOriginals();
			if (originals.size === 0) {
				warn("no --dsw-* surface tokens found on body; leaving the theme untouched");
				return "";
			}
			const mainDeclarations = [];
			const sidebarDeclarations = [];
			const composerDeclarations = [];
			const opaqueDeclarations = [];
			const skipped = [];
			for (const [token, value] of originals) {
				if (!isColorValue(value)) {
					skipped.push(token);
					continue;
				}
				mainDeclarations.push(`${token}: ${translucent(value, settings.surface)} !important;`);
				sidebarDeclarations.push(`${token}: ${darken(translucent(value, sidebarSurface()), SIDEBAR_DARKEN)} !important;`);
				// Overlays (settings sheet, dialogs) get the theme's untouched values back.
				opaqueDeclarations.push(`${token}: ${value} !important;`);
				// Only the input card goes back to the theme's opaque value. The scrim above
				// it keeps fading into a translucent colour on purpose — that is what leaves
				// the wallpaper visible behind the whole input area.
				if (COMPOSER_OPAQUE_TOKENS.has(token))
					composerDeclarations.push(`${token}: ${value} !important;`);
			}
			if (skipped.length > 0)
				warn(`skipped ${skipped.length} surface token(s) whose value is not a colour: ${skipped.join(", ")}`);
			if (mainDeclarations.length === 0) {
				warn("no re-mixable surface tokens; leaving the theme untouched");
				return "";
			}
			/** ① the Windows title-bar strip keeps the theme's fully opaque floor. */
			const opaqueStrip = originals.get("--dsw-specific-sidebar-fill")
				?? originals.get("--dsw-alias-bg-base")
				?? "rgb(0 0 0)";
			const gate = `html[${ACTIVE_ATTR}]`;
			const rules = [
				`${gate} body { background-color: transparent !important; background-image: none !important; }`,
				`${gate} #root { position: relative !important; z-index: 1 !important; background-color: transparent !important; }`,
				`${gate} body { ${mainDeclarations.join(" ")} }`,
				`${gate} ${FRAME_STRIP_SELECTOR} { background: ${opaqueStrip} !important; }`,
				`${gate} ${MENU_HOST_SELECTOR} { background: ${opaqueStrip} !important; }`,
				// The frame keeps its translucent background (the wallpaper must show
				// behind the sidebar), so the single rounded corner the Windows layout
				// puts on the content column reveals that translucent fill as a notch
				// that no longer matches the opaque caption strip above it. Squaring
				// that one corner removes the seam and matches the other three corners.
				`${gate} ${FRAME_SELECTOR} { --dsh-windows-content-radius: 0px !important; }`,
			];
			const sidebarScope = detectSidebarScope();
			if (sidebarScope !== null)
				rules.push(`${gate} ${selectorText(sidebarScope)} { ${sidebarDeclarations.join(" ")} }`);
			else
				warn("sidebar container not found; every region keeps the main-area transparency");
			if (composerDeclarations.length > 0)
				rules.push(`${gate} ${COMPOSER_SELECTOR} { ${composerDeclarations.join(" ")} }`);
			// Overlays must never inherit the translucent window surface: the settings
			// sheet is read against the transcript behind it, so see-through text is
			// unusable. Give every modal/sheet the theme's original opaque tokens.
			if (opaqueDeclarations.length > 0) {
				const overlaySelectors = OPAQUE_OVERLAY_SELECTORS.map((selector) => `${gate} ${selector}`);
				rules.push(`${overlaySelectors.join(", ")} { ${opaqueDeclarations.join(" ")} }`);
			}
			if (settings.disableSkin)
				rules.push(`${gate} ${SKIN_LAYER_SELECTOR} { display: none !important; }`);
			return rules.join("\n");
		}

		/** A stable CSS selector for an element found by a compound selector list. */
		function selectorText(element) {
			for (const selector of SIDEBAR_SCOPE_SELECTORS) {
				try {
					if (element.matches(selector))
						return selector;
				}
				catch {
					/* next selector */
				}
			}
			return SIDEBAR_SCOPE_SELECTORS[0];
		}

		function writeGlobalStyles() {
			globalStyleTag().textContent = buildStylesheet();
		}
		//#endregion

		//#region background layer
		function ensureLayer() {
			let layer = document.querySelector(`div[${LAYER_ATTR}]`);
			if (layer !== null)
				return layer;
			layer = document.createElement("div");
			layer.setAttribute(LAYER_ATTR, "");
			layer.style.cssText = "position:fixed;inset:0;z-index:0;pointer-events:none;overflow:hidden;";
			const photo = document.createElement("div");
			photo.setAttribute(PHOTO_ATTR, "");
			photo.style.cssText = [
				"position:absolute",
				"inset:-40px",
				"background-position:center center",
				"background-size:cover",
				"background-repeat:no-repeat",
			].join(";");
			// The same -40px overscan that hides the blur halo on the photo also gives
			// the video room to bleed, so a blurred frame never shows hard edges.
			const video = document.createElement("video");
			video.setAttribute(VIDEO_ATTR, "");
			video.style.cssText = VIDEO_LAYER_CSS;
			// Properties alone are not enough on every Chromium build; autoplay for
			// unmuted media is refused, so the attributes are set too.
			video.muted = true;
			video.defaultMuted = true;
			video.loop = true;
			video.autoplay = true;
			video.playsInline = true;
			video.preload = "auto";
			for (const attribute of ["muted", "loop", "autoplay", "playsinline"])
				video.setAttribute(attribute, "");
			video.addEventListener("error", () => {
				warn("this renderer cannot decode the wallpaper video:", settings.file);
			});
			const scrim = document.createElement("div");
			scrim.setAttribute(SCRIM_ATTR, "");
			scrim.style.cssText = "position:absolute;inset:0;";
			layer.append(photo, video, scrim);
			document.body.appendChild(layer);
			return layer;
		}

		/** Stop a wallpaper video and drop its source, so it stops decoding. */
		function stopVideo(video) {
			if (video === null || video === undefined)
				return;
			video.pause?.();
			if (video.getAttribute("src") !== null) {
				video.removeAttribute("src");
				video.load?.();
			}
		}

		/**
		 * Media-only update: which element paints the wallpaper, its blur, the dim
		 * scrim. Cheap enough to run on every frame of a slider drag.
		 */
		function applyMedia() {
			if (!isActive())
				return;
			const layer = ensureLayer();
			const photo = layer.querySelector(`[${PHOTO_ATTR}]`);
			const video = layer.querySelector(`[${VIDEO_ATTR}]`);
			const scrim = layer.querySelector(`[${SCRIM_ATTR}]`);
			layer.style.display = "";
			const filter = settings.blur > 0 ? `blur(${settings.blur}px)` : "none";
			scrim.style.background = settings.dim > 0 ? `rgba(0, 0, 0, ${settings.dim / 100})` : "transparent";
			if (kindOf(settings.file) === "video") {
				photo.style.display = "none";
				photo.style.backgroundImage = "none";
				video.style.display = "";
				video.style.filter = filter;
				const source = imageUrl(settings.file);
				// Only reload when the file actually changed: applyMedia also runs on
				// theme flips, and re-assigning src there would restart the video.
				if (video.getAttribute("src") !== source) {
					video.setAttribute("src", source);
					video.load?.();
				}
				const started = video.play?.();
				if (started !== undefined && typeof started.catch === "function")
					started.catch((error) => warn("wallpaper video was not allowed to play:", describe(error)));
			}
			else {
				stopVideo(video);
				video.style.display = "none";
				photo.style.display = "";
				photo.style.backgroundImage = `url("${imageUrl(settings.file)}")`;
				photo.style.filter = filter;
			}
		}

		/**
		 * Expensive update: rewrite the translucent surface tokens. Memoised, so
		 * repeating it with unchanged settings costs one string compare.
		 */
		function applySurfaces() {
			if (!isActive())
				return;
			writeGlobalStyles();
			document.documentElement.setAttribute(ACTIVE_ATTR, "");
		}

		function applyVisuals() {
			if (!isActive()) {
				// Gate off first, so the theme's own tokens apply again immediately.
				document.documentElement.removeAttribute(ACTIVE_ATTR);
				const existing = document.querySelector(`div[${LAYER_ATTR}]`);
				if (existing !== null) {
					existing.style.display = "none";
					stopVideo(existing.querySelector(`[${VIDEO_ATTR}]`));
				}
				writeGlobalStyles();
				return;
			}
			ensureLayer();
			applyMedia();
			applySurfaces();
		}
		//#endregion

		//#region base stylesheet
		const BASE_CSS = `
[${ENTRY_ATTR}] {
  display: flex;
  align-items: center;
  gap: 8px;
  box-sizing: border-box;
  min-height: 36px;
  margin: 0 2px;
  padding: 7px 8px;
  border: none;
  border-radius: var(--dsw-radius-md);
  background: transparent;
  color: var(--dsw-alias-label-primary, inherit);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
[${ENTRY_ATTR}]:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.16)); }
[${ENTRY_ATTR}][data-open="true"] { background: var(--dsw-alias-interactive-bg-active, rgba(127, 127, 127, 0.24)); }
[${ENTRY_ATTR}] svg { flex: none; }

[${PANEL_ATTR}] {
  --dsw-wallpaper-panel-bg: #ffffff;
  --dsw-wallpaper-panel-fg: #1b1b1f;
  --dsw-wallpaper-panel-line: rgba(0, 0, 0, 0.12);
  --dsw-wallpaper-panel-soft: rgba(0, 0, 0, 0.05);
  position: fixed;
  z-index: 2147483000;
  box-sizing: border-box;
  width: ${PANEL_WIDTH}px;
  max-height: min(78vh, 720px);
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 14px;
  border: 1px solid var(--dsw-wallpaper-panel-line);
  border-radius: 12px;
  background: var(--dsw-wallpaper-panel-bg);
  color: var(--dsw-wallpaper-panel-fg);
  /* No drop shadow: 48px of 32%-black reads as a thick dark halo around a 332px
     panel, especially over a dark theme. The 1px border is enough separation. */
  box-shadow: none;
  font: 13px/1.5 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
}
body[data-ds-dark-theme] [${PANEL_ATTR}] {
  --dsw-wallpaper-panel-bg: #1f2023;
  --dsw-wallpaper-panel-fg: #ececf1;
  --dsw-wallpaper-panel-line: rgba(255, 255, 255, 0.14);
  --dsw-wallpaper-panel-soft: rgba(255, 255, 255, 0.07);
}
[${PANEL_ATTR}] h4 {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 0 0 10px;
  font-size: 13px;
  font-weight: 600;
}
[${PANEL_ATTR}] .dsw-wp-row { display: flex; align-items: center; gap: 8px; margin: 8px 0; }
[${PANEL_ATTR}] .dsw-wp-row > label { flex: 1; display: flex; align-items: center; gap: 6px; cursor: pointer; }
[${PANEL_ATTR}] .dsw-wp-path {
  flex: 1;
  min-width: 0;
  padding: 6px 8px;
  border: 1px solid var(--dsw-wallpaper-panel-line);
  border-radius: 6px;
  background: var(--dsw-wallpaper-panel-soft);
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  direction: rtl;
  text-align: left;
}
[${PANEL_ATTR}] input[type="text"] {
  box-sizing: border-box;
  width: 100%;
  padding: 6px 8px;
  border: 1px solid var(--dsw-wallpaper-panel-line);
  border-radius: 6px;
  background: var(--dsw-wallpaper-panel-soft);
  color: inherit;
  font: inherit;
  font-size: 12px;
}
[${PANEL_ATTR}] button.dsw-wp-btn {
  padding: 6px 10px;
  border: 1px solid var(--dsw-wallpaper-panel-line);
  border-radius: 6px;
  background: var(--dsw-wallpaper-panel-soft);
  color: inherit;
  font: inherit;
  font-size: 12px;
  white-space: nowrap;
  cursor: pointer;
}
[${PANEL_ATTR}] button.dsw-wp-btn:hover { border-color: currentColor; }
[${PANEL_ATTR}] button.dsw-wp-btn[disabled] { opacity: 0.5; cursor: default; }
[${PANEL_ATTR}] .dsw-wp-close {
  padding: 2px 4px;
  border: none;
  background: transparent;
  color: inherit;
  opacity: 0.6;
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
}
[${PANEL_ATTR}] .dsw-wp-close:hover { opacity: 1; }
[${PANEL_ATTR}] .dsw-wp-preview {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
  border: 1px solid var(--dsw-wallpaper-panel-line);
  border-radius: 8px;
  overflow: hidden;
  background: var(--dsw-wallpaper-panel-soft);
}
[${PANEL_ATTR}] .dsw-wp-preview img { display: block; width: 100%; height: 100%; object-fit: cover; }
[${PANEL_ATTR}] .dsw-wp-preview video,
[${PANEL_ATTR}] .dsw-wp-preview canvas { display: block; width: 100%; height: 100%; object-fit: cover; background: #000; }
[${PANEL_ATTR}] .dsw-wp-caption {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 3px 6px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
[${PANEL_ATTR}] .dsw-wp-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin-top: 8px; }
[${PANEL_ATTR}] .dsw-wp-pager {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  margin-top: 10px;
}
[${PANEL_ATTR}] .dsw-wp-pager button { flex: none; }
[${PANEL_ATTR}] .dsw-wp-pageinfo {
  flex: 1;
  min-width: 0;
  text-align: center;
  font-size: 11.5px;
  opacity: 0.7;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
[${PANEL_ATTR}] .dsw-wp-thumb {
  position: relative;
  padding: 0;
  aspect-ratio: 16 / 10;
  border: 2px solid transparent;
  border-radius: 6px;
  overflow: hidden;
  background: var(--dsw-wallpaper-panel-soft);
  cursor: pointer;
}
[${PANEL_ATTR}] .dsw-wp-thumb img { display: block; width: 100%; height: 100%; object-fit: cover; }
[${PANEL_ATTR}] .dsw-wp-thumb video,
[${PANEL_ATTR}] .dsw-wp-thumb canvas { display: block; width: 100%; height: 100%; object-fit: cover; background: #000; }
[${PANEL_ATTR}] .dsw-wp-thumb-play {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 9px;
  line-height: 1;
  pointer-events: none;
}
[${PANEL_ATTR}] .dsw-wp-thumb[data-selected="true"] { border-color: #4c8dff; }
[${PANEL_ATTR}] .dsw-wp-thumb em {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 2px 4px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 10px;
  font-style: normal;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
[${PANEL_ATTR}] .dsw-wp-slider { display: flex; align-items: center; gap: 8px; margin: 6px 0; }
[${PANEL_ATTR}] .dsw-wp-slider > span:first-child { flex: none; width: 46px; }
[${PANEL_ATTR}] .dsw-wp-slider input[type="range"] { flex: 1; min-width: 0; }
[${PANEL_ATTR}] .dsw-wp-value { flex: none; width: 58px; text-align: right; font-variant-numeric: tabular-nums; }
[${PANEL_ATTR}] .dsw-wp-note {
  display: block;
  margin-top: 6px;
  padding: 0;
  background: none;
  border: none;
  color: inherit;
  opacity: 0.62;
  font-size: 11.5px;
  line-height: 1.5;
}
[${PANEL_ATTR}] .dsw-wp-error { margin-top: 6px; color: #ff6b6b; font-size: 12px; }
`;
		//#endregion

		//#region dom helpers
		function baseStyleTag() {
			let tag = document.querySelector(`style[data-plugin-css="${STYLE_BASE}"]`);
			if (tag === null) {
				tag = document.createElement("style");
				tag.setAttribute("data-plugin-css", STYLE_BASE);
				document.head.appendChild(tag);
			}
			return tag;
		}

		/** Innermost element inside `root` whose trimmed text equals `text`. */
		function findByText(root, text) {
			if (root === null || root === undefined)
				return null;
			const nodes = root.querySelectorAll("button, a, [role='button'], span, div");
			for (const node of nodes) {
				if ((node.textContent ?? "").trim() === text)
					return node;
			}
			return null;
		}

		function createEntry() {
			const button = document.createElement("button");
			button.type = "button";
			button.setAttribute(ENTRY_ATTR, "");
			button.setAttribute("data-open", "false");
			button.title = "壁纸";
			button.innerHTML = ICON_SVG;
			const label = document.createElement("span");
			label.textContent = "壁纸";
			button.appendChild(label);
			// Activation is handled by the delegated capture-phase listener below, not
			// by a listener on this node: the shell renders the sidebar with React, so a
			// row re-render between mousedown and click can replace this element and the
			// click would never reach a node-bound handler.
			return button;
		}

		/**
		 * Walk up to the outermost wrapper that still holds only this element, so an
		 * entry inserted after it lands on a row boundary rather than inside a label.
		 * Never climbs past `boundary`.
		 */
		function rowBlockOf(node, boundary) {
			let current = node;
			for (let depth = 0; depth < 6; depth += 1) {
				const parent = current.parentElement;
				if (parent === null || parent === document.body || parent === boundary || parent.children.length > 1)
					return current;
				current = parent;
			}
			return current;
		}

		/**
		 * Mount the entry, in the order the requirement asked for:
		 *   1. directly below 「新会话」 (the shipped 0.2.0-rc.2 layout)
		 *   2. directly below 「新会话」 found by row, when the class hooks are absent
		 *   3. above 「侧边对话」, at the bottom of the sidebar
		 *   4. inside the settings surface
		 * Returns true when the entry is in the document.
		 */
		function mountEntry() {
			const existing = document.querySelector(`[${ENTRY_ATTR}]`);
			const column = queryAny(SIDEBAR_COLUMN_SELECTORS);
			const scope = column ?? document.body;

			// 1 — logoRow's parent holds the new-session button; sit right after it
			if (column !== null) {
				const logoRow = queryAny(LOGO_ROW_SELECTORS, column);
				const root = logoRow?.parentElement ?? column.firstElementChild;
				if (root !== null && root !== undefined) {
					const anchor = queryAny(NEW_SESSION_SELECTORS, root) ?? findByText(root, "新会话");
					if (anchor !== null) {
						entry = existing ?? createEntry();
						if (entry.parentElement !== root || entry.previousElementSibling !== anchor)
							root.insertBefore(entry, anchor.nextElementSibling);
						return true;
					}
				}
			}

			// 2 — no logoRow/new-session hooks: anchor on the row holding 新会话
			const sessionAnchor = queryAny(NEW_SESSION_SELECTORS, scope) ?? findByText(scope, "新会话");
			if (sessionAnchor !== null) {
				const block = rowBlockOf(sessionAnchor, column);
				const parent = block.parentElement;
				if (parent !== null) {
					entry = existing ?? createEntry();
					if (block.nextElementSibling !== entry)
						parent.insertBefore(entry, block.nextElementSibling);
					return true;
				}
			}

			// 3 — above 「侧边对话」, at the bottom of the sidebar
			const sideChat = findByText(scope, "侧边对话");
			if (sideChat !== null && sideChat.parentElement !== null) {
				entry = existing ?? createEntry();
				sideChat.parentElement.insertBefore(entry, sideChat);
				return true;
			}

			// 4 — the settings surface
			const settingsPane = queryAny(['[class*="settingsModal"]', '[class*="settings-modal"]', '[class*="settingsPanel"]', '[class*="settings-panel"]', '[class*="settingsPane"]']);
			if (settingsPane !== null) {
				entry = existing ?? createEntry();
				settingsPane.insertBefore(entry, settingsPane.firstChild);
				return true;
			}

			if (existing !== null) {
				entry = existing;
				return true;
			}
			return false;
		}

		/** Keep the entry mounted across SPA re-renders, backing the retry off. */
		function startHealing() {
			const attempt = () => {
				let mounted = false;
				try {
					mounted = mountEntry();
				}
				catch (error) {
					warn("mount attempt failed:", describe(error));
				}
				if (mounted) {
					healDelay = 2000;
					return;
				}
				if (healTimer !== null)
					window.clearTimeout(healTimer);
				healTimer = window.setTimeout(attempt, healDelay);
				healDelay = Math.min(healDelay * 2, 8000);
			};
			attempt();
			if (document.querySelector(`[${ENTRY_ATTR}]`) === null)
				warn("侧栏挂载点还没出现（新会话／侧边对话／设置面板都没找到），继续重试");
			let healing = false;
			domObserver = new MutationObserver(() => {
				// Streaming replies mutate the DOM many times per second; without these two
				// guards every token would cost a document-wide querySelector.
				if (healing)
					return;
				if (entry !== null && entry.isConnected !== false)
					return; // still mounted — nothing to heal
				healing = true;
				const run = () => {
					healing = false;
					if (entry !== null && entry.isConnected !== false)
						return;
					if (document.querySelector(`[${ENTRY_ATTR}]`) !== null)
						return;
					healDelay = 300;
					attempt();
				};
				if (typeof window.requestAnimationFrame === "function")
					window.requestAnimationFrame(run);
				else
					run();
			});
			domObserver.observe(document.body, { childList: true, subtree: true });
		}
		//#endregion

		//#region panel
		function panelButton(label, onClick) {
			const button = document.createElement("button");
			button.type = "button";
			button.className = "dsw-wp-btn";
			button.textContent = label;
			button.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				onClick(button);
			});
			return button;
		}

		function closePanel() {
			if (panel === null)
				return;
			// Detaching the panel is not enough: a <video> keeps its decoder (and the
			// open request) until its source is dropped.
			for (const media of Array.from(panel.querySelectorAll?.("video") ?? []))
				releaseMedia(media);
			panel.remove();
			panel = null;
			entry?.setAttribute("data-open", "false");
			document.removeEventListener("mousedown", onDocumentMouseDown, true);
			window.removeEventListener("keydown", onWindowKeyDown, true);
			window.removeEventListener("resize", onWindowResize);
		}

		function onDocumentMouseDown(event) {
			if (panel === null)
				return;
			const target = event.target;
			if (panel.contains(target) || (entry !== null && entry.contains(target)))
				return;
			closePanel();
		}

		function onWindowKeyDown(event) {
			if (event.key === "Escape")
				closePanel();
		}

		function onWindowResize() {
			closePanel();
		}

		/**
		 * Delegated, capture-phase handling for anything aimed at our entry.
		 *
		 * Capture on `document` runs before the shell's React root listeners, so the
		 * entry keeps working even when the shell re-renders the row it sits in, and
		 * `stopPropagation` keeps the shell from reacting to our own button at all.
		 *   - pointerdown  : the action (fires before any re-render the press causes)
		 *   - mousedown    : swallowed, so no separate shell state change
		 *   - click        : only a keyboard/programmatic activation (detail === 0) acts,
		 *                    otherwise the pointerdown already handled it
		 */
		function onEntryPointerLike(event) {
			const target = event.target;
			if (target === null || target === undefined || typeof target.closest !== "function")
				return;
			const hit = target.closest(`[${ENTRY_ATTR}]`);
			if (hit === null)
				return;
			if (event.type === "pointerdown") {
				if (event.pointerType === "mouse" && event.button !== 0)
					return;
				event.preventDefault();
				event.stopPropagation();
				togglePanel(hit);
				return;
			}
			event.stopPropagation();
			if (event.type === "click" && event.detail === 0) {
				event.preventDefault();
				togglePanel(hit);
			}
		}

		function togglePanel(anchor) {
			if (panel !== null) {
				closePanel();
				return;
			}
			try {
				renderPanel(anchor);
			}
			catch (error) {
				// Never throw out of a UI handler; closePanel() already restored
				// `panel === null`, so the next activation can simply try again.
				warn("opening the panel failed:", describe(error));
			}
		}

		/** Refresh the image list from the host and repair the current selection. */
		async function refreshImages() {
			if (settings.folder === "") {
				images = [];
				return;
			}
			try {
				const result = await hostList(settings.folder);
				if (!result || result.ok !== true) {
					images = [];
					lastError = result?.error ?? "读取文件夹失败";
					return;
				}
				images = Array.isArray(result.images) ? result.images : [];
				// The host answers with the *resolved* folder path. For the bundled
				// library that path is not interchangeable with the sentinel: only the
				// sentinel makes the host merge the Wallpaper Engine index. Keep (or
				// restore) `@builtin` so a previously-saved absolute path migrates back.
				if (result.builtin === true) {
					if (settings.folder !== BUILTIN_FOLDER) {
						settings.folder = BUILTIN_FOLDER;
						scheduleSave();
					}
				}
				else if (typeof result.folder === "string" && result.folder !== "") {
					settings.folder = result.folder;
				}
				if (images.length > 0 && !images.some((image) => image.name === settings.file))
					settings.file = images[0].name;
				lastError = "";
			}
			catch (error) {
				images = [];
				hostReachable = false;
				lastError = `无法读取壁纸文件夹：${describe(error)}`;
			}
		}

		/** Apply a new wallpaper folder coming from either the dialog or the text box. */
		async function adoptFolder(folder) {
			settings.folder = folder;
			settings.file = "";
			await refreshImages();
			if (settings.file !== "")
				settings.enabled = true;
			applyVisuals();
			scheduleSave();
		}

		function renderPanel(anchor) {
			const node = document.createElement("div");
			node.setAttribute(PANEL_ATTR, "");

			// — header
			const header = document.createElement("h4");
			const title = document.createElement("span");
			title.textContent = "壁纸";
			const close = document.createElement("button");
			close.type = "button";
			close.className = "dsw-wp-close";
			close.textContent = "✕";
			close.addEventListener("click", (event) => {
				event.preventDefault();
				closePanel();
			});
			header.append(title, close);
			node.appendChild(header);

			// — master switch
			const enableRow = document.createElement("div");
			enableRow.className = "dsw-wp-row";
			const enableLabel = document.createElement("label");
			const enableBox = document.createElement("input");
			enableBox.type = "checkbox";
			enableBox.checked = settings.enabled;
			const enableText = document.createElement("span");
			enableText.textContent = "启用壁纸";
			enableLabel.append(enableBox, enableText);
			enableRow.appendChild(enableLabel);
			node.appendChild(enableRow);

			// — folder row
			const folderRow = document.createElement("div");
			folderRow.className = "dsw-wp-row";
			const path = document.createElement("span");
			path.className = "dsw-wp-path";
			path.textContent = folderLabel(settings.folder);
			path.title = folderTitle(settings.folder);
			const pick = panelButton("选择文件夹", async () => {
				// Never disable this: the native dialog is a separate process, so the app
				// window stays interactive while it is open. Leaving the button greyed out
				// looked like "it broke after one click". A second click asks the host to
				// replace the open dialog with a fresh one.
				lastError = "";
				renderStatus();
				const label = pick.textContent;
				pick.textContent = "正在选择…";
				pick.dataset.busy = "true";
				try {
					const result = await hostPick();
					if (result?.folder) {
						await adoptFolder(result.folder);
						path.textContent = folderLabel(settings.folder);
						path.title = folderTitle(settings.folder);
						renderBody();
					}
				}
				catch (error) {
					lastError = `打开文件夹对话框失败：${describe(error)}（可以直接粘贴路径）`;
					renderStatus();
				}
				finally {
					pick.textContent = label;
					delete pick.dataset.busy;
				}
			});
			const rescan = panelButton("重扫", async () => {
				await refreshImages();
				path.textContent = folderLabel(settings.folder);
				path.title = folderTitle(settings.folder);
				renderBody();
			});
			folderRow.append(path, pick, rescan);
			node.appendChild(folderRow);

			// — manual path fallback
			const pathRow = document.createElement("div");
			pathRow.className = "dsw-wp-row";
			const pathInput = document.createElement("input");
			pathInput.type = "text";
			pathInput.placeholder = String.raw`或粘贴文件夹路径，例如 D:\dsh背景`;
			const usePath = panelButton("使用", async () => {
				const value = pathInput.value.trim();
				if (value === "")
					return;
				await adoptFolder(value);
				path.textContent = folderLabel(settings.folder);
				path.title = folderTitle(settings.folder);
				renderBody();
			});
			pathRow.append(pathInput, usePath);
			node.appendChild(pathRow);

			// — Wallpaper Engine import (reads THIS machine's library, nothing is bundled)
			const importRow = document.createElement("div");
			importRow.className = "dsw-wp-row";
			const importNote = document.createElement("span");
			importNote.className = "dsw-wp-note";
			importNote.textContent = "只记路径、不复制文件；壁纸直接用 Steam 库里的原文件";
			const importButton = panelButton("扫描本机 Wallpaper Engine", async () => {
				const label = importButton.textContent;
				importButton.textContent = "扫描中…";
				importNote.textContent = "正在读取 Steam 库…";
				lastError = "";
				renderStatus();
				try {
					const result = await hostIndexWe();
					if (result?.ok === false) {
						lastError = result.error ?? "扫描失败";
						importNote.textContent = "没扫描成功";
					}
					else {
						const size = formatSize(result?.bytes ?? 0);
						// Always re-list: the scan may have migrated a saved absolute path
						// back to the `@builtin` sentinel, and the grid has to pick that up.
						await refreshImages();
						path.textContent = folderLabel(settings.folder);
						renderBody();
						const where = settings.folder === BUILTIN_FOLDER ? "" : "；把文件夹填 @builtin 就能看到";
						importNote.textContent = `已收录 ${result?.count ?? 0} 个视频（合计 ${size}）${where}`;
					}
				}
				catch (error) {
					// 404/405 with no JSON body means the framework never matched the route:
					// the host half only registers routes at startup, so a freshly added
					// endpoint does not exist until the desktop app is restarted.
					const message = describe(error);
					if (/HTTP (404|405)/.test(message)) {
						lastError = `宿主还没有这个接口，请重启桌面端（${message}）`;
						importNote.textContent = "重启后再点一次";
					}
					else {
						lastError = `扫描失败：${message}`;
						importNote.textContent = "没扫描成功";
					}
				}
				finally {
					importButton.textContent = label;
					renderStatus();
				}
			});
			importRow.append(importButton);
			node.appendChild(importRow);
			node.appendChild(importNote);

			// — preview + grid: separate hosts so a click only re-renders the preview
			const body = document.createElement("div");
			body.setAttribute(BODY_ATTR, "");
			node.appendChild(body);
			const previewHost = document.createElement("div");
			const listHost = document.createElement("div");
			body.append(previewHost, listHost);

			// — effects
			const effectsTitle = document.createElement("h4");
			effectsTitle.style.marginTop = "12px";
			const effectsText = document.createElement("span");
			effectsText.textContent = "效果";
			effectsTitle.appendChild(effectsText);
			node.appendChild(effectsTitle);

			const liveNote = document.createElement("div");
			liveNote.className = "dsw-wp-note";
			const refreshNote = () => {
				liveNote.textContent = `主内容区 透出 ${settings.surface}% ／ 左侧栏 ${sidebarSurface()}%（比主区少透出 ${settings.sidebarDelta}%、再暗 ${SIDEBAR_DARKEN}%）／ 顶部菜单栏保持主题原色、完全不透`;
			};
			refreshNote();

			const slider = (label, key, min, max, suffix) => {
				const row = document.createElement("div");
				row.className = "dsw-wp-slider";
				const name = document.createElement("span");
				name.textContent = label;
				const input = document.createElement("input");
				input.type = "range";
				input.min = String(min);
				input.max = String(max);
				input.step = "1";
				input.value = String(settings[key]);
				const value = document.createElement("span");
				value.className = "dsw-wp-value";
				value.textContent = `${settings[key]}${suffix}`;
				input.addEventListener("input", () => {
					settings[key] = clamp(input.value, min, max);
					value.textContent = `${settings[key]}${suffix}`;
					refreshNote();
					// Only the surface slider needs the (memoised) token rewrite; blur and
					// dim are pure style writes, so a drag stays at 60 fps.
					if (key === "surface")
						applySurfaces();
					else
						applyMedia();
					scheduleSave();
				});
				row.append(name, input, value);
				return row;
			};
			node.appendChild(slider("暗化", "dim", 0, 80, "%"));
			node.appendChild(slider("模糊", "blur", 0, 24, "px"));
			node.appendChild(slider("透出", "surface", 0, 100, "%"));
			node.appendChild(liveNote);

			// — skin coexistence
			const skinRow = document.createElement("div");
			skinRow.className = "dsw-wp-row";
			const skinLabel = document.createElement("label");
			const skinBox = document.createElement("input");
			skinBox.type = "checkbox";
			skinBox.checked = settings.disableSkin;
			const skinText = document.createElement("span");
			skinText.textContent = "启用壁纸时自动关闭皮肤";
			skinLabel.append(skinBox, skinText);
			skinRow.appendChild(skinLabel);
			node.appendChild(skinRow);

			// — reset
			const actions = document.createElement("div");
			actions.className = "dsw-wp-row";
			actions.style.marginTop = "12px";
			actions.appendChild(panelButton("恢复默认", () => {
				settings = { ...DEFAULT_SETTINGS, folder: settings.folder, file: settings.file };
				applyVisuals();
				scheduleSave();
				closePanel();
			}));
			node.appendChild(actions);

			enableBox.addEventListener("change", () => {
				settings.enabled = enableBox.checked;
				applyVisuals();
				scheduleSave();
			});
			skinBox.addEventListener("change", () => {
				settings.disableSkin = skinBox.checked;
				applyVisuals();
				scheduleSave();
			});

			function renderStatus() {
				let error = listHost.querySelector(".dsw-wp-error");
				if (lastError === "") {
					error?.remove();
					return;
				}
				if (error === null) {
					error = document.createElement("div");
					error.className = "dsw-wp-error";
					listHost.appendChild(error);
				}
				error.textContent = lastError;
			}

			/** Human-readable byte size for the preview caption. */
			function formatSize(bytes) {
				if (!Number.isFinite(bytes) || bytes <= 0)
					return "";
				if (bytes >= 1024 * 1024)
					return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
				return `${Math.round(bytes / 1024)} KB`;
			}

			/** Lazy poster loaders of the current grid; rebuilt on every renderBody(). */
			let posterObserver = null;
			let posterJobs = [];
			let page = 0;
			/** Switching libraries starts at page 1 again. */
			let pageFolder = settings.folder;
			/** Poster probes run one at a time: N parallel decoders is what kills the GPU. */
			let posterQueue = [];
			let posterBusy = false;
			/** Bumped on every list rebuild so queued probes for old tiles bail out. */
			let posterGeneration = 0;
			/** Same idea for the preview: a rapid series of clicks paints the last one only. */
			let previewGeneration = 0;

			function pumpPosters() {
				if (posterBusy)
					return;
				const load = posterQueue.shift();
				if (load === undefined)
					return;
				posterBusy = true;
				load(() => {
					posterBusy = false;
					pumpPosters();
				});
			}

			/**
			 * Highlight the selected tile without rebuilding the grid.
			 *
			 * Rebuilding all 15 tiles (plus a fresh preview probe) on every click was the
			 * main source of jank: the click only changes two elements' `data-selected`.
			 */
			function markSelection() {
				for (const thumb of listHost.querySelectorAll(".dsw-wp-thumb"))
					thumb.dataset.selected = String(thumb.dataset.name === settings.file);
			}

			function renderPreview() {
				previewHost.textContent = "";
				const preview = document.createElement("div");
				preview.className = "dsw-wp-preview";
				const caption = document.createElement("span");
				caption.className = "dsw-wp-caption";
				if (settings.file !== "" && settings.folder !== "") {
					const entry = images.find((image) => image.name === settings.file);
					const kind = entry?.kind === "video" ? "video" : kindOf(settings.file);
					const size = formatSize(entry?.size ?? 0);
					if (kind === "video") {
						// One still frame, never playback: the picker must stay cheap even for
						// a 1.8 GB 4K clip. Playback happens on the desktop, one at a time.
						const frame = document.createElement("canvas");
						frame.className = "dsw-wp-preview-media";
						previewGeneration += 1;
						const mine = previewGeneration;
						// Front of the queue: the preview is what the click was for.
						posterQueue.unshift((done) => {
							if (mine !== previewGeneration) {
								done?.();
								return;
							}
							paintVideoFrame(frame, settings.file, 480, 270, done);
						});
						pumpPosters();
						caption.textContent = size === "" ? `▶ ${settings.file}` : `▶ ${settings.file} · ${size}`;
						preview.append(frame, caption);
					}
					else {
						const img = document.createElement("img");
						img.src = imageUrl(settings.file);
						img.alt = settings.file;
						img.decoding = "async";
						caption.textContent = settings.file;
						preview.append(img, caption);
					}
				}
				else {
					caption.textContent = "还没有选中壁纸";
					preview.appendChild(caption);
				}
				previewHost.appendChild(preview);
			}

			function renderList() {
				// Invalidate anything still queued for the previous page: at most one probe
				// decoder runs at a time, and stale jobs would keep it busy for seconds.
				posterGeneration += 1;
				const generation = posterGeneration;
				posterQueue = [];
				posterJobs = [];
				if (posterObserver !== null) {
					posterObserver.disconnect();
					posterObserver = null;
				}
				listHost.textContent = "";

				if (images.length > 0) {
					if (settings.folder !== pageFolder) {
						pageFolder = settings.folder;
						page = 0;
					}
					const totalPages = pageCount(images.length);
					if (page > totalPages - 1)
						page = totalPages - 1;
					if (page < 0)
						page = 0;
					const first = page * PAGE_SIZE;
					const visible = images.slice(first, first + PAGE_SIZE);

					const grid = document.createElement("div");
					grid.className = "dsw-wp-grid";
					for (const image of visible) {
						const thumb = document.createElement("button");
						thumb.type = "button";
						thumb.className = "dsw-wp-thumb";
						thumb.dataset.name = image.name;
						thumb.dataset.selected = String(image.name === settings.file);
						thumb.dataset.kind = image.kind === "video" ? "video" : "image";
						thumb.title = `${image.name}（${formatSize(image.size)}）`;
						const name = document.createElement("em");
						name.textContent = image.name;
						if (image.kind === "video") {
							// One painted frame per tile, no playback anywhere in the picker:
							// the probe <video> exists only long enough to draw it.
							const frame = document.createElement("canvas");
							frame.className = "dsw-wp-thumb-media";
							posterJobs.push({
								thumb,
								load: (done) => {
									if (generation !== posterGeneration || frame.isConnected === false || frame.dataset.painted === "true") {
										done?.();
										return;
									}
									frame.dataset.painted = "true";
									paintVideoFrame(frame, image.name, 160, 100, done);
								},
							});
							const badge = document.createElement("span");
							badge.className = "dsw-wp-thumb-play";
							badge.textContent = "▶";
							thumb.append(frame, badge, name);
						}
						else {
							const img = document.createElement("img");
							img.src = imageUrl(image.name);
							img.alt = image.name;
							img.loading = "lazy";
							img.decoding = "async";
							thumb.append(img, name);
						}
						thumb.addEventListener("click", () => {
							settings.file = image.name;
							settings.enabled = true;
							applyVisuals();
							scheduleSave();
							markSelection();
							renderPreview();
						});
						grid.appendChild(thumb);
					}
					listHost.appendChild(grid);

					// — pager: five rows per page, so a 100+ item library stays short
					if (totalPages > 1) {
						const pager = document.createElement("div");
						pager.className = "dsw-wp-pager";
						const go = (next) => {
							if (next < 0 || next > totalPages - 1 || next === page)
								return;
							page = next;
							renderList();
							// Keep the refreshed grid in view after flipping.
							listHost.scrollIntoView?.({ block: "nearest" });
						};
						const prev = panelButton("‹ 上一页", () => go(page - 1));
						prev.disabled = page === 0;
						const info = document.createElement("span");
						info.className = "dsw-wp-pageinfo";
						info.textContent = `${page + 1} / ${totalPages} 页 · 共 ${images.length} 个`;
						const next = panelButton("下一页 ›", () => go(page + 1));
						next.disabled = page === totalPages - 1;
						pager.append(prev, info, next);
						listHost.appendChild(pager);
					}
					// Poster frames only for the tiles that actually scroll into view.
					if (posterJobs.length > 0) {
						if (typeof window.IntersectionObserver === "function") {
							const jobs = new Map(posterJobs.map((job) => [job.thumb, job.load]));
							posterObserver = new window.IntersectionObserver((entries) => {
								for (const entry of entries) {
									if (!entry.isIntersecting)
										continue;
									const load = jobs.get(entry.target);
									jobs.delete(entry.target);
									posterObserver?.unobserve(entry.target);
									if (load !== undefined)
										posterQueue.push(load);
								}
								pumpPosters();
							}, { rootMargin: "200px" });
							for (const job of posterJobs)
								posterObserver.observe(job.thumb);
						}
						else {
							posterQueue.push(...posterJobs.map((job) => job.load));
							pumpPosters();
						}
					}
				}
				else if (settings.folder !== "" && lastError === "") {
					const empty = document.createElement("div");
					empty.className = "dsw-wp-note";
					empty.textContent = "这个文件夹里没有 jpg / jpeg / png / webp / gif / bmp / avif 图片，也没有 mp4 / webm 视频。";
					listHost.appendChild(empty);
				}
				renderStatus();
			}

			function renderBody() {
				renderPreview();
				renderList();
			}

			renderBody();

			// — placement: beside the sidebar entry, clamped into the viewport
			const rect = anchor.getBoundingClientRect();
			const margin = 8;
			const width = Math.max(240, Math.min(PANEL_WIDTH, window.innerWidth - margin * 2));
			// A hidden or not-yet-laid-out anchor reports an all-zero rect; centring is
			// better than parking the panel off-screen where the click looks ignored.
			const degenerate = rect.width === 0 && rect.height === 0;
			let left;
			let top;
			if (degenerate) {
				left = (window.innerWidth - width) / 2;
				top = 80;
			}
			else {
				left = rect.left - width - margin;
				if (left < margin)
					left = rect.right + margin;
				left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
				top = Math.max(margin, Math.min(rect.top - 8, window.innerHeight - 260));
			}
			node.style.width = `${Math.round(width)}px`;
			node.style.left = `${Math.round(left)}px`;
			node.style.top = `${Math.round(top)}px`;

			document.body.appendChild(node);
			panel = node;
			entry?.setAttribute("data-open", "true");
			document.addEventListener("mousedown", onDocumentMouseDown, true);
			window.addEventListener("keydown", onWindowKeyDown, true);
			window.addEventListener("resize", onWindowResize);
			// Interaction beacon: materialises the durable settings copy, which also
			// makes "a click reached the plugin" observable from outside the renderer.
			void flushSave();
		}
		//#endregion

		//#region icon
		const ICON_SVG = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" stroke-width="1.3"/><circle cx="5.6" cy="6.4" r="1.3" fill="currentColor"/><path d="M2 11.4l3.3-3.1a1.2 1.2 0 011.6 0l2 1.9 1.6-1.5a1.2 1.2 0 011.6 0L14.5 11" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
		//#endregion

		//#region theme watching
		function watchTheme() {
			let pending = false;
			const themeObserver = new MutationObserver(() => {
				// The shell adds/removes body classes constantly; coalesce to one frame and
				// only re-sample tokens when the theme key actually changed.
				if (pending)
					return;
				pending = true;
				const run = () => {
					pending = false;
					if (originalsCache !== null && originalsKey !== themeKey())
						invalidateStylesheet();
					applyVisuals();
				};
				if (typeof window.requestAnimationFrame === "function")
					window.requestAnimationFrame(run);
				else
					run();
			});
			themeObserver.observe(document.body, { attributes: true, attributeFilter: ["data-ds-dark-theme", "class"] });
			disposers.push(() => {
				themeObserver.disconnect();
			});
		}
		//#endregion

		//#region boot
		async function boot() {
			baseStyleTag().textContent = BASE_CSS;

			const local = readLocal();
			if (local !== null)
				settings = sanitize(local, DEFAULT_SETTINGS);

			// Listing only needs the folder, which the localStorage mirror already holds:
			// run it alongside the settings read instead of after it.
			const listFolder = settings.folder;
			const listPromise = refreshImages();

			try {
				const hosted = await hostLoad();
				if (hosted !== null)
					settings = sanitize(hosted, settings);
			}
			catch (error) {
				hostReachable = false;
				warn("host settings unavailable, falling back to the localStorage copy:", describe(error));
			}

			await listPromise;
			if (settings.folder !== listFolder)
				await refreshImages();
			applyVisuals();
			startHealing();
			watchTheme();
			for (const type of ["pointerdown", "mousedown", "click"])
				document.addEventListener(type, onEntryPointerLike, true);

			disposers.push(() => {
				for (const type of ["pointerdown", "mousedown", "click"])
					document.removeEventListener(type, onEntryPointerLike, true);
				closePanel();
				if (saveTimer !== null)
					window.clearTimeout(saveTimer);
				if (healTimer !== null)
					window.clearTimeout(healTimer);
				domObserver?.disconnect();
				document.documentElement.removeAttribute(ACTIVE_ATTR);
				document.querySelector(`div[${LAYER_ATTR}]`)?.remove();
				document.querySelector(`[${ENTRY_ATTR}]`)?.remove();
				baseStyleTag().textContent = "";
				globalStyleTag().textContent = "";
			});
			log("mounted", { folder: settings.folder, file: settings.file, enabled: settings.enabled, active: isActive() });
		}
		//#endregion

		//#region entry
		/** No hard service dependencies — the wallpaper only touches the DOM. */
		const inject = [];

		/** Apply the browser half. */
		function apply() {
			try {
				void boot();
			}
			catch (error) {
				console.error(`[${PLUGIN_ID}] mount failed:`, error);
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.__internals = { DEFAULT_SETTINGS, SURFACE_TOKENS, SIDEBAR_DARKEN, PAGE_SIZE, pageCount, sanitize, sidebarSurface, translucent, darken, kindOf, posterUrl, VIDEO_EXTENSIONS, VIDEO_LAYER_CSS, BASE_CSS, buildStylesheet, styleBuilds: () => stylesheetBuilds };
		return module.exports;
		//#endregion
	}
});
