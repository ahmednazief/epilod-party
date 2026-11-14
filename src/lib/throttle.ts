export interface LeadingTrailingThrottle<A extends unknown[]> {
  call: (...args: A) => void;
  flush: () => void;
  cancel: () => void;
}

export function createLeadingTrailingThrottle<A extends unknown[]>(
  fn: (...args: A) => void,
  waitMs: number,
): LeadingTrailingThrottle<A> {
  let lastRunAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingArgs: A | null = null;

  const invoke = (args: A) => {
    lastRunAt = Date.now();
    fn(...args);
  };

  return {
    call: (...args: A) => {
      const now = Date.now();
      const remaining = waitMs - (now - lastRunAt);
      if (remaining <= 0) {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        pendingArgs = null;
        invoke(args);
      } else {
        pendingArgs = args;
        if (!timer) {
          timer = setTimeout(() => {
            timer = null;
            if (pendingArgs) {
              const argsToRun = pendingArgs;
              pendingArgs = null;
              invoke(argsToRun);
            }
          }, remaining);
        }
      }
    },
    flush: () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (pendingArgs) {
        const argsToRun = pendingArgs;
        pendingArgs = null;
        invoke(argsToRun);
      }
    },
    cancel: () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      pendingArgs = null;
    },
  };
}
