import { memo } from "react";
import { createPortal } from "react-dom";
import type { Participant, RoomControlState } from "../lib/syncplay";
import { computeParticipantDrift } from "../lib/syncHealth";
import type { ControllerLockState } from "../lib/syncController";
import { formatSignedOffset } from "../lib/sourceAlignment";
import { captureSceneAnchor, captureSecondDriftAnchor, setSceneAlignMode } from "../lib/timelineActions";
import type { VoicePeerRosterDto } from "../lib/voice";
import { usePlayerStore } from "../store/usePlayerStore";
import { useSyncStore } from "../store/useSyncStore";
import { useVoiceStore } from "../store/useVoiceStore";

export interface PeerVolumeOverride {
  volume: number;
  muted: boolean;
}
import { formatClock } from "./TransportBar";
import { AppMicIcon, AppSpeakerVolumeIcon } from "./ui/AppIcons";
import { GlassHoverTip } from "./ui/GlassHoverTip";
import { PartyAdminIcon, PartyAlignSceneIcon, PartyFpsMatchIcon } from "./ui/PlayerIcons";
import { PresenceAvatar } from "./ui/PresenceAvatar";
import { resolvePeerAvatarId, type AvatarId } from "./ui/ProfileAvatar";
import { Scrubber } from "./ui/Scrubber";

export function voiceTransportLabel(transport: string | undefined): string {
  switch (transport) {
    case "directLan":
      return "Direct LAN";
    case "directIpv6":
      return "Direct IPv6";
    case "directWan":
      return "Direct P2P";
    case "relayed":
      return "Relayed P2P";
    case "blocked":
    case "unavailable":
      return "Strict NAT blocked";
    default:
      return "Direct P2P";
  }
}

export const ParticipantDriftBadge = memo(function ParticipantDriftBadge({
  participant,
  hostPeerPos,
  hideWhenOk = false,
}: {
  participant: Parameters<typeof computeParticipantDrift>[0];
  hostPeerPos: number | null;
  hideWhenOk?: boolean;
}) {
  const liveRoomPositionSecs = useSyncStore((s) =>
    hostPeerPos !== null && hostPeerPos > 0 ? 0 : s.liveRoomPositionSecs,
  );
  const refPos = hostPeerPos !== null && hostPeerPos > 0 ? hostPeerPos : liveRoomPositionSecs;
  const driftInfo = computeParticipantDrift(participant, refPos);
  if (!driftInfo || (hideWhenOk && driftInfo.level === "ok")) return null;
  const dotClass =
    driftInfo.level === "ok"
      ? "bg-ok"
      : driftInfo.level === "warn"
        ? "bg-warn"
        : "bg-bad";
  return (
    <GlassHoverTip
      label={driftInfo.label}
      detail={driftInfo.detail}
      accent={driftInfo.level}
    >
      <span
        aria-label={`${driftInfo.label}: ${driftInfo.detail}`}
        className="inline-flex items-center justify-center h-4 w-4 rounded-full bg-white/[0.06] cursor-default shrink-0"
      >
        <span className={`w-1.5 h-1.5 rounded-full ${dotClass}`} />
      </span>
    </GlassHoverTip>
  );
});

export const RoomAlignReadout = memo(function RoomAlignReadout({
  timelineScale,
}: {
  timelineScale: number;
}) {
  const liveRoomPositionSecs = useSyncStore((s) => s.liveRoomPositionSecs);
  const localPositionSecs = usePlayerStore((s) => s.positionSecs);
  const liveAlignDelta = localPositionSecs - timelineScale * liveRoomPositionSecs;

  return (
    <div className="p-2 rounded-xl bg-white/[0.05] space-y-2">
      <div className="text-[11px] text-secondary leading-snug">
        Scrub your video to the same moment your friend is on, then click{" "}
        <span className="text-white font-medium">Match Here</span>.
      </div>
      <div className="flex items-center justify-between text-[11px] num">
        <span className="text-muted">
          Friend:{" "}
          <span className="text-white font-medium">
            {formatClock(liveRoomPositionSecs)}
          </span>
        </span>
        <span className="text-muted">
          Yours:{" "}
          <span className="text-accent-soft font-medium">
            {formatClock(localPositionSecs)}
          </span>
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => void captureSceneAnchor()}
          className="ep-glass-primary-pill ep-press flex-1 h-7.5 rounded-xl inline-flex items-center justify-center gap-1.5 text-[11px] font-medium text-white cursor-pointer"
        >
          <PartyAlignSceneIcon size={12} />
          <span>Match Here ({formatSignedOffset(liveAlignDelta)})</span>
        </button>
        <button
          type="button"
          onClick={() => void setSceneAlignMode(false)}
          className="ep-bar-icon-btn ep-press h-7.5 px-2.5 rounded-xl text-[11px] font-medium text-secondary hover:text-white cursor-pointer"
        >
          Cancel
        </button>
      </div>
    </div>
  );
});

