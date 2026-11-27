import {
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { formatUserError } from "../lib/errors";
import { isIdentityTransform } from "../lib/sourceAlignment";
import { getControllerLockState, resolveEffectiveUsername } from "../lib/syncController";
import { syncSetRoomAdmin, type Participant } from "../lib/syncplay";
import { setSceneAlignMode, applyTimelineTransform } from "../lib/timelineActions";
import { usePresencePayload } from "../lib/useAnimatedPresence";
import { formatVoiceHotkey } from "../lib/voice";
import { isLocalVoiceSpeaking, toggleVoiceSession } from "../lib/voiceActions";
import { useAppStore } from "../store/useAppStore";
import { useNotificationStore } from "../store/useNotificationStore";
import { usePlayerStore } from "../store/usePlayerStore";
import { useSyncStore } from "../store/useSyncStore";
import { useVoiceStore } from "../store/useVoiceStore";
import {
  buildMemberMeta,
  MemberActionMenuPortal,
  type MemberMenuCoords,
  voiceTransportLabel,
} from "./PartyLoungeShared";
import { AnimatedCollapse } from "./ui/AnimatedCollapse";
import {
  AppChevronIcon,
  AppHeadphonesIcon,
  AppMemberMenuArrowIcon,
  AppMicIcon,
  AppVoiceIcon,
  AppVoiceTuneIcon,
} from "./ui/AppIcons";
import { GlassHoverTip } from "./ui/GlassHoverTip";
import { PartyAdminIcon, PartyHostIcon, PartyLeaveIcon } from "./ui/PlayerIcons";
import { PresenceAvatar } from "./ui/PresenceAvatar";
import { resolveAvatarAccentRgb, resolvePeerAvatarId } from "./ui/ProfileAvatar";
import { VoiceMicDeafenPills } from "./ui/VoiceQuickControls";
import { VoiceQuickSettingsTray } from "./ui/VoiceQuickSettingsTray";

interface ChatVoiceStripProps {
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}

export const ChatVoiceStrip = memo(function ChatVoiceStrip({
  expanded,
  onExpandedChange,
}: ChatVoiceStripProps) {
  const username = useAppStore((s) => s.username);
  const avatarId = useAppStore((s) => s.avatarId);
  const hideParticipants = useAppStore((s) => s.hideParticipants);
  const openSettings = useAppStore((s) => s.openSettings);

  const status = useSyncStore((s) => s.status);
  const participants = useSyncStore((s) => s.participants);
  const roomControl = useSyncStore((s) => s.roomControl);
  const timelineOffsetSecs = useSyncStore((s) => s.timelineOffsetSecs);
  const timelineScale = useSyncStore((s) => s.timelineScale);
  const timelineSegments = useSyncStore((s) => s.timelineSegments);

  const localLoaded = usePlayerStore((s) => s.loaded);
  const pushNote = useNotificationStore((s) => s.push);

  const voiceEnabled = useVoiceStore((s) => s.voiceEnabled);
  const voiceJoined = useVoiceStore((s) => s.joined);
  const voiceJoining = useVoiceStore((s) => s.joining);
  const voiceMuted = useVoiceStore((s) => s.muted);
  const voiceDeafened = useVoiceStore((s) => s.deafened);
  const voiceGateOpen = useVoiceStore((s) => s.localGateOpen);
  const voiceSpeakingPeers = useVoiceStore((s) => s.speakingPeers);
  const voiceRoster = useVoiceStore((s) => s.roster);
  const voiceStreamStatus = useVoiceStore((s) => s.streamStatus);
  const voiceStreamError = useVoiceStore((s) => s.streamError);
  const voiceSpeakerLeak = useVoiceStore((s) => s.speakerLeakDetected);
  const voiceBtHfpDropped = useVoiceStore((s) => s.bluetoothHfpDropped);
  const voiceLowBandwidth = useVoiceStore((s) => s.lowBandwidthWarning);
  const voicePeerOverrides = useVoiceStore((s) => s.peerOverrides);
  const voiceInputMode = useVoiceStore((s) => s.inputMode);
  const voicePttVk = useVoiceStore((s) => s.pttVk);
  const voicePttMod = useVoiceStore((s) => s.pttMod);

  const [btPreJoinConfirm, setBtPreJoinConfirm] = useState(false);
  const [voiceSetupOpen, setVoiceSetupOpen] = useState(false);
  const [busyAdminUser, setBusyAdminUser] = useState<string | null>(null);
  const [openMemberUser, setOpenMemberUser] = useState<string | null>(null);
  const [memberMenuCoords, setMemberMenuCoords] = useState<MemberMenuCoords | null>(null);

  const stripRef = useRef<HTMLDivElement | null>(null);
  const voiceSetupBtnRef = useRef<HTMLButtonElement | null>(null);
  const voiceSetupBoxRef = useRef<HTMLDivElement | null>(null);
  const memberAnchorRefs = useRef<Record<string, HTMLElement | null>>({});
  const memberMenuBoxRef = useRef<HTMLDivElement | null>(null);
  const [voiceSetupCoords, setVoiceSetupCoords] = useState<{
    left: number;
    top: number;
    width: number;
  } | null>(null);

  useEffect(() => {
    if (!voiceJoined) {
      onExpandedChange(false);
      setOpenMemberUser(null);
    }
  }, [voiceJoined, onExpandedChange]);

  const syncConnected = status.state === "connected";
  const effectiveUsername = resolveEffectiveUsername(status, username);
  const ctrlLock = getControllerLockState(
    syncConnected,
    participants,
    effectiveUsername,
    roomControl,
  );
  const hasTimelineAlignment =
    !isIdentityTransform({ offsetSecs: timelineOffsetSecs, scale: timelineScale }) ||
    timelineSegments.length > 1;
  const scaleCalibrated = Math.abs(timelineScale - 1.0) > 0.001;

  const voiceCaptureHealthy =
    voiceStreamStatus !== "micBusy" &&
    voiceStreamStatus !== "permissionDenied" &&
    voiceStreamStatus !== "reconnecting" &&
    !voiceStreamError &&
    !voiceBtHfpDropped;

  const localSpeaking = isLocalVoiceSpeaking({
    joined: voiceJoined,
    muted: voiceMuted,
    deafened: voiceDeafened,
    localGateOpen: voiceGateOpen,
    streamStatus: voiceStreamStatus,
  });

  const getMemberMeta = (p: Participant) =>
    buildMemberMeta({
      participant: p,
      effectiveUsername,
      ctrlLock,
      syncConnected,
      localLoaded,
      scaleCalibrated,
      hasTimelineAlignment,
      voiceEnabled,
      voiceJoined,
      voiceMuted,
      voiceDeafened,
      voiceCaptureHealthy,
      localSpeaking,
      voiceRoster,
      voiceSpeakingPeers,
      voicePeerOverrides,
    });

  const memberEntries = participants.map((p) => ({
    participant: p,
    meta: getMemberMeta(p),
  }));
  const voiceMembers = memberEntries.filter((m) => m.meta.peerInVoice);
  const blockedVoicePeers = voiceRoster.filter(
    (r) => r.inVoice && (r.transport === "blocked" || r.transport === "unavailable"),
  );
  const hasVoiceWarning =
    voiceJoined &&
    (!voiceCaptureHealthy || voiceSpeakerLeak || voiceLowBandwidth || blockedVoicePeers.length > 0);

  const toggleMemberMenu = (peerKey: string) => {
    setVoiceSetupOpen(false);
    setOpenMemberUser((cur) => (cur === peerKey ? null : peerKey));
  };

  useLayoutEffect(() => {
    if (!openMemberUser) {
      setMemberMenuCoords(null);
      return;
    }

    const updatePosition = () => {
      const anchor = memberAnchorRefs.current[openMemberUser];
      if (!anchor) {
        setOpenMemberUser(null);
        return;
      }
      const rect = anchor.getBoundingClientRect();
      const stripRect = stripRef.current?.getBoundingClientRect();
      const vw = window.innerWidth || 1280;
      const vh = window.innerHeight || 720;
      const menuW = 216;
      const estMenuH = 210;
      const anchorLeftEdge = stripRect ? stripRect.left : rect.left;
      const left = Math.max(10, Math.min(Math.round(anchorLeftEdge - menuW - 6), vw - menuW - 10));
      const openUpward = rect.top + estMenuH > vh - 16;
      if (openUpward) {
        const bottom = Math.max(12, Math.round(vh - rect.bottom));
        setMemberMenuCoords({ peerKey: openMemberUser, left, bottom, origin: "bottom right" });
      } else {
        const top = Math.max(12, Math.round(rect.top));
        setMemberMenuCoords({ peerKey: openMemberUser, left, top, origin: "top right" });
      }
    };

    const onScroll = (e: Event) => {
      if (
        memberMenuBoxRef.current &&
        e.target instanceof Node &&
        memberMenuBoxRef.current.contains(e.target)
      ) {
        return;
      }
      setOpenMemberUser(null);
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [openMemberUser, expanded]);

  useEffect(() => {
    if (!openMemberUser) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      const anchor = memberAnchorRefs.current[openMemberUser];
      if (
        memberMenuBoxRef.current &&
        !memberMenuBoxRef.current.contains(target) &&
        (!anchor || !anchor.contains(target))
      ) {
        setOpenMemberUser(null);
      }
    };
    window.addEventListener("mousedown", onMouseDown);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
    };
  }, [openMemberUser]);

  useLayoutEffect(() => {
    if (!voiceSetupOpen) {
      setVoiceSetupCoords(null);
      return;
    }

    const updatePosition = () => {
      const strip = stripRef.current;
      const btn = voiceSetupBtnRef.current;
      if (!strip) {
        setVoiceSetupOpen(false);
        return;
      }
      const stripRect = strip.getBoundingClientRect();
      const btnRect = btn?.getBoundingClientRect();
      const vw = window.innerWidth || 1280;
      const vh = window.innerHeight || 720;
      const trayWidth = Math.max(248, Math.min(286, Math.round(stripRect.width - 24)));
      const left = Math.max(10, Math.min(Math.round(stripRect.right - trayWidth - 12), vw - trayWidth - 10));
      const preferredTop = Math.round((btnRect ? btnRect.bottom : stripRect.bottom) + 8);
      const top = Math.max(12, Math.min(preferredTop, Math.max(12, vh - 360)));
      setVoiceSetupCoords({ left, top, width: trayWidth });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    return () => window.removeEventListener("resize", updatePosition);
  }, [voiceSetupOpen, expanded, voiceJoined]);

  useEffect(() => {
    if (!voiceSetupOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        voiceSetupBoxRef.current &&
        !voiceSetupBoxRef.current.contains(target) &&
        (!voiceSetupBtnRef.current || !voiceSetupBtnRef.current.contains(target))
      ) {
        setVoiceSetupOpen(false);
      }
    };
    window.addEventListener("mousedown", onMouseDown);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
    };
  }, [voiceSetupOpen]);

  // Unified LIFO Escape priority: member menu -> audio setup tray -> expanded voice accordion
  useEffect(() => {
    if (!openMemberUser && !voiceSetupOpen && !expanded) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      if (openMemberUser) {
        setOpenMemberUser(null);
      } else if (voiceSetupOpen) {
        setVoiceSetupOpen(false);
      } else if (expanded) {
        onExpandedChange(false);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [openMemberUser, voiceSetupOpen, expanded, onExpandedChange]);

  const handleToggleVoice = async (listenOnly = false, skipBtCheck = false) => {
    const res = await toggleVoiceSession({
      listenOnly,
      skipBtCheck: skipBtCheck || btPreJoinConfirm,
    });
    if (res === "needsBtConfirm") {
      setBtPreJoinConfirm(true);
    } else if (res === "joined" || res === "left") {
      setBtPreJoinConfirm(false);
    }
  };

  const handleTogglePeerAdmin = async (peerUsername: string, grant: boolean) => {
    setBusyAdminUser(peerUsername);
    try {
      await syncSetRoomAdmin(peerUsername, grant);
      pushNote("info", grant ? `${peerUsername} is now a room admin` : `Removed admin from ${peerUsername}`);
    } catch (err) {
      pushNote("error", formatUserError(err, "Could not update room admin."));
    } finally {
      setBusyAdminUser((prev) => (prev === peerUsername ? null : prev));
    }
  };

  const activeMenuParticipant = openMemberUser
    ? participants.find((p) => p.username.trim().toLowerCase() === openMemberUser) ?? null
    : null;
  const activeMenuPayload = usePresencePayload(
    activeMenuParticipant && memberMenuCoords && memberMenuCoords.peerKey === openMemberUser
      ? { participant: activeMenuParticipant, coords: memberMenuCoords }
      : null,
    160,
  );
  const voiceSetupPresence = usePresencePayload(
    voiceSetupOpen && voiceSetupCoords ? voiceSetupCoords : null,
    190,
  );

  if (!syncConnected) return null;

  const stripMode = !voiceEnabled ? "disabled" : !voiceJoined ? "lobby" : "joined";

  const voiceAudioControls = (
    <div className="flex items-center gap-0.5 shrink-0">
      <VoiceMicDeafenPills
        variant="flat"
        size="sm"
        muted={voiceMuted}
        deafened={voiceDeafened}
        speaking={localSpeaking}
        captureHealthy={voiceCaptureHealthy}
      />
      <GlassHoverTip
        label="Audio settings"
        disabled={voiceSetupOpen}
      >
        <button
          ref={voiceSetupBtnRef}
          type="button"
          aria-label="Voice & Audio Quick Setup"
          aria-expanded={voiceSetupOpen}
          onClick={() => {
            setOpenMemberUser(null);
            setVoiceSetupOpen((o) => !o);
          }}
          className={`ep-press h-7.5 w-7.5 rounded-full flex items-center justify-center cursor-pointer ${
            voiceSetupOpen
              ? "bg-white/[0.12] text-white"
              : "text-secondary hover:text-white hover:bg-white/[0.08]"
          }`}
        >
          <AppVoiceTuneIcon active={voiceSetupOpen} size={14} />
        </button>
      </GlassHoverTip>
    </div>
  );

  const voiceControlsCluster = (
    <div className="flex items-center gap-0.5 shrink-0">
      {voiceAudioControls}
      <span aria-hidden="true" className="mx-0.5 h-3.5 w-px bg-white/[0.08] shrink-0" />
      <GlassHoverTip label="Leave Voice" accent="bad">
        <button
          type="button"
          disabled={voiceJoining}
          aria-label="Leave Voice Chat"
          onClick={() => void handleToggleVoice(false)}
          className="ep-press h-7.5 w-7.5 rounded-full flex items-center justify-center text-muted hover:text-bad hover:bg-bad/14 cursor-pointer disabled:opacity-60"
        >
          <PartyLeaveIcon size={13} />
        </button>
      </GlassHoverTip>
    </div>
  );

  return (
    <div ref={stripRef} className="px-5 pb-1.5 shrink-0">
      <div
        data-joined={voiceEnabled && voiceJoined ? "true" : "false"}
        data-expanded={voiceEnabled && voiceJoined && expanded ? "true" : "false"}
        className={`ep-chat-voice-strip ${
          voiceEnabled && voiceJoined && expanded
            ? "rounded-[18px] px-0 pt-0 pb-0.5"
            : btPreJoinConfirm
              ? "rounded-[18px] p-1.5"
              : "rounded-full p-1.5"
        }`}
      >
        {!voiceEnabled ? (
          <div key={stripMode} className="ep-voice-strip-swap flex items-center justify-between gap-2 min-h-[28px]">
            <span className="inline-flex items-center gap-1.5 text-[11px] text-muted">
              <AppVoiceIcon size={13} className="opacity-70 shrink-0" />
              <span>Voice chat disabled</span>
            </span>
            <button
              type="button"
              onClick={() => openSettings("voice")}
              className="ep-bar-pill ep-press h-6.5 px-2.5 rounded-full text-[10.5px] font-medium text-secondary hover:text-white cursor-pointer"
            >
              Enable
            </button>
          </div>
        ) : !voiceJoined ? (
          <div key={stripMode} className="ep-voice-strip-swap space-y-1.5">
            <div className="flex items-center justify-between gap-2 min-h-[30px]">
              <div className="min-w-0 flex items-center gap-2">
                {voiceMembers.length > 0 && !hideParticipants ? (
                  <>
                    <div className="flex items-center gap-2.5 shrink-0">
                      {voiceMembers.slice(0, 2).map(({ participant: p, meta }) => (
                        <PresenceAvatar
                          key={p.username}
                          avatarId={resolvePeerAvatarId(p.username, effectiveUsername, avatarId)}
                          size={20}
                          speaking={meta.peerSpeaking && !meta.peerLocallyMuted}
                          status={meta.voiceEntry?.deafened || meta.voiceEntry?.muted ? "muted" : "none"}
                          className="ep-voice-avatar-pop"
                          avatarClassName="ring-1 ring-[#0b0a14]"
                        />
                      ))}
                    </div>
                    <span className="text-[11.5px] font-medium text-white/90 truncate">
                      {voiceMembers.length === 1
                        ? `${voiceMembers[0].participant.username} in Voice`
                        : `${voiceMembers.length} in Voice`}
                    </span>
                  </>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-[11.5px] font-medium text-secondary">
                    <AppVoiceIcon active size={13} className="text-accent-soft shrink-0" />
                    <span>Voice</span>
                  </span>
                )}
              </div>

              <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    disabled={voiceJoining}
                    onClick={() => void handleToggleVoice(false)}
                    className="ep-bar-pill ep-press h-7 px-3 rounded-full inline-flex items-center gap-1.5 bg-accent/18 hover:bg-accent/28 text-[11px] font-medium text-white/95 hover:text-white cursor-pointer disabled:opacity-60"
                  >
                    <span>{voiceJoining ? "Joining…" : "Join"}</span>
                  </button>
                <GlassHoverTip label="Listen Only">
                  <button
                    type="button"
                    disabled={voiceJoining}
                    onClick={() => void handleToggleVoice(true)}
                    aria-label="Listen Only"
                    className="ep-bar-pill ep-press h-7 w-7 rounded-full flex items-center justify-center text-secondary hover:text-white cursor-pointer disabled:opacity-60 shrink-0"
                  >
                    <AppHeadphonesIcon size={13} />
                  </button>
                </GlassHoverTip>
              </div>
            </div>

            <AnimatedCollapse open={btPreJoinConfirm} innerClassName="pt-0.5">
              <div
                role="alert"
                className="ep-glass-warning-inline rounded-[12px] px-2.5 py-2 space-y-1.5 text-[10.5px]"
              >
                <p className="text-secondary leading-snug">
                  Bluetooth mic active — hands-free mode reduces movie audio quality.
                </p>
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => void handleToggleVoice(false, true)}
                    className="ep-warning-action ep-press h-6 px-2.5 rounded-full text-[10px] font-semibold text-white cursor-pointer"
                  >
                    Join Anyway
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleToggleVoice(true, true)}
                    className="ep-bar-pill ep-press h-6 px-2.5 rounded-full text-[10px] font-medium text-secondary hover:text-white cursor-pointer"
                  >
                    Listen Only
                  </button>
                  <button
                    type="button"
                    onClick={() => setBtPreJoinConfirm(false)}
                    className="h-6 px-1.5 text-[10px] text-muted hover:text-white cursor-pointer"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </AnimatedCollapse>
          </div>
        ) : (
          <div key={stripMode} className="ep-voice-strip-swap">
            {/* Compact Voice Control Row (hidden when expanded; header pill toggles collapse) */}
            {!expanded && (
              <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => onExpandedChange(!expanded)}
                title={expanded ? "Collapse Voice Lounge" : "Expand Voice Lounge & per-peer volume"}
                className={`ep-press min-w-0 h-7.5 rounded-full inline-flex items-center gap-2 hover:bg-white/[0.06] text-left cursor-pointer focus:outline-none ${
                  expanded
                    ? "w-full justify-between px-2"
                    : !hideParticipants && voiceMembers.length > 0
                      ? "shrink pl-[5px] pr-2.5"
                      : "shrink pl-2 pr-2.5"
                }`}
              >
                <div className="min-w-0 flex items-center gap-2">
                  {!expanded && !hideParticipants && voiceMembers.length > 0 ? (
                    <div className="flex items-center gap-2 shrink-0">
                      {voiceMembers.slice(0, 2).map(({ participant: p, meta }) => (
                        <PresenceAvatar
                          key={p.username}
                          avatarId={resolvePeerAvatarId(p.username, effectiveUsername, avatarId)}
                          size={20}
                          speaking={meta.peerSpeaking && !meta.peerLocallyMuted}
                          status={
                            meta.isSelf && !voiceCaptureHealthy
                              ? "alert"
                              : meta.voiceEntry?.deafened || meta.voiceEntry?.muted || meta.peerLocallyMuted
                                ? "muted"
                                : "none"
                          }
                          className="ep-voice-avatar-pop"
                          avatarClassName="ring-1 ring-[#0b0a14]"
                        />
                      ))}
                    </div>
                  ) : (
                    <AppVoiceIcon
                      active
                      connected={voiceCaptureHealthy}
                      deafened={voiceDeafened}
                      size={14}
                      className={expanded ? "shrink-0" : "shrink-0 ml-1"}
                    />
                  )}

                  <span
                    className={`text-[12px] font-medium whitespace-nowrap ${
                      hasVoiceWarning
                        ? "text-warn"
                        : voiceDeafened
                          ? "text-bad/90"
                          : "text-white/90"
                    }`}
                  >
                    {voiceJoining
                      ? "Connecting…"
                      : !voiceCaptureHealthy
                        ? expanded
                          ? "Voice Issue"
                          : "Issue"
                        : voiceDeafened
                          ? expanded
                            ? "Deafened"
                            : "Deaf"
                          : voiceInputMode === "ptt"
                            ? expanded
                              ? `PTT · ${formatVoiceHotkey(voicePttVk, voicePttMod)}`
                              : formatVoiceHotkey(voicePttVk, voicePttMod)
                            : voiceMembers.length > 1
                              ? expanded
                                ? `${voiceMembers.length} in Voice`
                                : `${voiceMembers.length} live`
                              : expanded
                                ? "Voice Live"
                                : "Live"}
                  </span>
                </div>
                <AppChevronIcon
                  direction="down"
                  size={11}
                  className={`text-muted/75 shrink-0 transition-transform duration-200 ${
                    expanded ? "rotate-180" : ""
                  }`}
                />
              </button>

              {voiceControlsCluster}
              </div>
            )}

            {/* Expandable Accordion: Discord-style Tile Grid for small rooms, clean list for larger rooms */}
            <AnimatedCollapse open={expanded} durationMs={320} variant="liquid">
              <div className="pt-0.5 space-y-2">
                {!hideParticipants && voiceMembers.length > 0 && (
                  voiceMembers.length <= 4 ? (
                    <div className="grid grid-cols-2 gap-2.5 px-0.5 py-1">
                      {voiceMembers.map(({ participant: p, meta }, idx) => {
                        const isMenuOpen =
                          memberMenuCoords?.peerKey === meta.peerKey && openMemberUser === meta.peerKey;
                        const isTileSpeaking = meta.peerSpeaking && !meta.peerLocallyMuted;
                        const isTileMuted = Boolean(
                          meta.voiceEntry?.deafened || meta.voiceEntry?.muted || meta.peerLocallyMuted,
                        );
                        const tileAvatarId = resolvePeerAvatarId(
                          p.username,
                          effectiveUsername,
                          avatarId,
                        );
                        const tileAccentRgb = resolveAvatarAccentRgb(tileAvatarId);

                        return (
                          <div
                            key={p.username}
                            ref={(el) => {
                              if (meta.hasMemberActions) {
                                memberAnchorRefs.current[meta.peerKey] = el;
                              }
                            }}
                            onClick={() => {
                              if (!meta.hasMemberActions) return;
                              toggleMemberMenu(meta.peerKey);
                            }}
                            onContextMenu={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              if (!meta.hasMemberActions) return;
                              toggleMemberMenu(meta.peerKey);
                            }}
                            style={{
                              animationDelay: `${Math.min(idx, 5) * 30}ms`,
                              "--ep-tile-accent": tileAccentRgb,
                            } as CSSProperties}
                            data-speaking={isTileSpeaking ? "true" : "false"}
                            className={`ep-voice-row-in ep-voice-tile group relative rounded-[20px] px-2.5 py-2.5 flex flex-col items-center justify-center gap-1 text-center ${
                              meta.hasMemberActions ? "cursor-pointer" : ""
                            }`}
                          >
                            {(meta.isRowHost || meta.isRowAdmin) && (
                              <span
                                title={meta.isRowHost ? "Host" : "Admin"}
                                className="absolute top-2.5 left-2.5 opacity-80 pointer-events-none"
                              >
                                {meta.isRowHost ? (
                                  <PartyHostIcon size={11.5} />
                                ) : (
                                  <PartyAdminIcon size={11} />
                                )}
                              </span>
                            )}

                            {isTileMuted && (
                              <span
                                title={meta.voiceEntry?.deafened ? "Deafened" : "Muted"}
                                className={`absolute top-2.5 right-2.5 text-bad pointer-events-none transition-opacity ${
                                  meta.hasMemberActions ? "group-hover:opacity-0" : ""
                                }`}
                              >
                                {meta.voiceEntry?.deafened ? (
                                  <AppHeadphonesIcon deafened size={13} />
                                ) : (
                                  <AppMicIcon muted speaking={false} size={13} />
                                )}
                              </span>
                            )}

                            {meta.hasMemberActions && (
                              <button
                                type="button"
                                aria-label={`Actions for ${p.username}`}
                                aria-expanded={isMenuOpen}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  toggleMemberMenu(meta.peerKey);
                                }}
                                className={`absolute top-1.5 right-1.5 h-5.5 w-5.5 rounded-full flex items-center justify-center cursor-pointer transition-opacity ${
                                  isMenuOpen
                                    ? "opacity-100 text-white bg-white/[0.08]"
                                    : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-muted hover:text-white"
                                }`}
                              >
                                <AppMemberMenuArrowIcon open={isMenuOpen} size={12} />
                              </button>
                            )}

                            <div className={isTileMuted ? "opacity-60 transition-opacity" : ""}>
                              <PresenceAvatar
                                avatarId={tileAvatarId}
                                size={44}
                                speaking={false}
                                status={meta.isSelf && !voiceCaptureHealthy ? "alert" : "none"}
                              />
                            </div>

                            <div className="min-w-0 w-full flex items-center justify-center">
                              <span
                                title={meta.isSelf ? `${p.username} (you)` : p.username}
                                className="text-[12px] font-medium text-white/95 truncate text-center"
                              >
                                {p.username}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="ep-menu-scroll max-h-[240px] overflow-y-auto overflow-x-hidden flex flex-col gap-0.5 pr-0.5">
                    {voiceMembers.map(({ participant: p, meta }, idx) => {
                      const isMenuOpen =
                        memberMenuCoords?.peerKey === meta.peerKey && openMemberUser === meta.peerKey;
                      const customVolPct = Math.round(meta.peerVolOv.volume * 100);
                      const baseTransport =
                        meta.voiceEntry?.transport === "relayed" && meta.voiceEntry.relayVia
                          ? `Relayed via ${meta.voiceEntry.relayVia}`
                          : voiceTransportLabel(meta.voiceEntry?.transport);
                      const statusDetail = meta.isSelf
                        ? voiceCaptureHealthy
                          ? voiceDeafened
                            ? "Deafened"
                            : voiceMuted
                              ? "Mic muted"
                              : "Mic live"
                          : "Check audio device"
                        : meta.peerLocallyMuted
                          ? "Muted by you"
                          : meta.voiceEntry?.deafened
                            ? "Deafened"
                            : meta.voiceEntry?.muted
                              ? "Muted"
                              : customVolPct !== 100
                                ? `${baseTransport} · ${customVolPct}%`
                                : baseTransport;

                      return (
                        <div
                          key={p.username}
                          onClick={() => {
                            if (!meta.hasMemberActions) return;
                            toggleMemberMenu(meta.peerKey);
                          }}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            if (!meta.hasMemberActions) return;
                            toggleMemberMenu(meta.peerKey);
                          }}
                          style={{ animationDelay: `${Math.min(idx, 6) * 28}ms` }}
                          className={`ep-voice-row-in group px-2 py-1.5 rounded-xl flex items-center justify-between gap-2 min-w-0 transition-colors hover:bg-white/[0.05] ${
                            meta.hasMemberActions ? "cursor-pointer" : ""
                          }`}
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <PresenceAvatar
                              avatarId={resolvePeerAvatarId(p.username, effectiveUsername, avatarId)}
                              size={24}
                              speaking={meta.peerSpeaking && !meta.peerLocallyMuted}
                              status={
                                meta.isSelf && !voiceCaptureHealthy
                                  ? "alert"
                                  : meta.voiceEntry?.deafened || meta.voiceEntry?.muted || meta.peerLocallyMuted
                                    ? "muted"
                                    : "none"
                              }
                            />
                            <div className="min-w-0">
                              <div className="flex items-center gap-1 min-w-0">
                                <span className="text-[12px] font-medium text-white/90 truncate">
                                  {p.username}
                                </span>
                                {meta.isSelf && (
                                  <span className="text-[10px] text-muted shrink-0">you</span>
                                )}
                                {meta.isRowHost && (
                                  <PartyHostIcon size={11} className="shrink-0 opacity-75" />
                                )}
                                {!meta.isRowHost && meta.isRowAdmin && (
                                  <PartyAdminIcon size={10} className="shrink-0 opacity-75" />
                                )}
                              </div>
                              <div className="text-[10px] text-muted truncate leading-tight">
                                {statusDetail}
                              </div>
                            </div>
                          </div>

                          <div className="flex items-center gap-1 shrink-0">
                            {(meta.voiceEntry?.deafened || meta.voiceEntry?.muted || meta.peerLocallyMuted) && (
                              <span className="text-bad">
                                {meta.voiceEntry?.deafened ? (
                                  <AppHeadphonesIcon deafened size={12} />
                                ) : (
                                  <AppMicIcon
                                    muted={Boolean(meta.voiceEntry?.muted || meta.peerLocallyMuted)}
                                    speaking={false}
                                    size={12}
                                  />
                                )}
                              </span>
                            )}
                            {meta.hasMemberActions && (
                              <button
                                ref={(el) => {
                                  memberAnchorRefs.current[meta.peerKey] = el;
                                }}
                                type="button"
                                aria-label={`Actions for ${p.username}`}
                                aria-expanded={isMenuOpen}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  toggleMemberMenu(meta.peerKey);
                                }}
                                className={`h-6 w-6 rounded-full flex items-center justify-center cursor-pointer transition-opacity ${
                                  isMenuOpen
                                    ? "opacity-100 text-white"
                                    : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-muted hover:text-white"
                                }`}
                              >
                                <AppMemberMenuArrowIcon open={isMenuOpen} size={13} />
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                    </div>
                  )
                )}

                {expanded && (
                  <div className="flex justify-center pt-0.5">
                    <div className="inline-flex items-center p-1 rounded-full bg-white/[0.045] ring-1 ring-white/[0.07]">
                      {voiceControlsCluster}
                    </div>
                  </div>
                )}

                {hasVoiceWarning && (
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-secondary px-1.5 pt-0.5">
                    {voiceStreamStatus === "micBusy" && (
                      <span className="text-bad font-medium">Mic in use by another app</span>
                    )}
                    {voiceStreamStatus === "reconnecting" && (
                      <span className="text-warn font-medium">Reconnecting audio device…</span>
                    )}
                    {voiceStreamStatus === "permissionDenied" && (
                      <span className="text-bad font-medium">Microphone permission denied</span>
                    )}
                    {voiceStreamError &&
                      voiceStreamStatus !== "micBusy" &&
                      voiceStreamStatus !== "reconnecting" &&
                      voiceStreamStatus !== "permissionDenied" && (
                        <span className="text-warn">{voiceStreamError}</span>
                      )}
                    {voiceBtHfpDropped && (
                      <span className="text-warn font-medium">
                        Bluetooth mic dropped — switch mic or Listen Only
                      </span>
                    )}
                    {voiceSpeakerLeak && (
                      <span className="text-warn font-medium">
                        Speaker echo guard active (headphones recommended)
                      </span>
                    )}
                    {voiceLowBandwidth && (
                      <span className="text-warn">Low upload bandwidth — audio adapted</span>
                    )}
                    {blockedVoicePeers.length > 0 && (
                      <span className="text-warn">
                        Voice blocked for {blockedVoicePeers.map((b) => b.username).join(", ")}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </AnimatedCollapse>
          </div>
        )}
      </div>

      {activeMenuPayload.mounted && activeMenuPayload.value && (
        <MemberActionMenuPortal
          menuBoxRef={memberMenuBoxRef}
          menuPeer={activeMenuPayload.value.participant}
          menuMeta={getMemberMeta(activeMenuPayload.value.participant)}
          coords={activeMenuPayload.value.coords}
          exiting={activeMenuPayload.exiting}
          effectiveUsername={effectiveUsername}
          avatarId={avatarId}
          voiceEnabled={voiceEnabled}
          busyAdminUser={busyAdminUser}
          onTogglePeerAdmin={(u, grant) => void handleTogglePeerAdmin(u, grant)}
          onFixFps={(scale, label) => {
            void applyTimelineTransform(
              { offsetSecs: timelineOffsetSecs, scale },
              `FPS matched (${label ?? "calibrated"})`,
            );
          }}
          onAlignScene={() => {
            void setSceneAlignMode(true);
          }}
          onCloseMenu={() => setOpenMemberUser(null)}
        />
      )}

      {voiceSetupPresence.mounted &&
        voiceSetupPresence.value &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={voiceSetupBoxRef}
            style={{
              left: `${voiceSetupPresence.value.left}px`,
              top: `${voiceSetupPresence.value.top}px`,
              width: `${voiceSetupPresence.value.width}px`,
              transformOrigin: "top right",
              backgroundColor: "rgba(10, 10, 16, 0.96)",
            }}
            className={`ep-glass-submenu fixed z-[80] rounded-2xl p-2 ${
              voiceSetupPresence.exiting
                ? "ep-popover-bloom-out pointer-events-none"
                : "ep-popover-bloom"
            }`}
          >
            <VoiceQuickSettingsTray
              open={voiceSetupOpen}
              onOpenFullSettings={() => {
                setVoiceSetupOpen(false);
                openSettings("voice");
              }}
            />
          </div>,
          document.body,
        )}
    </div>
  );
});
