interface ToggleOptionProps {
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}

export function ToggleOption({
  label,
  description,
  checked,
  disabled = false,
  onChange,
}: ToggleOptionProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="flex w-full items-center justify-between gap-3 py-1 text-left transition-opacity duration-150 disabled:opacity-45 cursor-pointer disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-[#8B5CF6] rounded-lg"
    >
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-[#EDEDF2]">{label}</div>
        <div className="mt-0.5 text-[11px] text-[#7C7C90]">{description}</div>
      </div>

      <span
        aria-hidden="true"
        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-200 ease-out ${
          checked ? "bg-[#7C3AED]" : "bg-[#282834]"
        }`}
      >
        <span
          className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform duration-200 ease-out ${
            checked ? "translate-x-[18px]" : "translate-x-[3px]"
          }`}
        />
      </span>
    </button>
  );
}
