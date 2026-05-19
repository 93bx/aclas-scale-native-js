import type { UnitPrintRecord } from "../types.js";

const UNIT_RECORD_SIZE = 16;
const UNIT_SLOTS = 25;
const UNIT_PRINT_MARKER = Buffer.from([0xaa, 0x55]);
const UNIT_PRINT_MAX = 14;

export { UNIT_RECORD_SIZE, UNIT_SLOTS };

/** Encode one 16-byte unit record. Slot with a custom print name starts with aa 55. */
export function encodeUnitRecord(unit: UnitPrintRecord): Buffer {
  const rec = Buffer.alloc(UNIT_RECORD_SIZE, 0);
  UNIT_PRINT_MARKER.copy(rec, 0);
  const name = unit.printName.slice(0, UNIT_PRINT_MAX);
  Buffer.from(name, "ascii").copy(rec, 2);
  return rec;
}

/** Decode a 16-byte unit record (slot 0-based). Returns null for empty (no print name) slots. */
export function decodeUnitRecord(rec: Buffer, slot: number): UnitPrintRecord | null {
  if (rec[0] !== 0xaa || rec[1] !== 0x55) return null;
  return {
    id: slot,
    printName: rec.subarray(2, UNIT_RECORD_SIZE).toString("ascii").replace(/\0+$/, ""),
  };
}

/**
 * Build a full 25-slot unit record array.
 * Only slots referenced in `units` get an aa 55 record; others are all-zero.
 */
export function buildUnitTable(units: UnitPrintRecord[]): Buffer[] {
  const table: Buffer[] = [];
  for (let slot = 0; slot < UNIT_SLOTS; slot++) {
    const u = units.find((x) => x.id === slot);
    table.push(u ? encodeUnitRecord(u) : Buffer.alloc(UNIT_RECORD_SIZE, 0));
  }
  return table;
}
