import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

function walkTsx(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkTsx(full));
    } else if (entry.name.endsWith(".tsx") || entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

test("Components contain zero native <select>, zero backdrop-blur, zero gradients, and zero alert()", () => {
  const componentFiles = walkTsx(path.join(REPO_ROOT, "src/components"));
  assert.ok(componentFiles.length >= 10);

  for (const file of componentFiles) {
    const src = fs.readFileSync(file, "utf8");
    const srcNoMask = src.replace(/\[mask-image:linear-gradient\([^\]]+\)\]/g, "");
    assert.equal(src.includes("<select"), false, `Forbidden <select> found in ${file}`);
    assert.equal(src.includes("backdrop-blur"), false, `Forbidden backdrop-blur found in ${file}`);
    assert.equal(
      /linear-gradient|radial-gradient/.test(srcNoMask),
      false,
      `Forbidden CSS gradient found in ${file}`,
    );
    assert.equal(/\balert\s*\(/.test(src), false, `Forbidden alert() found in ${file}`);
  }
});

test("ViewportPlaceholder and WatchRoom uphold child HWND empty-surface and overlay visibility invariants", () => {
  const placeholder = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/ViewportPlaceholder.tsx"),
    "utf8",
  );
  assert.equal(placeholder.includes("if (loaded && !playerError) return null;"), true);

  const watchRoom = fs.readFileSync(path.join(REPO_ROOT, "src/components/WatchRoom.tsx"), "utf8");
  assert.equal(watchRoom.includes("modalBlockingVideo"), true);
  assert.equal(watchRoom.includes("mpvSetVisible(false)"), true);
  assert.equal(watchRoom.includes("mpvSetVisible(true)"), true);
  assert.equal(watchRoom.includes("<FrozenVideoFrame"), true);
  assert.equal(watchRoom.includes("useShallow"), true);
  assert.equal(watchRoom.includes("<PlaybackPanel />"), true);
  assert.equal(watchRoom.includes("<SubtitlePanel />"), true);
  assert.equal(watchRoom.includes("<ViewportPlaceholder"), true);
  assert.equal(watchRoom.includes("<RoomPanel"), true);
  assert.equal(watchRoom.includes("usePlayerShortcuts"), true);
  assert.equal(watchRoom.includes("onDragDropEvent"), true);
  assert.equal(
    watchRoom.includes('["mkv", "mp4", "ts", "m2ts", "avi", "webm", "flv", "wmv", "ogv", "3gp", "*"]'),
    true,
  );

  const subtitlePanel = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/SubtitlePanel.tsx"),
    "utf8",
  );
  assert.equal(
    subtitlePanel.includes('["srt", "ass", "ssa", "vtt", "sub", "idx", "*"]'),
    true,
  );
});

test("Animation and compositor performance invariants hold in UI primitives and CSS", () => {
  const transport = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/TransportBar.tsx"),
    "utf8",
  );
  assert.equal(transport.includes("PlaybackScrubber"), true);

  const scrubber = fs.readFileSync(path.join(REPO_ROOT, "src/components/ui/Scrubber.tsx"), "utf8");
  assert.equal(scrubber.includes("translateX(${(ratio - 1) * 100}%)"), true);
  assert.equal(scrubber.includes("translateX("), true);
  assert.doesNotMatch(scrubber, /ep-scrubber-fill[^"]*rounded-full/);

  const tabs = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/ui/SegmentedTabs.tsx"),
    "utf8",
  );
  assert.equal(tabs.includes("transition-[transform,width]"), true);
  assert.equal(tabs.includes("ep-droplet-core"), true);
  assert.equal(tabs.includes("ep-tray-option"), true);

  const ctxMenu = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/ui/ContextMenu.tsx"),
    "utf8",
  );
  assert.equal(ctxMenu.includes("offsetWidth"), true);
  assert.equal(ctxMenu.includes("scrollHeight"), true);
  assert.equal(ctxMenu.includes("minTop"), true);

  const selectMenu = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/ui/SelectMenu.tsx"),
    "utf8",
  );
  assert.equal(selectMenu.includes("Math.max(110"), false);
  assert.equal(selectMenu.includes("resolvedPlacement"), true);

  const settingsSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/SettingsModal.tsx"),
    "utf8",
  );
  const shortcutsSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/ShortcutsModal.tsx"),
    "utf8",
  );
  assert.equal(settingsSrc.includes('<div className="ep-menu-row'), false);
  assert.equal(shortcutsSrc.includes("ep-menu-row"), false);
  assert.equal(shortcutsSrc.includes("ep-glass-input"), false);
  const globalsCss = fs.readFileSync(path.join(REPO_ROOT, "src/styles/globals.css"), "utf8");
  assert.equal(globalsCss.includes(".ep-glass-input:focus-within"), false);
  assert.equal(globalsCss.includes(".ep-glass-tray"), true);

  const selectMenuSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/ui/SelectMenu.tsx"),
    "utf8",
  );
  assert.equal(selectMenuSrc.includes("ep-glass-submenu"), true);
  assert.equal(selectMenuSrc.includes("ep-glass-select"), true);
  assert.equal(selectMenuSrc.includes('data-glass-region="true"'), true);

  assert.equal(ctxMenu.includes("ep-glass-submenu"), true);

  const scrubberSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/ui/Scrubber.tsx"),
    "utf8",
  );
  assert.equal(scrubberSrc.includes("-ml-[7px]"), true);
  assert.equal(scrubberSrc.includes("left-[7px] right-[7px]"), true);
  assert.equal(scrubberSrc.includes("tooltipPlacement"), true);
  assert.equal(scrubberSrc.includes("tooltipVariant"), true);
  assert.equal(scrubberSrc.includes('data-glass-region="true"'), true);
  const transportBarSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/TransportBar.tsx"),
    "utf8",
  );
  assert.doesNotMatch(transportBarSrc, /ariaLabel="Volume"[\s\S]*?tooltipPlacement="bottom"/);
  assert.match(transportBarSrc, /ariaLabel="Volume"[\s\S]*?tooltipPlacement="top"[\s\S]*?tooltipVariant="plain"/);

  const subPanelSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/SubtitlePanel.tsx"),
    "utf8",
  );
  assert.equal(subPanelSrc.includes("ring-2 ring-accent-soft"), true);
  assert.equal(subPanelSrc.includes("ring-offset-chrome"), false);
  assert.equal(subPanelSrc.includes("Image sub"), true);
  assert.equal(subPanelSrc.includes("<GlassHoverTip"), true);
  assert.equal(subPanelSrc.includes("ep-glass-well"), false);
  assert.equal(subPanelSrc.includes("<SegmentedTabs"), true);
  assert.match(subPanelSrc, /space-y-2\.5[\s\S]*Appearance/);

  const playbackSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/PlaybackPanel.tsx"),
    "utf8",
  );
  assert.equal(playbackSrc.includes("ep-glass-well"), false);
  assert.equal(playbackSrc.includes("<SegmentedTabs"), true);

  const backdropSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/VideoGlassBackdrop.tsx"),
    "utf8",
  );
  assert.equal(backdropSrc.includes("ResizeObserver"), true);
  assert.equal(backdropSrc.includes("MutationObserver"), true);

  const homeSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/HomeScreen.tsx"),
    "utf8",
  );
  assert.equal(homeSrc.includes("max-h-[calc(100vh-4rem)] overflow-hidden"), true);
  assert.equal(homeSrc.includes("ep-menu-scroll flex-1 min-h-0"), true);
  assert.equal(settingsSrc.includes("overflow-y-auto gap-3") || settingsSrc.includes("min-h-0 overflow-y-auto"), true);
  assert.equal(settingsSrc.includes("break-all"), false);
});

