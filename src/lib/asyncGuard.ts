export class LatestOnlyGuard {
  private seq = 0;

  next(): number {
    this.seq += 1;
    return this.seq;
  }

  isCurrent(token: number): boolean {
    return token === this.seq;
  }

  invalidate(): void {
    this.seq += 1;
  }
}

export function createSerialQueue(): <T>(fn: () => Promise<T>) => Promise<T> {
  let chain: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => undefined);
    return next;
  };
}
