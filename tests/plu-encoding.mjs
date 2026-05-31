#!/usr/bin/env node
/**
 * plu-encoding.mjs — offline regression tests for PLU encode/decode.
 *
 * Does not require a live scale. Verifies byte-for-byte correctness of:
 *   • LFCode  → 2-byte BCD: packet header buf[14] + record rec[0]  (cap 14B)
 *   • Code    → rec[8-10]   (3-byte BCD big-endian, 0–999999)       (cap 13)
 *   • Price   → rec[139-140] (2-byte BCD big-endian, cents, 0–9999) (live test)
 *   • Name1/2 → Windows-1256 (Arabic supported)                      (cap 13)
 *
 * Run: npm run build && node tests/plu-encoding.mjs
 */

import { strict as assert } from "node:assert";
import {
  buildDownloadPluPacket,
  encodePluRecord,
  decodePluRecord,
  encodeCp1256,
  decodeCp1256,
  crc16CcittFalse,
} from "../dist/index.js";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed += 1;
  } catch (e) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${e.message}`);
    if (e.expected !== undefined) {
      console.log(`        expected: ${JSON.stringify(e.expected)}`);
      console.log(`        actual:   ${JSON.stringify(e.actual)}`);
    }
    failed += 1;
  }
}

const REC_SIZE = 512;
function encode(plu) {
  const rec = Buffer.alloc(REC_SIZE, 0);
  encodePluRecord(rec, plu);
  return rec;
}

console.log("PLU encoding regression tests\n");

// ── LFCode 0–9999: 2-byte BCD split across packet header + record body ─────
// rec[0] = LFCode % 100 BCD; buildDownloadPluPacket sets buf[14] = LFCode / 100 BCD.
test("LFCode=99 + unitPrice=999 (smoke PLU) → rec[0]=0x99, header[14]=0x00, price BCD 0x09 0x99", () => {
  const plu = {
    lfCode: 99,
    code: 9900,
    barcodeStartCode: 99,
    name1: "SMOKE TEST",
    unitPrice: 999,
    unitId: 1,
    barcodeType1: 1,
  };
  const pkt = buildDownloadPluPacket(plu, 0);
  assert.equal(pkt[14], 0x00, "packet header[14] = LFCode high BCD (0 for ≤99)");
  assert.equal(pkt[15 + 0], 0x99, "rec[0] = LFCode low BCD");
  assert.equal(pkt[15 + 139], 0x09, "rec[139] = price.hi (BCD of 999/100=9)");
  assert.equal(pkt[15 + 140], 0x99, "rec[140] = price.lo (BCD of 999%100=99)");

  const rec = pkt.subarray(15, 15 + 512);
  const decoded = decodePluRecord(rec, pkt[14]);
  assert.equal(decoded.lfCode, 99);
  assert.equal(decoded.code, 9900);
  assert.equal(decoded.name1, "SMOKE TEST");
  assert.equal(decoded.unitPrice, 999, "price round-trips as integer (no ÷100)");
});

test("LFCode=100 → header[14]=0x01, rec[0]=0x00 (capture 14 P3 LF100)", () => {
  const pkt = buildDownloadPluPacket({
    lfCode: 100, code: 3, barcodeStartCode: 99, name1: "LF100",
    unitPrice: 0, unitId: 4, barcodeType1: 7,
  }, 2);
  assert.equal(pkt[14], 0x01);
  assert.equal(pkt[15 + 0], 0x00);
  const dec = decodePluRecord(pkt.subarray(15, 15 + 512), pkt[14]);
  assert.equal(dec.lfCode, 100);
});

test("LFCode=256 → header[14]=0x02, rec[0]=0x56 (capture 14 P4 LF256)", () => {
  const pkt = buildDownloadPluPacket({
    lfCode: 256, code: 4, barcodeStartCode: 99, name1: "LF256",
    unitPrice: 0, unitId: 4, barcodeType1: 7,
  }, 3);
  assert.equal(pkt[14], 0x02);
  assert.equal(pkt[15 + 0], 0x56);
  assert.equal(decodePluRecord(pkt.subarray(15, 15 + 512), pkt[14]).lfCode, 256);
});

test("LFCode=9999 → header[14]=0x99, rec[0]=0x99 (capture 14 P5 LF9999)", () => {
  const pkt = buildDownloadPluPacket({
    lfCode: 9999, code: 5, barcodeStartCode: 99, name1: "LF9999",
    unitPrice: 0, unitId: 4, barcodeType1: 7,
  }, 4);
  assert.equal(pkt[14], 0x99);
  assert.equal(pkt[15 + 0], 0x99);
  assert.equal(decodePluRecord(pkt.subarray(15, 15 + 512), pkt[14]).lfCode, 9999);
});

test("LFCode=150 → header[14]=0x01, rec[0]=0x50 (capture 14B Name1)", () => {
  const pkt = buildDownloadPluPacket({
    lfCode: 150, code: 1, barcodeStartCode: 99, name1: "Name1",
    unitPrice: 0, unitId: 4, barcodeType1: 7,
  }, 0);
  assert.equal(pkt[14], 0x01);
  assert.equal(pkt[15 + 0], 0x50);
  assert.equal(decodePluRecord(pkt.subarray(15, 15 + 512), pkt[14]).lfCode, 150);
});

test("LFCode=3000 → header[14]=0x30, rec[0]=0x00 (capture 14B Name30)", () => {
  const pkt = buildDownloadPluPacket({
    lfCode: 3000, code: 30, barcodeStartCode: 99, name1: "Name30",
    unitPrice: 0, unitId: 4, barcodeType1: 7,
  }, 29);
  assert.equal(pkt[14], 0x30);
  assert.equal(pkt[15 + 0], 0x00);
  assert.equal(decodePluRecord(pkt.subarray(15, 15 + 512), pkt[14]).lfCode, 3000);
});

// ── PLU packet CRC must COVER buf[14] (the LFCode HIGH byte) ───────────────
// Regression for the "LFCode >= 100 times out" bug: the scale silently drops
// packets whose CRC does not include buf[14]. The CRC range is buf[13..525].
// Confirmed against captures 14 and 14B (30/30 packets matched start=13, 0/30
// matched start=15 for buf[14] != 0). See appendPluPacketCrc.
test("PLU CRC covers buf[14]: trailer == crc16(buf[13..525]) for LFCode>=100", () => {
  const pkt = buildDownloadPluPacket({
    lfCode: 150, code: 1, barcodeStartCode: 99, name1: "CRC150",
    unitPrice: 0, unitId: 4, barcodeType1: 7,
  }, 0);
  assert.equal(pkt[14], 0x01, "precondition: buf[14] != 0 for LFCode 150");

  const trailer = (pkt[525] << 8) | pkt[526];
  const crcFrom13 = crc16CcittFalse(pkt.subarray(13, 525));
  const crcFrom15 = crc16CcittFalse(pkt.subarray(15, 525));

  assert.equal(trailer, crcFrom13, "packet trailer must equal CRC over buf[13..525]");
  assert.notEqual(
    trailer,
    crcFrom15,
    "CRC over buf[15..525] must DIFFER (proves buf[14] is covered)",
  );
});

test("PLU CRC: LFCode<100 — start=13 and start=15 agree (buf[14]==0)", () => {
  const pkt = buildDownloadPluPacket({
    lfCode: 50, code: 1, barcodeStartCode: 99, name1: "CRC50",
    unitPrice: 0, unitId: 4, barcodeType1: 7,
  }, 0);
  assert.equal(pkt[14], 0x00, "precondition: buf[14] == 0 for LFCode 50");
  const trailer = (pkt[525] << 8) | pkt[526];
  assert.equal(trailer, crc16CcittFalse(pkt.subarray(13, 525)));
  assert.equal(
    trailer,
    crc16CcittFalse(pkt.subarray(15, 525)),
    "with buf[14]==0 a leading zero byte does not change the CRC",
  );
});

test("LFCode=0 + unitPrice=0 — empty PLU edge case", () => {
  const pkt = buildDownloadPluPacket({
    lfCode: 0, code: 0, barcodeStartCode: 0, name1: "",
    unitPrice: 0, unitId: 4, barcodeType1: 7,
  }, 0);
  assert.equal(pkt[14], 0x00);
  assert.equal(pkt[15 + 0], 0x00);
  const dec = decodePluRecord(pkt.subarray(15, 15 + 512), pkt[14]);
  assert.equal(dec.lfCode, 0);
  assert.equal(dec.unitPrice, 0);
});

test("LFCode=10000 — out of range, throws", () => {
  assert.throws(
    () => buildDownloadPluPacket({
      lfCode: 10000, code: 1, barcodeStartCode: 99, name1: "X",
      unitPrice: 0, unitId: 4, barcodeType1: 7,
    }, 0),
    /lfCode 10000 out of range/,
  );
});

test("Backward-compat: decodePluRecord without lfCodeHighBcd → LFCode 0–99 only", () => {
  const rec = encode({
    lfCode: 77, code: 1, barcodeStartCode: 99, name1: "X",
    unitPrice: 0, unitId: 4, barcodeType1: 7,
  });
  assert.equal(decodePluRecord(rec).lfCode, 77);
});

// ── Code: 3-byte BCD at rec[8-10] (working, verified by user) ──────────────
test("Code=99999 — capture 13 A5", () => {
  const rec = encode({
    lfCode: 5, code: 99999, barcodeStartCode: 99, name1: "ACODE99K",
    unitPrice: 0, unitId: 4, barcodeType1: 7,
  });
  assert.equal(rec[8], 0x09);
  assert.equal(rec[9], 0x99);
  assert.equal(rec[10], 0x99);
  assert.equal(decodePluRecord(rec).code, 99999);
});

test("Code=999999 — upper bound", () => {
  const rec = encode({
    lfCode: 1, code: 999999, barcodeStartCode: 99, name1: "X",
    unitPrice: 0, unitId: 4, barcodeType1: 7,
  });
  assert.equal(rec[8], 0x99);
  assert.equal(rec[9], 0x99);
  assert.equal(rec[10], 0x99);
  assert.equal(decodePluRecord(rec).code, 999999);
});

test("Code=1000000 — out of range, throws", () => {
  assert.throws(
    () => encode({
      lfCode: 1, code: 1000000, barcodeStartCode: 99, name1: "X",
      unitPrice: 0, unitId: 4, barcodeType1: 7,
    }),
    /code 1000000 out of range/,
  );
});

// ── Unit Price: integer 0–9999, BCD big-endian at rec[139-140] ─────────────
// What you set is what the scale stores and displays (no implicit ÷100).
// Confirmed live 2026-05-31: setting `unitPrice: 1500` showed "1500" on scale.
test("unitPrice=1500 → rec[139-140] = 0x15 0x00 (BCD)", () => {
  const rec = encode({
    lfCode: 1, code: 1, barcodeStartCode: 99, name1: "P1500",
    unitPrice: 1500, unitId: 4, barcodeType1: 7,
  });
  assert.equal(rec[139], 0x15, "price.hi at rec[139]");
  assert.equal(rec[140], 0x00, "price.lo at rec[140]");
  assert.equal(decodePluRecord(rec).unitPrice, 1500, "price round-trips as integer");
});

test("unitPrice=15 → rec[139-140] = 0x00 0x15 (no ×100 multiplication)", () => {
  const rec = encode({
    lfCode: 1, code: 1, barcodeStartCode: 99, name1: "P15",
    unitPrice: 15, unitId: 4, barcodeType1: 7,
  });
  assert.equal(rec[139], 0x00);
  assert.equal(rec[140], 0x15);
  assert.equal(decodePluRecord(rec).unitPrice, 15);
});

test("unitPrice=9999 — upper bound", () => {
  const rec = encode({
    lfCode: 1, code: 1, barcodeStartCode: 99, name1: "P9999",
    unitPrice: 9999, unitId: 4, barcodeType1: 7,
  });
  assert.equal(rec[139], 0x99);
  assert.equal(rec[140], 0x99);
  assert.equal(decodePluRecord(rec).unitPrice, 9999);
});

test("unitPrice=10000 — out of range, throws", () => {
  assert.throws(
    () => encode({
      lfCode: 1, code: 1, barcodeStartCode: 99, name1: "X",
      unitPrice: 10000, unitId: 4, barcodeType1: 7,
    }),
    /price 10000 out of range/,
  );
});

// ── Arabic Name2 encoding (Windows-1256) ───────────────────────────────────
test("Name2 = 'احمد' encodes to capture 13 B3 bytes", () => {
  const text = "احمد";
  const enc = encodeCp1256(text);
  assert.deepEqual(
    [...enc],
    [0xc7, 0xcd, 0xe3, 0xcf],
    "alif/ha/meem/dal in Windows-1256",
  );
  assert.equal(decodeCp1256(enc), text);
});

test("Name2 = 'بسم الله' encodes to capture 13 B4 bytes", () => {
  const text = "بسم الله";
  const enc = encodeCp1256(text);
  assert.deepEqual(
    [...enc],
    [0xc8, 0xd3, 0xe3, 0x20, 0xc7, 0xe1, 0xe1, 0xe5],
  );
  assert.equal(decodeCp1256(enc), text);
});

test("PLU with Arabic Name2 round-trips through encode/decode", () => {
  const rec = encode({
    lfCode: 12, code: 12, barcodeStartCode: 99, name1: "BARA4",
    name2: "احمد",
    unitPrice: 0, unitId: 4, barcodeType1: 7,
  });
  assert.equal(rec[51], 0xc7);
  assert.equal(rec[52], 0xcd);
  assert.equal(rec[53], 0xe3);
  assert.equal(rec[54], 0xcf);
  const decoded = decodePluRecord(rec);
  assert.equal(decoded.name1, "BARA4");
  assert.equal(decoded.name2, "احمد");
});

test("Latin Name1 + Arabic Name2 mirror layout (Name1[:8] at rec[248])", () => {
  const rec = encode({
    lfCode: 13, code: 13, barcodeStartCode: 99, name1: "BARLONG",
    name2: "بسم الله",
    unitPrice: 0, unitId: 4, barcodeType1: 7,
  });
  const mirror = Buffer.from(rec.subarray(248, 256)).toString("ascii").replace(/\0+$/, "");
  assert.equal(mirror, "BARLONG");
});

test("Unmapped codepoint throws (emoji)", () => {
  assert.throws(() => encodeCp1256("hi 🙂"), /U\+1f642.*not representable/);
});

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
