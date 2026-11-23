import { formatUserError } from "./errors";
import {
  mpvRemoveSubtitle,
  mpvSetSubDelay,
  mpvSetSubStyle,
  safeMpvCall,
} from "./mpv";
import { buildMediaFileKey } from "./resume";
import { savePerFileSubtitlePref } from "./subtitlePrefs";
import { applySharedSubtitle } from "./syncplay";
import { useAppStore } from "../store/useAppStore";
import { useNotificationStore } from "../store/useNotificationStore";
import { usePlayerStore } from "../store/usePlayerStore";
import { buildSubStyleParams, useSubtitleStore } from "../store/useSubtitleStore";

/**
 * Applies a room-shared subtitle stored in RAM by persisting it to the auto-pruned
 * shared subtitle cache and loading it into mpv.
 */
export async function applySharedRoomSubtitle(id: string): Promise<boolean> {
  const pushNote = useNotificationStore.getState().push;
  const playerNow = usePlayerStore.getState();
  if (!playerNow.loaded) {
    pushNote("info", "Open a video before applying a shared subtitle.");
    return false;
  }

  const subStore = useSubtitleStore.getState();
  const item = subStore.sharedSubtitles.find((s) => s.id === id);
  if (!item) {
    return false;
  }

  const fixRtl =
    typeof localStorage !== "undefined"
      ? localStorage.getItem("ep.fixArabicPunctuation") !== "false"
      : true;

  try {
    const activeSub = playerNow.tracks.find((t) => t.type === "sub" && t.selected);
    const savedPath = await applySharedSubtitle({
      id: item.id,
      fileName: item.fileName,
      ext: item.ext,
      content: item.content,
      fixRtl,
    });
    if (activeSub?.external) {
      await mpvRemoveSubtitle(activeSub.id).catch(() => undefined);
    }
    await mpvSetSubDelay(0);
    subStore.setDelaySecs(0);
    subStore.setLoadedTrack(savedPath, savedPath);
    subStore.markSharedSubtitleApplied(id);
    safeMpvCall(
      mpvSetSubStyle(buildSubStyleParams(useSubtitleStore.getState(), { visible: true })),
      "applySharedRoomSubtitle:mpvSetSubStyle",
    );

    const appNow = useAppStore.getState();
    const durNow = usePlayerStore.getState().durationSecs;
    savePerFileSubtitlePref(buildMediaFileKey(appNow.selectedFileName, durNow), {
      delaySecs: 0,
      subtitleFile: item.fileName,
      trackLang: item.lang ?? null,
    });

    pushNote("success", `Applied shared subtitle: ${item.fileName}`);
    return true;
  } catch (err) {
    pushNote("error", formatUserError(err, "Failed applying shared subtitle."));
    return false;
  }
}
