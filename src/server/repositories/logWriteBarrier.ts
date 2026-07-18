import "server-only";

let flushPendingWrites: () => void = () => undefined;

export function registerLogWriteBarrier(flush: () => void) {
  flushPendingWrites = flush;
}

export function flushLogWriteBarrier() {
  flushPendingWrites();
}
