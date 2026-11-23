import { useAppStore } from "../store/useAppStore";
import { useChatStore } from "../store/useChatStore";
import { usePlayerStore } from "../store/usePlayerStore";
import { usePlaylistStore } from "../store/usePlaylistStore";
import { enqueueReactionBurst } from "../store/useReactionStore";
import { useRatingStore } from "../store/useRatingStore";
import { seedOfficialRatingsCache } from "./officialRatings";
import { buildRatingKey } from "./ratings";
import { useSubtitleStore } from "../store/useSubtitleStore";
import { useSyncStore } from "../store/useSyncStore";
import { useVoiceStore } from "../store/useVoiceStore";

export type ShowcaseScene = "hero" | "episodes" | "reactions" | "preferences" | "rating" | "voice";

export interface ShowcaseConfig {
  scene: ShowcaseScene;
  initialTab: "room" | "episodes" | "reactions" | null;
}

const VALID_SCENES = new Set<string>(["hero", "episodes", "reactions", "preferences", "rating", "voice"]);

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
  if (scene === "rating") {
    return {
      scene,
      initialTab: null,
    };
  }
  if (scene === "voice") {
    return {
      scene,
      initialTab: "room",
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

  const isEpisodesScene = scene === "episodes";
  const isReactionsScene = scene === "reactions";

  usePlaylistStore.setState({
    folderName: isEpisodesScene
      ? "Stranger Things — Season 2"
      : isReactionsScene
        ? "Game of Thrones — Season 5"
        : "Breaking Bad — Season 5",
    currentIndex: 3,
    autoPlayNext: true,
    followPartyEpisode: true,
    items: isEpisodesScene
      ? [
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
            season: 2,
            episode: 4,
            episodeBadge: "S02E04",
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
        ]
      : isReactionsScene
        ? [
            {
              path: "06.mkv",
              fileName: "Game.of.Thrones.S05E06.Unbowed.Unbent.Unbroken.mkv",
              cleanTitle: "Unbowed, Unbent, Unbroken",
              season: 5,
              episode: 6,
              episodeBadge: "S05E06",
              subtitlePath: "06.srt",
            },
            {
              path: "07.mkv",
              fileName: "Game.of.Thrones.S05E07.The.Gift.mkv",
              cleanTitle: "The Gift",
              season: 5,
              episode: 7,
              episodeBadge: "S05E07",
              subtitlePath: "07.srt",
            },
            {
              path: "08.mkv",
              fileName: "Game.of.Thrones.S05E08.Hardhome.mkv",
              cleanTitle: "Hardhome",
              season: 5,
              episode: 8,
              episodeBadge: "S05E08",
              subtitlePath: "08.srt",
            },
            {
              path: "09.mkv",
              fileName: "Game.of.Thrones.S05E09.The.Dance.of.Dragons.mkv",
              cleanTitle: "The Dance of Dragons",
              season: 5,
              episode: 9,
              episodeBadge: "S05E09",
              subtitlePath: "09.srt",
            },
            {
              path: "10.mkv",
              fileName: "Game.of.Thrones.S05E10.Mothers.Mercy.mkv",
              cleanTitle: "Mother's Mercy",
              season: 5,
              episode: 10,
              episodeBadge: "S05E10",
              subtitlePath: "10.srt",
            },
          ]
        : [
            {
              path: "02.mkv",
              fileName: "Breaking.Bad.S05E02.Madrigal.mkv",
              cleanTitle: "Madrigal",
              season: 5,
              episode: 2,
              episodeBadge: "S05E02",
              subtitlePath: "02.srt",
            },
            {
              path: "03.mkv",
              fileName: "Breaking.Bad.S05E03.Hazard.Pay.mkv",
              cleanTitle: "Hazard Pay",
              season: 5,
              episode: 3,
              episodeBadge: "S05E03",
              subtitlePath: "03.srt",
            },
            {
              path: "04.mkv",
              fileName: "Breaking.Bad.S05E04.Fifty-One.mkv",
              cleanTitle: "Fifty-One",
              season: 5,
              episode: 4,
              episodeBadge: "S05E04",
              subtitlePath: "04.srt",
            },
            {
              path: "05.mkv",
              fileName: "Breaking.Bad.S05E05.Dead.Freight.mkv",
              cleanTitle: "Dead Freight",
              season: 5,
              episode: 5,
              episodeBadge: "S05E05",
              subtitlePath: "05.srt",
            },
            {
              path: "06.mkv",
              fileName: "Breaking.Bad.S05E06.Buyout.mkv",
              cleanTitle: "Buyout",
              season: 5,
              episode: 6,
              episodeBadge: "S05E06",
              subtitlePath: "06.srt",
            },
          ],
  });

  usePlayerStore.setState({
    loaded: true,
    paused: false,
    positionSecs: scene === "episodes" ? 860 : scene === "reactions" ? 1868 : scene === "rating" ? 6828 : 2894,
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

  seedOfficialRatingsCache({
    showKey: "stranger things",
    showTitle: "Stranger Things",
    source: "tvmaze",
    showRating: 8.6,
    episodes: {
      S02E01: 8.2,
      S02E02: 8.4,
      S02E03: 8.5,
      S02E04: 8.8,
      S02E05: 8.6,
    },
    updatedAt: Date.now(),
  });
  seedOfficialRatingsCache({
    showKey: "breaking bad",
    showTitle: "Breaking Bad",
    source: "tvmaze",
    showRating: 9.2,
    episodes: {
      S05E02: 8.8,
      S05E03: 8.9,
      S05E04: 9.0,
      S05E05: 9.7,
      S05E06: 9.1,
    },
    updatedAt: Date.now(),
  });

  if (scene === "episodes") {
    const rStore = useRatingStore.getState();
    const k1 = buildRatingKey("Stranger.Things.S02E01.MADMAX.mkv", 3100);
    const k2 = buildRatingKey("Stranger.Things.S02E02.Trick.or.Treat.Freak.mkv", 3200);
    if (k1) rStore.castLocalVote(k1, "Noor", "luna", 9, "Stranger.Things.S02E01.MADMAX.mkv");
    if (k2) rStore.castLocalVote(k2, "Noor", "luna", 10, "Stranger.Things.S02E02.Trick.or.Treat.Freak.mkv");
  }

  if (scene === "voice") {
    useVoiceStore.setState({
      voiceEnabled: true,
      joined: true,
      joining: false,
      muted: false,
      deafened: false,
      localGateOpen: true,
      localLevelDb: -16,
      localSpeechProb: 0.94,
      speakingPeers: ["Maya", "Tariq"],
      streamStatus: "live",
      streamError: null,
      roster: [
        {
          username: "Maya",
          voiceId: 1,
          epoch: 1,
          inVoice: true,
          muted: false,
          deafened: false,
          transport: "directLan",
          relayVia: null,
          rttMs: 4,
          lossPct: 0,
          jitterMs: 1.2,
          bitrateKbps: 48,
          qualityBars: 4,
          healthReason: null,
          healthFix: null,
        },
        {
          username: "Tariq",
          voiceId: 2,
          epoch: 1,
          inVoice: true,
          muted: false,
          deafened: false,
          transport: "directWan",
          relayVia: null,
          rttMs: 28,
          lossPct: 0.2,
          jitterMs: 3.1,
          bitrateKbps: 48,
          qualityBars: 4,
          healthReason: null,
          healthFix: null,
        },
        {
          username: "Omar",
          voiceId: 3,
          epoch: 1,
          inVoice: true,
          muted: true,
          deafened: false,
          transport: "relayed",
          relayVia: "Maya",
          rttMs: 62,
          lossPct: 0.8,
          jitterMs: 7.4,
          bitrateKbps: 32,
          qualityBars: 3,
          healthReason: null,
          healthFix: null,
        },
      ],
    });
  }

  if (scene === "rating") {
    const ratingKey = buildRatingKey(selectedFileName, 6840);
    if (ratingKey) {
      const rStore = useRatingStore.getState();
      rStore.resetSession();
      rStore.openForKey(ratingKey, selectedFileName.replace(/\.[^.]+$/, ""));
      rStore.castLocalVote(ratingKey, "Noor", "luna", 9, selectedFileName);
      rStore.receivePeerVote(ratingKey, "Maya", "maya", 9);
      rStore.receivePeerVote(ratingKey, "Tariq", "kai", 8);
      rStore.receivePeerVote(ratingKey, "Omar", "fox", 10);
    }
  }

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