export const SecondAnchorButton = memo(function SecondAnchorButton({
  anchorRoomSecs,
}: {
  anchorRoomSecs: number;
}) {
  const localPositionSecs = usePlayerStore((s) => Math.floor(s.positionSecs));
  if (Math.abs(localPositionSecs - anchorRoomSecs) < 30) {
    return null;
  }
  return (
    <button
      type="button"
      onClick={() => void captureSecondDriftAnchor()}
      className="ep-menu-row ep-press w-full px-2 py-1 rounded-lg text-[10.5px] text-accent-soft hover:text-white text-left cursor-pointer"
    >
      Still drifting? Set 2nd anchor point here to calibrate FPS
    </button>
  );
});

export interface MemberMetaInput {
  participant: Participant;
  effectiveUsername: string;
  ctrlLock: ControllerLockState;
  syncConnected: boolean;
  localLoaded: boolean;
  scaleCalibrated: boolean;
  hasTimelineAlignment: boolean;
  voiceEnabled: boolean;
  voiceJoined: boolean;
  voiceMuted: boolean;
  voiceDeafened: boolean;
  voiceCaptureHealthy: boolean;
  localSpeaking: boolean;
  voiceRoster: VoicePeerRosterDto[];
  voiceSpeakingPeers: string[];
  voicePeerOverrides: Record<string, PeerVolumeOverride>;
}

export interface MemberMetaResult {
  peerKey: string;
  isSelf: boolean;
  canQuickFixFps: boolean;
  canQuickAlign: boolean;
  isRowHost: boolean;
  isRowAdmin: boolean;
  canManageAdmin: boolean;
  voiceEntry: VoicePeerRosterDto | null;
  peerInVoice: boolean;
  peerSpeaking: boolean;
  peerVolOv: PeerVolumeOverride;
  peerLocallyMuted: boolean;
  hasMemberActions: boolean;
}

export function buildMemberMeta({
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
}: MemberMetaInput): MemberMetaResult {
  const normName = (n: string | null | undefined) => (n ?? "").trim().toLowerCase();
  const peerKey = normName(p.username);
  const isSelf = peerKey === normName(effectiveUsername);
  const canQuickFixFps =
    !isSelf &&
    !scaleCalibrated &&
    p.sourceRelation === "fpsMismatch" &&
    typeof p.suggestedFpsScale === "number";
  const canQuickAlign =
    !isSelf &&
    !hasTimelineAlignment &&
    p.sourceRelation === "differentCut" &&
    localLoaded;
  const isRowHost =
    Boolean(p.isHost) ||
    (ctrlLock.hostControlActive
      ? peerKey !== "" && peerKey === normName(ctrlLock.hostUsername)
      : p.isController && !p.isAdmin);
  const isRowAdmin =
    Boolean(p.isAdmin) ||
    (ctrlLock.hostControlActive &&
      !isRowHost &&
      ctrlLock.adminUsernames.some((a) => normName(a) === peerKey));
  const canManageAdmin = ctrlLock.localIsHost && !isSelf && syncConnected && !isRowHost;
  const voiceEntry: VoicePeerRosterDto | null = isSelf
    ? voiceJoined
      ? {
          username: p.username,
          voiceId: 0,
          epoch: 0,
          inVoice: true,
          muted: voiceMuted,
          deafened: voiceDeafened,
          transport: "directLan",
          relayVia: null,
          rttMs: null,
          lossPct: 0,
          jitterMs: 0,
          bitrateKbps: 0,
          qualityBars: voiceCaptureHealthy ? 4 : 1,
          healthReason: null,
          healthFix: null,
        }
      : null
    : voiceRoster.find((r) => normName(r.username) === peerKey) ?? null;
  const peerInVoice = Boolean(voiceEntry?.inVoice);
  const peerSpeaking = isSelf
    ? localSpeaking
    : peerInVoice &&
      !voiceEntry?.muted &&
      !voiceEntry?.deafened &&
      voiceSpeakingPeers.some((s) => normName(s) === peerKey);
  const peerVolOv = voicePeerOverrides[peerKey] ?? { volume: 1.0, muted: false };
  const peerLocallyMuted = !isSelf && peerVolOv.muted;
  const hasMemberActions =
    !isSelf &&
    (canManageAdmin ||
      voiceEnabled ||
      peerInVoice ||
      (canQuickFixFps && Boolean(p.suggestedFpsScale)) ||
      canQuickAlign);

  return {
    peerKey,
    isSelf,
    canQuickFixFps,
    canQuickAlign,
    isRowHost,
    isRowAdmin,
    canManageAdmin,
    voiceEntry,
    peerInVoice,
    peerSpeaking,
    peerVolOv,
    peerLocallyMuted,
    hasMemberActions,
  };
}

