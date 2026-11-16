import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { buildSync } from "esbuild";

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

async function loadInstallerBridge() {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "epilod-inst-test-"));
  const outFile = path.join(outDir, "bridge.mjs");
  buildSync({
    entryPoints: [path.join(REPO_ROOT, "installer/src/lib/installerBridge.ts")],
    outfile: outFile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    external: ["@tauri-apps/*"],
  });
  return (await import(pathToFileURL(outFile).href)) as typeof import("../installer/src/lib/installerBridge");
}

test("Custom installer UI enforces Liquid Glass design invariants, compact stage, and rotating status titles", () => {
  const files = walkTsx(path.join(REPO_ROOT, "installer/src"));
  assert.ok(files.length >= 8);

  for (const file of files) {
    const src = fs.readFileSync(file, "utf8");
    assert.equal(src.includes("<select"), false, `Forbidden <select> in ${file}`);
    assert.equal(src.includes("backdrop-blur"), false, `Forbidden inline backdrop-blur in ${file}`);
    assert.equal(
      /linear-gradient|radial-gradient/.test(src),
      false,
      `Forbidden inline gradient in ${file}`,
    );
    assert.equal(/\balert\s*\(/.test(src), false, `Forbidden alert() in ${file}`);
    assert.equal(
      /#E5A93C|#F0B94E|orange-|amber-/i.test(src),
      false,
      `Forbidden orange/amber styling token in installer ${file}`,
    );
  }

  for (const legacy of ["EcosystemTraces.tsx", "ModuleTile.tsx", "StepRow.tsx"]) {
    assert.equal(
      fs.existsSync(path.join(REPO_ROOT, "installer/src/components", legacy)),
      false,
      `Legacy cluttered component should be removed: ${legacy}`,
    );
  }

  const installerCss = fs.readFileSync(path.join(REPO_ROOT, "installer/src/styles.css"), "utf8");
  const prefixedMatches = [...installerCss.matchAll(/-webkit-backdrop-filter:\s*([^;]+);/g)];
  assert.ok(prefixedMatches.length >= 4);
  for (const m of prefixedMatches) {
    const start = m.index ?? 0;
    const after = installerCss.slice(start + m[0].length, start + m[0].length + 120);
    assert.match(
      after,
      /^\s*backdrop-filter:\s*[^;]+;/,
      "Unprefixed backdrop-filter must follow -webkit-backdrop-filter so LightningCSS retains it",
    );
  }

  const progressSrc = fs.readFileSync(
    path.join(REPO_ROOT, "installer/src/components/ProgressView.tsx"),
    "utf8",
  );
  assert.equal(progressSrc.includes("Unfolding the magic"), true);
  assert.equal(progressSrc.includes("Setting up everything"), true);
  assert.equal(progressSrc.includes("Updating Epilod Party"), true);
  assert.equal(progressSrc.includes("Setting up the update"), true);
  assert.equal(progressSrc.includes("ep-scrubber-fill"), true);
  assert.equal(progressSrc.includes("scaleX("), false);
  const customizeSrc = fs.readFileSync(
    path.join(REPO_ROOT, "installer/src/components/CustomizePanel.tsx"),
    "utf8",
  );
  assert.equal(customizeSrc.includes("space-y-2"), true);
  assert.doesNotMatch(
    installerCss,
    /\.ep-installer-window\s*\{[^}]*backdrop-filter:/,
  );

  const appSrc = fs.readFileSync(path.join(REPO_ROOT, "installer/src/App.tsx"), "utf8");
  assert.equal(appSrc.includes('"Updating"'), true);
  assert.equal(appSrc.includes('"Updated"'), true);
  assert.equal(appSrc.includes('"Epilod Party updated"'), true);
  assert.equal(appSrc.includes("Replaces existing"), true);

  const setupLib = fs.readFileSync(path.join(REPO_ROOT, "src-installer/src/lib.rs"), "utf8");
  assert.equal(setupLib.includes("find_primary_existing_install_dir"), true);
  assert.equal(setupLib.includes("detect_running_processes_for_install"), true);

  const winInstall = fs.readFileSync(
    path.join(REPO_ROOT, "src-installer/src/windows_install.rs"),
    "utf8",
  );
  assert.equal(winInstall.includes("cleanup_duplicate_installs_after_commit"), true);
  assert.equal(winInstall.includes("retire_superseded_install_dir"), true);

  const tauriConf = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "src-installer/tauri.conf.json"), "utf8"),
  ) as { app: { windows: Array<{ width?: number; height?: number }> } };
  assert.equal(tauriConf.app.windows[0]?.width, 460);
  assert.equal(tauriConf.app.windows[0]?.height, 344);
});

