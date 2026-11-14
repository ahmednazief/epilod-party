import type { ReactNode } from "react";

interface ModuleTileProps {
  label: string;
  icon: ReactNode;
  accent?: "rose" | "purple" | "neutral";
  status: "idle" | "active" | "done";
  positionClass: string;
}

export function ModuleTile({
  label,
  icon,
  accent = "purple",
  status,
  positionClass,
}: ModuleTileProps) {
  const iconColor =
    status === "done"
      ? "text-[#4ADE80]"
      : accent === "rose"
        ? "text-[#F47292]"
        : accent === "purple"
          ? "text-[#A78BFA]"
          : "text-[#D4D4DF]";

  const tileSurface =
    status === "active"
      ? "bg-[#1C1A29] scale-[1.04] anim-tile-active"
      : status === "done"
        ? "bg-[#171B1E]"
        : "bg-[#17171E]";

  return (
    <div
      className={`absolute z-10 flex flex-col items-center gap-2 ${positionClass}`}
    >
      <div
        className={`relative flex h-[76px] w-[76px] items-center justify-center rounded-[20px] transition-[background-color,transform] duration-300 ease-out shadow-[inset_0_1px_0_rgba(255,255,255,0.05),0_10px_24px_rgba(0,0,0,0.35)] ${tileSurface} ${iconColor}`}
      >
        {icon}
        <span
          aria-hidden="true"
          className={`absolute bottom-2.5 h-1 w-1 rounded-full transition-opacity duration-300 ${
            status === "active"
              ? "bg-[#A78BFA] opacity-100"
              : status === "done"
                ? "bg-[#22C55E] opacity-85"
                : "opacity-0"
          }`}
        />
      </div>
      <span
        className={`text-[11px] tracking-[0.01em] transition-colors duration-200 ${
          status === "active"
            ? "text-[#C4B5FD]"
            : status === "done"
              ? "text-[#9CA3AF]"
              : "text-[#6B6B7E]"
        }`}
      >
        {label}
      </span>
    </div>
  );
}
