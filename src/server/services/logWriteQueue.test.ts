import { describe, expect, test, vi } from "vitest";

import { LogWriteQueue } from "@/src/server/services/logWriteQueue";

describe("LogWriteQueue", () => {
  test("batches queued writes into one flush", () => {
    const flushed: number[][] = [];
    const queue = new LogWriteQueue<number>({
      flushIntervalMs: 100,
      maxBatchSize: 100,
      writeBatch: (batch) => flushed.push(batch),
    });

    queue.enqueue(1);
    queue.enqueue(2);
    expect(flushed).toEqual([]);

    queue.flushNow();
    expect(flushed).toEqual([[1, 2]]);
    queue.close();
  });

  test("flushes automatically after the configured interval", () => {
    vi.useFakeTimers();
    const flushed: number[][] = [];
    const queue = new LogWriteQueue<number>({
      flushIntervalMs: 100,
      maxBatchSize: 100,
      writeBatch: (batch) => flushed.push(batch),
    });

    queue.enqueue(1);
    vi.advanceTimersByTime(99);
    expect(flushed).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(flushed).toEqual([[1]]);

    queue.close();
    vi.useRealTimers();
  });

  test("schedules a flush when the batch size is reached", () => {
    vi.useFakeTimers();
    const flushed: number[][] = [];
    const queue = new LogWriteQueue<number>({
      flushIntervalMs: 1_000,
      maxBatchSize: 2,
      writeBatch: (batch) => flushed.push(batch),
    });

    queue.enqueue(1);
    queue.enqueue(2);
    expect(flushed).toEqual([]);
    vi.runAllTimers();
    expect(flushed).toEqual([[1, 2]]);

    queue.close();
    vi.useRealTimers();
  });

  test("returns a failed batch to the front of the queue", () => {
    const flushed: number[][] = [];
    let fail = true;
    const queue = new LogWriteQueue<number>({
      flushIntervalMs: 100,
      maxBatchSize: 100,
      writeBatch: (batch) => {
        if (fail) {
          fail = false;
          throw new Error("disk busy");
        }
        flushed.push(batch);
      },
    });

    queue.enqueue(1);
    expect(() => queue.flushNow()).toThrow("disk busy");
    queue.enqueue(2);
    queue.flushNow();
    expect(flushed).toEqual([[1, 2]]);
    queue.close();
  });
});
