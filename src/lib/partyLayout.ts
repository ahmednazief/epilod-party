export const MIN_PARTY_SIDEBAR_WIDTH = 256;
export const MAX_PARTY_SIDEBAR_WIDTH = 360;
export const DEFAULT_PARTY_SIDEBAR_WIDTH = 264;

export const MIN_STAGE_VIDEO_WIDTH = 480;
export const SINGLE_DOCK_MIN_WINDOW_WIDTH = 860;
export const DUAL_DOCK_MIN_WINDOW_WIDTH = 1080;

export function clampPartySidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_PARTY_SIDEBAR_WIDTH;
  return Math.max(MIN_PARTY_SIDEBAR_WIDTH, Math.min(MAX_PARTY_SIDEBAR_WIDTH, Math.round(width)));
}

export interface DualSidebarLayoutInput {
  windowWidth: number;
  partyOpen: boolean;
  partyPreferredWidth: number;
  chatOpen: boolean;
  chatPreferredWidth: number;
  minChatWidth?: number;
}

export interface DualSidebarLayoutResult {
  partyDocked: boolean;
  chatDocked: boolean;
  effectivePartyWidth: number;
  effectiveChatWidth: number;
}

/**
 * Resolves docked vs. overlay mode and non-destructive clamped widths for
 * Left Party Lounge and Right Party Chat so the center video stage always keeps >= 480px.
 */
export function resolveDualSidebarLayout({
  windowWidth,
  partyOpen,
  partyPreferredWidth,
  chatOpen,
  chatPreferredWidth,
  minChatWidth = 320,
}: DualSidebarLayoutInput): DualSidebarLayoutResult {
  const safeWinW = Number.isFinite(windowWidth) && windowWidth > 0 ? windowWidth : 1280;
  const partyW = clampPartySidebarWidth(partyPreferredWidth);
  const chatW = Math.max(minChatWidth, Math.round(chatPreferredWidth || 440));

  const partyDocked = partyOpen && safeWinW >= SINGLE_DOCK_MIN_WINDOW_WIDTH;
  const chatDocked =
    chatOpen && safeWinW >= (partyOpen ? DUAL_DOCK_MIN_WINDOW_WIDTH : SINGLE_DOCK_MIN_WINDOW_WIDTH);

  if (!partyDocked || !chatDocked) {
    return {
      partyDocked,
      chatDocked,
      effectivePartyWidth: partyW,
      effectiveChatWidth: chatW,
    };
  }

  const maxCombined = Math.max(MIN_PARTY_SIDEBAR_WIDTH + minChatWidth, safeWinW - MIN_STAGE_VIDEO_WIDTH);
  if (partyW + chatW <= maxCombined) {
    return {
      partyDocked,
      chatDocked,
      effectivePartyWidth: partyW,
      effectiveChatWidth: chatW,
    };
  }

  const total = partyW + chatW;
  const ratio = maxCombined / total;
  let nextParty = Math.max(MIN_PARTY_SIDEBAR_WIDTH, Math.floor(partyW * ratio));
  let nextChat = Math.max(minChatWidth, maxCombined - nextParty);
  if (nextParty + nextChat > maxCombined) {
    nextParty = Math.max(MIN_PARTY_SIDEBAR_WIDTH, maxCombined - nextChat);
  }

  return {
    partyDocked,
    chatDocked,
    effectivePartyWidth: nextParty,
    effectiveChatWidth: nextChat,
  };
}

export interface HorizontalRectBounds {
  left: number;
  right: number;
  width: number;
}

export function computeMpvMarginRatios(
  stageRect: HorizontalRectBounds,
  viewportRect: Pick<HorizontalRectBounds, "left" | "right">,
): { leftRatio: number; rightRatio: number } {
  if (!Number.isFinite(stageRect.width) || stageRect.width <= 1) {
    return { leftRatio: 0, rightRatio: 0 };
  }
  const rawLeft = (viewportRect.left - stageRect.left) / stageRect.width;
  const rawRight = (stageRect.right - viewportRect.right) / stageRect.width;
  const clampRatio = (r: number) =>
    Math.round(Math.max(0, Math.min(0.7, Number.isFinite(r) ? r : 0)) * 10_000) / 10_000;
  return {
    leftRatio: clampRatio(rawLeft),
    rightRatio: clampRatio(rawRight),
  };
}
