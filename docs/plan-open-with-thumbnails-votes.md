# Implementation Plan: Open With, Seekbar Thumbnails, Room Votes

Target: Epilod Party v0.1.5 (Tauri 2, React 19, Rust). Verify each item against the code before starting.

## Verified starting points
- `src-tauri/src/lib.rs`: `extract_startup_deep_link()` reads `std::env::args()`. `try_forward_deep_link_to_running_instance()` and `spawn_deep_link_pipe_listener()` forward over the named pipe `\\.\pipe\EpilodParty_DeepLink_v1`, and the app emits `app://deep-link`. Single-instance behaviour already exists through this pipe.
- `src/lib/fileDrop.ts`: `VIDEO_EXTENSIONS`, `classifyDroppedFile` and `splitDroppedFiles` already classify files.
- `src/components/ui/Scrubber.tsx`: already tracks `hoverRatio` and `hoverX` and shows a tooltip with the time only. There is no image.
- ffmpeg and mpv are bundled under `src-tauri/resources/`. `autosync.rs` already runs ffmpeg.
- Controller state exists (`syncController.ts`, `isController`, `getControllerLockState`). There is no voting.
- `tauri.conf.json` has `bundle.targets = ["nsis"]` and no file association.

---

## Feature 1: Open With / file association

**Goal:** Right-click a video, choose "Open with Epilod Party" (or set it as default), and the app opens with that file loaded. If the app is already running, the file goes to the running instance.

### Steps
1. **Bundle config.** Add `bundle.fileAssociations` in `tauri.conf.json` for the extensions in `VIDEO_EXTENSIONS`: mkv, mp4, avi, webm, mov, m4v, ts, m2ts, wmv, flv. Set `role: "Viewer"` and a name such as "Video file". Check that the NSIS installer registers it. If it doesn't, add a custom NSIS hook that writes the `OpenWithProgids` keys under HKCU.
2. **Startup args.** Extend `extract_startup_deep_link()` and the arg parser in `lib.rs`. Besides `epilod://`, accept an argument that is an existing file path with a video extension, and produce a `PendingOpenFile(path)` value.
3. **Forward to the running instance.** Reuse the named pipe and add a message type (`{"kind":"open-file","path":...}`) next to the invite message. Check the current pipe protocol first so the existing invite flow doesn't break.
4. **Frontend.** Emit `app://open-file` and add `pending_open_file` with a `consume_pending_open_file` command, mirroring the deep-link code. Subscribe in `App.tsx` or `roomJoinHelper.ts`. Route the file to the same load function that drag-and-drop uses.
5. **State rules:**
   - Not in a room: load the file and show the home or watch screen as drag-and-drop does today.
   - In a room: ask "Replace the current file?" first. Follow the existing file-mismatch and announce logic (`syncFileAnnounce.ts`).
   - Invalid or missing file: show a toast. Don't crash.
6. **Edge cases:** paths with Arabic or Unicode characters, spaces, UNC paths, several files at once (take the first and queue the rest to the playlist if the playlist store allows it), and a file opened during a deep-link join (the invite takes priority).

### Acceptance
- A fresh install shows the app in "Open with" for mkv and mp4.
- Double-clicking a file with the app closed: the app opens and plays it.
- Double-clicking with the app open: the existing window is focused and the file loads. No second instance appears.
- Existing deep-link behaviour is unchanged.

### Tests
- Rust unit tests for the arg parser (path, uri, mixed, invalid).
- A manual Windows checklist in `docs/windows-release-checklist.md`.

---

## Feature 5: Thumbnail preview on the seekbar

**Goal:** Hovering over the seekbar shows the frame at that time, with the timestamp.

### Design
Generate a sprite sheet once per file, in the background, using the bundled ffmpeg. Don't extract a frame per hover.

### Steps
1. **Rust command `generate_thumbnails(path, duration)`** in a new `src-tauri/src/thumbnails.rs`:
   - Run ffmpeg with `-vf "fps=1/N,scale=160:-1,tile=10x10"` into a JPEG or WebP sprite. Pick N so there are at most about 100 to 200 frames: `N = max(5, duration/150)`.
   - Use low priority (`BELOW_NORMAL`) and hide the console window. Add a timeout and a kill switch.
   - Cache under `%LOCALAPPDATA%/Epilod/thumbs/<hash>.jpg`, keyed by path, size and mtime. Add an LRU or size cap (for example 200 MB) and cleanup at startup.
   - Return `{spritePath, cols, rows, frameW, frameH, interval}`. Emit a progress event.
2. **Serving the image.** The CSP is `img-src 'self' data:`, so use one of these:
   - read the file and return a `data:` URL (simple, but the payload is large), or
   - register an asset protocol scoped to the cache folder and extend the CSP. Prefer this one.
3. **Frontend.**
   - Add `src/lib/thumbnails.ts` and `useThumbnailStore` (or add to `usePlayerStore`). Trigger generation when a file loads, and cancel it when the file changes.
   - Add an optional prop `renderPreview?(value)` to `Scrubber.tsx`, using `hoverVal` and `hoverX`. In `TransportBar.tsx`, show the frame by CSS `background-position`, plus the time label, above the cursor. Clamp it to the edges as the tooltip already does.
   - Fall back to the current text tooltip when the sprite isn't ready or has failed.
4. **Settings.** Add a toggle "Seekbar previews" in `SettingsModal.tsx`, on by default, plus a "Clear thumbnail cache" button.
5. **Constraints:**
   - Skip it for network or very short files, and for files without a video stream.
   - Don't generate while the machine is under load, or while subtitle auto-sync is running (`autosync.rs`), to avoid fighting over ffmpeg.
   - Work in mini mode and fullscreen. Keep the HWND overlay in mind, because mpv is a child window and the preview is HTML. Check z-order the same way the existing tooltips do.

