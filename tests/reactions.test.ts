import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { buildSync } from "esbuild";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

function setupMockLocalStorage(): Map<string, string> {
  const backing = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    get length() {
      return backing.size;
    },
    clear() {
      backing.clear();
    },
    getItem(k: string) {
      return backing.get(k) ?? null;
    },
    key(i: number) {
      return Array.from(backing.keys())[i] ?? null;
    },
    removeItem(k: string) {
      backing.delete(k);
    },
    setItem(k: string, v: string) {
      backing.set(k, String(v));
    },
  };
  return backing;
}

interface BundledReactionModules {
  reactions: typeof import("../src/lib/reactions");
  reactionStore: typeof import("../src/store/useReactionStore");
  appStore: typeof import("../src/store/useAppStore");
  shortcuts: typeof import("../src/lib/shortcuts");
}

async function loadBundledReactionModules(): Promise<BundledReactionModules> {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "epilod-reaction-test-"));
  try {
    const entryFile = path.join(outDir, "entry.ts");
    const outFile = path.join(outDir, "bundle.mjs");
    fs.writeFileSync(
      entryFile,
      [
        `export * as reactions from ${JSON.stringify(path.join(REPO_ROOT, "src/lib/reactions.ts"))};`,
        `export * as reactionStore from ${JSON.stringify(path.join(REPO_ROOT, "src/store/useReactionStore.ts"))};`,
        `export * as appStore from ${JSON.stringify(path.join(REPO_ROOT, "src/store/useAppStore.ts"))};`,
        `export * as shortcuts from ${JSON.stringify(path.join(REPO_ROOT, "src/lib/shortcuts.ts"))};`,
      ].join("\n"),
      "utf8",
    );
    buildSync({
      entryPoints: [entryFile],
      outfile: outFile,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
    });
    return (await import(pathToFileURL(outFile).href)) as BundledReactionModules;
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

test("PRESET_REACTIONS includes scared emoji 😱, search finds cinema/scary emojis, and app store persists settings", async () => {
  const ls = setupMockLocalStorage();
  const { reactions, appStore } = await loadBundledReactionModules();

  const emojis = reactions.PRESET_REACTIONS.map((r) => r.emoji);
  assert.deepEqual(emojis, ["❤️", "😂", "😮", "😱", "😢", "🔥", "👏"]);
  assert.deepEqual(
    reactions.PRESET_REACTIONS.map((r) => r.shortcut),
    ["1", "2", "3", "4", "5", "6", "7"],
  );

  const scaredHits = reactions.filterEmojiCatalog("scared", "all");
  assert.equal(scaredHits.some((item) => item.emoji === "😱"), true);

  const cinemaHits = reactions.filterEmojiCatalog("popcorn", "cinema");
  assert.equal(cinemaHits.some((item) => item.emoji === "🍿"), true);

  const app = appStore.useAppStore.getState();
  assert.equal(app.reactionsEnabled, true);
  app.setReactionsEnabled(false);
  assert.equal(ls.get("ep.reactionsEnabled"), "false");
  app.setReactionsEnabled(true);

  for (let i = 0; i < 16; i++) {
    app.pushRecentEmoji(`E${i}`);
  }
  const storedRecent = appStore.useAppStore.getState().recentEmojis;
  assert.equal(storedRecent.length, 12);
  assert.equal(storedRecent[0], "E15");
});

test("useReactionStore attaches lead-only sender badges in rapid bursts and triggerPartyReaction respects reactionsEnabled", async () => {
  setupMockLocalStorage();
  const { reactions, reactionStore, appStore } = await loadBundledReactionModules();

  const spawned: Array<{ username: string; avatarId: string; emoji: string; showBadge: boolean }> = [];
  let clearCount = 0;
  const unsub = reactionStore.subscribeReactions(
    (item) => {
      spawned.push({
        username: item.username,
        avatarId: item.avatarId,
        emoji: item.emoji,
        showBadge: item.showBadge,
      });
    },
    () => {
      clearCount += 1;
    },
  );

  try {
    appStore.useAppStore.getState().setUsername("Maya");
    appStore.useAppStore.getState().setAvatarId("maya");
    appStore.useAppStore.getState().setReactionsEnabled(true);

    reactions.triggerPartyReaction("😱");
    reactions.triggerPartyReaction("😱");
    reactions.triggerPartyReaction("🔥");

    assert.equal(spawned.length, 3);
    assert.equal(spawned[0].username, "Maya");
    assert.equal(spawned[0].avatarId, "maya");
    assert.equal(spawned[0].emoji, "😱");
    assert.equal(spawned[0].showBadge, true);
    assert.equal(spawned[1].showBadge, false);
    assert.equal(spawned[2].showBadge, false);

    // Disabling reactions suppresses further local triggers
    appStore.useAppStore.getState().setReactionsEnabled(false);
    reactions.triggerPartyReaction("❤️");
    assert.equal(spawned.length, 3);

    // Re-enabling and clearing resets badge state cleanly
    reactionStore.clearReactions();
    assert.equal(clearCount, 1);
    appStore.useAppStore.getState().setReactionsEnabled(true);
    reactions.triggerPartyReaction("❤️");
    assert.equal(spawned.length, 4);
    assert.equal(spawned[3].showBadge, true);
  } finally {
    unsub();
    reactionStore.clearReactions();
  }
});

test("Shortcuts, UI components, WatchRoom, and Rust P2P/Syncplay layers wire live liquid-glass reactions cleanly", async () => {
  const { shortcuts } = await loadBundledReactionModules();
  assert.equal(
    shortcuts.PLAYER_SHORTCUTS.some((s) => s.keys.includes("E")),
    true,
  );
  assert.equal(
    shortcuts.PLAYER_SHORTCUTS.some((s) => s.keys.includes("1–7")),
    true,
  );

  const watchRoom = fs.readFileSync(path.join(REPO_ROOT, "src/components/WatchRoom.tsx"), "utf8");
  assert.equal(watchRoom.includes("FloatingReactionsOverlay"), true);
  assert.equal(watchRoom.includes("ReactionPopover"), true);
  assert.equal(watchRoom.includes("onSyncReaction"), true);
  assert.equal(watchRoom.includes("onToggleReactions"), true);

  const transportBar = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/TransportBar.tsx"),
    "utf8",
  );
  assert.equal(transportBar.includes('data-capsule-anchor="reactions"'), true);
  assert.equal(transportBar.includes("ep-reaction-icon-btn"), true);
  assert.equal(transportBar.includes("ep-orb-reaction"), false);
  assert.equal(transportBar.includes("PlayerReactionsIcon"), true);

  const reactionPopover = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/ReactionPopover.tsx"),
    "utf8",
  );
  assert.equal(reactionPopover.includes("ep-glass-reaction-dock"), true);
  assert.equal(reactionPopover.includes("ep-glass-reaction-sheet"), true);
  assert.equal(reactionPopover.includes("ep-glass-reaction-orb"), true);
  assert.equal(reactionPopover.includes("ep-glass-reaction-hint"), true);
  assert.equal(reactionPopover.includes("ep-reaction-kbd"), true);
  assert.equal(reactionPopover.includes("ep-reaction-emoji-glyph"), true);
  assert.equal(reactionPopover.includes("ep-reaction-droplet"), true);
  assert.equal(reactionPopover.includes("ep-droplet-core"), true);
  assert.equal(reactionPopover.includes('data-glass-region="true"'), true);
  assert.ok(
    reactionPopover.indexOf("ep-glass-reaction-hint") <
      reactionPopover.indexOf("ep-glass-reaction-dock"),
    "Floating shortcut hint pill must remain a sibling outside .ep-glass-reaction-dock",
  );

  const globalsCss = fs.readFileSync(path.join(REPO_ROOT, "src/styles/globals.css"), "utf8");
  assert.equal(globalsCss.includes(".ep-reaction-icon-btn"), true);
  assert.equal(globalsCss.includes(".ep-orb-reaction"), false);
  assert.equal(globalsCss.includes(".ep-glass-reaction-dock"), true);
  assert.equal(globalsCss.includes(".ep-glass-reaction-sheet"), true);
  assert.equal(globalsCss.includes(".ep-glass-reaction-orb"), true);
  assert.equal(globalsCss.includes(".ep-glass-reaction-hint"), true);
  assert.equal(globalsCss.includes(".ep-reaction-kbd"), true);

  const playerIcons = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/ui/PlayerIcons.tsx"),
    "utf8",
  );
  const reactionSection = playerIcons.slice(
    playerIcons.indexOf("export function PlayerReactionsIcon"),
    playerIcons.indexOf("export function PlayerAutoNextIcon"),
  );
  assert.equal(reactionSection.includes("ep-laugh-face-"), true);
  assert.equal(reactionSection.includes("ep-laugh-tear-"), true);

  const sfxSrc = fs.readFileSync(path.join(REPO_ROOT, "src/lib/soundEffects.ts"), "utf8");
  assert.equal(sfxSrc.includes("playReactionSoundCue"), true);

  const overlay = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/FloatingReactionsOverlay.tsx"),
    "utf8",
  );
  assert.equal(overlay.includes("data-glass-region"), false);
  assert.equal(overlay.includes("hideParticipants"), true);
  assert.equal(overlay.includes("reducedMotion"), true);
  assert.equal(overlay.includes("lowPowerMode"), true);

  const settings = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/SettingsModal.tsx"),
    "utf8",
  );
  assert.equal(settings.includes("Floating Party Reactions"), true);

  const rustLib = fs.readFileSync(path.join(REPO_ROOT, "src-tauri/src/lib.rs"), "utf8");
  assert.equal(rustLib.includes("sync_send_reaction"), true);

  const rustP2p = fs.readFileSync(path.join(REPO_ROOT, "src-tauri/src/p2p.rs"), "utf8");
  assert.equal(rustP2p.includes("P2pDatagramMessage::Reaction"), true);
  assert.equal(rustP2p.includes("RelayUnavailable"), true);

  const rustSyncplay = fs.readFileSync(
    path.join(REPO_ROOT, "src-tauri/src/syncplay/mod.rs"),
    "utf8",
  );
  assert.equal(rustSyncplay.includes("EP_REACTION_CHAT_PREFIX"), true);
  assert.equal(rustSyncplay.includes("sync://reaction"), true);
});