test("Built dist bundle emits strictly 3 WOFF2 fonts and includes reliability symbols", () => {
  const assetsDir = path.join(REPO_ROOT, "dist/assets");
  assert.equal(fs.existsSync(assetsDir), true, "dist/assets must exist after npm run build");

  const assetFiles = fs.readdirSync(assetsDir);
  const woff2Files = assetFiles.filter((f) => f.endsWith(".woff2"));
  assert.equal(woff2Files.length, 3, `Expected 3 .woff2 files, got: ${woff2Files.join(", ")}`);

  const jsFiles = assetFiles.filter((f) => f.endsWith(".js"));
  assert.ok(jsFiles.length >= 1);
  const jsBundle = jsFiles
    .map((f) => fs.readFileSync(path.join(assetsDir, f), "utf8"))
    .join("\n");

  for (const token of [
    "Noto Sans Arabic",
    "overrideAssStyle",
    "encodingHint",
    "allowNetworkShares",
    "sameLengthDifferentEncode",
  ]) {
    assert.equal(jsBundle.includes(token), true, `Expected token "${token}" in built JS bundle`);
  }
});

test("Fix 22: compact static TTF fonts exist for mpv under 350 KB installer budget", () => {
  const fontsDir = path.join(REPO_ROOT, "src-tauri/resources/fonts");
  const regularExpected = ["Inter-Regular.ttf", "NotoSansArabic-Regular.ttf"];
  const boldExpected = ["Inter-Bold.ttf", "NotoSansArabic-Bold.ttf"];
  let regularBytes = 0;
  let totalBytes = 0;

  for (const file of regularExpected) {
    const full = path.join(fontsDir, file);
    assert.equal(fs.existsSync(full), true, `Missing bundled mpv font: ${file}`);
    const size = fs.statSync(full).size;
    assert.ok(size > 10_000, `Font ${file} unexpectedly empty (${size} bytes)`);
    regularBytes += size;
    totalBytes += size;
  }

  for (const file of boldExpected) {
    const full = path.join(fontsDir, file);
    assert.equal(fs.existsSync(full), true, `Missing bundled mpv bold font: ${file}`);
    const size = fs.statSync(full).size;
    assert.ok(size > 10_000, `Bold font ${file} unexpectedly empty (${size} bytes)`);
    totalBytes += size;
  }

  assert.ok(
    regularBytes < 350 * 1024,
    `Bundled regular TTF fonts (${regularBytes} bytes) exceeded 350 KB size budget`,
  );
  assert.ok(
    totalBytes < 550 * 1024,
    `Bundled Regular + Bold TTF fonts (${totalBytes} bytes) exceeded 550 KB size budget`,
  );
});

test("Main app uses Royal Purple branding (#7C3AED/#8B5CF6) with zero legacy amber accents", () => {
  const globalsCss = fs.readFileSync(path.join(REPO_ROOT, "src/styles/globals.css"), "utf8");
  assert.equal(/#E5A93C|#F0B94E/i.test(globalsCss), false, "Legacy amber accent remains in globals.css");
  assert.equal(globalsCss.includes("#7C3AED"), true);
  assert.equal(globalsCss.includes("#8B5CF6"), true);
});

test("Custom frameless TitleBar and consumer Smoked-Amethyst UX invariants hold cleanly", () => {
  const tauriConf = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "src-tauri/tauri.conf.json"), "utf8"),
  ) as { app: { windows: Array<{ decorations?: boolean }> } };
  assert.equal(tauriConf.app.windows[0]?.decorations, false);

  const caps = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "src-tauri/capabilities/default.json"), "utf8"),
  ) as { permissions: string[] };
  for (const perm of [
    "core:window:allow-start-dragging",
    "core:window:allow-minimize",
    "core:window:allow-toggle-maximize",
    "core:window:allow-close",
  ]) {
    assert.equal(caps.permissions.includes(perm), true, `Missing capability permission ${perm}`);
  }

  const titleBar = fs.readFileSync(path.join(REPO_ROOT, "src/components/TitleBar.tsx"), "utf8");
  assert.equal(titleBar.includes("data-tauri-drag-region"), true);
  assert.equal(titleBar.includes("toggleMaximize"), true);
  assert.equal(titleBar.includes("minimize"), true);

  const homeSrc = fs.readFileSync(path.join(REPO_ROOT, "src/components/HomeScreen.tsx"), "utf8");
  assert.equal(homeSrc.includes("<TitleBar"), true);
  assert.equal(homeSrc.includes("ep-amethyst-canvas"), true);
  assert.equal(homeSrc.includes("Room password & options"), true);

  const watchSrc = fs.readFileSync(path.join(REPO_ROOT, "src/components/WatchRoom.tsx"), "utf8");
  assert.equal(watchSrc.includes("<TitleBar"), true);
  assert.equal(watchSrc.includes('"Watch Party"'), true);
  assert.equal(watchSrc.includes("<SegmentedTabs"), false);
  assert.equal(watchSrc.includes("<RoomPanel"), true);
  assert.equal(watchSrc.includes("<PlaybackPanel />"), true);
  assert.equal(watchSrc.includes("<SubtitlePanel />"), true);

  const settingsSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/SettingsModal.tsx"),
    "utf8",
  );
  assert.match(settingsSrc, /value:\s*"profile",\s*label:\s*"Profile"/);
  assert.match(settingsSrc, /value:\s*"appearance",\s*label:\s*"Appearance"/);
  assert.match(settingsSrc, /value:\s*"playback",\s*label:\s*"Playback"/);
  assert.match(settingsSrc, /value:\s*"party",\s*label:\s*"Party & Privacy"/);
  assert.match(settingsSrc, /value:\s*"updates",\s*label:\s*"Updates"/);
  assert.match(settingsSrc, /value:\s*"server",\s*label:\s*"Connection & Server"/);
  assert.match(settingsSrc, /value:\s*"logs",\s*label:\s*"Diagnostics"/);
});

test("Transparent WebView2 punch-through reveals underlying mpv child HWND during playback", () => {
  const tauriConf = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "src-tauri/tauri.conf.json"), "utf8"),
  ) as { app: { windows: Array<{ transparent?: boolean }> } };
  assert.equal(tauriConf.app.windows[0]?.transparent, true);

  const indexHtml = fs.readFileSync(path.join(REPO_ROOT, "index.html"), "utf8");
  assert.equal(/<body[^>]*bg-canvas/.test(indexHtml), false);

  const globalsCss = fs.readFileSync(path.join(REPO_ROOT, "src/styles/globals.css"), "utf8");
  const layerIdx = globalsCss.indexOf("@layer base");
  const videoActiveIdx = globalsCss.indexOf("html.ep-video-active");
  assert.ok(layerIdx !== -1 && videoActiveIdx > layerIdx);
  // html.ep-video-active must live outside @layer base so @layer utilities never override it
  const baseBlockClose = globalsCss.indexOf("}\n}", layerIdx);
  assert.ok(baseBlockClose !== -1 && videoActiveIdx > baseBlockClose);
});

