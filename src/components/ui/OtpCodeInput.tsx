import { useEffect, useId, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";

interface OtpCodeInputProps {
  value: string;
  onChange: (digits: string) => void;
  onComplete: (sixDigitCode: string) => void;
  verifying?: boolean;
  compact?: boolean;
  disabled?: boolean;
  autoFocusFirst?: boolean;
}

function toSixSlots(raw: string): string[] {
  const clean = raw.replace(/\D/g, "").slice(0, 6);
  return Array.from({ length: 6 }, (_, i) => clean[i] ?? "");
}

export function OtpCodeInput({
  value,
  onChange,
  onComplete,
  verifying = false,
  compact = false,
  disabled = false,
  autoFocusFirst = false,
}: OtpCodeInputProps) {
  const otpId = useId();
  const [slots, setSlots] = useState<string[]>(() => toSixSlots(value));
  const inputRefs = useRef<Array<HTMLInputElement | null>>([]);
  const lastCompletedRef = useRef<string>("");

  // Sync external updates (e.g. "Paste Code" button or reset) without collapsing intentional gaps while typing.
  useEffect(() => {
    const joined = slots.join("");
    const normalizedExternal = value.replace(/\D/g, "").slice(0, 6);
    if (normalizedExternal !== joined) {
      setSlots(toSixSlots(normalizedExternal));
      if (normalizedExternal.length < 6) {
        lastCompletedRef.current = "";
      }
    }
  }, [value, slots]);

  useEffect(() => {
    if (autoFocusFirst && !disabled) {
      inputRefs.current[0]?.focus();
    }
  }, [autoFocusFirst, disabled]);

  const focusSlot = (index: number) => {
    const clamped = Math.max(0, Math.min(5, index));
    inputRefs.current[clamped]?.focus();
    inputRefs.current[clamped]?.select();
  };

  const commitSlots = (nextSlots: string[], nextFocusIndex: number | null) => {
    setSlots(nextSlots);
    const joined = nextSlots.join("");
    onChange(joined);

    if (nextFocusIndex !== null) {
      focusSlot(nextFocusIndex);
    }

    if (nextSlots.every((d) => d.length === 1)) {
      if (lastCompletedRef.current !== joined) {
        lastCompletedRef.current = joined;
        onComplete(joined);
      }
    } else {
      lastCompletedRef.current = "";
    }
  };

  const applyPastedDigits = (startIndex: number, rawText: string) => {
    const digits = rawText.replace(/\D/g, "").slice(0, 6);
    if (!digits) return;

    // Pasting a full 6-digit code into any box populates all 6 slots from box 0.
    const origin = digits.length === 6 ? 0 : startIndex;
    const nextSlots = [...slots];
    let lastFilled = origin;

    for (let offset = 0; offset < digits.length && origin + offset < 6; offset++) {
      nextSlots[origin + offset] = digits[offset];
      lastFilled = origin + offset;
    }

    const nextEmpty = nextSlots.findIndex((d) => d === "");
    const nextFocus = nextEmpty === -1 ? Math.min(lastFilled, 5) : nextEmpty;
    commitSlots(nextSlots, nextFocus);
  };

  const handleSlotChange = (index: number, rawInput: string) => {
    if (disabled || verifying) return;
    const digits = rawInput.replace(/\D/g, "");

    if (digits.length === 0) {
      const nextSlots = [...slots];
      nextSlots[index] = "";
      commitSlots(nextSlots, null);
      return;
    }

    if (digits.length === 1) {
      const nextSlots = [...slots];
      nextSlots[index] = digits;
      const isComplete = nextSlots.every((d) => d.length === 1);
      commitSlots(nextSlots, isComplete ? index : index < 5 ? index + 1 : 5);
      return;
    }

    // Typing over an occupied box where the browser appends/prepends rather than replacing
    if (digits.length === 2 && slots[index]) {
      const typed = digits[0] === slots[index] ? digits[1] : digits[0];
      const nextSlots = [...slots];
      nextSlots[index] = typed;
      const isComplete = nextSlots.every((d) => d.length === 1);
      commitSlots(nextSlots, isComplete ? index : index < 5 ? index + 1 : 5);
      return;
    }

    // Multi-digit autofill / paste delivered via input event
    applyPastedDigits(index, digits);
  };

  const handleKeyDown = (index: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (disabled || verifying) return;

    if (e.key === "Backspace") {
      e.preventDefault();
      const nextSlots = [...slots];
      if (nextSlots[index]) {
        nextSlots[index] = "";
        commitSlots(nextSlots, index);
      } else if (index > 0) {
        nextSlots[index - 1] = "";
        commitSlots(nextSlots, index - 1);
      }
      return;
    }

    if (e.key === "Delete") {
      e.preventDefault();
      if (slots[index]) {
        const nextSlots = [...slots];
        nextSlots[index] = "";
        commitSlots(nextSlots, index);
      }
      return;
    }

    if (e.key === "ArrowLeft") {
      e.preventDefault();
      focusSlot(index - 1);
      return;
    }

    if (e.key === "ArrowRight") {
      e.preventDefault();
      focusSlot(index + 1);
      return;
    }

    if (e.key === "Home") {
      e.preventDefault();
      focusSlot(0);
      return;
    }

    if (e.key === "End") {
      e.preventDefault();
      focusSlot(5);
    }
  };

  const handlePaste = (index: number, e: ClipboardEvent<HTMLInputElement>) => {
    if (disabled || verifying) return;
    e.preventDefault();
    const pasted = e.clipboardData.getData("text");
    applyPastedDigits(index, pasted);
  };

  const renderSlot = (digit: string, index: number) => {
    const isFilled = digit.length === 1;
    const firstEmptyIndex = slots.findIndex((d) => d.length === 0);
    const isNextEmpty = index === firstEmptyIndex && !disabled;
    return (
      <input
        key={index}
        id={`${otpId}-digit-${index + 1}`}
        name={`otp-digit-${index + 1}`}
        ref={(el) => {
          inputRefs.current[index] = el;
        }}
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]*"
        disabled={disabled}
        value={digit}
        aria-label={`Digit ${index + 1} of 6`}
        placeholder="•"
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => handleSlotChange(index, e.target.value)}
        onKeyDown={(e) => handleKeyDown(index, e)}
        onPaste={(e) => handlePaste(index, e)}
        className={[
          "ep-otp-box num text-center font-semibold text-white placeholder:text-white/20 focus:outline-none w-full min-w-0",
          compact
            ? "h-10 rounded-xl text-sm"
            : "h-12 sm:h-13 rounded-2xl text-lg",
          verifying && isFilled
            ? "ep-otp-box-verifying"
            : isFilled
              ? "ep-otp-box-filled"
              : isNextEmpty
                ? "ring-1 ring-accent-soft/40"
                : "",
        ].join(" ")}
      />
    );
  };

  return (
    <div
      className={`flex items-center ${compact ? "gap-2.5" : "gap-3.5"}`}
      role="group"
      aria-label="6-digit Watch Party room code"
    >
      <div className={`flex-1 grid grid-cols-3 ${compact ? "gap-1.5" : "gap-2"}`}>
        {slots.slice(0, 3).map((digit, i) => renderSlot(digit, i))}
      </div>
      <div className={`flex-1 grid grid-cols-3 ${compact ? "gap-1.5" : "gap-2"}`}>
        {slots.slice(3, 6).map((digit, i) => renderSlot(digit, i + 3))}
      </div>
    </div>
  );
}
