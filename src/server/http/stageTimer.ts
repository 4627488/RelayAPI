import "server-only";

export interface StageTimingEntry {
  name: string;
  label: string;
  startedAtMs: number;
  endedAtMs: number;
  durationMs: number;
}

export interface StageTimer {
  time<T>(name: string, label: string, fn: () => T): T;
  timeAsync<T>(name: string, label: string, fn: () => Promise<T>): Promise<T>;
  start(name: string, label: string): StageHandle;
  mark(name: string, label: string): void;
  snapshot(): StageTimingEntry[];
}

export interface StageHandle {
  finish(): void;
}

export function createStageTimer(): StageTimer {
  const origin = performance.now();
  const entries: StageTimingEntry[] = [];

  function relativeNow() {
    return Math.max(0, Math.round(performance.now() - origin));
  }

  function push(name: string, label: string, startedAtMs: number) {
    const endedAtMs = relativeNow();
    entries.push({
      name,
      label,
      startedAtMs,
      endedAtMs,
      durationMs: Math.max(0, endedAtMs - startedAtMs),
    });
  }

  return {
    time<T>(name: string, label: string, fn: () => T) {
      const startedAtMs = relativeNow();
      try {
        return fn();
      } finally {
        push(name, label, startedAtMs);
      }
    },
    async timeAsync<T>(name: string, label: string, fn: () => Promise<T>) {
      const startedAtMs = relativeNow();
      try {
        return await fn();
      } finally {
        push(name, label, startedAtMs);
      }
    },
    start(name: string, label: string) {
      const startedAtMs = relativeNow();
      let finished = false;
      return {
        finish() {
          if (finished) {
            return;
          }
          finished = true;
          push(name, label, startedAtMs);
        },
      };
    },
    mark(name: string, label: string) {
      const at = relativeNow();
      entries.push({
        name,
        label,
        startedAtMs: at,
        endedAtMs: at,
        durationMs: 0,
      });
    },
    snapshot() {
      return [...entries];
    },
  };
}