### Acceptance
- The sprite is ready within about 10 to 30 seconds for a 1-hour 1080p file. Playback has no stutter while it's generated.
- Hover shows the correct frame within about 1 second of the real time.
- A second open of the same file uses the cache instantly.
- If ffmpeg is missing or fails, nothing breaks and the tooltip falls back to text.

### Tests
- Rust: interval and grid maths, cache key, and cleanup.
- Manual: mkv, mp4, a very short file, an audio-only file, and a file path with Arabic characters.

---

## Feature 6 (revised): Episode/movie rating vote at the outro

**Goal:** When playback reaches the outro (or the end if no outro was detected), every member sees a nice rating card and gives a score from 1 to 10. Everyone sees the live results: average, number of votes, and which score the majority picked. This replaces the earlier action-vote idea.

### Verified starting points
- Outro detection already exists: `useIntroStore` has `outro`, `dismissedOutroKeys` and `autoAdvancedOutroKeys`. `introActions.ts` has `resolveActiveOutroPrompt`. `NextEpisodeOverlay.tsx` already shows the outro prompt. The rating card should reuse this trigger and must not clash with auto-next.
- Reactions already travel between members. `p2p.rs` has an `EPR` reaction codec with round-trip tests, `reactions.ts` and `useReactionStore.ts` on the frontend. Use the same channel for ratings, so there is no new transport.
- Playback end handling is in `playbackEnd.ts`. Series and file identity live in `seriesProgress.ts` and `useIntroStore.normalizeIntroVideoKey`.

### Decisions to confirm with the user
1. Scale: 1 to 10 (stars, numbers or emoji faces).
2. Voting is anonymous, or the card shows who voted what. Suggested: show the live count and the distribution anonymously during voting, then names after the result is revealed. Make it a room setting.
3. Trigger point: the outro start, or the end of the file. If an outro exists, show the card there, and keep it small so it doesn't hide the credits.
4. Auto-next: when the room has auto-next on, wait for the rating window (about 15 to 20 seconds, or until everyone voted) before advancing, but never block longer than that.
5. History: store ratings locally per episode so the user can see "your rating" and the room's rating later (optional, phase 2).

### Steps
1. **Protocol.** Add one small message over the existing P2P/reaction channel: `rate{key, score(1-10), v}`. `key` is a hash of the file identity (use the same privacy-hashed identity as file matching, so members with the same episode share a key). Add an encoder and decoder with round-trip tests next to the `EPR` tests. Ignore unknown versions. Rate-limit with the existing limiter, and accept one rating per member per key (the last one wins, so people can change their vote).
2. **Frontend state.** Add `src/store/useRatingStore.ts` with `{ key, myScore, votes: Record<peerId, score>, phase: idle|open|revealed, closesAt }`, and pure helpers in `src/lib/ratings.ts`: `average`, `distribution` (counts for 1..10), `majority` (the mode, ties broken to the higher score), and `isComplete(votes, members)`. Keep them pure so they can be unit tested.
3. **Trigger.** In a new `RatingOverlay.tsx`, open the card when playback enters the outro window or ends, using the same conditions as `resolveActiveOutroPrompt`. Open once per file key. Don't open for very short files or when the user turned ratings off.
4. **UI.**
   - A glass card matching `NextEpisodeOverlay` and `SkipIntroOverlay`. A row of 10 tappable steps with keyboard support (keys 1 to 0 and Enter).
   - Live area: a small bar chart of the distribution, the average (for example 8.4), the number of votes ("3 of 4 voted") and a highlight of the majority score ("Most picked: 9").
   - Works with Arabic and RTL, and with mini mode (collapse to a compact row).
   - Dismiss button, and a setting "Ask me to rate" (Settings and a room toggle for the host).
6. **Closing the vote.** The card closes when everyone has voted, or after the timeout, or when the user dismisses it. Then show the result for a few seconds. If the user left it, they can still open it from the room panel.
7. **Auto-next interaction.** In `NextEpisodeOverlay` and `autoNext.ts`, delay the auto-advance while a rating is open and not complete, with a hard cap. A manual "Next" always wins.
8. **Edge cases:** a member joins or leaves mid-vote (recompute completeness), a member has a different file (they vote on their own key, so don't merge), a room with one person (still show a personal rating, no results chart), seeking back out of the outro (close the card), and reconnects (ask peers for the current votes through the existing sync state, or just accept new ones).

### Acceptance
- At the outro, all members see the card, vote, and see live results with the average and the majority.
- Changing a vote updates everyone. A duplicate message doesn't double count.
- Auto-next waits for the vote but never longer than the cap.
- With the setting off, behaviour is exactly as before. Old clients ignore the message without errors.

### Tests
- Vitest: `ratings.ts` (average, distribution, majority ties, completeness, duplicates).
- Rust: codec round trip, bad version, and out-of-range scores (reject 0 and above 10).
- Manual: 3 clients, one late joiner, one disconnect, and one on a different file.

---
## Suggested order and effort
1. Feature 1 (small, 0.5 to 1 day, low risk). It reuses the existing pipe.
2. Feature 5 (medium, 1 to 2 days). Only the CSP/asset protocol and the Scrubber hook are risky.
3. Feature 6 (largest, 2 to 4 days). It touches the protocol, so do it last and make it opt-in.

## Before release
- `cargo fmt`, `cargo clippy --all-targets -- -D warnings`, `cargo test -p epilod-core -p epilod-party`, `npx tsc --noEmit`, `npm run build`.
- Run the Windows checklist in `docs/windows-release-checklist.md` and add items for these three features.

