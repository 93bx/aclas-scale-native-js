import type { PluRecord } from "../types.js";
import {
  fromBcd2BE,
  fromBcd3BE,
  fromBcdByte,
  toBcd2BE,
  toBcd3BE,
  toBcdByte,
  toBcdPrice,
} from "./bcd.js";
import { decodeCp1256, encodeCp1256 } from "./cp1256.js";
import { appendPluPacketCrc } from "./crc.js";
import {
  MAGIC,
  PLU_COUNTER_BASE,
  PLU_PACKET_SIZE,
  PLU_RECORD_SIZE,
} from "./constants.js";

const MARKER_A = Buffer.from([0x3c, 0xff]);
const MARKER_B = Buffer.from([0x18, 0x99, 0x12, 0x30]);

/**
 * Write a fixed-length text field, encoded as Windows-1256 (CP-1256).
 * Confirmed encoding for PLU Name1/Name2 from capture 13 (Arabic captures).
 * For ASCII-only text, CP-1256 bytes are identical to ASCII bytes, so this
 * stays byte-for-byte compatible with the prior ASCII-only implementation.
 *
 * Overflow rule: if the encoded text exceeds `len` bytes, the excess is
 * silently truncated (matches the original ASCII path, which also truncated
 * via `text.slice(0, len)`).
 */
function writeTextField(rec: Buffer, offset: number, text: string, len: number): void {
  const encoded = encodeCp1256(text);
  encoded.subarray(0, len).copy(rec, offset);
}

/**
 * Build 527-byte Download PLU packet (op 98 2e).
 *
 * LFCode wire format (capture 14 + 14B, May 2026): 2-byte BCD spanning
 *   buf[14]  = (lfCode / 100) BCD  ← packet HEADER byte (outside 512B record)
 *   rec[0]   = (lfCode % 100) BCD  ← record body byte
 * Range 0–9999; scale firmware stores and round-trips the full value.
 */
export function buildDownloadPluPacket(plu: PluRecord, seqIndex: number): Buffer {
  const buf = Buffer.alloc(PLU_PACKET_SIZE, 0);
  MAGIC.copy(buf, 0);
  buf.writeUInt16BE(0x982e, 5);
  buf[8] = seqIndex;
  buf[10] = 0x02;
  buf[12] = PLU_COUNTER_BASE + seqIndex;

  validateLfCode(plu.lfCode);
  buf[14] = toBcd2BE(plu.lfCode).hi;

  const rec = buf.subarray(15, 15 + PLU_RECORD_SIZE);
  encodePluRecord(rec, plu);

  return appendPluPacketCrc(buf);
}

function validateLfCode(lfCode: number): void {
  if (!Number.isInteger(lfCode) || lfCode < 0 || lfCode > 9999) {
    throw new RangeError(`lfCode ${lfCode} out of range (must be 0–9999 integer)`);
  }
}

