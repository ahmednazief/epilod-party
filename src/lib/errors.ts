import { RuntimeUnavailableError } from "./bridge";

export function formatUserError(err: unknown, fallback = "Something went wrong."): string {
  if (err instanceof RuntimeUnavailableError) {
    return err.message;
  }
  if (typeof err === "string") {
    const clean = err.trim();
    return clean || fallback;
  }
  if (err instanceof Error) {
    const clean = err.message.trim();
    return clean || fallback;
  }
  if (err && typeof err === "object" && "message" in err && typeof (err as { message?: unknown }).message === "string") {
    const clean = ((err as { message: string }).message || "").trim();
    return clean || fallback;
  }
  return fallback;
}
