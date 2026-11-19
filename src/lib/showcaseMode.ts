import { useAppStore } from "../store/useAppStore";
import { useChatStore } from "../store/useChatStore";
import { usePlayerStore } from "../store/usePlayerStore";
import { usePlaylistStore } from "../store/usePlaylistStore";
import { enqueueReactionBurst } from "../store/useReactionStore";
import { useSubtitleStore } from "../store/useSubtitleStore";
import { useSyncStore } from "../store/useSyncStore";

export type ShowcaseScene = "hero" | "episodes" | "reactions" | "preferences";

export interface ShowcaseConfig {
  scene: ShowcaseScene;
  initialTab: "room" | "episodes" | "reactions" | null;
}

const VALID_SCENES = new Set<string>(["hero", "episodes", "reactions", "preferences"]);

export function getActiveShowcaseConfig(): ShowcaseConfig | null {
  if (!import.meta.env.DEV || typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const raw = params.get("showcase") ?? "";
  if (!VALID_SCENES.has(raw)) return null;
  const scene = raw as ShowcaseScene;

  if (scene === "hero") {
    return {
      scene,
      initialTab: null,
    };
  }
  if (scene === "episodes") {
    return {
      scene,
      initialTab: "episodes",
    };
  }
  if (scene === "reactions") {
    return {
      scene,
      initialTab: "reactions",
    };
  }
  return {
    scene: "preferences",
    initialTab: null,
  };
}

let reactionIntervalId: number | null = null;

async function paintVideoStill(url: string, focalX = 0.5): Promise<void> {
  const img = new Image();
  img.crossOrigin = "anonymous";
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("Failed to load showcase still: " + url));
    img.src = url;
  });

  const stage =
    (document.querySelector('[data-showcase-stage="true"]') as HTMLElement | null) ||
    document.documentElement;
  const w = Math.max(480, stage.clientWidth || window.innerWidth);
  const h = Math.max(480, stage.clientHeight || window.innerHeight);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const scale = Math.max(w / img.naturalWidth, h / img.naturalHeight);
  const dw = img.naturalWidth * scale;
  const dh = img.naturalHeight * scale;
  const dx = Math.min(0, Math.max(w - dw, (w - dw) * focalX));
  const dy = (h - dh) / 2;
  ctx.drawImage(img, dx, dy, dw, dh);

  const imageData = ctx.getImageData(0, 0, w, h);
  usePlayerStore.setState({
    loaded: true,
    paused: false,
    engineSurfaceVisible: false,
    frozenFrame: {
      width: w,
      height: h,
      rgba: imageData.data,
    },
  });
}

function defaultStillUrl(scene: ShowcaseScene): string {
  const params = new URLSearchParams(window.location.search);
  const explicitBg = params.get("bg");
  if (explicitBg) return explicitBg;
  const file =
    scene === "episodes"
      ? "train.jpg"
      : scene === "reactions"
        ? "rooftop.jpg"
        : "hero.jpg";
  return `http://127.0.0.1:8766/${file}?v=${Date.now()}`;
}