export interface MemberMenuCoords {
  peerKey: string;
  left: number;
  top?: number;
  bottom?: number;
  origin?: string;
}

export function MemberActionMenuPortal({
  menuBoxRef,
  menuPeer,
  menuMeta,
  coords,
  exiting,
  effectiveUsername,
  avatarId,
  peerAvatars,
  voiceEnabled,
  busyAdminUser,
  onTogglePeerAdmin,
  onFixFps,
  onAlignScene,
  onCloseMenu,
}: {
  menuBoxRef: React.RefObject<HTMLDivElement | null>;
  menuPeer: Participant;
  menuMeta: MemberMetaResult;
  coords: MemberMenuCoords;
  exiting: boolean;
  effectiveUsername: string;
  avatarId: string;
  peerAvatars?: Record<string, AvatarId>;
  voiceEnabled: boolean;
  busyAdminUser: string | null;
  onTogglePeerAdmin: (username: string, grant: boolean) => void;
  onFixFps: (scale: number, label?: string | null) => void;
  onAlignScene: () => void;
  onCloseMenu: () => void;
}) {
  const setVoicePeerVolume = useVoiceStore((s) => s.setPeerVolume);
  const adminBusy = busyAdminUser === menuPeer.username;
  const statusLabel = menuMeta.isRowHost
    ? "Host"
    : menuMeta.isRowAdmin
      ? "Admin"
      : menuMeta.peerInVoice
        ? "In voice"
        : "Viewer";

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={menuBoxRef}
      role="menu"
      aria-label={`Actions for ${menuPeer.username}`}
      style={{
        left: `${coords.left}px`,
        ...(coords.origin ? { transformOrigin: coords.origin } : {}),
        ...(coords.top !== undefined ? { top: `${coords.top}px` } : {}),
        ...(coords.bottom !== undefined ? { bottom: `${coords.bottom}px` } : {}),
      }}
      className={`${
        exiting ? "anim-pop-out pointer-events-none" : "anim-pop-in"
      } ep-glass-submenu fixed z-[80] w-[216px] rounded-2xl p-1.5 flex flex-col gap-1`}
    >
      <div className="px-2 py-1 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <PresenceAvatar
            avatarId={resolvePeerAvatarId(menuPeer.username, effectiveUsername, avatarId, peerAvatars)}
            size={18}
            speaking={menuMeta.peerSpeaking && !menuMeta.peerLocallyMuted}
            avatarClassName="ring-1 ring-white/20"
          />
          <span className="text-[11.5px] font-medium text-white truncate">
            {menuPeer.username}
          </span>
        </div>
        <span className="text-[10px] font-medium text-secondary shrink-0">
          {statusLabel}
        </span>
      </div>

      {!menuMeta.isSelf && (menuMeta.peerInVoice || voiceEnabled) && (
        <div className="space-y-1 pb-0.5">
          <button
            type="button"
            role="menuitem"
            onClick={() =>
              setVoicePeerVolume(
                menuPeer.username,
                menuMeta.peerVolOv.volume,
                !menuMeta.peerVolOv.muted,
              )
            }
            className={`ep-menu-row ep-press w-full px-2 py-1.5 rounded-xl flex items-center justify-between gap-2 text-left text-[11.5px] font-medium cursor-pointer ${
              menuMeta.peerLocallyMuted ? "text-bad" : "text-secondary hover:text-white"
            }`}
          >
            <span className="inline-flex items-center gap-2">
              <AppMicIcon
                muted={menuMeta.peerLocallyMuted}
                speaking={menuMeta.peerSpeaking}
                size={14}
              />
              <span>
                {menuMeta.peerLocallyMuted ? "Unmute in Voice" : "Mute in Voice"}
              </span>
            </span>
          </button>

          <div className="px-2 pt-0.5 pb-1.5 space-y-1.5">
            <div className="flex items-center justify-between gap-2 text-[10.5px]">
              <span className="inline-flex items-center gap-1.5 text-secondary">
                <AppSpeakerVolumeIcon
                  muted={menuMeta.peerLocallyMuted || menuMeta.peerVolOv.volume === 0}
                  size={13}
                />
                <span>Voice Volume</span>
              </span>
              <span className="num font-medium text-white/90">
                {Math.round(menuMeta.peerVolOv.volume * 100)}%
              </span>
            </div>
            <Scrubber
              ariaLabel={`${menuPeer.username} voice volume`}
              min={0}
              max={200}
              step={5}
              value={Math.round(menuMeta.peerVolOv.volume * 100)}
              alwaysShowThumb
              formatTooltip={(v) => `${Math.round(v)}%`}
              onChange={(v) =>
                setVoicePeerVolume(
                  menuPeer.username,
                  v / 100,
                  menuMeta.peerVolOv.muted,
                )
              }
            />
          </div>
        </div>
      )}

      {menuMeta.canManageAdmin && (
        <button
          type="button"
          role="menuitem"
          disabled={Boolean(busyAdminUser)}
          onClick={() => {
            onTogglePeerAdmin(menuPeer.username, !menuMeta.isRowAdmin);
            onCloseMenu();
          }}
          className={`ep-menu-row ep-press w-full px-2 py-1.5 rounded-xl flex items-center gap-2 text-left text-[11.5px] font-medium cursor-pointer disabled:opacity-50 ${
            menuMeta.isRowAdmin
              ? "text-secondary hover:text-bad"
              : "text-accent-soft hover:text-white"
          }`}
        >
          <PartyAdminIcon size={14} revoke={menuMeta.isRowAdmin} className="shrink-0" />
          <span>
            {adminBusy
              ? "Updating…"
              : menuMeta.isRowAdmin
                ? "Remove Admin"
                : "Make Admin"}
          </span>
        </button>
      )}

      {menuMeta.canQuickFixFps && menuPeer.suggestedFpsScale && (
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            onCloseMenu();
            onFixFps(menuPeer.suggestedFpsScale!, menuPeer.suggestedFpsLabel);
          }}
          className="ep-menu-row ep-press w-full px-2 py-1.5 rounded-xl flex items-center gap-2 text-left text-[11.5px] font-medium text-white cursor-pointer"
        >
          <PartyFpsMatchIcon size={14} className="shrink-0" />
          <span>Fix FPS</span>
        </button>
      )}

      {menuMeta.canQuickAlign && (
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            onCloseMenu();
            onAlignScene();
          }}
          className="ep-menu-row ep-press w-full px-2 py-1.5 rounded-xl flex items-center gap-2 text-left text-[11.5px] font-medium text-warn cursor-pointer"
        >
          <PartyAlignSceneIcon size={14} className="shrink-0" />
          <span>Align Scene</span>
        </button>
      )}
    </div>,
    document.body,
  );
}

export function resolveHostPeerPosition(
  participants: Participant[],
  roomControl: RoomControlState,
): number | null {
  const hostPeer = roomControl.hostUsername
    ? participants.find(
        (hp) =>
          hp.username.trim().toLowerCase() === roomControl.hostUsername?.trim().toLowerCase(),
      )
    : undefined;
  return hostPeer && hostPeer.position > 0 ? hostPeer.position : null;
}
