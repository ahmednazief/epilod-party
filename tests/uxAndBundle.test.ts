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
    assert.equal(src.includes("<select"), false, `Forbidden <select> found in ${file}`);
    assert.equal(src.includes("backdrop-blur"), false, `Forbidden backdrop-blur found in ${file}`);
    assert.equal(
      /linear-gradient|radial-gradient/.test(src),
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
  assert.equal(
    watchRoom.includes("mpvSetVisible(!settingsOpen && !shortcutsOpen && !playerError)"),
    true,
  );
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
  assert.equal(scrubber.includes("scaleX("), true);
  assert.equal(scrubber.includes("translateX("), true);

  const tabs = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/ui/SegmentedTabs.tsx"),
    "utf8",
  );
  assert.equal(tabs.includes("transition-[transform,width]"), true);
});

test("Built dist bundle emits strictly 3 WOFF2 fonts and includes reliability symbols", () => {
  const assetsDir = path.join(REPO_ROOT, "dist/assets");
  assert.equal(fs.existsSync(assetsDir), true, "dist/assets must exist after npm run build");

  const assetFiles = fs.readdirSync(assetsDir);
  const woff2Files = assetFiles.filter((f) => f.endsWith(".woff2"));
  assert.equal(woff2Files.length, 3, `Expected 3 .woff2 files, got: ${woff2Files.join(", ")}`);

  const jsFiles = assetFiles.filter((f) => f.endsWith(".js"));
  assert.ok(jsFiles.length >= 1);
  const jsBundle = fs.readFileSync(path.join(assetsDir, jsFiles[0]), "utf8");

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
  const expected = ["Inter-Regular.ttf", "NotoSansArabic-Regular.ttf"];
  let totalBytes = 0;

  for (const file of expected) {
    const full = path.join(fontsDir, file);
    assert.equal(fs.existsSync(full), true, `Missing bundled mpv font: ${file}`);
    const size = fs.statSync(full).size;
    assert.ok(size > 10_000, `Font ${file} unexpectedly empty (${size} bytes)`);
    totalBytes += size;
  }

  assert.ok(
    totalBytes < 350 * 1024,
    `Bundled TTF fonts (${totalBytes} bytes) exceeded 350 KB size budget`,
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
  assert.equal(settingsSrc.includes('{ value: "prefs", label: "Comfort & Privacy" }'), true);
  assert.equal(settingsSrc.includes('{ value: "updates", label: "Updates" }'), true);
  assert.equal(settingsSrc.includes('{ value: "server", label: "Connection & Server" }'), true);
  assert.equal(settingsSrc.includes('{ value: "logs", label: "Diagnostics" }'), true);
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

  const transportSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/TransportBar.tsx"),
    "utf8",
  );
  assert.match(transportSrc, /ep-orb-play[\s\S]*<PlayerPlayIcon[\s\S]*<PlayerPauseIcon/);

  const globalsCss = fs.readFileSync(path.join(REPO_ROOT, "src/styles/globals.css"), "utf8");
  assert.match(globalsCss, /\.ep-orb-play\s*\{[\s\S]*rgba\(124,\s*58,\s*237/);
  assert.match(globalsCss, /\.ep-orb-play:hover:not\(:disabled\)[\s\S]*rgba\(139,\s*92,\s*246/);
});

test("Auto-hiding and re-showing play bar, top bar, and video backdrop glide smoothly together", () => {
  const globalsCss = fs.readFileSync(path.join(REPO_ROOT, "src/styles/globals.css"), "utf8");
  assert.match(globalsCss, /\.ep-chrome-transition\s*\{[\s\S]*opacity[\s\S]*transform/);
  assert.match(
    globalsCss,
    /\.ep-chrome-transition\[aria-hidden="true"\]\s*\{[\s\S]*cubic-bezier\(0\.32,\s*0\.72,\s*0,\s*1\)/,
  );

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

  const backdropSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/VideoGlassBackdrop.tsx"),
    "utf8",
  );
  assert.match(backdropSrc, /globalAlpha\s*=\s*0\.92\s*\*\s*regionAlpha/);
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




