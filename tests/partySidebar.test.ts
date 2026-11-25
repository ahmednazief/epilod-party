import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  computeMpvMarginRatios,
  MIN_PARTY_SIDEBAR_WIDTH,
  MIN_STAGE_VIDEO_WIDTH,
  resolveDualSidebarLayout,
} from "../src/lib/partyLayout.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

test("resolveDualSidebarLayout preserves >= 480px movie stage and falls back cleanly on narrow windows", () => {
  const wide = resolveDualSidebarLayout({
    windowWidth: 1440,
    partyOpen: true,
    partyPreferredWidth: 280,
    chatOpen: true,
    chatPreferredWidth: 440,
  });
  assert.equal(wide.partyDocked, true);
  assert.equal(wide.chatDocked, true);
  assert.equal(wide.effectivePartyWidth, 280);
  assert.equal(wide.effectiveChatWidth, 440);

  // At 1100px with 280 + 440 = 720, stage would be 380 < 480, so widths clamp to keep >= 480px
  const crampedDual = resolveDualSidebarLayout({
    windowWidth: 1100,
    partyOpen: true,
    partyPreferredWidth: 280,
    chatOpen: true,
    chatPreferredWidth: 440,
  });
  assert.equal(crampedDual.partyDocked, true);
  assert.equal(crampedDual.chatDocked, true);
  assert.ok(crampedDual.effectivePartyWidth >= MIN_PARTY_SIDEBAR_WIDTH);
  assert.ok(crampedDual.effectiveChatWidth >= 320);
  assert.ok(
    1100 - crampedDual.effectivePartyWidth - crampedDual.effectiveChatWidth >= MIN_STAGE_VIDEO_WIDTH,
  );

  // Between 860 and 1080 when both are open: Party stays docked, Chat floats as drawer
  const midLaptop = resolveDualSidebarLayout({
    windowWidth: 980,
    partyOpen: true,
    partyPreferredWidth: 280,
    chatOpen: true,
    chatPreferredWidth: 440,
  });
  assert.equal(midLaptop.partyDocked, true);
  assert.equal(midLaptop.chatDocked, false);

  // Below 860px: both use slide-over drawers
  const narrow = resolveDualSidebarLayout({
    windowWidth: 780,
    partyOpen: true,
    partyPreferredWidth: 280,
    chatOpen: true,
    chatPreferredWidth: 440,
  });
  assert.equal(narrow.partyDocked, false);
  assert.equal(narrow.chatDocked, false);
});

test("computeMpvMarginRatios computes independent left and right GPU ratios", () => {
  const ratios = computeMpvMarginRatios(
    { left: 0, right: 1600, width: 1600 },
    { left: 280, right: 1160 },
  );
  assert.equal(ratios.leftRatio, 0.175);
  assert.equal(ratios.rightRatio, 0.275);

  const leftOnly = computeMpvMarginRatios(
    { left: 0, right: 1280, width: 1280 },
    { left: 280, right: 1280 },
  );
  assert.equal(leftOnly.leftRatio, 0.2188);
  assert.equal(leftOnly.rightRatio, 0);
});

test("PartySidebar, ChatSidebar cleanup, and mpv left-margin invariants hold", () => {
  const partySrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/PartySidebar.tsx"),
    "utf8",
  );
  const sharedSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/PartyLoungeShared.tsx"),
    "utf8",
  );
  const chatSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/ChatSidebar.tsx"),
    "utf8",
  );
  const globalsCss = fs.readFileSync(path.join(REPO_ROOT, "src/styles/globals.css"), "utf8");
  const mpvSrc = fs.readFileSync(path.join(REPO_ROOT, "src/lib/mpv.ts"), "utf8");

  assert.match(partySrc, /ep-party-dock-slot/);
  assert.match(partySrc, /data-docked-sidebar/);
  assert.match(partySrc, /ep-menu-scroll/);
  assert.equal(partySrc.includes("<svg"), false);
  assert.equal(sharedSrc.includes("<svg"), false);
  assert.equal(partySrc.includes("ep-hairline-divider"), false);
  assert.equal(partySrc.includes('role="separator"'), false);

  assert.match(globalsCss, /\.ep-party-sidebar\s*\{[^}]*background-color:\s*#0c0c15/);
  assert.match(globalsCss, /\.ep-party-dock-slot\s*\{[^}]*background-color:\s*#060608/);
  assert.match(mpvSrc, /mpv_set_video_margin_left/);

  // ChatSidebar should be pure text chat without duplicate voice strip or VoiceQuickSettingsTray
  assert.equal(chatSrc.includes("VoiceQuickSettingsTray"), false);
  assert.equal(chatSrc.includes("VoiceMicDeafenPills"), false);
});
