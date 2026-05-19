import type { DepartmentRecord } from "../types.js";

const DEPT_RECORD_SIZE = 64;
const DEPT_MARKER = Buffer.from([0x40, 0xf3, 0x81, 0x04]);
const DEPT_MAX_NAME = 28;

export { DEPT_RECORD_SIZE };

/** Encode one 64-byte department record. Slot index = dept.id − 1. */
export function encodeDeptRecord(dept: DepartmentRecord): Buffer {
  const rec = Buffer.alloc(DEPT_RECORD_SIZE, 0);
  const name = dept.name.slice(0, DEPT_MAX_NAME);
  Buffer.from(name, "ascii").copy(rec, 0);
  rec[30] = name.length;
  DEPT_MARKER.copy(rec, 36);
  rec[40] = (dept.active ?? true) ? 0x01 : 0x00;
  rec[44] = 0x1e; // max name length = 30
  return rec;
}

/** Decode a 64-byte department record (slot 0-based). */
export function decodeDeptRecord(rec: Buffer, slot: number): DepartmentRecord {
  const name = rec.subarray(0, DEPT_MAX_NAME).toString("ascii").replace(/\0+$/, "");
  return {
    id: slot + 1,
    name,
    active: rec[40] === 0x01,
  };
}

/** Build a full 99-element dept record array (empty slots are all-zero with marker). */
export function buildDeptTable(depts: DepartmentRecord[]): Buffer[] {
  const table: Buffer[] = [];
  for (let slot = 0; slot < 99; slot++) {
    const d = depts.find((x) => x.id === slot + 1);
    if (d) {
      table.push(encodeDeptRecord(d));
    } else {
      const empty = Buffer.alloc(DEPT_RECORD_SIZE, 0);
      DEPT_MARKER.copy(empty, 36);
      empty[44] = 0x1e;
      table.push(empty);
    }
  }
  return table;
}