/**
 * Encode a PluRecord into a 512-byte wire record for the download op (98 2e).
 *
 * IMPORTANT: this writes only the 512-byte record body. The LFCode HIGH BCD
 * byte lives in the packet header at buf[14] and is written by
 * `buildDownloadPluPacket`, not here. If you call `encodePluRecord` directly,
 * you also need to populate buf[14] = toBcd2BE(plu.lfCode).hi yourself,
 * otherwise LFCodes > 99 will be transmitted with only the low byte.
 *
 * Field positions (capture 04b/05 + capture 13 + live-test 2026-05-31 + capture 14B):
 *
 *   buf[14]      LFCode HIGH BCD byte (in packet header, NOT in record)   ← cap 14B
 *   rec[0]       LFCode LOW BCD byte                                       ← cap 14B
 *   rec[1]       BarcodeStartCode (BCD)
 *   rec[2]       CategoryId (binary)
 *   rec[8-10]    Code (3-byte BCD, big-endian, 0–999999)                   ← cap 13
 *   rec[11-30]   Name1 (CP-1256, 20B null-padded)                          ← cap 13
 *   rec[51-70]   Name2 (CP-1256, 20B null-padded)                          ← cap 13
 *   rec[131]     mainLabelId (binary)
 *   rec[133]     barcodeType1 (binary)
 *   rec[135]     unitId (binary: 1=g, 4=kg)
 *   rec[139-140] unitPrice high/low BCD (cents, big-endian)                ← live test
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

  validateLfCode(plu.lfCode);
  const code = plu.code ?? plu.lfCode;
  if (code < 0 || code > 999999 || !Number.isInteger(code)) {
    throw new RangeError(`code ${code} out of range (must be 0–999999 integer)`);
  }

  // LFCode low BCD byte. The high BCD byte goes in the packet header
  // (buf[14]) — see buildDownloadPluPacket. Capture 14B (May 2026) proved
  // LFCode is a 2-byte BCD split across the packet header and record body.
  rec[0] = toBcd2BE(plu.lfCode).lo;
  rec[1] = toBcdByte(plu.barcodeStartCode ?? 0);
  rec[2] = plu.categoryId ?? 0;

  const codeBcd = toBcd3BE(code);
  rec[8] = codeBcd.hi;
  rec[9] = codeBcd.mid;
  rec[10] = codeBcd.lo;

  const name1 = plu.name1 ?? "";
  writeTextField(rec, 11, name1, 20);

  const name2 = plu.name2 ?? "";
  if (name2) {
    writeTextField(rec, 51, name2, 20);
    writeTextField(rec, 248, name1.slice(0, 8), 8);
  } else {
    writeTextField(rec, 248, name1, 20);
  }

  rec[131] = plu.mainLabelId ?? 0;
  rec[133] = plu.barcodeType1 ?? 1;
  rec[135] = plu.unitId ?? 4;

  // Unit Price at rec[139-140] (NOT rec[140-141] as the old field map claimed).
  // Confirmed by user live test 2026-05-31: sending LFCode=1001 + unitPrice=10
  // produced wire bytes rec[139-140]=[0x10, 0x01]; Link69 read back Unit Price
  // as 1001 cents, which only fits if the scale reads price from rec[139-140].
  const price = toBcdPrice(plu.unitPrice ?? 0);
  rec[139] = price.hi;
  rec[140] = price.lo;

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
 * `lfCodeHighBcd` is the LFCode HIGH BCD byte from the packet header (buf[14])
 * — required to reconstruct the full LFCode 0–9999. When decoding an upload
 * packet, pass `payload[14]` here. Defaults to 0 for backward compatibility
 * with callers that only have the record body (which limits LFCode to 0–99).
 *
 * Download (98 2e) and upload (60 2e) share the same 512-byte record layout —
 * confirmed by byte-for-byte comparison of capture 04b (download) vs capture 05
 * (upload) for all fingerprint PLUs A-F. Capture 14B (May 2026) revealed the
 * LFCode high byte position (packet header, not record body); capture 13 +
 * the 2026-05-31 live test resolved Code (3-byte BCD at rec[8-10]), Unit
 * Price (2-byte BCD at rec[139-140]), and CP-1256 Name1/Name2.
 */
export function decodePluRecord(rec: Buffer, lfCodeHighBcd = 0): PluRecord {
  const lfCode = fromBcdByte(lfCodeHighBcd) * 100 + fromBcdByte(rec[0]!);

  const code = fromBcd3BE(rec[8]!, rec[9]!, rec[10]!);

  const name1 = decodeCp1256(rec.subarray(11, 31));
  const name2raw = decodeCp1256(rec.subarray(51, 71));
  const mirror = decodeCp1256(rec.subarray(248, 268));
  const name2 = name2raw || (mirror && mirror !== name1 ? mirror : undefined);

  const unitPrice = fromBcd2BE(rec[139]!, rec[140]!);

  const mpHi = rec[250]!;
  const mpLo = rec[251]!;
  const memberPrice =
    mpHi !== 0 || mpLo !== 0 ? fromBcd2BE(mpHi, mpLo) : undefined;

  return {
    lfCode,
    barcodeStartCode: fromBcdByte(rec[1]!),
    categoryId: rec[2],
    code,
    name1,
    name2,
    mainLabelId: rec[131],
    barcodeType1: rec[133],
    unitId: rec[135],
    unitPrice,
    memberPrice,
    shelfDate: rec[143],
    tare: fromBcdByte(rec[180]!),
    tax1Percent: fromBcdByte(rec[185]!),
    message1Id: rec[229],
  };
}

export function extractPluFromUploadPacket(payload: Buffer): {
  record: Buffer;
  lfCodeHighBcd: number;
} {
  if (payload.length < 15 + PLU_RECORD_SIZE) {
    throw new Error(`Upload PLU packet too short: ${payload.length}`);
  }
  // LFCode HIGH BCD byte lives at packet header offset 14 (capture 14B).
  // The record body starts at offset 15.
  return {
    record: payload.subarray(15, 15 + PLU_RECORD_SIZE),
    lfCodeHighBcd: payload[14]!,
  };
}