test("Custom installer bridge formats bytes, splits live metrics cleanly, and initializes ready state", async () => {
  const bridge = await loadInstallerBridge();

  assert.equal(bridge.formatBytes(94_800_000), "90.4 MB");
  assert.equal(bridge.formatBytes(142 * 1024 ** 3), "142.0 GB");
  assert.equal(bridge.formatBytesPair(512 * 1024, 1024 * 1024), "0.5 / 1.0 MB");

  const split = bridge.splitStatusMessage("Unpacking mpv.exe engine · 22.3 / 44.6 MB");
  assert.equal(split.actionText, "Unpacking mpv.exe engine");
  assert.equal(split.metricSuffix, "22.3 / 44.6 MB");

  const plain = bridge.splitStatusMessage("Checking folder write access");
  assert.equal(plain.actionText, "Checking folder write access");
  assert.equal(plain.metricSuffix, null);

  const ready = bridge.makeReadyTelemetry(String.raw`C:\Users\Demo\AppData\Local\Epilod Party`);
  assert.equal(ready.phase, "ready");
  assert.equal(ready.overallPercent, 0);
  assert.equal(ready.steps.length, 3);
  assert.equal(ready.finished, false);
});

test("Custom installer preview pipeline emits monotonic progress, dynamic changing status text, and respects cancel", async () => {
  const bridge = await loadInstallerBridge();

  // 1. Verify full run emits monotonic percentage & distinct operations
  const events: import("../installer/src/lib/types").InstallTelemetry[] = [];
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Installer preview timed out")), 15_000);
    void bridge.runInstallation(
      {
        installDir: String.raw`C:\Users\Demo\AppData\Local\Epilod Party`,
        createDesktopShortcut: false,
        createStartMenuShortcut: true,
        registerFileAssociations: true,
        autoLaunch: false,
      },
      (t) => {
        events.push(t);
        if (t.finished) {
          clearTimeout(timeout);
          resolve();
        }
      },
    );
  });

  assert.ok(events.length >= 25, `Expected streaming progress events, got ${events.length}`);

  let prevPct = 0;
  const distinctActions = new Set<string>();
  const phasesSeen = new Set<string>();

  for (const ev of events) {
    assert.ok(ev.overallPercent >= prevPct, `Non-monotonic pct: ${ev.overallPercent} < ${prevPct}`);
    assert.ok(ev.overallPercent >= 0 && ev.overallPercent <= 100);
    prevPct = ev.overallPercent;
    phasesSeen.add(ev.phase);
    distinctActions.add(bridge.splitStatusMessage(ev.liveStatus).actionText);
  }

  assert.equal(events.at(-1)?.phase, "complete");
  assert.equal(events.at(-1)?.overallPercent, 100);
  assert.ok(distinctActions.size >= 10, `Expected >= 10 live status messages, got ${distinctActions.size}`);
  assert.ok(phasesSeen.has("verifyingExisting"));
  assert.ok(phasesSeen.has("unpackingCore"));
  assert.ok(phasesSeen.has("unpackingMpv"));
  assert.ok(phasesSeen.has("unpackingFonts"));
  assert.ok(phasesSeen.has("backingUp"));
  assert.ok(phasesSeen.has("configuringSyncplay"));
  assert.ok(phasesSeen.has("integratingWindows"));
  assert.equal(
    events.some((e) => e.liveStatus.includes("Desktop shortcut")),
    false,
    "Desktop shortcut step should be skipped when disabled",
  );

  // 2. Verify cancellation stops progression cleanly
  const cancelEvents: import("../installer/src/lib/types").InstallTelemetry[] = [];
  const handle = await bridge.runInstallation(
    {
      installDir: String.raw`C:\Users\Demo\AppData\Local\Epilod Party`,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      registerFileAssociations: true,
      autoLaunch: false,
    },
    (t) => {
      cancelEvents.push(t);
    },
  );
  await new Promise((r) => setTimeout(r, 150));
  await handle.cancel();
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(cancelEvents.at(-1)?.phase, "cancelled");
  assert.equal(cancelEvents.at(-1)?.cancelled, true);
  assert.equal(cancelEvents.at(-1)?.finished, false);
});

