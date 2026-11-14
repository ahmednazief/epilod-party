export type StatusTone = "ok" | "warn" | "bad" | "muted" | "accent";

interface StatusDotProps {
  tone: StatusTone;
  pulse?: boolean;
  label?: string;
}

const TONE_COLORS: Record<StatusTone, string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  bad: "bg-bad",
  muted: "bg-muted",
  accent: "bg-accent",
};

export function StatusDot({ tone, pulse = false, label }: StatusDotProps) {
  return (
    <span
      className="relative inline-flex h-2 w-2 shrink-0 items-center justify-center"
      role={label ? "status" : undefined}
      aria-label={label}
    >
      {pulse && (
        <span
          className={`absolute inline-flex h-full w-full rounded-full opacity-75 animate-ping ${TONE_COLORS[tone]}`}
        />
      )}
      <span className={`relative inline-flex h-2 w-2 rounded-full ${TONE_COLORS[tone]}`} />
    </span>
  );
}
