export interface LogWriteQueueOptions<T> {
  flushIntervalMs: number;
  maxBatchSize: number;
  writeBatch: (batch: T[]) => void;
  onBackgroundError?: (error: unknown) => void;
}

export class LogWriteQueue<T> {
  private readonly flushIntervalMs: number;
  private readonly maxBatchSize: number;
  private readonly writeBatch: (batch: T[]) => void;
  private readonly onBackgroundError: (error: unknown) => void;
  private pending: T[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;
  private closed = false;

  constructor(options: LogWriteQueueOptions<T>) {
    this.flushIntervalMs = Math.max(1, options.flushIntervalMs);
    this.maxBatchSize = Math.max(1, options.maxBatchSize);
    this.writeBatch = options.writeBatch;
    this.onBackgroundError = options.onBackgroundError || (() => undefined);
  }

  enqueue(item: T) {
    if (this.closed) {
      throw new Error("Log write queue is closed");
    }
    this.pending.push(item);
    this.schedule(this.pending.length >= this.maxBatchSize ? 0 : this.flushIntervalMs);
  }

  flushNow() {
    if (this.flushing || this.pending.length === 0) {
      return;
    }
    this.cancelTimer();
    const batch = this.pending;
    this.pending = [];
    this.flushing = true;
    try {
      this.writeBatch(batch);
    } catch (error) {
      this.pending = [...batch, ...this.pending];
      if (!this.closed) {
        this.schedule(this.flushIntervalMs);
      }
      throw error;
    } finally {
      this.flushing = false;
    }
    if (this.pending.length > 0 && !this.closed) {
      this.schedule(
        this.pending.length >= this.maxBatchSize ? 0 : this.flushIntervalMs,
      );
    }
  }

  close() {
    this.closed = true;
    this.cancelTimer();
  }

  private schedule(delayMs: number) {
    if (this.timer) {
      if (delayMs !== 0) {
        return;
      }
      this.cancelTimer();
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      try {
        this.flushNow();
      } catch (error) {
        this.onBackgroundError(error);
      }
    }, delayMs);
    this.timer.unref?.();
  }

  private cancelTimer() {
    if (!this.timer) {
      return;
    }
    clearTimeout(this.timer);
    this.timer = null;
  }
}
