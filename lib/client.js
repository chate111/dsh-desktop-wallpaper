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

		const STORAGE_KEY = `${PLUGIN_ID}.settings`;
		const ACTIVE_ATTR = "data-dwp-active";
		const LAYER_ATTR = "data-dsw-wallpaper-layer";
		const PHOTO_ATTR = "data-dsw-wallpaper-photo";
		const SCRIM_ATTR = "data-dsw-wallpaper-scrim";
		const ENTRY_ATTR = "data-dsw-wallpaper-entry";
		const PANEL_ATTR = "data-dsw-wallpaper-panel";
		const BODY_ATTR = "data-dsw-wallpaper-body";
		const STYLE_BASE = `${PLUGIN_ID}/base`;
		const STYLE_GLOBAL = `${PLUGIN_ID}/global`;

		const DEFAULT_SETTINGS = {
			version: 1,
			enabled: false,
			folder: "",
			file: "",
			dim: 0,
			blur: 0,
			surface: 66,
			sidebarDelta: 15,
			disableSkin: true,
		};

		/**
		 * Background-ish surface tokens. Deliberately excludes label, border and
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
		const MENU_HOST_SELECTOR = "[data-windows-menu]";

		const PANEL_WIDTH = 332;
		const PLACEHOLDER_FOLDER = "（还没选择壁纸文件夹）";
		//#endregion

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

		function buildStylesheet() {
			const originals = captureOriginals();
			if (originals.size === 0) {
				warn("no --dsw-* surface tokens found on body; leaving the theme untouched");
				return "";
			}
			const mainDeclarations = [];
			const sidebarDeclarations = [];
			const skipped = [];
			for (const [token, value] of originals) {
				if (!isColorValue(value)) {
					skipped.push(token);
					continue;
				}
				mainDeclarations.push(`${token}: ${translucent(value, settings.surface)} !important;`);
				sidebarDeclarations.push(`${token}: ${darken(translucent(value, sidebarSurface()), SIDEBAR_DARKEN)} !important;`);
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
			const scrim = document.createElement("div");
			scrim.setAttribute(SCRIM_ATTR, "");
			scrim.style.cssText = "position:absolute;inset:0;";
			layer.append(photo, scrim);
			document.body.appendChild(layer);
			return layer;
		}

		function applyVisuals() {
			if (!isActive()) {
				// Gate off first, so the theme's own tokens apply again immediately.
				document.documentElement.removeAttribute(ACTIVE_ATTR);
				const existing = document.querySelector(`div[${LAYER_ATTR}]`);
				if (existing !== null)
					existing.style.display = "none";
				writeGlobalStyles();
				return;
			}
			const layer = ensureLayer();
			const photo = layer.querySelector(`[${PHOTO_ATTR}]`);
			const scrim = layer.querySelector(`[${SCRIM_ATTR}]`);
			layer.style.display = "";
			photo.style.backgroundImage = `url("${imageUrl(settings.file)}")`;
			photo.style.filter = settings.blur > 0 ? `blur(${settings.blur}px)` : "none";
			scrim.style.background = settings.dim > 0 ? `rgba(0, 0, 0, ${settings.dim / 100})` : "transparent";
			writeGlobalStyles();
			document.documentElement.setAttribute(ACTIVE_ATTR, "");
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
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.32);
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
  margin-top: 8px;
  padding: 6px 8px;
  border-radius: 6px;
  background: var(--dsw-wallpaper-panel-soft);
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
			domObserver = new MutationObserver(() => {
				if (document.querySelector(`[${ENTRY_ATTR}]`) === null) {
					healDelay = 300;
					attempt();
				}
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
				if (typeof result.folder === "string" && result.folder !== "")
					settings.folder = result.folder;
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
			path.textContent = settings.folder === "" ? PLACEHOLDER_FOLDER : settings.folder;
			path.title = settings.folder;
			const pick = panelButton("选择文件夹", async () => {
				pick.disabled = true;
				lastError = "";
				renderStatus();
				try {
					const result = await hostPick();
					if (result?.folder) {
						await adoptFolder(result.folder);
						path.textContent = settings.folder;
						path.title = settings.folder;
						renderBody();
					}
				}
				catch (error) {
					lastError = `打开文件夹对话框失败：${describe(error)}（可以直接粘贴路径）`;
					renderStatus();
				}
				finally {
					pick.disabled = false;
				}
			});
			const rescan = panelButton("重扫", async () => {
				await refreshImages();
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
				path.textContent = settings.folder;
				path.title = settings.folder;
				renderBody();
			});
			pathRow.append(pathInput, usePath);
			node.appendChild(pathRow);

			// — preview + thumbnails (rebuilt in place)
			const body = document.createElement("div");
			body.setAttribute(BODY_ATTR, "");
			node.appendChild(body);

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
					applyVisuals();
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
				let error = body.querySelector(".dsw-wp-error");
				if (lastError === "") {
					error?.remove();
					return;
				}
				if (error === null) {
					error = document.createElement("div");
					error.className = "dsw-wp-error";
					body.appendChild(error);
				}
				error.textContent = lastError;
			}

			function renderBody() {
				body.textContent = "";
				const preview = document.createElement("div");
				preview.className = "dsw-wp-preview";
				const caption = document.createElement("span");
				caption.className = "dsw-wp-caption";
				if (settings.file !== "" && settings.folder !== "") {
					const img = document.createElement("img");
					img.src = imageUrl(settings.file);
					img.alt = settings.file;
					img.decoding = "async";
					caption.textContent = settings.file;
					preview.append(img, caption);
				}
				else {
					caption.textContent = "还没有选中图片";
					preview.appendChild(caption);
				}
				body.appendChild(preview);

				if (images.length > 0) {
					const grid = document.createElement("div");
					grid.className = "dsw-wp-grid";
					for (const image of images) {
						const thumb = document.createElement("button");
						thumb.type = "button";
						thumb.className = "dsw-wp-thumb";
						thumb.dataset.selected = String(image.name === settings.file);
						thumb.title = `${image.name}（${Math.round(image.size / 1024)} KB）`;
						const img = document.createElement("img");
						img.src = imageUrl(image.name);
						img.alt = image.name;
						img.loading = "lazy";
						img.decoding = "async";
						const name = document.createElement("em");
						name.textContent = image.name;
						thumb.append(img, name);
						thumb.addEventListener("click", () => {
							settings.file = image.name;
							settings.enabled = true;
							applyVisuals();
							scheduleSave();
							renderBody();
						});
						grid.appendChild(thumb);
					}
					body.appendChild(grid);
				}
				else if (settings.folder !== "" && lastError === "") {
					const empty = document.createElement("div");
					empty.className = "dsw-wp-note";
					empty.textContent = "这个文件夹里没有 jpg / jpeg / png / webp / gif / bmp / avif 图片。";
					body.appendChild(empty);
				}
				renderStatus();
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
			const themeObserver = new MutationObserver(() => {
				applyVisuals();
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

			try {
				const hosted = await hostLoad();
				if (hosted !== null)
					settings = sanitize(hosted, settings);
			}
			catch (error) {
				hostReachable = false;
				warn("host settings unavailable, falling back to the localStorage copy:", describe(error));
			}

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
		exports.__internals = { DEFAULT_SETTINGS, SURFACE_TOKENS, SIDEBAR_DARKEN, sanitize, sidebarSurface, translucent, darken, buildStylesheet };
		return module.exports;
		//#endregion
	}
});
