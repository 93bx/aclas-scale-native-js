import type { PluRecord } from "../types.js";
import { toBcdByte, toBcdPrice } from "./bcd.js";
import { appendPluPacketCrc } from "./crc.js";
import {
  MAGIC,
  PLU_COUNTER_BASE,
  PLU_PACKET_SIZE,
  PLU_RECORD_SIZE,
} from "./constants.js";

const MARKER_A = Buffer.from([0x3c, 0xff]);
const MARKER_B = Buffer.from([0x18, 0x99, 0x12, 0x30]);

function writeAsciiField(rec: Buffer, offset: number, text: string, len: number): void {
  Buffer.from(text.slice(0, len), "ascii").copy(rec, offset);
}

/** Build 527-byte Download PLU packet (op 98 2e). */
export function buildDownloadPluPacket(plu: PluRecord, seqIndex: number): Buffer {
  const buf = Buffer.alloc(PLU_PACKET_SIZE, 0);
  MAGIC.copy(buf, 0);
  buf.writeUInt16BE(0x982e, 5);
  buf[8] = seqIndex;
  buf[10] = 0x02;
  buf[12] = PLU_COUNTER_BASE + seqIndex;

  const rec = buf.subarray(15, 15 + PLU_RECORD_SIZE);
  encodePluRecord(rec, plu);

  return appendPluPacketCrc(buf);
}

/**
 * Encode a PluRecord into a 512-byte wire record for the download op (98 2e).
 *
 * Field positions confirmed from captures 04b (download fingerprint PLUs A-F)
 * and 05 (upload — same positions in both directions, verified byte-for-byte):
 *
 *   rec[0]       LFCode (BCD)
 *   rec[1]       BarcodeStartCode (BCD)
 *   rec[2]       CategoryId (binary)
 *   rec[10]      Code (BCD)
 *   rec[11-30]   Name1 (ASCII, 20B, null-padded)
 *   rec[51-70]   Name2 (ASCII, 20B, null-padded)
 *   rec[131]     mainLabelId (binary)
 *   rec[133]     barcodeType1 (binary)
 *   rec[135]     unitId (binary: 1=g, 4=kg)
 *   rec[140]     unitPrice high byte (BCD)
 *   rec[141]     unitPrice low byte (BCD)
 *   rec[143]     shelfDate in days (binary)
 *   rec[155-156] 3c ff  (fixed marker)
 *   rec[159-162] 18 99 12 30  (fixed marker)
 *   rec[180]     tare in grams (BCD)
 *   rec[185]     tax1Percent (BCD)
 *   rec[210-213] 18 99 12 30  (fixed marker)
 *   rec[216-219] 18 99 12 30  (fixed marker)
 *   rec[229]     message1Id (binary)
 *   rec[248-267] Name2 mirror (Name1 when Name2 empty; Name1[:8] when Name2 set)
 *   rec[250-251] memberPrice hi/lo (BCD, overlaps mirror when set)
 *   rec[510-511] CRC-16 (written by appendPluPacketCrc)
 */
export function encodePluRecord(rec: Buffer, plu: PluRecord): void {
  rec.fill(0);
  rec[0] = toBcdByte(plu.lfCode);
  rec[1] = toBcdByte(plu.barcodeStartCode ?? 0);
  rec[2] = plu.categoryId ?? 0;
  rec[10] = toBcdByte(plu.code ?? plu.lfCode);

  const name1 = plu.name1 ?? "";
  writeAsciiField(rec, 11, name1, 20);

  const name2 = plu.name2 ?? "";
  if (name2) {
    writeAsciiField(rec, 51, name2, 20);
    writeAsciiField(rec, 248, name1.slice(0, 8), 8);
  } else {
    writeAsciiField(rec, 248, name1, 20);
  }

  rec[131] = plu.mainLabelId ?? 0;
  rec[133] = plu.barcodeType1 ?? 1;
  rec[135] = plu.unitId ?? 4;

  const price = toBcdPrice(plu.unitPrice ?? 0);
  rec[140] = price.hi;
  rec[141] = price.lo;
  rec[143] = plu.shelfDate ?? 0;

  MARKER_A.copy(rec, 155);
  MARKER_B.copy(rec, 159);
  rec[180] = toBcdByte(plu.tare ?? 0);
  rec[185] = toBcdByte(plu.tax1Percent ?? 0);
  MARKER_B.copy(rec, 210);
  MARKER_B.copy(rec, 216);
  rec[229] = plu.message1Id ?? 0;

  if (plu.memberPrice !== undefined) {
    const mp = toBcdPrice(plu.memberPrice);
    rec[250] = mp.hi;
    rec[251] = mp.lo;
  }
}

/**
 * Decode a 512-byte PLU record received from the scale via the upload op (60 2e).
 *
 * Download (98 2e) and upload (60 2e) share the same 512-byte record layout —
 * confirmed by byte-for-byte comparison of capture 04b (download) vs capture 05
 * (upload) for all fingerprint PLUs A-F. The CLAUDE.md field map was incorrect;
 * the true positions were determined from both captures simultaneously.
 *
 * All field offsets match encodePluRecord exactly:
 */
export function decodePluRecord(rec: Buffer): PluRecord {
  const lfCode = ((rec[0]! >> 4) & 0xf) * 10 + (rec[0]! & 0xf);
  const name1 = rec.subarray(11, 31).toString("ascii").replace(/\0+$/, "");
  const name2raw = rec.subarray(51, 71).toString("ascii").replace(/\0+$/, "");
  // Mirror is at same offset in upload as download
  const mirror = rec.subarray(248, 268).toString("ascii").replace(/\0+$/, "");
  const name2 = name2raw || (mirror && mirror !== name1 ? mirror : undefined);

  const priceHi = rec[140]!;
  const priceLo = rec[141]!;
  const unitPrice =
    (((priceHi >> 4) & 0xf) * 10 + (priceHi & 0xf)) +
    (((priceLo >> 4) & 0xf) * 10 + (priceLo & 0xf)) / 100;

  const mpHi = rec[250]!;
  const mpLo = rec[251]!;
  const memberPriceRaw = mpHi !== 0 || mpLo !== 0
    ? (((mpHi >> 4) & 0xf) * 10 + (mpHi & 0xf)) +
      (((mpLo >> 4) & 0xf) * 10 + (mpLo & 0xf)) / 100
    : undefined;

  return {
    lfCode,
    barcodeStartCode: ((rec[1]! >> 4) & 0xf) * 10 + (rec[1]! & 0xf),
    categoryId: rec[2],
    code: ((rec[10]! >> 4) & 0xf) * 10 + (rec[10]! & 0xf),
    name1,
    name2,
    mainLabelId: rec[131],
    barcodeType1: rec[133],
    unitId: rec[135],
    unitPrice,
    memberPrice: memberPriceRaw,
    shelfDate: rec[143],
    tare: ((rec[180]! >> 4) & 0xf) * 10 + (rec[180]! & 0xf),
    tax1Percent: ((rec[185]! >> 4) & 0xf) * 10 + (rec[185]! & 0xf),
    message1Id: rec[229],
  };
}

export function extractPluFromUploadPacket(payload: Buffer): Buffer {
  if (payload.length < 15 + PLU_RECORD_SIZE) {
    throw new Error(`Upload PLU packet too short: ${payload.length}`);
  }
  return payload.subarray(15, 15 + PLU_RECORD_SIZE);
}