test("Custom installer inspection and scoped uninstallation bridges behave deterministically", async () => {
  const bridge = await loadInstallerBridge();
  const targetDir = String.raw`C:\Users\Demo\AppData\Local\Epilod Party`;

  const preflightOk = await bridge.preflightInstallDir(targetDir);
  assert.equal(preflightOk.resolvedDir, targetDir);
  assert.equal(preflightOk.writable, true);
  assert.equal(preflightOk.protectedDir, false);
  assert.ok(preflightOk.peakRequiredBytes > 0);

  const preflightProtected = await bridge.preflightInstallDir(
    String.raw`C:\Program Files\Epilod Party`,
  );
  assert.equal(preflightProtected.protectedDir, true);
  assert.equal(preflightProtected.writable, false);
  assert.ok(preflightProtected.writeError?.includes("Administrator"));

  const inspectRes = await bridge.inspectInstallDir(targetDir);
  assert.equal(inspectRes.resolvedDir, targetDir);
  assert.equal(inspectRes.writable, true);
  assert.ok((inspectRes.peakRequiredBytes ?? 0) > 0);

  const verifyRes = await bridge.verifyExistingInstall(targetDir);
  assert.equal(verifyRes.resolvedDir, targetDir);

  const closed = await bridge.closeRunningProcesses(targetDir);
  assert.ok(closed >= 0);

  const uninstReady = bridge.makeReadyTelemetry(targetDir, 8, 94_800_000, "uninstall");
  assert.equal(uninstReady.phase, "ready");
  assert.equal(uninstReady.headline, "Uninstall Epilod Party");
  assert.equal(uninstReady.steps[0].title, "Verified App Files");

  const uninstallEvents: import("../installer/src/lib/types").InstallTelemetry[] = [];
  const summary = await bridge.runUninstallation(
    { installDir: targetDir, removeUserData: false },
    (t) => {
      uninstallEvents.push(t);
    },
  );

  assert.equal(summary.removedRegistry, true);
  assert.equal(summary.removedUserData, false);
  assert.ok(summary.removedFiles >= 1);
  assert.ok(summary.skippedUnrelatedFiles >= 1);
  assert.equal(uninstallEvents.at(-1)?.phase, "complete");
  assert.equal(uninstallEvents.at(-1)?.finished, true);
  const removingIdx = uninstallEvents.findIndex((e) => e.phase === "removingFiles");
  const registryIdx = uninstallEvents.findIndex((e) => e.phase === "cleaningRegistry");
  assert.ok(removingIdx >= 0, "Expected removingFiles phase in uninstall telemetry");
  assert.ok(registryIdx >= 0, "Expected cleaningRegistry phase in uninstall telemetry");
  assert.ok(
    removingIdx < registryIdx,
    `Expected removingFiles (${removingIdx}) before cleaningRegistry (${registryIdx})`,
  );
});

