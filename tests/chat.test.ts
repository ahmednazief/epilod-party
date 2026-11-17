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

interface BundledChatModules {
  chat: typeof import("../src/lib/chat");
  chatStore: typeof import("../src/store/useChatStore");
  appStore: typeof import("../src/store/useAppStore");
}

async function loadBundledChatModules(): Promise<BundledChatModules> {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "epilod-chat-test-"));
  try {
    const entryFile = path.join(outDir, "entry.ts");
    const outFile = path.join(outDir, "bundle.mjs");
    fs.writeFileSync(
      entryFile,
      [
        `export * as chat from ${JSON.stringify(path.join(REPO_ROOT, "src/lib/chat.ts"))};`,
        `export * as chatStore from ${JSON.stringify(path.join(REPO_ROOT, "src/store/useChatStore.ts"))};`,
        `export * as appStore from ${JSON.stringify(path.join(REPO_ROOT, "src/store/useAppStore.ts"))};`,
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
    return (await import(pathToFileURL(outFile).href)) as BundledChatModules;
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

test("chat draft sanitization, inline token parsing (spoilers, timestamps, mentions, URLs), and grouping work", async () => {
  setupMockLocalStorage();
  const { chat } = await loadBundledChatModules();

  assert.equal(chat.sanitizeChatDraft("   \n\n  "), null);
  assert.equal(chat.sanitizeChatDraft("  hello\r\n\r\n\r\nworld  "), "hello\n\nworld");

  const tooLong = "x".repeat(chat.MAX_CHAT_MESSAGE_CHARS + 30);
  assert.equal(chat.sanitizeChatDraft(tooLong)?.length, chat.MAX_CHAT_MESSAGE_CHARS);

  const id = chat.generateChatMessageId();
  assert.match(id, /^[a-z0-9]{10,12}$/);

  const tokens = chat.parseChatTokens(
    "Hey @Maya check 14:32 at https://example.com/clip!",
  );
  assert.equal(tokens.some((t) => t.type === "mention" && t.username === "Maya"), true);
  assert.equal(tokens.some((t) => t.type === "timestamp" && t.secs === 872 && t.label === "14:32"), true);
  assert.equal(tokens.some((t) => t.type === "url" && t.href === "https://example.com/clip"), true);

  assert.equal(chat.textMentionsUsername("yo @Maya ready?", "maya"), true);
  assert.equal(chat.textMentionsUsername("notmaya", "maya"), false);

  const base = 1_700_000_000_000;
  const msgs = [
    {
      id: "1",
      kind: "message" as const,
      sender: "Maya",
      avatarId: "maya",
      text: "hey",
      replyToId: null,
      isSelf: false,
      timestampMs: base,
      editedAtMs: null,
      reactions: {},
      via: "p2p" as const,
    },
    {
      id: "2",
      kind: "message" as const,
      sender: "Maya",
      avatarId: "maya",
      text: "ready?",
      replyToId: null,
      isSelf: false,
      timestampMs: base + 15_000,
      editedAtMs: null,
      reactions: {},
      via: "p2p" as const,
    },
    {
      id: "3",
      kind: "message" as const,
      sender: "Maya",
      avatarId: "maya",
      text: "starting!",
      replyToId: null,
      isSelf: false,
      timestampMs: base + 30_000,
      editedAtMs: null,
      reactions: {},
      via: "p2p" as const,
    },
    {
      id: "4",
      kind: "message" as const,
      sender: "Maya",
      avatarId: "maya",
      text: "much later",
      replyToId: null,
      isSelf: false,
      timestampMs: base + 5 * 60_000,
      editedAtMs: null,
      reactions: {},
      via: "p2p" as const,
    },
    {
      id: "5",
      kind: "message" as const,
      sender: "Me",
      avatarId: "luna",
      text: "yep",
      replyToId: "2",
      isSelf: true,
      timestampMs: base + 5 * 60_000 + 2_000,
      editedAtMs: null,
      reactions: {},
      via: "local" as const,
    },
  ];

  assert.equal(chat.computeMessageGroupPosition(msgs, 0), "first");
  assert.equal(chat.computeMessageGroupPosition(msgs, 1), "middle");
  assert.equal(chat.computeMessageGroupPosition(msgs, 2), "last");
  assert.equal(chat.computeMessageGroupPosition(msgs, 3), "solo");
  assert.equal(chat.computeMessageGroupPosition(msgs, 4), "solo");

  assert.equal(chat.shouldShowTimeDivider(msgs, 0), true);
  assert.equal(chat.shouldShowTimeDivider(msgs, 1), false);
  assert.equal(chat.shouldShowTimeDivider(msgs, 3), true); // +4m30s gap after idx 2
  assert.equal(chat.shouldShowTimeDivider(msgs, 4), false);

  assert.equal(chat.isPureEmojiMessage("😮"), true);
  assert.equal(chat.isPureEmojiMessage("❤️ 😂🔥"), true);
  assert.equal(chat.isPureEmojiMessage("😮😂😂🔥"), false); // >3 emoji clusters
  assert.equal(chat.isPureEmojiMessage("14:32"), false);
  assert.equal(chat.isPureEmojiMessage("🍿 nice"), false);

  assert.equal(chat.resolvePeerNameTint("Maya"), chat.resolvePeerNameTint("maya"));
  assert.match(chat.resolvePeerNameTint("Tariq"), /^text-\[#/);
});

test("useChatStore tracks unread/mentions, edits, micro-reactions, sidebar width, and clears on leaveRoom", async () => {
  const ls = setupMockLocalStorage();
  const { chatStore, appStore } = await loadBundledChatModules();

  const app = appStore.useAppStore.getState();
  assert.equal(app.chatPeeksEnabled, true);
  app.setChatPeeksEnabled(false);
  assert.equal(ls.get("ep.chatPeeksEnabled"), "false");
  app.setChatPeeksEnabled(true);

  assert.equal(app.chatTriggerPlacement, "playbar");
  app.setChatTriggerPlacement("edge");
  assert.equal(ls.get("ep.chatTriggerPlacement"), "edge");
  app.setChatTriggerPlacement("playbar");

  const store = chatStore.useChatStore.getState();
  store.clearChat();
  store.setSidebarWidth(999);
  assert.equal(chatStore.useChatStore.getState().sidebarWidth, chatStore.MAX_CHAT_SIDEBAR_WIDTH);
  store.setSidebarWidth(100);
  assert.equal(chatStore.useChatStore.getState().sidebarWidth, chatStore.MIN_CHAT_SIDEBAR_WIDTH);
  store.setSidebarWidth(380);

  const added1 = store.receiveRemoteMessage(
    {
      id: "m1",
      sender: "Tariq",
      avatarId: "fox",
      text: "Hey @You grabbed popcorn 🍿",
      via: "p2p",
      timestampMs: 1000,
    },
    { allowPeek: false, localUsername: "You" },
  );
  assert.equal(added1, true);

  // Duplicate from same sender is ignored
  const addedDup = store.receiveRemoteMessage({
    id: "m1",
    sender: "tariq",
    avatarId: "fox",
    text: "dup",
    via: "syncplay",
    timestampMs: 1005,
  });
  assert.equal(addedDup, false);

  let snap = chatStore.useChatStore.getState();
  assert.equal(snap.messages.length, 1);
  assert.equal(snap.unreadCount, 1);
  assert.equal(snap.unreadSinceId, "m1");
  // @Mention triggers peek even when allowPeek is false
  assert.equal(snap.peeks.length, 1);
  assert.equal(snap.peeks[0]?.isMention, true);

  // Micro-reaction toggle on message
  assert.equal(snap.toggleMessageReaction("m1", "You", "🔥"), true);
  assert.deepEqual(chatStore.useChatStore.getState().messages[0]?.reactions["🔥"], ["You"]);
  assert.equal(snap.toggleMessageReaction("m1", "You", "🔥"), true);
  assert.equal(chatStore.useChatStore.getState().messages[0]?.reactions["🔥"], undefined);

  // Remote edit only works for matching sender
  assert.equal(snap.applyMessageEdit("m1", "SomeoneElse", "hacked"), false);
  assert.equal(snap.applyMessageEdit("m1", "Tariq", "Hey @You ready now!"), true);
  assert.equal(chatStore.useChatStore.getState().messages[0]?.text, "Hey @You ready now!");
  assert.ok(chatStore.useChatStore.getState().messages[0]?.editedAtMs);

  // Typing status expires cleanly
  snap.setPeerTyping("Tariq", true, 5000);
  assert.equal(Object.keys(chatStore.useChatStore.getState().typingPeers).length, 1);
  snap.pruneExpiredTyping(10_000);
  assert.equal(Object.keys(chatStore.useChatStore.getState().typingPeers).length, 0);

  // Opening chat clears unread and peeks
  snap.setChatOpen(true);
  snap = chatStore.useChatStore.getState();
  assert.equal(snap.unreadCount, 0);
  assert.equal(snap.peeks.length, 0);

  // Leaving room clears all session chat state
  appStore.useAppStore.getState().enterRoom("123456");
  appStore.useAppStore.getState().leaveRoom();
  snap = chatStore.useChatStore.getState();
  assert.equal(snap.messages.length, 0);
  assert.equal(snap.chatOpen, false);
});
