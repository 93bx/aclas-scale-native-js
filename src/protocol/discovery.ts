import type { DiscoveredScale } from "../types.js";
import { MAGIC } from "./constants.js";
import { stripToPayload } from "./packet.js";

/** Op code for discovery/heartbeat packets (71 03). */
export const DISCOVERY_OP = 0x7103;

/**
 * Static 21-byte PC→Scale discovery/heartbeat request.
 * The scale responds with a 271-byte device description.
 * Link69 sends this every 5 seconds as a keep-alive heartbeat.
 * The trailer bytes b7 dd are fixed (not CRC-computed).
 */
const DISCOVERY_REQUEST = Buffer.from([
  0xaa, 0x00, 0x00, 0x00, 0x00, 0x71, 0x03, 0x00, 0x00, 0x00, 0x00, 0x06, 0x24, 0x0f,
  0x41, 0x43, 0x4c, 0x41, 0x53, 0xb7, 0xdd,
]);

export function buildDiscoveryRequest(): Buffer {
  return Buffer.from(DISCOVERY_REQUEST);
}

/**
 * Decode BCD-encoded firmware version from two bytes.
 * Each nibble is one decimal digit: 0x74 0x29 → "V7.429".
 */
function decodeFirmwareVersion(b0: number, b1: number): string {
  const major = b0 >> 4;
  const minor = ((b0 & 0xf) * 100) + ((b1 >> 4) * 10) + (b1 & 0xf);
  return `V${major}.${minor}`;
}

function readAscii(p: Buffer, start: number, len: number): string {
  return p.subarray(start, start + len).toString("ascii").replace(/\0/g, "").trim();
}

/**
 * Parse the 271-byte Scale→PC discovery response.
 *
 * Field map (all offsets from UDP payload start):
 *   [0-4]    MAGIC aa 00 00 00 00
 *   [5-6]    op 71 03
 *   [10]     direction: 01 = response
 *   [13]     body sync marker (aa)
 *   [14-15]  unknown descriptor (4d 33)
 *   [17-19]  last 3 bytes of requester PC MAC
 *   [20-24]  model ASCII, e.g. "LS5Z7"
 *   [25-32]  serial number ASCII, e.g. "24210002"
 *   [36-37]  firmware version BCD, e.g. 0x74 0x29 → "V7.429"
 *   [38]     firmware sub-version byte
 *   [39-42]  Scale IP (big-endian)
 *   [55-64]  zone/location name (ASCII, "TRACE NULL" = unconfigured)
 *   [143-147] manufacturer "ACLAS"
 *   [171-176] internal model, e.g. "LS5RZX"
 *   [179-180] unknown port/capability 1 (0x0190 = 400)
 *   [189-190] unknown port/capability 2 (0x0130 = 304)
 *   [193-198] requester (PC) MAC address (6 bytes)
 *   [206-212] firmware build tag, e.g. "F-HF527"
 *   [214-217] firmware revision, e.g. "R299"
 *   [269-270] CRC-16/CCITT-FALSE over [13:-2], big-endian
 */
export function parseDiscoveryResponse(payload: Buffer, host: string, port: number): DiscoveredScale | null {
  const p = stripToPayload(payload);
  if (
    p.length < 271 ||
    !p.subarray(0, 5).equals(MAGIC) ||
    p.readUInt16BE(5) !== 0x7103 ||
    p[10] !== 0x01
  ) {
    return null;
  }

  const macBytes = p.subarray(193, 199);
  const requesterMac = Array.from(macBytes).map((b) => b.toString(16).padStart(2, "0")).join(":");

  return {
    host,
    port,
    model:         readAscii(p, 20, 5),
    serialNumber:  readAscii(p, 25, 8),
    firmware:      decodeFirmwareVersion(p[36]!, p[37]!),
    firmwareSub:   p[38]!,
    firmwareBuild: readAscii(p, 206, 7),
    firmwareRev:   readAscii(p, 214, 4),
    internalModel: readAscii(p, 171, 6),
    zoneName:      readAscii(p, 55, 10),
    requesterMac,
    rawResponse:   Buffer.from(p),
  };
}
