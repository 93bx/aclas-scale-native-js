/**
 * CRC-16/CCITT-FALSE (poly 0x1021, init 0x0000, refin=false, refout=false, xorout=0).
 * Verified against captures 04/04b/06/07/09/03b/11 (PLU, 271 B chunks, clock, write params, 98 1e).
 * On wire the 16-bit value is stored **big-endian** (high byte first).
 */

/** CRC-16/CCITT-FALSE — init 0x0000. */
export function crc16CcittFalse(data: Buffer): number {
  let crc = 0;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i]! << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

/** Write CRC at `offset` as big-endian (Link69 wire format). */
export function writeCrc16Be(buf: Buffer, offset: number, crcOver: Buffer): void {
  const crc = crc16CcittFalse(crcOver);
  buf[offset] = (crc >> 8) & 0xff;
  buf[offset + 1] = crc & 0xff;
}

/**
 * Append CRC over `buf[bodyStart .. length-2]` into the last two bytes (big-endian).
 * `buf` must already be allocated with 2 trailing bytes reserved.
 */
export function appendPacketCrcBe(buf: Buffer, bodyStart = 13): Buffer {
  writeCrc16Be(buf, buf.length - 2, buf.subarray(bodyStart, buf.length - 2));
  return buf;
}

/**
 * PLU download (98 2e): CRC over buf[13 .. 525] (big-endian into the last 2 bytes).
 *
 * The CRC range starts at offset 13 — the same convention as `appendPacketCrcBe`
 * — which means it COVERS buf[14], the LFCode HIGH BCD byte. This was confirmed
 * by recomputing CRCs against captures 14 and 14B: for every packet with
 * buf[14] != 0 (LFCode >= 100), only a CRC that includes buf[14] matches the
 * scale's expected value (30/30 on cap 14B). A CRC starting at offset 15 only
 * matched when buf[14] == 0 (LFCode < 100), because a leading zero byte does not
 * change a CCITT-FALSE CRC. Starting at offset 15 silently produced wrong CRCs
 * for LFCode >= 100, so the scale dropped those packets without ACK (timeout).
 */
export function appendPluPacketCrc(buf: Buffer): Buffer {
  writeCrc16Be(buf, buf.length - 2, buf.subarray(13, buf.length - 2));
  return buf;
}

export function verifyPacketCrcBe(buf: Buffer, bodyStart = 13): boolean {
  const offset = buf.length - 2;
  const expected = (buf[offset]! << 8) | buf[offset + 1]!;
  return crc16CcittFalse(buf.subarray(bodyStart, offset)) === expected;
}

/** @deprecated Use crc16CcittFalse + appendPacketCrcBe — MODBUS was not a match on captures. */
export function crc16Modbus(data: Buffer): number {
  let crc = 0xffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i]!;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >> 1) ^ 0xa001 : crc >> 1;
    }
  }
  return crc & 0xffff;
}