test("Built installer frontend dist exists after npm run build", () => {
  const installerDist = path.join(REPO_ROOT, "installer/dist");
  assert.equal(fs.existsSync(path.join(installerDist, "index.html")), true);
  const assets = fs.readdirSync(path.join(installerDist, "assets"));
  assert.ok(assets.some((f) => f.endsWith(".js")));
  const cssFile = assets.find((f) => f.endsWith(".css"));
  assert.ok(cssFile, "Expected compiled CSS asset in installer/dist/assets");
  const builtCss = fs.readFileSync(path.join(installerDist, "assets", cssFile), "utf8");
  assert.match(builtCss, /\.ep-glass-well\{[^}]*backdrop-filter:blur\(/);
  assert.match(builtCss, /\.ep-glass-pill\{[^}]*backdrop-filter:blur\(/);
  assert.equal(fs.existsSync(path.join(installerDist, "app-icon.png")), true);
});

test("App logo and Watch Party icons are synced across desktop, web, and installer targets", () => {
  const requiredAssets = [
    "src-tauri/icons/32x32.png",
    "src-tauri/icons/128x128.png",
    "src-tauri/icons/128x128@2x.png",
    "src-tauri/icons/icon.ico",
    "public/app-icon.png",
    "public/watch-party-icon.png",
    "src/assets/app-icon.png",
    "src/assets/watch-party-icon.png",
    "installer/public/app-icon.png",
    "installer/src/assets/app-icon.png",
  ];

  for (const rel of requiredAssets) {
    const full = path.join(REPO_ROOT, rel);
    assert.equal(fs.existsSync(full), true, `Missing required icon asset: ${rel}`);
    assert.ok(fs.statSync(full).size > 500, `Unexpectedly small icon asset: ${rel}`);
  }

  const logoMarkSrc = fs.readFileSync(path.join(REPO_ROOT, "src/components/ui/LogoMark.tsx"), "utf8");
  assert.equal(logoMarkSrc.includes("#E5A93C"), false);
  assert.equal(logoMarkSrc.includes("watch-party-icon.png"), true);
  assert.equal(logoMarkSrc.includes("app-icon.png"), true);

  const brandMarkSrc = fs.readFileSync(path.join(REPO_ROOT, "installer/src/components/BrandMark.tsx"), "utf8");
  assert.equal(brandMarkSrc.includes("#E8456B"), false);
  assert.equal(brandMarkSrc.includes("app-icon.png"), true);

  const publicSvg = fs.readFileSync(path.join(REPO_ROOT, "public/logo.svg"), "utf8");
  assert.equal(publicSvg.includes("#E3A63A"), false);
  assert.equal(publicSvg.includes("#E8456B"), false);
});

test("Installer UI enforces writable preflight, autoStart guards, cancel preservation, warnings, and update relaunch", () => {
  const appSrc = fs.readFileSync(path.join(REPO_ROOT, "installer/src/App.tsx"), "utf8");
  const bridgeSrc = fs.readFileSync(
    path.join(REPO_ROOT, "installer/src/lib/installerBridge.ts"),
    "utf8",
  );

  const typesSrc = fs.readFileSync(
    path.join(REPO_ROOT, "installer/src/lib/types.ts"),
    "utf8",
  );

  // Hydrates writable/writeError from InstallerDefaults and gates autoStart on preflight health
  assert.equal(appSrc.includes("const isWritable = info.writable ?? true;"), true);
  assert.equal(appSrc.includes("isWritable &&"), true);
  assert.equal(appSrc.includes("hasEnoughDisk &&"), true);
  assert.equal(appSrc.includes("hasPayload &&"), true);

  // Preserves cancellation state in startInstallWith catch and surfaces downgrade / warnings / update relaunch
  assert.equal(appSrc.includes("const isCancelled = /cancel/i.test(msg);"), true);
  assert.equal(appSrc.includes("uninstallSummary.warnings"), true);
  assert.equal(appSrc.includes("Relaunch previous version"), true);
  assert.equal(appSrc.includes("allowDowngrade"), true);
  assert.equal(typesSrc.includes("allowDowngrade"), true);
  assert.equal(bridgeSrc.includes("isCancelled"), true);
});

