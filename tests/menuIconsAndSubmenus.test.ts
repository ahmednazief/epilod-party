import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

function readRepoFile(relPath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8");
}

test("MenuIcons exports bespoke crystal SVG icons for all menus", () => {
  const menuIconsSrc = readRepoFile("src/components/ui/MenuIcons.tsx");
  const expectedExports = [
    "MenuControlsIcon",
    "MenuSpeedIcon",
    "MenuAspectFrameIcon",
    "MenuPlayBarLayoutIcon",
    "MenuScreenIcon",
    "MenuMediaDiscIcon",
    "MenuTrackListIcon",
    "MenuSubtitlesOffIcon",
    "MenuAddFileIcon",
    "MenuTimingSyncIcon",
    "MenuPaletteIcon",
    "MenuFontIcon",
    "MenuBoldIcon",
    "MenuOverrideFansubIcon",
    "MenuEncodingIcon",
    "MenuAutoNextIcon",
    "MenuInterfaceIcon",
  ];

  for (const name of expectedExports) {
    assert.match(
      menuIconsSrc,
      new RegExp(`export function ${name}\\(`),
      `Missing exported custom menu icon ${name}`,
    );
  }
  assert.equal(menuIconsSrc.includes("<svg"), true);
  assert.equal(menuIconsSrc.includes('aria-hidden="true"'), true);
});

