import type { HotkeyRecord } from "../types.js";
import { toBcdByte } from "./bcd.js";
import { MAGIC } from "./constants.js";

const HOTKEY_RECORD_SIZE = 4;
const HOTKEY_SLOTS = 160;

export { HOTKEY_RECORD_SIZE, HOTKEY_SLOTS };

/**
 * Encode one 4-byte hotkey record.  Empty key: lfCode = 0 → [00 00 00 00].
 *
 * The hotkey wire record only has a single BCD byte at `rec[2]` for the LFCode,
 * so it is limited to LFCode 0–99 — this is a wire-protocol limit, not a
 * library limit. PLU records support LFCode 0–9999 via the multi-byte field
 * at rec[139-140]; pointing a hotkey at a high-LFCode PLU is unsupported on
 * the wire and would require a different (still-undecoded) hotkey op code.
 */
export function encodeHotkeyRecord(lfCode: number): Buffer {
  if (lfCode < 0 || lfCode > 99 || !Number.isInteger(lfCode)) {
    throw new RangeError(
      `Hotkey lfCode ${lfCode} out of wire range (0–99). ` +
      `The 4-byte hotkey record holds a single BCD byte; LFCode > 99 is not yet supported for hotkeys.`,
    );
  }
  const rec = Buffer.alloc(HOTKEY_RECORD_SIZE, 0);
  if (lfCode > 0) {
    rec[2] = toBcdByte(lfCode);
  }
  return rec;
}

/** Decode a 4-byte hotkey record (slot 0-based). Returns null for empty keys. */
export function decodeHotkeyRecord(rec: Buffer, slot: number): HotkeyRecord | null {
  const bcd = rec[2]!;
  if (bcd === 0) return null;
  const lfCode = ((bcd >> 4) & 0xf) * 10 + (bcd & 0xf);
  return { slot, lfCode };
}

/**
 * Build a full 160-slot hotkey record array.
 * Unassigned slots are [00 00 00 00].
 */
export function buildHotkeyTable(hotkeys: HotkeyRecord[]): Buffer[] {
  const table: Buffer[] = new Array(HOTKEY_SLOTS)
    .fill(null)
    .map(() => Buffer.alloc(HOTKEY_RECORD_SIZE, 0));
  for (const hk of hotkeys) {
    if (hk.slot >= 0 && hk.slot < HOTKEY_SLOTS) {
      table[hk.slot] = encodeHotkeyRecord(hk.lfCode);
    }
  }
  return table;
}

/** Build 13-byte PC ACK for a Scale→PC 60 12 hotkey data packet. */
export function buildHotkeyUploadAck(seq: number): Buffer {
  const buf = Buffer.alloc(13, 0);
  MAGIC.copy(buf, 0);
  buf[5] = 0x60;
  buf[6] = 0x12;
  buf[8] = seq;
  buf[12] = 0x1c + seq;
  return buf;
}