export function initShowcaseMode(): void {
  const cfg = getActiveShowcaseConfig();
  if (!cfg) return;

  const scene = cfg.scene;
  const selectedFileName =
    scene === "episodes"
      ? "Stranger.Things.S02E04.1080p.mkv"
      : scene === "reactions"
        ? "Game.of.Thrones.S05E09.1080p.mkv"
        : "Breaking.Bad.S05E05.1080p.mkv";

  useAppStore.setState({
    screen: "room",
    username: "Noor",
    avatarId: "luna",
    roomCode: "482 917",
    selectedFileName,
    chatPeeksEnabled: true,
    reactionsEnabled: true,
    hideParticipants: false,
    fullWidthPlayBar: false,
    settingsOpen: scene === "preferences",
    settingsTab: "profile",
  });

  useSyncStore.setState({
    status: {
      state: "connected",
      endpoint: "syncplay.pl:8999",
      tls: true,
      username: "Noor",
    },
    localReady: true,
    participants: [
      {
        username: "Noor",
        room: "epilod-482917",
        position: 2894,
        fileName: selectedFileName,
        fileDuration: 6840,
        isReady: true,
        isController: true,
        isHost: true,
        fileMatch: "matched",
      },
      {
        username: "Maya",
        room: "epilod-482917",
        position: 2894,
        fileName: selectedFileName,
        fileDuration: 6840,
        isReady: true,
        isController: true,
        isAdmin: true,
        fileMatch: "matched",
      },
      {
        username: "Tariq",
        room: "epilod-482917",
        position: 2894,
        fileName: selectedFileName,
        fileDuration: 6840,
        isReady: true,
        isController: false,
        fileMatch: "matched",
      },
      {
        username: "Omar",
        room: "epilod-482917",
        position: 2894,
        fileName: selectedFileName,
        fileDuration: 6840,
        isReady: true,
        isController: false,
        fileMatch: "matched",
      },
    ],
    roomControl: {
      hostControlActive: true,
      localIsHost: true,
      localIsAdmin: false,
      hostUsername: "Noor",
      adminUsernames: ["Maya"],
    },
    p2pStatus: {
      natMode: "symmetric",
      peers: [
        { username: "Maya", transport: "directLan", autoAlignState: "aligned" },
        { username: "Tariq", transport: "directWan", autoAlignState: "aligned" },
        { username: "Omar", transport: "directWan", autoAlignState: "aligned" },
      ],
    },
  });

  useSubtitleStore.setState({
    visible: false,
    loadedFilePath: null,
    originalFilePath: null,
  });

  usePlaylistStore.setState({
    folderName: "Stranger Things — Season 2",
    currentIndex: 3,
    autoPlayNext: true,
    followPartyEpisode: true,
    items: [
      {
        path: "01.mkv",
        fileName: "Stranger.Things.S02E01.MADMAX.mkv",
        cleanTitle: "MADMAX",
        season: 2,
        episode: 1,
        episodeBadge: "S02E01",
        subtitlePath: "01.srt",
      },
      {
        path: "02.mkv",
        fileName: "Stranger.Things.S02E02.Trick.or.Treat.Freak.mkv",
        cleanTitle: "Trick or Treat, Freak",
        season: 2,
        episode: 2,
        episodeBadge: "S02E02",
        subtitlePath: "02.srt",
      },
      {
        path: "03.mkv",
        fileName: "Stranger.Things.S02E03.The.Pollywog.mkv",
        cleanTitle: "The Pollywog",
        season: 2,
        episode: 3,
        episodeBadge: "S02E03",
        subtitlePath: "03.srt",
      },
      {
        path: "04.mkv",
        fileName: "Stranger.Things.S02E04.Will.the.Wise.mkv",
        cleanTitle: "Will the Wise",
        season: scene === "episodes" ? 2 : 5,
        episode: scene === "episodes" ? 4 : scene === "reactions" ? 9 : 5,
        episodeBadge: scene === "episodes" ? "S02E04" : scene === "reactions" ? "S05E09" : "S05E05",
        subtitlePath: "04.srt",
      },
      {
        path: "05.mkv",
        fileName: "Stranger.Things.S02E05.Dig.Dug.mkv",
        cleanTitle: "Dig Dug",
        season: 2,
        episode: 5,
        episodeBadge: "S02E05",
        subtitlePath: "05.srt",
      },
    ],
  });

  usePlayerStore.setState({
    loaded: true,
    paused: false,
    positionSecs: scene === "episodes" ? 860 : scene === "reactions" ? 1868 : 2894,
    durationSecs: scene === "episodes" ? 1440 : scene === "reactions" ? 2880 : 6840,
    volume: 92,
    muted: false,
    engineSurfaceVisible: false,
  });

  const now = Date.now();
  useChatStore.setState({
    chatOpen: scene === "hero",
    unreadCount: 0,
    typingPeers: scene === "hero" ? { Omar: now + 60000 } : {},
    peeks:
      scene === "reactions"
        ? [
            {
              id: "peek-1",
              sender: "Maya",
              avatarId: "maya",
              text: "Those sky lanterns look unreal in 4K ✨",
              isMention: false,
              createdAtMs: now,
              expiresAtMs: now + 600000,
            },
            {
              id: "peek-2",
              sender: "Tariq",
              avatarId: "kai",
              text: "Best movie night setup ever 🍿",
              isMention: false,
              createdAtMs: now,
              expiresAtMs: now + 600000,
            },
          ]
        : [],
    messages: [
      {
        id: "m1",
        kind: "message",
        sender: "Maya",
        avatarId: "maya",
        text: "That desert sunset cinematography in 4K!! ✨",
        replyToId: null,
        isSelf: false,
        timestampMs: now - 45000,
        editedAtMs: null,
        reactions: {},
        via: "p2p",
      },
      {
        id: "m2",
        kind: "message",
        sender: "Noor",
        avatarId: "luna",
        text: "Wait till the train heist starts right after this 🍿",
        replyToId: "m1",
        isSelf: true,
        timestampMs: now - 24000,
        editedAtMs: null,
        reactions: {},
        via: "p2p",
      },
      {
        id: "m3",
        kind: "message",
        sender: "Tariq",
        avatarId: "kai",
        text: "Zero lag on sync, this is unreal 🔥",
        replyToId: null,
        isSelf: false,
        timestampMs: now - 6000,
        editedAtMs: null,
        reactions: {},
        via: "p2p",
      },
    ],
  });

  const bgUrl = defaultStillUrl(scene);
  const focalX = scene === "episodes" ? 0.16 : scene === "reactions" ? 0.62 : 0.45;
  window.setTimeout(() => {
    void paintVideoStill(bgUrl, focalX).catch(() => undefined);
  }, 120);

  window.addEventListener("resize", () => {
    void paintVideoStill(bgUrl, focalX).catch(() => undefined);
  });

  if (scene === "reactions") {
    const fire = () => {
      enqueueReactionBurst({ username: "Maya", avatarId: "maya", emoji: "🔥", count: 1 });
      window.setTimeout(() => {
        enqueueReactionBurst({ username: "Omar", avatarId: "omar", emoji: "😮", count: 1 });
      }, 280);
      window.setTimeout(() => {
        enqueueReactionBurst({ username: "Noor", avatarId: "luna", emoji: "❤️", count: 1, isSelf: true });
      }, 560);
    };
    window.setTimeout(fire, 250);
    if (reactionIntervalId !== null) window.clearInterval(reactionIntervalId);
    reactionIntervalId = window.setInterval(fire, 1800);
  }
}
