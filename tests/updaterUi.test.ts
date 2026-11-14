import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { buildSync } from "esbuild";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

async function bundleAndImport<T>(entryRel: string): Promise<T> {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "epilod-upd-test-"));
  try {
    const outFile = path.join(outDir, "mod.mjs");
    buildSync({
      entryPoints: [path.join(REPO_ROOT, entryRel)],
      outfile: outFile,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
    });
    return (await import(pathToFileURL(outFile).href)) as T;
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

test("useAppStore supports Updates tab navigation and auto-check preference without MouseEvent corruption", async () => {
  const { useAppStore } = await bundleAndImport<typeof import("../src/store/useAppStore")>(
    "src/store/useAppStore.ts",
  );

  assert.equal(useAppStore.getState().autoCheckUpdates, true);
  assert.equal(useAppStore.getState().settingsTab, "server");

  useAppStore.getState().openSettings("updates");
  assert.equal(useAppStore.getState().settingsOpen, true);
  assert.equal(useAppStore.getState().settingsTab, "updates");

  useAppStore.getState().openSettings();
  assert.equal(useAppStore.getState().settingsTab, "server");

  // Guard against synthetic pointer/click event accidentally forwarded into openSettings
  useAppStore.getState().openSettings({ type: "click" } as unknown as "updates");
  assert.equal(useAppStore.getState().settingsTab, "server");

  useAppStore.getState().setAutoCheckUpdates(false);
  assert.equal(useAppStore.getState().autoCheckUpdates, false);
});

test("useUpdaterStore and updater formatters behave safely outside Tauri runtime", async () => {
  const updaterLib = await bundleAndImport<typeof import("../src/lib/updater")>(
    "src/lib/updater.ts",
  );
  const { useUpdaterStore } = await bundleAndImport<typeof import("../src/store/useUpdaterStore")>(
    "src/store/useUpdaterStore.ts",
  );

  assert.equal(updaterLib.formatBytesCompact(512), "512 B");
  assert.equal(updaterLib.formatBytesCompact(96_400_000), "91.9 MB");
  assert.equal(updaterLib.formatTransferSpeed(2_621_440), "2.5 MB/s");

  await useUpdaterStore.getState().init();
  assert.equal(useUpdaterStore.getState().status?.currentVersion, "0.1.0");
  assert.equal(useUpdaterStore.getState().status?.availability, "upToDate");

  await useUpdaterStore.getState().checkForUpdates(false);
  assert.equal(useUpdaterStore.getState().isChecking, false);
  assert.equal(useUpdaterStore.getState().hasCheckedStartup, true);
  assert.equal(useUpdaterStore.getState().error, null);
});

test("useUpdaterStore prevents concurrent init overwrites and clears stale non-paused progress", async () => {
  const { useUpdaterStore } = await bundleAndImport<typeof import("../src/store/useUpdaterStore")>(
    "src/store/useUpdaterStore.ts",
  );

  // Deduplicated concurrent init() calls resolve cleanly without corrupting state
  await Promise.all([useUpdaterStore.getState().init(), useUpdaterStore.getState().init()]);
  assert.equal(useUpdaterStore.getState().status?.currentVersion, "0.1.0");

  // Pre-existing updateAvailable status is preserved across init() and stale non-paused progress is cleared on checkForUpdates
  useUpdaterStore.setState({
    status: {
      currentVersion: "0.1.0",
      availability: "updateAvailable",
      availableRelease: {
        version: "0.2.0",
        releasedAt: "2026-11-14T12:00:00Z",
        notes: "Test",
        downloadUrl: "https://github.com/ahmednazief/epilod-party/releases/download/v0.2.0/Epilod.Party.Setup.exe",
        sha256: "a".repeat(64),
        sizeBytes: 96_400_000,
      },
      downloadedInstallerPath: null,
      cacheDir: String.raw`C:\Temp\updates`,
      checkedAtUnix: 12345,
      signatureVerified: true,
      message: "Update available: Epilod Party v0.2.0",
    },
    progress: {
      stage: "downloading",
      downloadedBytes: 1024,
      totalBytes: 96_400_000,
      percent: 1,
      speedBps: 100,
      message: "Old progress",
    },
    isPaused: false,
  });

  await useUpdaterStore.getState().init();
  assert.equal(useUpdaterStore.getState().status?.availability, "updateAvailable");
  assert.equal(useUpdaterStore.getState().status?.signatureVerified, true);

  await useUpdaterStore.getState().checkForUpdates(true);
  assert.equal(useUpdaterStore.getState().progress, null);
});

test("SettingsModal and HomeScreen expose updater UI cleanly without breaking invariants", () => {
  const settingsSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/SettingsModal.tsx"),
    "utf8",
  );
  assert.equal(settingsSrc.includes('{ value: "updates", label: "Updates" }'), true);
  assert.equal(settingsSrc.includes("Restart & Update to v"), true);
  assert.equal(settingsSrc.includes("scaleX("), true);
  assert.equal(settingsSrc.includes("Check for updates automatically"), true);
  assert.equal(settingsSrc.includes("Ed25519 Signed"), true);
  assert.equal(settingsSrc.includes("SHA-256 Verified:"), true);

  const homeSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/HomeScreen.tsx"),
    "utf8",
  );
  assert.equal(homeSrc.includes('openSettings("updates")'), true);
  assert.equal(homeSrc.includes("checkForUpdates(true)"), true);
});
