import { ArrowRight, Download, KeyRound, Plus, Settings } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { sanitizeRoomCodeInput, sanitizeUsername } from "../lib/webviewHardening";
import { useAppStore } from "../store/useAppStore";
import { useUpdaterStore } from "../store/useUpdaterStore";
import { Button } from "./ui/Button";
import { LogoMark } from "./ui/LogoMark";
import { TextField } from "./ui/TextField";

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateRoomCode(): string {
  const randomBytes = new Uint8Array(12);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(randomBytes);
  } else {
    for (let i = 0; i < 12; i++) {
      randomBytes[i] = Math.floor(Math.random() * 256);
    }
  }
  const seg = (start: number) =>
    Array.from(randomBytes.slice(start, start + 4))
      .map((b) => CODE_CHARS[b % CODE_CHARS.length])
      .join("");
  return `${seg(0)}-${seg(4)}-${seg(8)}`;
}

export function HomeScreen() {
  const username = useAppStore((s) => s.username);
  const serverEndpoint = useAppStore((s) => s.serverEndpoint);
  const serverPassword = useAppStore((s) => s.serverPassword);
  const literalRoomStored = useAppStore((s) => s.literalRoom);
  const autoCheckUpdates = useAppStore((s) => s.autoCheckUpdates);
  const setUsername = useAppStore((s) => s.setUsername);
  const setServerPassword = useAppStore((s) => s.setServerPassword);
  const enterRoom = useAppStore((s) => s.enterRoom);
  const openSettings = useAppStore((s) => s.openSettings);

  const updateStatus = useUpdaterStore((s) => s.status);
  const hasCheckedStartup = useUpdaterStore((s) => s.hasCheckedStartup);
  const initUpdater = useUpdaterStore((s) => s.init);
  const checkForUpdates = useUpdaterStore((s) => s.checkForUpdates);

  const [joinInput, setJoinInput] = useState("");
  const [standardRoomName, setStandardRoomName] = useState(literalRoomStored);
  const [showPassword, setShowPassword] = useState(Boolean(serverPassword));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      await initUpdater();
      if (active && autoCheckUpdates && !hasCheckedStartup) {
        await checkForUpdates(true);
      }
    })();
    return () => {
      active = false;
    };
  }, [autoCheckUpdates, hasCheckedStartup, initUpdater, checkForUpdates]);

  const ensureValidName = (): boolean => {
    const clean = sanitizeUsername(username);
    if (!clean) {
      setError("Please enter a display name first.");
      return false;
    }
    setError(null);
    return true;
  };

  const handleCreateRoom = () => {
    if (!ensureValidName()) return;
    const code = generateRoomCode();
    enterRoom(code, false);
  };

  const handleJoinRoom = (e: FormEvent) => {
    e.preventDefault();
    if (!ensureValidName()) return;
    const cleaned = sanitizeRoomCodeInput(joinInput, standardRoomName);
    if (cleaned.length < (standardRoomName ? 1 : 4)) {
      setError(
        standardRoomName
          ? "Enter the exact Syncplay room name to join."
          : "Enter a room code (e.g. ABCD-EFGH-JKLM).",
      );
      return;
    }
    enterRoom(cleaned, standardRoomName);
  };

  const hasPendingUpdate =
    updateStatus?.availability === "updateAvailable" ||
    updateStatus?.availability === "downloadedReady";

  return (
    <div className="min-h-full w-full flex flex-col bg-canvas text-primary">
      <header className="flex items-center justify-between px-6 py-4 border-b border-hairline">
        <div className="flex items-center gap-2.5">
          <LogoMark size={32} />
          <div>
            <h1 className="text-sm font-semibold tracking-tight text-primary">Epilod Party</h1>
            <p className="text-[11px] text-muted">{serverEndpoint}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {hasPendingUpdate && updateStatus?.availableRelease && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => openSettings("updates")}
            >
              <Download className="h-3.5 w-3.5 text-accent-soft" />
              {updateStatus.availability === "downloadedReady"
                ? `Restart to v${updateStatus.availableRelease.version}`
                : `Update v${updateStatus.availableRelease.version}`}
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => openSettings()}>
            <Settings className="h-4 w-4" />
            Settings
          </Button>
        </div>
      </header>

      <main className="flex-1 flex items-center justify-center p-6">
        <div className="anim-fade-slide-up w-full max-w-md bg-chrome border border-hairline rounded-[var(--radius-ui)] p-6 space-y-6">
          <div className="flex items-start gap-3.5">
            <LogoMark variant="party" size={40} className="mt-0.5" />
            <div className="space-y-1 min-w-0">
              <h2 className="text-lg font-medium tracking-tight text-primary">Watch together locally</h2>
              <p className="text-xs text-secondary leading-relaxed">
                Synchronize playback cleanly across local copies of your video with optional Arabic &amp; multi-language auto-synced subtitles.
              </p>
            </div>
          </div>

          <TextField
            label="Your Display Name"
            value={username}
            maxLength={32}
            placeholder="Viewer"
            onChange={(e) => setUsername(e.target.value)}
          />

          <div className="pt-1">
            <Button
              variant="primary"
              size="lg"
              className="w-full"
              onClick={handleCreateRoom}
            >
              <Plus className="h-4 w-4" />
              Create Private Room
            </Button>
          </div>

          <div className="relative flex items-center py-1">
            <div className="flex-grow border-t border-hairline" />
            <span className="mx-3 text-[11px] uppercase tracking-wider text-muted">
              or join existing
            </span>
            <div className="flex-grow border-t border-hairline" />
          </div>

          <form onSubmit={handleJoinRoom} className="space-y-3">
            <TextField
              label={standardRoomName ? "Syncplay Room Name (Literal)" : "Room Code"}
              value={joinInput}
              placeholder={standardRoomName ? "Exact room name from Syncplay" : "ABCD-EFGH-JKLM"}
              onChange={(e) => {
                setJoinInput(sanitizeRoomCodeInput(e.target.value, standardRoomName));
                if (error) setError(null);
              }}
              error={error}
            />

            <div className="flex items-center justify-between gap-2 text-xs">
              <label className="inline-flex items-center gap-2 text-secondary cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={standardRoomName}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setStandardRoomName(checked);
                    setJoinInput((prev) => sanitizeRoomCodeInput(prev, checked));
                  }}
                  className="accent-[var(--color-accent)] h-3.5 w-3.5"
                />
                Standard Syncplay room name
              </label>

              <button
                type="button"
                onClick={() => setShowPassword((p) => !p)}
                className="inline-flex items-center gap-1 text-muted hover:text-secondary cursor-pointer"
              >
                <KeyRound className="h-3 w-3" />
                {showPassword ? "Hide password" : "Room password"}
              </button>
            </div>

            {showPassword && (
              <TextField
                label="Room / Server Password (RAM-only this session)"
                type="password"
                value={serverPassword}
                maxLength={128}
                placeholder="Optional password"
                onChange={(e) => setServerPassword(e.target.value)}
              />
            )}

            <Button type="submit" variant="secondary" size="lg" className="w-full">
              Join Room
              <ArrowRight className="h-4 w-4" />
            </Button>
          </form>
        </div>
      </main>
    </div>
  );
}
