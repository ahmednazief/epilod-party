import { ChevronRight, Download, Lock, Plus, Settings } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { sanitizeRoomCodeInput, sanitizeUsername } from "../lib/webviewHardening";
import { useAppStore } from "../store/useAppStore";
import { useUpdaterStore } from "../store/useUpdaterStore";
import { TitleBar } from "./TitleBar";
import { Button } from "./ui/Button";
import { LogoMark } from "./ui/LogoMark";
import { TextField } from "./ui/TextField";

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const STEPS = [
  "1. Pick your local movie or episode",
  "2. Share a private room code",
  "3. Watch in sync with smart subtitles",
] as const;

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
  const [showAdvancedOptions, setShowAdvancedOptions] = useState(false);
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
      setError("Please enter your name first.");
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
          ? "Enter the room name to join."
          : "Enter a room code like ABCD-EFGH-JKLM.",
      );
      return;
    }
    enterRoom(cleaned, standardRoomName);
  };

  const hasPendingUpdate =
    updateStatus?.availability === "updateAvailable" ||
    updateStatus?.availability === "downloadedReady";

  return (
    <div className="h-full w-full flex flex-col bg-canvas text-primary overflow-hidden">
      <TitleBar
        leftSlot={
          <>
            <LogoMark size={22} />
            <span className="text-[13px] font-medium tracking-tight text-primary">
              Epilod Party
            </span>
          </>
        }
        rightActions={
          <>
            {hasPendingUpdate && updateStatus?.availableRelease ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => openSettings("updates")}
              >
                <Download className="h-3.5 w-3.5 text-accent-soft" />
                <span>
                  {updateStatus.availability === "downloadedReady"
                    ? `Restart to v${updateStatus.availableRelease.version}`
                    : `Update v${updateStatus.availableRelease.version}`}
                </span>
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => openSettings("updates")}
              >
                <span className="h-1.5 w-1.5 rounded-full bg-accent-soft" aria-hidden="true" />
                <span>Check for updates</span>
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => openSettings("prefs")}
              aria-label="Open settings"
              title="Settings"
            >
              <Settings className="h-4 w-4" />
            </Button>
          </>
        }
      />

      <main className="flex-1 flex items-center justify-center px-8 py-8 overflow-y-auto">
        <div className="anim-fade-slide-up w-full max-w-[960px] grid grid-cols-1 lg:grid-cols-[1.15fr_0.85fr] gap-10 lg:gap-14 items-center">
          <section className="space-y-6">
            <LogoMark variant="party" size={76} className="rounded-2xl" />

            <div className="space-y-3">
              <h1 className="text-3xl sm:text-4xl lg:text-[42px] font-semibold tracking-[-0.025em] leading-[1.08] text-primary">
                Watch together,
                <br />
                frame for frame.
              </h1>
              <p className="text-[15px] text-secondary leading-relaxed max-w-md">
                Open a video from your computer and sync playback effortlessly with friends.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-5 pt-3">
              {STEPS.map((step) => (
                <div key={step} className="flex flex-col justify-between gap-3">
                  <p className="text-xs text-secondary leading-snug">{step}</p>
                  <div className="relative flex items-center justify-center">
                    <div className="w-full border-t border-hairline" />
                    <span
                      aria-hidden="true"
                      className="absolute h-2 w-2 rounded-full bg-accent ring-4 ring-canvas"
                    />
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="w-full bg-chrome border border-hairline rounded-xl p-6 sm:p-7 space-y-5">
            <TextField
              label="Your Name"
              value={username}
              maxLength={32}
              placeholder="Viewer"
              className="h-10"
              onChange={(e) => {
                setUsername(e.target.value);
                if (error) setError(null);
              }}
            />

            <Button
              variant="primary"
              size="lg"
              className="w-full h-11 text-[14px] font-medium"
              onClick={handleCreateRoom}
            >
              <Plus className="h-4 w-4" />
              Start a Watch Party
            </Button>

            <div className="relative flex items-center py-0.5">
              <div className="flex-grow border-t border-hairline" />
              <span className="mx-3 text-xs text-muted">or join a friend</span>
              <div className="flex-grow border-t border-hairline" />
            </div>

            <form onSubmit={handleJoinRoom} className="space-y-3">
              <div className="flex items-center gap-2.5">
                <div className="flex-1 min-w-0">
                  <TextField
                    aria-label={standardRoomName ? "Room name" : "Room code"}
                    value={joinInput}
                    placeholder={standardRoomName ? "Exact room name" : "ABCD-EFGH-JKLM"}
                    className="h-10 font-mono tracking-wide"
                    onChange={(e) => {
                      setJoinInput(sanitizeRoomCodeInput(e.target.value, standardRoomName));
                      if (error) setError(null);
                    }}
                    rightSlot={
                      <button
                        type="button"
                        onClick={() => setShowPassword((p) => !p)}
                        aria-label={showPassword ? "Hide room password" : "Add room password"}
                        title={showPassword ? "Hide room password" : "Room password"}
                        className={`p-1 rounded transition-colors cursor-pointer ${
                          showPassword || serverPassword
                            ? "text-accent-soft bg-hover"
                            : "text-muted hover:text-secondary"
                        }`}
                      >
                        <Lock className="h-3.5 w-3.5" />
                      </button>
                    }
                  />
                </div>
                <Button type="submit" variant="secondary" className="h-10 px-5 shrink-0 font-medium">
                  Join
                </Button>
              </div>

              {error && <p className="text-xs text-bad">{error}</p>}

              {showPassword && (
                <TextField
                  label="Room Password (Optional)"
                  type="password"
                  value={serverPassword}
                  maxLength={128}
                  placeholder="Enter password if this room is locked"
                  className="h-9"
                  onChange={(e) => setServerPassword(e.target.value)}
                />
              )}
            </form>

            <div className="pt-1 text-center">
              <button
                type="button"
                onClick={() => setShowAdvancedOptions((v) => !v)}
                className="inline-flex items-center gap-1 text-xs text-muted hover:text-secondary transition-colors cursor-pointer"
              >
                <span>Server &amp; room options</span>
                <ChevronRight
                  className={`h-3.5 w-3.5 transition-transform duration-150 ${
                    showAdvancedOptions ? "rotate-90" : ""
                  }`}
                />
              </button>

              {showAdvancedOptions && (
                <div className="mt-3 p-3 bg-canvas border border-hairline rounded-[var(--radius-ui)] text-left space-y-2.5">
                  <label className="flex items-center justify-between gap-2 text-xs text-secondary cursor-pointer select-none">
                    <span>Joining a public Syncplay room by exact name</span>
                    <input
                      type="checkbox"
                      checked={standardRoomName}
                      onChange={(e) => {
                        const checked = e.target.checked;
                        setStandardRoomName(checked);
                        setJoinInput((prev) => sanitizeRoomCodeInput(prev, checked));
                      }}
                      className="accent-[var(--color-accent)] h-3.5 w-3.5 shrink-0"
                    />
                  </label>
                  <div className="flex items-center justify-between gap-2 text-[11px] text-muted pt-1 border-t border-hairline">
                    <span className="truncate">Server: {serverEndpoint}</span>
                    <button
                      type="button"
                      onClick={() => openSettings("server")}
                      className="text-accent-soft hover:underline shrink-0 cursor-pointer"
                    >
                      Change
                    </button>
                  </div>
                </div>
              )}
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