test("Playback, Subtitles, Episodes, and Select menus render clean custom crystal icons without section-title clutter", () => {
  const playback = readRepoFile("src/components/PlaybackPanel.tsx");
  for (const sym of ["PlayerVolumeIcon", "AppLockIcon", "AppRepeatIcon", "AppCheckIcon"]) {
    assert.equal(playback.includes(sym), true, `PlaybackPanel must use ${sym}`);
  }
  assert.equal(playback.includes("MenuSpeedIcon"), false);
  assert.equal(playback.includes("MenuAspectFrameIcon"), false);

  const subtitles = readRepoFile("src/components/SubtitlePanel.tsx");
  for (const sym of [
    "PlayerCaptionsIcon",
    "MenuAddFileIcon",
    "MenuSubtitlesOffIcon",
    "MenuEncodingIcon",
    "MenuFontIcon",
    "MenuBoldIcon",
    "MenuOverrideFansubIcon",
  ]) {
    assert.equal(subtitles.includes(sym), true, `SubtitlePanel must use ${sym}`);
  }
  assert.equal(subtitles.includes("MenuTimingSyncIcon"), false);
  assert.equal(subtitles.includes("MenuPaletteIcon"), false);

  const episodes = readRepoFile("src/components/EpisodesPanel.tsx");
  for (const sym of [
    "PlayerAutoNextIcon",
    "PlayerFollowIcon",
    "AppFolderIcon",
    "AppPlusIcon",
    "PlayerCaptionsIcon",
    "PlayerWatchedCheckIcon",
  ]) {
    assert.equal(episodes.includes(sym), true, `EpisodesPanel must use ${sym}`);
  }
  assert.equal(episodes.includes("lucide-react"), false, "EpisodesPanel must not import stock lucide-react icons");
  const playerIcons = readRepoFile("src/components/ui/PlayerIcons.tsx");
  assert.match(playerIcons, /export function PlayerAutoNextIcon\(/);
  assert.match(playerIcons, /export function PlayerFollowIcon\(/);
  assert.match(playerIcons, /export function PlayerCaptionsIcon[\s\S]*Stepped luminous subtitle bars inside screen frame/);

  const selectMenu = readRepoFile("src/components/ui/SelectMenu.tsx");
  assert.equal(selectMenu.includes("triggerIcon"), true);
  assert.equal(selectMenu.includes("MenuInterfaceIcon"), true);
});

test("ContextMenu component supports sectioned headers with icons and nested flyout submenus", () => {
  const ctx = readRepoFile("src/components/ui/ContextMenu.tsx");
  assert.equal(ctx.includes('type: "submenu"'), true);
  assert.equal(ctx.includes("ContextMenuSubmenuEntry"), true);
  assert.equal(ctx.includes('aria-haspopup="menu"'), true);
  assert.equal(ctx.includes("aria-expanded={subOpen}"), true);
  assert.equal(ctx.includes("fitsRight"), true);
  assert.equal(ctx.includes("ArrowRight"), true);
  assert.equal(ctx.includes("ArrowLeft"), true);
  assert.equal(ctx.includes("subPresence.mounted"), true);
  assert.equal(ctx.includes("entry.icon"), true);
});

test("WatchRoom and HomeScreen right-click menus are divided into sections with custom icons and submenus", () => {
  const watchRoom = readRepoFile("src/components/WatchRoom.tsx");
  for (const sectionId of [
    "ctx-lbl-playback",
    "ctx-lbl-tracks",
    "ctx-lbl-media",
    "ctx-lbl-party",
    "ctx-lbl-app",
  ]) {
    assert.equal(watchRoom.includes(sectionId), true, `WatchRoom ContextMenu missing section ${sectionId}`);
  }
  for (const submenuId of [
    "sub-playback-opts",
    "sub-audio",
    "sub-subtitles",
    "sub-open-media",
    "sub-episodes",
    "sub-picture-window",
    "sub-party-controls",
    "sub-prefs-help",
  ]) {
    assert.equal(watchRoom.includes(submenuId), true, `WatchRoom ContextMenu missing submenu ${submenuId}`);
  }

  const homeScreen = readRepoFile("src/components/HomeScreen.tsx");
  assert.equal(homeScreen.includes("lobby-lbl-watch"), true);
  assert.equal(homeScreen.includes("lobby-lbl-app"), true);
  assert.equal(homeScreen.includes("lobby-sub-prefs"), true);
  assert.equal(homeScreen.includes("MenuMediaDiscIcon"), true);
});

test("Settings left sidebar clips ambient ::before aura so no phantom scrollbar appears", () => {
  const globalsCss = readRepoFile("src/styles/globals.css");
  assert.match(globalsCss, /\.ep-settings-sidebar\s*\{[\s\S]*overflow:\s*hidden;/);

  const settingsModal = readRepoFile("src/components/SettingsModal.tsx");
  assert.match(settingsModal, /<aside className="[^"]*ep-settings-sidebar[^"]*overflow-hidden/);
  assert.doesNotMatch(settingsModal, /<aside className="[^"]*ep-settings-sidebar[^"]*overflow-y-auto/);
});

test("TitleBar supports dragging out of maximized window state smoothly", () => {
  const titleBar = readRepoFile("src/components/TitleBar.tsx");
  assert.match(titleBar, /data-tauri-drag-region=\{isMaximized \? "false" : "deep"\}/);
  assert.equal(titleBar.includes("windowDragFromMaximized"), true);
  assert.equal(titleBar.includes("handleMaximizedTitleMouseDown"), true);

  const watchRoom = readRepoFile("src/components/WatchRoom.tsx");
  assert.doesNotMatch(watchRoom, /<span[^>]*data-tauri-drag-region/);

  const rustLib = readRepoFile("src-tauri/src/lib.rs");
  assert.equal(rustLib.includes("window_drag_from_maximized"), true);
  assert.equal(rustLib.includes("compute_drag_restore_bounds"), true);
});

test("All remaining app and installer controls use dedicated custom crystal icon components with zero raw inline SVGs", () => {
  const iconDirs = ["src/components", "installer/src"];
  const allowedSvgModules = new Set([
    path.normalize("src/components/ui/AppIcons.tsx"),
    path.normalize("src/components/ui/LobbyIcons.tsx"),
    path.normalize("src/components/ui/MenuIcons.tsx"),
    path.normalize("src/components/ui/PlayerIcons.tsx"),
    path.normalize("src/components/ui/ProfileAvatar.tsx"),
    path.normalize("installer/src/components/InstallerIcons.tsx"),
  ]);

  const walk = (relDir: string): string[] => {
    const out: string[] = [];
    for (const entry of fs.readdirSync(path.join(REPO_ROOT, relDir), { withFileTypes: true })) {
      const rel = path.join(relDir, entry.name);
      if (entry.isDirectory()) {
        out.push(...walk(rel));
      } else if (entry.name.endsWith(".tsx") || entry.name.endsWith(".ts")) {
        out.push(rel);
      }
    }
    return out;
  };

  for (const dir of iconDirs) {
    for (const rel of walk(dir)) {
      if (allowedSvgModules.has(path.normalize(rel))) continue;
      const src = readRepoFile(rel);
      assert.equal(src.includes("<svg"), false, `Unexpected raw inline <svg> in ${rel}`);
    }
  }

  const appIcons = readRepoFile("src/components/ui/AppIcons.tsx");
  for (const sym of [
    "AppMaximizeIcon",
    "AppUpdateProgressIcon",
    "AppSearchIcon",
    "AppSeasonFolderIcon",
  ]) {
    assert.match(appIcons, new RegExp(`export function ${sym}\\(`));
  }

  const playerIcons = readRepoFile("src/components/ui/PlayerIcons.tsx");
  for (const sym of [
    "PlayerReactionPickerIcon",
    "PartyAdminIcon",
    "PartyMismatchIcon",
    "PartyFpsMatchIcon",
    "PartyAlignSceneIcon",
  ]) {
    assert.match(playerIcons, new RegExp(`export function ${sym}\\(`));
  }

  const installerIcons = readRepoFile("installer/src/components/InstallerIcons.tsx");
  for (const sym of [
    "InstallerMinimizeIcon",
    "InstallerCloseIcon",
    "InstallerArrowIcon",
    "InstallerCheckIcon",
    "InstallerSlidersIcon",
    "InstallerFolderIcon",
    "InstallerResetIcon",
    "InstallerLaunchIcon",
  ]) {
    assert.match(installerIcons, new RegExp(`export function ${sym}\\(`));
  }

  const titleBar = readRepoFile("src/components/TitleBar.tsx");
  assert.equal(titleBar.includes("<AppMaximizeIcon"), true);
  assert.equal(titleBar.includes("<AppUpdateProgressIcon"), true);

  const reactionPopover = readRepoFile("src/components/ReactionPopover.tsx");
  assert.equal(reactionPopover.includes("<AppSearchIcon"), true);
  assert.equal(reactionPopover.includes("<PlayerReactionPickerIcon"), true);

  const mismatchBanner = readRepoFile("src/components/FileMismatchBanner.tsx");
  assert.equal(mismatchBanner.includes("<PartyMismatchIcon"), true);
  assert.equal(mismatchBanner.includes("<PartyFpsMatchIcon"), true);
  assert.equal(mismatchBanner.includes("<PartyAlignSceneIcon"), true);
  assert.equal(mismatchBanner.includes("<AppSeasonFolderIcon"), true);

  const roomPanel = readRepoFile("src/components/RoomPanel.tsx");
  assert.equal(roomPanel.includes("<PartyAdminIcon"), true);
  assert.equal(roomPanel.includes("<PartyFpsMatchIcon"), true);
  assert.equal(roomPanel.includes("<PartyAlignSceneIcon"), true);
  assert.equal(roomPanel.includes("<AppSeasonFolderIcon"), true);
});

test("Rounded floating menus clip corners with overflow-hidden shells and scroll via inset .ep-menu-scroll containers", () => {
  const globalsCss = readRepoFile("src/styles/globals.css");
  assert.match(globalsCss, /\.ep-menu-scroll\s*\{[^}]*overflow-anchor:\s*none;/);
  assert.match(
    globalsCss,
    /\.ep-menu-scroll::-webkit-scrollbar-thumb\s*\{[^}]*background-clip:\s*content-box;/,
  );
  assert.match(globalsCss, /\.ep-collapse\s*\{[\s\S]*grid-template-rows:\s*0fr;/);
  assert.doesNotMatch(globalsCss, /\.ep-collapse\s*\{[^}]*transform:\s*translateY/);

  const ctxMenu = readRepoFile("src/components/ui/ContextMenu.tsx");
  assert.doesNotMatch(ctxMenu, /ep-glass-submenu[\s\S]{0,180}overflow-y-auto/);
  assert.equal(ctxMenu.includes("menuScrollRef"), true);
  assert.equal(ctxMenu.includes("subScrollRef"), true);
  assert.match(ctxMenu, /overflow-hidden rounded-\[18px\] py-2 flex flex-col select-none/);
  assert.match(ctxMenu, /ep-menu-scroll flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-1\.5/);

  const selectMenu = readRepoFile("src/components/ui/SelectMenu.tsx");
  assert.doesNotMatch(selectMenu, /ep-glass-submenu[^"]*overflow-y-auto/);
  assert.match(selectMenu, /ep-glass-submenu fixed z-\[80\] overflow-hidden rounded-2xl py-2 flex flex-col/);
  assert.match(selectMenu, /ep-menu-scroll flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-1\.5/);

  const watchRoom = readRepoFile("src/components/WatchRoom.tsx");
  assert.doesNotMatch(watchRoom, /popover\.value\.tab === "reactions"[\s\S]{0,200}: "overflow-y-auto/);
  assert.match(watchRoom, /flex flex-col overflow-hidden rounded-\[22px\] p-3\.5/);
  assert.match(watchRoom, /ep-menu-scroll flex-1 min-h-0 overflow-y-auto overflow-x-hidden -mr-2\.5 pr-2\.5/);

  const homeScreen = readRepoFile("src/components/HomeScreen.tsx");
  assert.doesNotMatch(homeScreen, /max-h-\[calc\(100vh-4rem\)\] overflow-y-auto/);
  assert.match(homeScreen, /max-h-\[calc\(100vh-4rem\)\] overflow-hidden rounded-\[24px\] py-4 flex flex-col/);
});
