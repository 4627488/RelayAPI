import { describe, expect, test } from "vitest";
import { parseGrokBillingPayload } from "@/src/server/services/grokQuota";

describe("Grok billing quota parsing", () => {
  test("parses the preferred gRPC-web usage and reset fields", () => {
    const message = concat(fieldMessage(1, concat(fieldFloat(1, 37.5), fieldMessage(5, fieldVarint(1, 1_785_196_800)))));
    expect(parseGrokBillingPayload(grpcFrame(message), new Date("2026-07-01T00:00:00Z"))).toMatchObject({ usedPercent: 37.5, remainingPercent: 62.5, resetsAt: "2026-07-28T00:00:00.000Z", label: "Monthly" });
  });

  test("treats a reset-only empty credits window as unused", () => {
    const message = concat(fieldMessage(1, concat(fieldMessage(5, fieldVarint(1, 1_785_196_800)), fieldMessage(6, fieldVarint(1, 1)))));
    expect(parseGrokBillingPayload(grpcFrame(message), new Date("2026-07-01T00:00:00Z"))).toMatchObject({ usedPercent: 0, remainingPercent: 100 });
  });
});

function grpcFrame(payload: Uint8Array) { return concat(new Uint8Array([0, 0, 0, 0, payload.length]), payload); }
function fieldMessage(field: number, payload: Uint8Array) { return concat(varint(field << 3 | 2), varint(payload.length), payload); }
function fieldVarint(field: number, value: number) { return concat(varint(field << 3), varint(value)); }
function fieldFloat(field: number, value: number) { const bytes = new Uint8Array(5); bytes[0] = field << 3 | 5; new DataView(bytes.buffer).setFloat32(1, value, true); return bytes; }
function varint(value: number) { const bytes: number[] = []; let current = BigInt(value); do { let byte = Number(current & 0x7fn); current >>= 7n; if (current) byte |= 0x80; bytes.push(byte); } while (current); return new Uint8Array(bytes); }
function concat(...parts: Uint8Array[]) { const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0)); let offset = 0; for (const part of parts) { result.set(part, offset); offset += part.length; } return result; }
