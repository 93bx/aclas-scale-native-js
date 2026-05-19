/**
 * Run: npm run build && npm run verify:crc  (from aclas-scale-native-js/)
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendPluPacketCrc, verifyPacketCrcBe } from "../dist/protocol/crc.js";

const HEADER_SKIP = 42;
const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const cap = join(root, "wireshark_captures/04b_download_plu.txt");

function parseFrames(text) {
  const frames = [];
  let buf = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("+---------")) {
      if (buf.length) frames.push(Buffer.from(buf));
      buf = [];
      continue;
    }
    const m = line.match(/\|0\s+\|(.+)\|/);
    if (!m) continue;
    for (const p of m[1].split("|").map((s) => s.trim()).filter(Boolean)) {
      buf.push(parseInt(p, 16));
    }
  }
  if (buf.length) frames.push(Buffer.from(buf));
  return frames;
}

function payload(frame) {
  const i = frame.indexOf(Buffer.from([0xaa, 0, 0, 0, 0]));
  return i >= 0 ? frame.subarray(i + HEADER_SKIP - HEADER_SKIP + i) : frame;
}

let ok = 0;
let n = 0;
for (const frame of parseFrames(readFileSync(cap, "utf8"))) {
  const i = frame.indexOf(Buffer.from([0xaa, 0, 0, 0, 0]));
  if (i < 0) continue;
  const p = frame.subarray(i);
  if (p.length < 527 || p.readUInt16BE(5) !== 0x982e) continue;
  n++;
  const rebuilt = Buffer.from(p.subarray(0, 525));
  appendPluPacketCrc(Buffer.concat([rebuilt, Buffer.alloc(2)]));
  const pkt = Buffer.alloc(527);
  p.copy(pkt, 0, 0, 525);
  appendPluPacketCrc(pkt);
  if (verifyPacketCrcBe(pkt, 15) && pkt.subarray(525).equals(p.subarray(525))) ok++;
}

console.log(`PLU 98 2e CRC: ${ok === n && n > 0 ? "PASS" : "FAIL"} (${ok}/${n})`);
process.exit(ok === n && n > 0 ? 0 : 1);
