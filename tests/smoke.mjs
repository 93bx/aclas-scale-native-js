#!/usr/bin/env node
/**
 * smoke.mjs  —  Live-scale integration test for @93bx/aclas-scale-native-js.
 *
 * Usage:
 *   node tests/smoke.mjs [SCALE_IP]
 *
 * Defaults:
 *   SCALE_IP = 192.168.100.87
 *
 * Prerequisites:
 *   1. npm run build   (dist/ must exist)
 *   2. Scale powered on and reachable
 *   (No Wireshark captures required — zero-body handshake works natively.)
 *
 * Tests run in order:
 *   T1  discover()           — no handshake; validates all parsed fields
 *   T2  connect()            — zero-body handshake; scale accepts without body validation
 *   T3  syncClock()          — 70 03 clock sync
 *   T4  readParams()         — 60 28; validates blob length + known marker
 *   T5  uploadPLUs()         — 60 33+60 2e; reads current scale PLU table
 *   T6  downloadPLUs()       — 98 2e; writes one smoke-test PLU (LFCode 99)
 *   T7  uploadPLUs() verify  — confirms smoke PLU round-tripped correctly
 *   T7b downloadPLUs() + uploadPLUs() — extended PLU (LFCode=9999, Code=99999, unitPrice=1234, Arabic Name2)
 *   T8  downloadDepartments() — 98 14; writes one dept row
 *   T9  downloadCategories()  — 98 15; writes one category row
 *   T10 downloadHotkeys()     — 98 12; writes one hotkey slot
 *
 * The smoke PLU (LFCode=99, name "SMOKE TEST", price 9.99) and the extended
 * PLU (LFCode=9999, name "EXTENDED", name2 "احمد") are left on the scale
 * after the test. Delete them from Link69 if you don't want them.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AclasScale } from "../dist/index.js";

const __dir    = dirname(fileURLToPath(import.meta.url));
const REPO     = resolve(__dir, "../..");
const SCALE_IP = process.argv[2] ?? "192.168.100.87";
const PORT     = 5002;

// ── colours ──────────────────────────────────────────────────────────────────
const G = (s) => `\x1b[32m${s}\x1b[0m`;
const R = (s) => `\x1b[31m${s}\x1b[0m`;
const Y = (s) => `\x1b[33m${s}\x1b[0m`;
const B = (s) => `\x1b[1m${s}\x1b[0m`;

// ── test harness ─────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const errors = [];

async function run(label, fn) {
  process.stdout.write(`  ${label} … `);
  const t0 = Date.now();
  try {
    const detail = await fn();
    const ms = Date.now() - t0;
    console.log(G("PASS") + (detail ? `  ${Y(detail)}` : "") + `  ${ms}ms`);
    passed++;
    return true;
  } catch (e) {
    const ms = Date.now() - t0;
    console.log(R("FAIL") + `  ${ms}ms`);
    console.log(`         ${R(e.message)}`);
    errors.push({ label, err: e });
    failed++;
    return false;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ── smoke PLU ────────────────────────────────────────────────────────────────
const SMOKE_PLU = {
  lfCode:           99,
  code:             9900,
  barcodeStartCode: 99,
  name1:            "SMOKE TEST",
  unitPrice:        999,    // integer 0–9999, stored as-is in BCD
  memberPrice:      850,
  unitId:           1,      // 1 = grams
  barcodeType1:     1,
  categoryId:       1,
  shelfDate:        30,
};

// Extended PLU: exercises LFCode > 99 (2-byte BCD across header[14]+rec[0]),
// Code > 99 (3-byte BCD), Arabic Name2 (CP-1256), and a multi-digit price.
const EXTENDED_PLU = {
  lfCode:           9999,
  code:             99999,
  barcodeStartCode: 99,
  name1:            "EXTENDED",
  name2:            "احمد",   // Arabic, CP-1256 → c7 cd e3 cf
  unitPrice:        1234,
  unitId:           1,
  barcodeType1:     1,
  categoryId:       1,
  shelfDate:        30,
};

// ── main ─────────────────────────────────────────────────────────────────────
console.log(B("\n@93bx/aclas-scale-native-js smoke test"));
console.log(`  Scale : ${SCALE_IP}:${PORT}`);
console.log(`  Repo  : ${REPO}\n`);

// ── T0: check dist exists ────────────────────────────────────────────────────
try {
  const { version } = JSON.parse(readFileSync(join(__dir, "../package.json"), "utf8"));
  console.log(`  Package v${version}  (dist/ is present)\n`);
} catch {
  console.error(R("  ERROR: dist/ not found. Run: npm run build"));
  process.exit(1);
}

// ── T1: discover ─────────────────────────────────────────────────────────────
let discovered = null;
await run("T1  discover()", async () => {
  const scales = await AclasScale.discover(SCALE_IP, { port: PORT, timeoutMs: 2000 });
  assert(scales.length > 0, `No response from ${SCALE_IP}`);
  discovered = scales[0];
  assert(discovered.model,        "model is empty");
  assert(discovered.serialNumber, "serialNumber is empty");
  assert(discovered.firmware,     "firmware is empty");
  return `${discovered.model} / ${discovered.serialNumber} / ${discovered.firmware} / zone="${discovered.zoneName}" / build=${discovered.firmwareBuild}`;
});

// ── construct scale client (no captured packet required) ──────────────────────
const scale = new AclasScale({
  host:      SCALE_IP,
  port:      PORT,
  timeoutMs: 8000,
  // handshakeReplay intentionally omitted — zero-body handshake is used
});

// ── T2: connect ───────────────────────────────────────────────────────────────
let connectOk = false;
await run("T2  connect()  [zero-body handshake — no capture needed]", async () => {
  await scale.connect();
  assert(scale.isConnected, "isConnected is false after connect()");
  connectOk = true;
  // nonce is 0 for the zero-body path (scale responds with 80 0d, not 65 88)
  return "scale accepted zero-body handshake (op 80 0d)";
});

if (!connectOk) {
  scale.close();
  printSummary();
  process.exit(1);
}

// ── T3: syncClock ─────────────────────────────────────────────────────────────
await run("T3  syncClock()", async () => {
  await scale.syncClock();
  return `synced to ${new Date().toISOString()}`;
});

// ── T4: readParams ────────────────────────────────────────────────────────────
let paramBlob = null;
await run("T4  readParams()", async () => {
  const result = await scale.readParams();
  assert(result.blob.length === 251, `blob length ${result.blob.length} ≠ 251`);
  assert(result.marker.equals(Buffer.from([0xaa, 0x55, 0xaa, 0x55])),
    "param marker mismatch");
  paramBlob = result.blob;
  return `blob[0..3]=${result.blob.subarray(0, 4).toString("hex")}  blob[142]=0x${result.blob[142].toString(16).padStart(2,"0")}`;
});

// ── T5: uploadPLUs (read current table) ──────────────────────────────────────
let existingPlus = [];
await run("T5  uploadPLUs()  [read scale table]", async () => {
  existingPlus = await scale.getScalePLUs({ syncClock: false });
  const hasSmokeAlready = existingPlus.some((p) => p.lfCode === SMOKE_PLU.lfCode);
  return `${existingPlus.length} PLU(s) on scale${hasSmokeAlready ? "  (smoke PLU already present from prior run)" : ""}`;
});

// ── T6: downloadPLUs (write smoke PLU) ────────────────────────────────────────
await run("T6  downloadPLUs()  [write LFCode=99 smoke PLU]", async () => {
  await scale.setScalePLUs([SMOKE_PLU], { syncClock: true });
  return `LFCode=${SMOKE_PLU.lfCode}  name="${SMOKE_PLU.name1}"  price=${SMOKE_PLU.unitPrice}`;
});

// small gap — give scale time to commit
await new Promise((r) => setTimeout(r, 300));

// ── T7: uploadPLUs (verify round-trip) ────────────────────────────────────────
await run("T7  uploadPLUs()  [verify smoke PLU round-trip]", async () => {
  // Re-connect on the same socket so the session stays active for T8-T10.
  await scale.connect();
  const plus = await scale.getScalePLUs({ syncClock: false });

  const plu = plus.find((p) => p.lfCode === SMOKE_PLU.lfCode);
  assert(plu, `LFCode=${SMOKE_PLU.lfCode} not found in upload result`);
  assert(
    plu.name1.trim() === SMOKE_PLU.name1,
    `name1 mismatch: got "${plu.name1.trim()}" expected "${SMOKE_PLU.name1}"`,
  );
  assert((plu.unitPrice ?? 0) === SMOKE_PLU.unitPrice,
    `unitPrice mismatch: got ${plu.unitPrice} expected ${SMOKE_PLU.unitPrice}`);
  return `name="${plu.name1.trim()}"  price=${plu.unitPrice}  unitId=${plu.unitId}`;
});

// ── T7b: extended PLU round-trip (LFCode 9999 + Code 99999 + Price 12.34 + Arabic) ─
await run("T7b downloadPLUs() + uploadPLUs()  [lfCode=9999, code=99999, unitPrice=1234, name2=Arabic]", async () => {
  await scale.setScalePLUs([EXTENDED_PLU], { syncClock: false });
  await new Promise((r) => setTimeout(r, 300));
  await scale.connect();
  const plus = await scale.getScalePLUs({ syncClock: false });
  const plu = plus.find((p) => p.lfCode === EXTENDED_PLU.lfCode);
  assert(plu, `LFCode=${EXTENDED_PLU.lfCode} not found in upload result`);
  assert(plu.code === EXTENDED_PLU.code,
    `code mismatch: got ${plu.code} expected ${EXTENDED_PLU.code}`);
  assert(plu.name1.trim() === EXTENDED_PLU.name1,
    `name1 mismatch: got "${plu.name1.trim()}" expected "${EXTENDED_PLU.name1}"`);
  assert(plu.name2 === EXTENDED_PLU.name2,
    `name2 mismatch: got "${plu.name2}" expected "${EXTENDED_PLU.name2}"`);
  assert(plu.unitPrice === EXTENDED_PLU.unitPrice,
    `unitPrice mismatch: got ${plu.unitPrice} expected ${EXTENDED_PLU.unitPrice}`);
  return `lfCode=${plu.lfCode}  code=${plu.code}  price=${plu.unitPrice}  name1="${plu.name1.trim()}"  name2="${plu.name2}"`;
});

// T8-T10 reuse the session from T7's re-connect (same socket = same scale session).

// ── T8: downloadDepartments ───────────────────────────────────────────────────
await run("T8  downloadDepartments()  [1 dept]", async () => {
  await scale.setScaleDepartments([{ id: 1, name: "SMOKE DEPT", active: true }]);
  return "dept ID=1 name=SMOKE DEPT";
});

// ── T9: downloadCategories ────────────────────────────────────────────────────
await run("T9  downloadCategories()   [1 category]", async () => {
  await scale.setScaleCategories([{ id: 1, name: "SMOKE CAT" }]);
  return "cat ID=1 name=SMOKE CAT";
});

// ── T10: downloadHotkeys ──────────────────────────────────────────────────────
await run("T10 downloadHotkeys()      [1 hotkey slot=0 → LFCode 99]", async () => {
  await scale.setScaleHotkeys([{ slot: 0, lfCode: 99 }]);
  return "slot=0 → LFCode=99";
});

scale.close();
printSummary();

function printSummary() {
  const total = passed + failed;
  console.log(`\n${"─".repeat(60)}`);
  if (failed === 0) {
    console.log(G(`  ALL ${total} TESTS PASSED  ✓`));
  } else {
    console.log(R(`  ${failed}/${total} TESTS FAILED`));
    for (const { label, err } of errors) {
      console.log(`    ${R("✗")} ${label}: ${err.message}`);
    }
  }
  console.log(`${"─".repeat(60)}\n`);
  if (failed > 0) process.exit(1);
}