test("Real-time liquid-glass backdrop sampling and convex bezel lens invariants hold", () => {
  const watchSrc = fs.readFileSync(path.join(REPO_ROOT, "src/components/WatchRoom.tsx"), "utf8");
  assert.equal(watchSrc.includes("<VideoGlassBackdrop"), true);
  assert.equal(watchSrc.includes('data-glass-region="true"'), true);

  const transportSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/TransportBar.tsx"),
    "utf8",
  );
  assert.equal(transportSrc.includes('data-glass-region="true"'), true);

  const titleBarSrc = fs.readFileSync(path.join(REPO_ROOT, "src/components/TitleBar.tsx"), "utf8");
  assert.equal(titleBarSrc.includes("data-glass-region="), true);

  const contextMenuSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/ui/ContextMenu.tsx"),
    "utf8",
  );
  assert.equal(contextMenuSrc.includes('data-glass-region="true"'), true);

  const backdropSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/VideoGlassBackdrop.tsx"),
    "utf8",
  );
  assert.equal(backdropSrc.includes("sampleBilinear"), true);
  assert.equal(backdropSrc.includes("bezelThickness"), true);
  assert.equal(backdropSrc.includes("devicePixelRatio"), true);
  assert.equal(backdropSrc.includes("pausedRefreshKey"), true);
  assert.equal(backdropSrc.includes("computeRegionPlacement"), true);

  const notifSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/ui/NotificationStrip.tsx"),
    "utf8",
  );
  assert.equal(notifSrc.includes('data-glass-region="true"'), true);
  assert.equal(watchSrc.includes("glassControls={showVideoBackdrop}"), true);

  const globalsCss = fs.readFileSync(path.join(REPO_ROOT, "src/styles/globals.css"), "utf8");
  assert.equal(globalsCss.includes("epilod-liquid-lens"), false);
  assert.equal(/saturate\(2\d\d%/.test(globalsCss), false);

  const mpvTs = fs.readFileSync(path.join(REPO_ROOT, "src/lib/mpv.ts"), "utf8");
  assert.equal(mpvTs.includes('"mpv_backdrop_frame"'), true);

  const rustLib = fs.readFileSync(path.join(REPO_ROOT, "src-tauri/src/lib.rs"), "utf8");
  assert.equal(rustLib.includes("async fn mpv_backdrop_frame"), true);
});

