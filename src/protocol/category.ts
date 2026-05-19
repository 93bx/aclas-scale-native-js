import type { CategoryRecord } from "../types.js";

const CAT_RECORD_SIZE = 32;

export { CAT_RECORD_SIZE };

/** Encode one 32-byte category record (name only; dept/parent are PC-side metadata). */
export function encodeCategoryRecord(cat: CategoryRecord): Buffer {
  const rec = Buffer.alloc(CAT_RECORD_SIZE, 0);
  const name = cat.name.slice(0, CAT_RECORD_SIZE);
  Buffer.from(name, "ascii").copy(rec, 0);
  return rec;
}

/** Decode a 32-byte category record (slot 0-based). */
export function decodeCategoryRecord(rec: Buffer, slot: number): CategoryRecord {
  return {
    id: slot + 1,
    name: rec.subarray(0, CAT_RECORD_SIZE).toString("ascii").replace(/\0+$/, ""),
  };
}

/** Build a full 99-element category record array (empty slots are all-zero). */
export function buildCategoryTable(categories: CategoryRecord[]): Buffer[] {
  const table: Buffer[] = [];
  for (let slot = 0; slot < 99; slot++) {
    const c = categories.find((x) => x.id === slot + 1);
    if (c) {
      table.push(encodeCategoryRecord(c));
    } else {
      table.push(Buffer.alloc(CAT_RECORD_SIZE, 0));
    }
  }
  return table;
}
