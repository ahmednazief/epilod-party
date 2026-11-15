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
  assert.equal(watchRoom.includes("<SegmentedTabs"), true);
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
  assert.equal(watchSrc.includes('{ value: "room", label: "Party" }'), true);
  assert.equal(watchSrc.includes('{ value: "playback", label: "Playback" }'), true);
  assert.equal(watchSrc.includes('{ value: "subtitles", label: "Subtitles" }'), true);

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