test("Hero play/pause button uses custom faceted crystal icons and purplish smoked-amethyst glass orb", () => {
  const iconsSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/ui/PlayerIcons.tsx"),
    "utf8",
  );
  const playSection = iconsSrc.slice(
    iconsSrc.indexOf("export function PlayerPlayIcon"),
    iconsSrc.indexOf("export function PlayerPauseIcon"),
  );
  const pauseSection = iconsSrc.slice(
    iconsSrc.indexOf("export function PlayerPauseIcon"),
    iconsSrc.indexOf("export function PlayerSeekIcon"),
  );
  assert.equal(playSection.includes("<clipPath"), true);
  assert.equal(playSection.includes("#7C3AED"), true);
  assert.equal(pauseSection.includes("<clipPath"), true);
  assert.equal(pauseSection.includes("#7C3AED"), true);

  const skipSection = iconsSrc.slice(
    iconsSrc.indexOf("export function PlayerSkipEpisodeIcon"),
    iconsSrc.indexOf("export function PlayerVolumeIcon"),
  );
  assert.equal(skipSection.includes("<clipPath"), true);
  assert.equal(skipSection.includes("#7C3AED"), true);

  const transportSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/TransportBar.tsx"),
    "utf8",
  );
  assert.match(transportSrc, /ep-orb-play[\s\S]*<PlayerPlayIcon[\s\S]*<PlayerPauseIcon/);
  assert.equal(transportSrc.includes("ep-transport-bubble"), true);
  assert.equal(transportSrc.includes("ep-transport-btn"), true);
  assert.equal(transportSrc.includes("relative z-10 anim-icon-pop"), true);

  const globalsCss = fs.readFileSync(path.join(REPO_ROOT, "src/styles/globals.css"), "utf8");
  assert.match(globalsCss, /\.ep-orb-play\s*\{[\s\S]*rgba\(124,\s*58,\s*237/);
  assert.match(globalsCss, /\.ep-orb-play\s*\{[\s\S]*backdrop-filter:\s*blur\(/);
  assert.match(globalsCss, /\.ep-orb-play:hover:not\(:disabled\)[\s\S]*rgba\(139,\s*92,\s*246/);
  assert.equal(globalsCss.includes(".ep-bar-icon-btn.ep-transport-btn"), true);
  assert.equal(globalsCss.includes(".ep-orb-play svg"), true);
  assert.equal(globalsCss.includes(".ep-orb-play::before"), true);
  assert.equal(globalsCss.includes(".ep-orb-play::after"), true);
});

test("Auto-hiding and re-showing play bar, top bar, and video backdrop glide smoothly together", () => {
  const globalsCss = fs.readFileSync(path.join(REPO_ROOT, "src/styles/globals.css"), "utf8");
  assert.match(globalsCss, /\.ep-chrome-transition\s*\{[\s\S]*opacity[\s\S]*transform[\s\S]*translate[\s\S]*scale/);
  assert.match(
    globalsCss,
    /\.ep-chrome-transition\[aria-hidden="true"\]\s*\{[\s\S]*translate[\s\S]*scale[\s\S]*cubic-bezier\(0\.32,\s*0\.72,\s*0,\s*1\)|\.ep-chrome-transition\[aria-hidden="true"\]\s*\{[\s\S]*cubic-bezier\(0\.32,\s*0\.72,\s*0,\s*1\)[\s\S]*translate[\s\S]*scale/,
  );
  assert.match(globalsCss, /\.ep-switch-slide\s*\{[\s\S]*transform[\s\S]*translate/);

  const transportSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/TransportBar.tsx"),
    "utf8",
  );
  assert.equal(transportSrc.includes("ep-chrome-transition"), true);
  assert.equal(transportSrc.includes("translate-y-0 scale-100"), true);
  assert.equal(transportSrc.includes("translate-y-5 scale-[0.982]"), true);

  const watchSrc = fs.readFileSync(path.join(REPO_ROOT, "src/components/WatchRoom.tsx"), "utf8");
  assert.equal(watchSrc.includes("backdropPresence.mounted"), true);
  assert.equal(watchSrc.includes("ep-chrome-transition"), true);
  assert.equal(watchSrc.includes("-translate-y-3 scale-[0.988]"), true);
  assert.equal(watchSrc.includes("handleBarHoverChange"), true);
  assert.equal(watchSrc.includes("onPassivePointerMove"), true);
  assert.match(watchSrc, /barLeaveCooldownUntilRef/);

  const backdropSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/VideoGlassBackdrop.tsx"),
    "utf8",
  );
  assert.match(backdropSrc, /globalAlpha\s*=\s*0\.92\s*\*\s*regionAlpha/);
  assert.equal(backdropSrc.includes("computeRegionPlacement"), true);
  assert.equal(backdropSrc.includes("cur.parentElement"), true);
});

test("Menus, popovers, tabs, modals, notifications, switches, and collapsible panels animate enter/exit cleanly", () => {
  const presenceSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/lib/useAnimatedPresence.ts"),
    "utf8",
  );
  assert.equal(presenceSrc.includes("export function useAnimatedPresence"), true);
  assert.equal(presenceSrc.includes("export function usePresencePayload"), true);
  assert.equal(presenceSrc.includes("prefersReducedMotion"), true);

  const globalsCss = fs.readFileSync(path.join(REPO_ROOT, "src/styles/globals.css"), "utf8");
  for (const className of [
    ".anim-pop-out",
    ".ep-popover-bloom-out",
    ".anim-backdrop-out",
    ".anim-modal-out",
    ".anim-fade-slide-down",
    ".ep-capsule-morph",
    ".ep-collapse",
    ".ep-switch-slide",
  ]) {
    assert.equal(globalsCss.includes(className), true, `Missing ${className} in globals.css`);
  }

  for (const rel of [
    "src/components/WatchRoom.tsx",
    "src/components/SettingsModal.tsx",
    "src/components/ShortcutsModal.tsx",
    "src/components/HomeScreen.tsx",
    "src/components/ui/ContextMenu.tsx",
    "src/components/ui/SelectMenu.tsx",
    "src/components/ui/NotificationStrip.tsx",
  ]) {
    const src = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
    assert.match(
      src,
      /(useAnimatedPresence|usePresencePayload|anim-fade-slide-down)/,
      `Expected animated exit support in ${rel}`,
    );
  }

  // Ensure every .ep-switch-track translates on GPU transforms rather than non-animatable justify-content,
  // and no .ep-press button conflicts with Tailwind transition utilities.
  const componentFiles: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name)) componentFiles.push(full);
    }
  };
  walk(path.join(REPO_ROOT, "src/components"));

  for (const file of componentFiles) {
    const src = fs.readFileSync(file, "utf8");
    const rel = path.relative(REPO_ROOT, file);
    assert.equal(
      src.includes("ep-btn-ghost"),
      false,
      `${rel} must not reference removed ep-btn-ghost class`,
    );
    assert.equal(
      /ep-switch-track[^`"}]*justify-(?:start|end)/.test(src),
      false,
      `${rel} must use transform slide on switch thumb instead of justify-start/end`,
    );
    assert.equal(
      /className=(?:"|`)[^"`]*\bep-press\b[^"`]*\btransition-(?:colors|all|transform)\b/.test(src),
      false,
      `${rel} must not override .ep-press transition with Tailwind transition utilities`,
    );
  }
});

test("Modal glass sheets keep unnested sibling backdrops and emit unprefixed backdrop-filter", () => {
  const globalsCss = fs.readFileSync(path.join(REPO_ROOT, "src/styles/globals.css"), "utf8");
  const prefixedMatches = [...globalsCss.matchAll(/-webkit-backdrop-filter:\s*([^;]+);/g)];
  assert.ok(prefixedMatches.length >= 6);
  for (const m of prefixedMatches) {
    const start = m.index ?? 0;
    const after = globalsCss.slice(start + m[0].length, start + m[0].length + 120);
    assert.match(
      after,
      /^\s*backdrop-filter:\s*[^;]+;/,
      "Unprefixed backdrop-filter must follow -webkit-backdrop-filter so LightningCSS retains it",
    );
  }

  for (const rel of ["src/components/SettingsModal.tsx", "src/components/ShortcutsModal.tsx"]) {
    const src = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
    const backdropMatch = /className=\{`ep-modal-backdrop\b/.exec(src);
    const sheetMatch = /className=\{`ep-glass-sheet\b/.exec(src);
    assert.ok(backdropMatch && sheetMatch && sheetMatch.index > backdropMatch.index, `${rel} must render backdrop before sheet`);
    // Ensure .ep-modal-backdrop closes before .ep-glass-sheet opens (sibling, never ancestor).
    const between = src.slice(backdropMatch.index, sheetMatch.index);
    assert.equal(between.includes("/>"), true, `${rel} backdrop scrim must be a sibling of .ep-glass-sheet`);
  }

  const assetsDir = path.join(REPO_ROOT, "dist/assets");
  const cssFile = fs.readdirSync(assetsDir).find((f) => f.endsWith(".css"));
  assert.ok(cssFile, "Expected compiled CSS asset in dist/assets");
  const builtCss = fs.readFileSync(path.join(assetsDir, cssFile), "utf8");
  assert.match(builtCss, /\.ep-modal-backdrop\{[^}]*backdrop-filter:blur\(/);
  assert.match(builtCss, /\.ep-glass-sheet\{[^}]*backdrop-filter:blur\(/);
  assert.match(builtCss, /\.ep-glass-submenu\{[^}]*backdrop-filter:blur\(/);
  assert.match(builtCss, /\.ep-glass-select\{[^}]*backdrop-filter:blur\(/);
  assert.match(builtCss, /\.ep-glass-well\{[^}]*backdrop-filter:blur\(/);
  assert.match(builtCss, /\.ep-hairline-divider\{[^}]*height:1px/);
  // Component layer classes must emit before Tailwind utilities so utility overrides win cleanly
  assert.ok(builtCss.indexOf(".ep-glass-pill") < builtCss.indexOf(".ring-1{"));
  assert.ok(builtCss.indexOf(".ep-glass-sheet") < builtCss.indexOf(".border-accent\\/55"));
  assert.match(builtCss, /\.ep-otp-box\.ep-otp-box-verifying:focus/);
  const reducedMotionSection =
    builtCss.slice(builtCss.indexOf("prefers-reduced-motion:reduce"));
  assert.match(reducedMotionSection, /\.animate-ping/);
  assert.match(reducedMotionSection, /\.animate-pulse/);
  assert.match(reducedMotionSection, /\.animate-spin/);
  assert.match(builtCss, /\.ep-glass-bottom-bar\{[^}]*backdrop-filter:blur\(/);
  assert.match(builtCss, /\.ep-settings-sidebar\{/);
  assert.match(builtCss, /\.ep-settings-sidebar:{1,2}before\{/);
  assert.doesNotMatch(
    fs.readFileSync(path.join(REPO_ROOT, "src/components/ui/SegmentedTabs.tsx"), "utf8"),
    /focus-visible:outline-accent/,
  );
  const mainSrc = fs.readFileSync(path.join(REPO_ROOT, "src/main.tsx"), "utf8");
  assert.match(mainSrc, /dataset\.focusMode/);
  assert.match(globalsCss, /:root\[data-focus-mode="keyboard"\]/);
  const episodesSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/EpisodesPanel.tsx"),
    "utf8",
  );
  assert.match(episodesSrc, /text-white\/85/);
  assert.doesNotMatch(episodesSrc, /active \? "text-accent-soft" : "text-muted/);
  const roomPanelSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/RoomPanel.tsx"),
    "utf8",
  );
  assert.doesNotMatch(roomPanelSrc, /bg-accent\/25/);
  const settingsSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/SettingsModal.tsx"),
    "utf8",
  );
  assert.match(settingsSrc, /ep-settings-sidebar/);
  assert.match(settingsSrc, /Full-Width Bottom Play Bar/);

  // Play bar and menus use dark Smoked-Amethyst Liquid Glass without harsh white top lines or bright top washes
  assert.match(globalsCss, /\.ep-glass-capsule\s*\{[^}]*brightness\(0\.92\)/);
  assert.doesNotMatch(globalsCss, /\.ep-glass-capsule\s*\{[^}]*inset 0 12px 24px -16px rgba\(255,\s*255,\s*255,\s*0\.08\)/);
  assert.match(globalsCss, /\.ep-glass-bottom-bar\s*\{[^}]*border-top:\s*1px solid rgba\(255,\s*255,\s*255,\s*0\.14\)[^}]*brightness\(0\.92\)/);
  assert.match(globalsCss, /\.ep-glass-submenu\s*\{[^}]*rgba\(16,\s*16,\s*22,\s*0\.16\)[^}]*brightness\(0\.45\)/);
  assert.match(globalsCss, /\.ep-menu-row\[data-active="true"\]\s*\{[^}]*rgba\(124,\s*58,\s*237,\s*0\.16\)/);
  assert.match(globalsCss, /\.ep-droplet-indicator\s*\{[^}]*rgba\(139,\s*92,\s*246,\s*0\.18\)[^}]*rgba\(196,\s*181,\s*253,\s*0\.24\)/);
  assert.doesNotMatch(
    fs.readFileSync(path.join(REPO_ROOT, "src/components/VideoGlassBackdrop.tsx"), "utf8"),
    /brightness\(0\.84\)|#08080c/,
  );
  assert.match(
    fs.readFileSync(path.join(REPO_ROOT, "src/components/ui/ContextMenu.tsx"), "utf8"),
    /text-white\/45/,
  );

  // Expanded CC/Audio popover cushions + iOS Liquid Glass elastic sliding navigation + harmonious full-width rails
  assert.match(
    fs.readFileSync(path.join(REPO_ROOT, "src/components/WatchRoom.tsx"), "utf8"),
    /rounded-\[22px\] p-3\.5/,
  );
  const segmentedTabsSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/ui/SegmentedTabs.tsx"),
    "utf8",
  );
  const playbackPanelSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/PlaybackPanel.tsx"),
    "utf8",
  );
  const subtitlePanelSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/SubtitlePanel.tsx"),
    "utf8",
  );
  assert.match(playbackPanelSrc, /flex flex-col gap-4/);
  assert.match(playbackPanelSrc, /space-y-1\.5/);
  assert.match(playbackPanelSrc, /text-white\/45/);
  assert.match(subtitlePanelSrc, /flex flex-col gap-4/);
  assert.match(subtitlePanelSrc, /space-y-1\.5/);
  assert.match(subtitlePanelSrc, /text-white\/45/);
  assert.match(segmentedTabsSrc, /gap-1/);
  assert.match(segmentedTabsSrc, /h-8 px-2\.5/);
  assert.doesNotMatch(playbackPanelSrc, /mx-1\.5/);
  assert.doesNotMatch(subtitlePanelSrc, /ep-hairline-divider my-1\.5 mx-1\.5/);
  assert.match(settingsSrc, /ep-droplet-nav/);
  assert.match(globalsCss, /\.ep-droplet-core\[data-morphing="true"\]/);
});

test("Play menu and glass button hover states stay crisp without text-zooming scale transforms", () => {
  const globalsCss = fs.readFileSync(path.join(REPO_ROOT, "src/styles/globals.css"), "utf8");
  const hoverSelectors = [
    "button\\.ep-glass-pill:hover:not\\(:disabled\\)",
    "\\.ep-glass-btn-party:hover:not\\(:disabled\\)",
    "\\.ep-glass-btn-media:hover:not\\(:disabled\\)",
    "\\.ep-glass-primary-pill:hover:not\\(:disabled\\)",
    "\\.ep-glass-liquid-pill:hover:not\\(:disabled\\)",
    "\\.ep-orb-play:hover:not\\(:disabled\\)",
    "\\.ep-bar-pill:hover:not\\(:disabled\\)",
    "\\.ep-bar-icon-btn:hover:not\\(:disabled\\)",
    "\\.ep-bar-icon-btn\\.ep-transport-btn:hover:not\\(:disabled\\)",
    "\\.ep-warning-action:hover:not\\(:disabled\\)",
    "\\.ep-menu-row:hover:not\\(:disabled\\):not\\(\\[aria-disabled=\"true\"\\]\\)",
  ];

  for (const sel of hoverSelectors) {
    const match = new RegExp(`${sel}\\s*\\{([^}]*)\\}`).exec(globalsCss);
    assert.ok(match, `Expected hover rule for ${sel}`);
    assert.doesNotMatch(
      match[1],
      /\btransform\s*:|scale\(|translateY\(/,
      `${sel} must not zoom or shift text on hover`,
    );
  }

  for (const baseClass of [".ep-bar-icon-btn", ".ep-bar-pill", ".ep-menu-row", ".ep-press"]) {
    const escaped = baseClass.replace(".", "\\.");
    const match = new RegExp(
      `(?:^|\\n)[ \\t]*${escaped}(?:,[\\s\\S]*?[^,{])?\\s*\\{([^}]*)\\}`,
    ).exec(globalsCss);
    assert.ok(match, `Expected base rule for ${baseClass}`);
    assert.doesNotMatch(
      match[1],
      /var\(--spring-fluid\)/,
      `${baseClass} should use crisp non-overshooting easing instead of --spring-fluid`,
    );
  }

  const titleBarSrc = fs.readFileSync(path.join(REPO_ROOT, "src/components/TitleBar.tsx"), "utf8");
  assert.equal(titleBarSrc.includes("hover:scale-105"), false);

  const homeSrc = fs.readFileSync(path.join(REPO_ROOT, "src/components/HomeScreen.tsx"), "utf8");
  assert.equal(homeSrc.includes("group-hover:scale-105"), false);
});

test("Non-context menus omit unnecessary separating strokes while right-click ContextMenu keeps dividers", () => {
  for (const rel of [
    "src/components/PlaybackPanel.tsx",
    "src/components/SubtitlePanel.tsx",
    "src/components/RoomPanel.tsx",
    "src/components/EpisodesPanel.tsx",
    "src/components/ReactionPopover.tsx",
    "src/components/SettingsModal.tsx",
    "src/components/ShortcutsModal.tsx",
    "src/components/ui/SelectMenu.tsx",
  ]) {
    const src = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
    assert.equal(
      src.includes("ep-hairline-divider"),
      false,
      `${rel} must not render unnecessary ep-hairline-divider strokes`,
    );
    assert.equal(
      src.includes('role="separator"'),
      false,
      `${rel} must not render role="separator" strokes`,
    );
    assert.doesNotMatch(
      src,
      /\bborder-[trbl]\s+border-white/,
      `${rel} must not render separating directional borders`,
    );
    assert.doesNotMatch(
      src,
      /\b[hw]-px\s+bg-white/,
      `${rel} must not render 1px separating lines`,
    );
  }

  const globalsCss = fs.readFileSync(path.join(REPO_ROOT, "src/styles/globals.css"), "utf8");
  const sidebarRule = /\.ep-settings-sidebar\s*\{([^}]*)\}/.exec(globalsCss);
  assert.ok(sidebarRule, "Expected .ep-settings-sidebar rule in globals.css");
  assert.doesNotMatch(
    sidebarRule[1],
    /border-right\s*:/,
    ".ep-settings-sidebar separates by glass tint without a vertical dividing stroke",
  );

  const contextMenuSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/ui/ContextMenu.tsx"),
    "utf8",
  );
  assert.equal(
    contextMenuSrc.includes("ep-hairline-divider"),
    false,
    "Right-click ContextMenu should group sections with clean spacing instead of hairline divider strokes",
  );
  assert.match(
    contextMenuSrc,
    /flex flex-col gap-1/,
    "ContextMenu submenus should space items comfortably apart",
  );
  assert.match(
    contextMenuSrc,
    /text-white\/45/,
    "ContextMenu section labels should render as muted pure-text headers distinct from clickable rows",
  );
  const hairlineRule = /\.ep-hairline-divider\s*\{([^}]*)\}/.exec(globalsCss);
  assert.ok(hairlineRule, "Expected .ep-hairline-divider rule in globals.css");
  assert.doesNotMatch(
    hairlineRule[1],
    /linear-gradient/,
    ".ep-hairline-divider must be a clean solid translucent stroke rather than faded at the ends",
  );
});

test("TransportBar play bar options retain an active liquid-glass pill and morph fluidly between options", () => {
  const transportSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/TransportBar.tsx"),
    "utf8",
  );
  assert.match(transportSrc, /rightDockRef/);
  assert.match(transportSrc, /ep-droplet-indicator ep-droplet-core/);
  assert.match(transportSrc, /data-visible=\{dockIndicator\.visible \? "true" : "false"\}/);
  assert.match(transportSrc, /data-morphing=\{dockMorphing \? "true" : undefined\}/);
  assert.match(transportSrc, /aria-pressed=\{activeTab === "subtitles"\}/);
  assert.match(transportSrc, /aria-pressed=\{activeTab === "playback"\}/);
  assert.match(transportSrc, /aria-pressed=\{activeTab === "room"\}/);

  const globalsCss = fs.readFileSync(path.join(REPO_ROOT, "src/styles/globals.css"), "utf8");
  assert.match(globalsCss, /\.ep-droplet-core\[data-visible="false"\]/);
});

test("Watch Party lobby uses a single unboxed glass sheet without nested container boxes or separating strokes", () => {
  const homeSrc = fs.readFileSync(path.join(REPO_ROOT, "src/components/HomeScreen.tsx"), "utf8");
  assert.equal(homeSrc.includes("ep-glass-well"), false);
  assert.equal(homeSrc.includes("ep-hairline-divider"), false);
  assert.equal(homeSrc.includes("bg-white/[0.04]"), false);
  assert.equal(homeSrc.includes("bg-white/[0.06] rounded-full"), false);
  assert.equal(homeSrc.includes("rounded-[22px]"), false);

  const partyStart = homeSrc.indexOf('key="party"');
  assert.ok(partyStart !== -1, 'Expected key="party" view in HomeScreen.tsx');
  const partySlice = homeSrc.slice(partyStart, homeSrc.indexOf("{dragBanner.mounted", partyStart));
  const partySheets = partySlice.match(/\bep-glass-sheet\b/g) ?? [];
  assert.equal(partySheets.length, 1, "Watch Party lobby should use exactly one outer glass sheet");
  assert.doesNotMatch(partySlice, /text-\[10\.5px\] text-secondary truncate/);
});

test("Auto-Next uses a smooth ep-toggle-pill without icon remount flicker and custom crystal orbital artwork", () => {
  const episodesSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/EpisodesPanel.tsx"),
    "utf8",
  );
  assert.equal(episodesSrc.includes("ep-toggle-pill"), true);
  assert.equal(episodesSrc.includes("aria-pressed={autoPlayNext}"), true);
  assert.equal(episodesSrc.includes('key={autoPlayNext ? "autonext-on"'), false);
  assert.equal(episodesSrc.includes('key={followPartyEpisode ? "follow-on"'), false);
  assert.equal(episodesSrc.includes("anim-icon-pop"), false);

  const playerIconsSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/ui/PlayerIcons.tsx"),
    "utf8",
  );
  const autoNextFnStart = playerIconsSrc.indexOf("export function PlayerAutoNextIcon");
  const autoNextFnEnd = playerIconsSrc.indexOf("export function PlayerFollowIcon", autoNextFnStart);
  const autoNextSlice = playerIconsSrc.slice(autoNextFnStart, autoNextFnEnd);
  assert.equal(autoNextSlice.includes("#10B981"), false);
  assert.equal(autoNextSlice.includes('viewBox="0 0 24 24"'), true);
  assert.match(autoNextSlice, /#8B5CF6/);

  const globalsCss = fs.readFileSync(path.join(REPO_ROOT, "src/styles/globals.css"), "utf8");
  const toggleHoverMatch = /\.ep-toggle-pill:hover:not\(:disabled\)\s*\{([^}]*)\}/.exec(globalsCss);
  assert.ok(toggleHoverMatch, "Expected .ep-toggle-pill:hover rule in globals.css");
  assert.doesNotMatch(toggleHoverMatch[1], /\btransform\s*:|scale\(|translateY\(/);
});

test("TransportBar right options stay unboxed without ep-bar-dock, VideoGlassBackdrop refreshes on resize/retry, and Episodes active row stays clean liquid glass", () => {
  const transportSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/TransportBar.tsx"),
    "utf8",
  );
  const rightDockStart = transportSrc.indexOf("ref={rightDockRef}");
  assert.notEqual(rightDockStart, -1);
  const rightDockSlice = transportSrc.slice(rightDockStart, rightDockStart + 3200);
  assert.equal(rightDockSlice.includes("ep-bar-dock"), false);
  assert.equal(rightDockSlice.includes("ep-droplet-indicator ep-droplet-core"), true);
  assert.equal(rightDockSlice.includes("ep-bar-icon-btn text-secondary hover:text-white"), true);

  const backdropSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/VideoGlassBackdrop.tsx"),
    "utf8",
  );
  assert.equal(backdropSrc.includes("getLastCapturedBackdropFrame"), true);
  assert.equal(backdropSrc.includes("schedulePausedRetries"), true);
  assert.equal(backdropSrc.includes("requestPausedCaptureRef.current(true)"), true);
  assert.equal(backdropSrc.includes("Math.max(0.78,"), true);
  assert.equal(backdropSrc.includes("Math.min(0.06, rawU - activeBox.maxU)"), true);

  const episodesSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/EpisodesPanel.tsx"),
    "utf8",
  );
  assert.equal(episodesSrc.includes("Now Playing"), false);
  assert.equal(episodesSrc.includes("ep-episode-active"), true);
  assert.equal(episodesSrc.includes("ep-episode-droplet"), true);
  assert.equal(episodesSrc.includes("ep-episode-index-active"), true);
  assert.equal(episodesSrc.includes("bg-white/90"), true);

  const globalsCss = fs.readFileSync(path.join(REPO_ROOT, "src/styles/globals.css"), "utf8");
  const activeEpisodeMatch = /\.ep-episode-active\s*\{([^}]*)\}/.exec(globalsCss);
  assert.ok(activeEpisodeMatch, "Expected .ep-episode-active rule in globals.css");
  assert.doesNotMatch(activeEpisodeMatch[1], /linear-gradient|139,\s*92,\s*246|196,\s*181,\s*253/);
});

test("TransportBar and Scrubber ergonomics: remaining time toggle, hour-safe labels, widened volume, and dragging thumb", () => {
  const transportSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/TransportBar.tsx"),
    "utf8",
  );
  assert.equal(transportSrc.includes("ep-bar-dock"), false);
  assert.match(transportSrc, /showRemaining/);
  assert.match(transportSrc, /Click to show remaining time/);
  assert.match(transportSrc, /min-w-12/);
  assert.match(transportSrc, /VOLUME_WIDTH_CLASSES[\s\S]*?"w-12"[\s\S]*?"w-14"[\s\S]*?"w-16"[\s\S]*?"w-20"/);

  const scrubberSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/ui/Scrubber.tsx"),
    "utf8",
  );
  assert.match(scrubberSrc, /dragging\s*\?\s*"opacity-100 scale-100"/);

  const subPanelSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/SubtitlePanel.tsx"),
    "utf8",
  );
  assert.match(subPanelSrc, /Advanced Options/);
  assert.match(subPanelSrc, /Outline Weight/);
  assert.match(subPanelSrc, /Vertical Position/);
  assert.match(subPanelSrc, /Override styled fansubs/);
});

test("SettingsModal uses smooth neutral Liquid Glass styling without horizontal overflow from Scrubber", () => {
  const scrubberSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/ui/Scrubber.tsx"),
    "utf8",
  );
  assert.match(scrubberSrc, /overflow-x-clip/);
  assert.match(scrubberSrc, /translateX\(/);

  const settingsSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/SettingsModal.tsx"),
    "utf8",
  );
  assert.match(settingsSrc, /ep-settings-scroll[^"]*overflow-y-auto overflow-x-hidden/);
  assert.match(settingsSrc, /col-span-8 ep-settings-content flex flex-col min-h-0 min-w-0/);

  const globalsCss = fs.readFileSync(path.join(REPO_ROOT, "src/styles/globals.css"), "utf8");
  const sidebarBlock = /\.ep-settings-sidebar\s*\{([^}]*)\}/.exec(globalsCss);
  const sidebarBefore = /\.ep-settings-sidebar::before\s*\{([^}]*)\}/.exec(globalsCss);
  assert.ok(sidebarBlock && sidebarBefore, "Expected settings sidebar CSS rules");
  assert.doesNotMatch(sidebarBlock[1], /196,\s*181,\s*253|167,\s*139,\s*250|124,\s*58,\s*237/);
  assert.doesNotMatch(sidebarBefore[1], /radial-gradient|167,\s*139,\s*250|filter:\s*blur/);
  assert.match(globalsCss, /\.ep-settings-sheet::after\s*\{/);
  assert.match(globalsCss, /\.ep-glass-tray \.ep-droplet-indicator\.ep-droplet-core::before\s*\{/);
  assert.match(globalsCss, /\*::-webkit-scrollbar-corner\s*\{[^}]*background:\s*transparent/);

  const appIconsSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/ui/AppIcons.tsx"),
    "utf8",
  );
  for (const iconName of [
    "AppProfileCategoryIcon",
    "AppAppearanceCategoryIcon",
    "AppPlaybackCategoryIcon",
    "AppPartyPrivacyCategoryIcon",
    "AppDownloadIcon",
    "AppWrenchIcon",
    "AppSlidersIcon",
    "AppLogsIcon",
  ]) {
    assert.equal(appIconsSrc.includes(`export function ${iconName}`), true, `Missing ${iconName}`);
    const fnStart = appIconsSrc.indexOf(`export function ${iconName}`);
    const nextFn = appIconsSrc.indexOf("\nexport function ", fnStart + 10);
    const fnBody = appIconsSrc.slice(fnStart, nextFn === -1 ? appIconsSrc.length : nextFn);
    assert.match(fnBody, /linearGradient/, `${iconName} should use custom sculpted SVG gradients`);
  }
});

test("TransportBar party avatar dock aligns concentrically with custom chevron arrow, seek buttons show liquid glass bubbles & seek cues", () => {
  const transportSrc = fs.readFileSync(path.join(REPO_ROOT, "src/components/TransportBar.tsx"), "utf8");
  const globalsCss = fs.readFileSync(path.join(REPO_ROOT, "src/styles/globals.css"), "utf8");
  const iconsSrc = fs.readFileSync(path.join(REPO_ROOT, "src/components/ui/PlayerIcons.tsx"), "utf8");
  const watchSrc = fs.readFileSync(path.join(REPO_ROOT, "src/components/WatchRoom.tsx"), "utf8");

  // Users pill aligns avatar concentrically (pl-1 + 1px border - 2px ring = 3px margin) and displays custom chevron arrow
  assert.match(transportSrc, /!hideParticipants && visiblePeers\.length > 0[\s\S]*?pl-\[5px\] pr-2\.5 gap-2/);
  assert.match(transportSrc, /<PlayerPartyChevronIcon\s+open=\{activeTab === "room"\}/);
  assert.equal(iconsSrc.includes("export function PlayerPartyChevronIcon"), true);
  assert.equal(transportSrc.includes("ep-reaction-icon-btn"), true);
  assert.equal(transportSrc.includes("ep-orb-reaction"), false);

  // Seek relative buttons fire seek cue without showFeedback suppression & reveal clean frosted pills on hover
  assert.equal(transportSrc.includes("showFeedback: false"), false);
  assert.match(globalsCss, /\.ep-transport-bubble,\s*\.ep-bar-icon-btn\.ep-transport-btn\s*\{[^}]*background-color:\s*transparent[^}]*border:\s*1px solid transparent/);
  assert.match(globalsCss, /\.ep-transport-bubble::before[\s\S]*opacity:\s*0;/);
  assert.match(globalsCss, /\.ep-transport-bubble::after[\s\S]*opacity:\s*0;/);
  assert.match(globalsCss, /\.ep-transport-bubble:hover:not\(:disabled\)[\s\S]*rgba\(255,\s*255,\s*255/);
  assert.equal(watchSrc.includes("onSyncPeerSeek"), true);
  assert.equal(watchSrc.includes("<PlayerSeekCueIcon"), true);

  // Volume icon keeps a stable SVG mount cleanly transitioning via data-muted
  const volBtnStart = transportSrc.indexOf('aria-label={muted ? "Unmute" : "Mute"}');
  assert.notEqual(volBtnStart, -1);
  const volSlice = transportSrc.slice(volBtnStart, volBtnStart + 420);
  assert.equal(volSlice.includes("ep-vol-btn"), true);
  assert.equal(volSlice.includes('key={muted'), false);
  assert.equal(volSlice.includes("anim-icon-pop"), false);

  assert.match(iconsSrc, /export function PlayerVolumeIcon[\s\S]*data-muted=\{muted \? "true" : "false"\}/);
  assert.match(globalsCss, /\.ep-vol-icon\[data-muted="false"\] \.ep-vol-wave-2/);
  assert.match(globalsCss, /\.ep-vol-icon\[data-muted="true"\] \.ep-vol-slash-2/);
});

test("SubtitlePanel renders Font Family and Text Encoding as inline Liquid Glass menu rows", () => {
  const selectMenuSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/ui/SelectMenu.tsx"),
    "utf8",
  );
  const subtitleSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/SubtitlePanel.tsx"),
    "utf8",
  );

  assert.match(selectMenuSrc, /variant\?:\s*"field"\s*\|\s*"row"/);
  assert.match(selectMenuSrc, /variant === "row"/);
  assert.match(selectMenuSrc, /ep-menu-row ep-press/);

  assert.match(
    subtitleSrc,
    /<SelectMenu[\s\S]*?variant="row"[\s\S]*?label="Text Encoding"/,
  );
  assert.match(
    subtitleSrc,
    /<SelectMenu[\s\S]*?variant="row"[\s\S]*?label="Font Family"/,
  );
});

test("TransportBar party pill stays stationary without press scale or layer-promotion shift", () => {
  const transportSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/TransportBar.tsx"),
    "utf8",
  );
  const globalsCss = fs.readFileSync(path.join(REPO_ROOT, "src/styles/globals.css"), "utf8");

  assert.match(
    transportSrc,
    /data-capsule-anchor="room"[\s\S]*?ep-bar-pill ep-party-pill[\s\S]*?activeTab === "room"\s*\?\s*"ep-droplet-indicator text-white font-semibold"/,
  );
  assert.match(
    globalsCss,
    /\.ep-bar-pill\.ep-party-pill:active:not\(:disabled\)\s*\{[^}]*transform:\s*none;/,
  );
  assert.match(
    globalsCss,
    /\.ep-bar-pill\.ep-party-pill\.ep-droplet-indicator\s*\{[^}]*will-change:\s*auto;/,
  );
});

test("Seek cue renders a highly translucent iOS Liquid Glass bubble with bubbly enter, pulse, and exit animations", () => {
  const watchSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/WatchRoom.tsx"),
    "utf8",
  );
  const globalsCss = fs.readFileSync(path.join(REPO_ROOT, "src/styles/globals.css"), "utf8");

  assert.match(watchSrc, /usePresencePayload\(seekCue,\s*240\)/);
  assert.match(watchSrc, /ep-glass-seek-bubble/);
  assert.match(watchSrc, /ep-seek-cue-back-out/);
  assert.match(watchSrc, /ep-seek-cue-forward-out/);
  assert.match(watchSrc, /ep-seek-bubble-bounce-a/);

  assert.match(
    globalsCss,
    /\.ep-glass-seek-bubble\s*\{[^}]*rgba\(8,\s*8,\s*12,\s*0\.08\)[^}]*backdrop-filter:\s*blur\(/,
  );
  assert.match(globalsCss, /@keyframes ep-seek-cue-back-out/);
  assert.match(globalsCss, /@keyframes ep-seek-cue-forward-out/);
});

test("AvatarPicker hides visible name captions, enlarges avatar artwork, and provides 24 character variations", () => {
  const avatarSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/ui/ProfileAvatar.tsx"),
    "utf8",
  );

  assert.doesNotMatch(avatarSrc, /\{preset\.label\}<\/span>/);
  assert.match(avatarSrc, /const avatarSize = compact \? 48 : 54;/);
  assert.match(avatarSrc, /aria-label=\{preset\.label\}/);
  const presetIds = Array.from(avatarSrc.matchAll(/\{\s*id:\s*"([^"]+)"/g)).map((m) => m[1]);
  assert.equal(presetIds.length, 24);
  assert.equal(new Set(presetIds).size, 24);
  assert.match(avatarSrc, /COLLAPSED_GRID_LIMIT\s*=\s*16/);
  assert.match(avatarSrc, /grid grid-cols-4/);
  assert.match(avatarSrc, /rounded-2xl py-2 px-1[\s\S]*bg-white\/\[0\.045\]/);
  assert.match(avatarSrc, /ep-avatar-more-orb[\s\S]*more<\/span>/);
  assert.match(avatarSrc, /ep-collapse-liquid/);
  assert.match(avatarSrc, /ep-avatar-reveal-tile/);
  assert.match(avatarSrc, /ep-avatar-more-slot/);
  assert.doesNotMatch(avatarSrc, /Show \$\{hiddenCount\} more characters[\s\S]{0,160}bg-white\/\[0\.045\]/);
  assert.match(avatarSrc, /ep-glass-pill ep-press h-8[\s\S]*AppShuffleIcon/);

  const globalsCss = fs.readFileSync(path.join(REPO_ROOT, "src/styles/globals.css"), "utf8");
  assert.match(globalsCss, /\.ep-avatar-more-orb\s*\{/);

  const settingsSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/SettingsModal.tsx"),
    "utf8",
  );
  const profileSection = settingsSrc.slice(
    settingsSrc.indexOf('tab === "profile"'),
    settingsSrc.indexOf('tab === "appearance"'),
  );
  assert.doesNotMatch(profileSection, /ep-glass-well/);
  assert.match(profileSection, /flex items-end gap-3/);
});

test("Appearance preferences expose Play Bar Opacity slider wired to both floating and full-width play bars", () => {
  const settingsSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/SettingsModal.tsx"),
    "utf8",
  );
  const globalsCss = fs.readFileSync(path.join(REPO_ROOT, "src/styles/globals.css"), "utf8");

  assert.match(settingsSrc, /Play Bar Opacity/);
  assert.match(settingsSrc, /ariaLabel="Play Bar Opacity"/);
  assert.match(settingsSrc, /setPlayBarOpacity/);
  assert.match(globalsCss, /\.ep-glass-capsule[\s\S]*--ep-playbar-capsule-bg/);
  assert.match(globalsCss, /\.ep-glass-bottom-bar[\s\S]*--ep-playbar-bar-bg/);
});

test("Preference sliders use iOS Liquid Glass pill thumb, recessed track, and refractive drag state", () => {
  const scrubberSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/ui/Scrubber.tsx"),
    "utf8",
  );
  const settingsSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/SettingsModal.tsx"),
    "utf8",
  );
  const subPanelSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/SubtitlePanel.tsx"),
    "utf8",
  );
  const globalsCss = fs.readFileSync(path.join(REPO_ROOT, "src/styles/globals.css"), "utf8");

  assert.match(scrubberSrc, /ep-scrubber-track/);
  assert.match(scrubberSrc, /ep-scrubber-glass-thumb/);
  assert.match(scrubberSrc, /alwaysShowThumb/);
  assert.match(scrubberSrc, /alwaysShowThumb \? "left-\[11px\] right-\[11px\]" : "left-\[7px\] right-\[7px\]"/);
  assert.match(scrubberSrc, /alwaysShowThumb \? "left-\[19px\] right-\[19px\]" : "left-\[15px\] right-\[15px\]"/);
  assert.match(scrubberSrc, /-ml-\[7px\] h-3\.5 w-3\.5 rounded-full ep-scrubber-glass-thumb ep-scrubber-hover-thumb/);
  assert.match(settingsSrc, /ariaLabel="Play Bar Opacity"[\s\S]{0,160}alwaysShowThumb/);
  assert.match(settingsSrc, /ariaLabel="Subtitle Vertical Position"[\s\S]{0,160}alwaysShowThumb/);
  assert.match(subPanelSrc, /ariaLabel="Subtitle Font Size"[\s\S]{0,160}alwaysShowThumb/);
  assert.match(globalsCss, /\.ep-scrubber-track \.ep-scrubber-fill[\s\S]*border-radius:\s*9999px/);
  assert.match(globalsCss, /\.ep-scrubber-glass-thumb\[data-dragging="true"\][\s\S]*backdrop-filter:\s*url\(#ep-scrubber-liquid-lens\)/);

  const appSrc = fs.readFileSync(path.join(REPO_ROOT, "src/App.tsx"), "utf8");
  const appIconsSrc = fs.readFileSync(path.join(REPO_ROOT, "src/components/ui/AppIcons.tsx"), "utf8");
  assert.match(appSrc, /<AppLiquidGlassDefs \/>/);
  assert.match(appIconsSrc, /id="ep-scrubber-liquid-lens"/);
  assert.match(appIconsSrc, /<feDisplacementMap/);
});

test("Docked chat & modal video handoffs avoid transparent punch-through, double chrome, and letterbox crops", () => {
  const frozenSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/FrozenVideoFrame.tsx"),
    "utf8",
  );
  const mpvLibSrc = fs.readFileSync(path.join(REPO_ROOT, "src/lib/mpv.ts"), "utf8");
  const watchRoomSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/WatchRoom.tsx"),
    "utf8",
  );
  const chatSidebarSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/ChatSidebar.tsx"),
    "utf8",
  );
  const globalsCss = fs.readFileSync(path.join(REPO_ROOT, "src/styles/globals.css"), "utf8");

  assert.match(frozenSrc, /useLayoutEffect/);
  assert.match(frozenSrc, /object-contain bg-canvas/);

  assert.match(mpvLibSrc, /mpv_capture_freeze_frame/);
  assert.match(mpvLibSrc, /mpv_set_video_margin_right/);
  assert.match(mpvLibSrc, /let lastCleanFreezeFrame: MpvBackdropFrame \| null = null;/);
  assert.match(mpvLibSrc, /clearLastCleanFreezeFrame/);

  assert.match(watchRoomSrc, /!videoSurfacePaused &&[\s\S]{0,60}!surfaceHoldPending/);
  assert.match(watchRoomSrc, /mpvSetVideoMarginRight/);
  assert.match(watchRoomSrc, /syncMpvRightMarginNow/);
  assert.match(watchRoomSrc, /measurePhysicalRect\(stageRef\.current \?\? viewportRef\.current\)/);
  assert.match(watchRoomSrc, /onDockTransitionEnd/);
  assert.doesNotMatch(watchRoomSrc, /getLastCapturedBackdropFrame|captureFrozenBackdropFrame/);

  assert.match(chatSidebarSrc, /ep-chat-dock-slot/);
  assert.match(chatSidebarSrc, /onTransitionEnd/);

  assert.match(globalsCss, /\.ep-chat-sidebar\s*\{[^}]*background-color:\s*#0c0c15/);
  assert.match(globalsCss, /\.ep-chat-dock-slot\s*\{[^}]*background-color:\s*#060608/);
  assert.match(
    globalsCss,
    /\.ep-chat-dock-slot\[data-open="false"\] \.ep-chat-dock-panel\s*\{[^}]*opacity:\s*0;/,
  );
});

test("TransportBar, PlaybackPanel, SkipIntroOverlay, and WatchRoom adapt cleanly across extreme narrow and mini scales", () => {
  const transportSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/TransportBar.tsx"),
    "utf8",
  );
  assert.match(transportSrc, /export function resolvePlayBarLayout\(outerWidth: number\)/);
  assert.match(transportSrc, /data-bar-tier=\{barLayout\.tier\}/);
  assert.match(transportSrc, /ref=\{rightDockRef\}[\s\S]{0,120}shrink-0/);
  assert.match(transportSrc, /resolvePlayBarLayout\(w\)/);

  const playbackSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/PlaybackPanel.tsx"),
    "utf8",
  );
  assert.match(playbackSrc, /ariaLabel="Playback volume"/);

  const skipSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/SkipIntroOverlay.tsx"),
    "utf8",
  );
  assert.match(skipSrc, /--ep-playbar-clearance/);

  const watchSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/WatchRoom.tsx"),
    "utf8",
  );
  assert.match(watchSrc, /stageAvailableW/);
  assert.match(watchSrc, /data-stage-container="true"/);
});

test("Default play bar is full-width and TransportBar renders separate circular chat and reactions pills after users", () => {
  const appStoreSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/store/useAppStore.ts"),
    "utf8",
  );
  assert.match(
    appStoreSrc,
    /initialFullWidthPlayBar\s*=\s*readStorage\("ep\.fullWidthPlayBar",\s*"true"\)\s*!==\s*"false"/,
  );

  const transportSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/TransportBar.tsx"),
    "utf8",
  );
  const roomIdx = transportSrc.indexOf('data-capsule-anchor="room"');
  const chatIdx = transportSrc.indexOf('data-capsule-anchor="chat"');
  const reactionsIdx = transportSrc.indexOf('data-capsule-anchor="reactions"');
  assert.ok(roomIdx !== -1 && chatIdx > roomIdx, "Chat pill should follow the party/users pill");
  assert.ok(reactionsIdx > chatIdx, "Reactions circular pill should follow Chat circular pill");
  assert.equal(transportSrc.includes("ep-party-social-pill"), false);
});






