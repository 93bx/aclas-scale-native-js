import { MAGIC } from "./constants.js";
import { crc16CcittFalse } from "./crc.js";

export function findMagicOffset(buf: Buffer): number {
  return buf.indexOf(MAGIC);
}

export function stripToPayload(udpPayload: Buffer): Buffer {
  const i = findMagicOffset(udpPayload);
  return i >= 0 ? udpPayload.subarray(i) : udpPayload;
}

export function readOpCode(payload: Buffer): number {
  if (payload.length < 7) return 0;
  return payload.readUInt16BE(5);
}

export function buildShortRequest(op: number, bodyByte = 0x00): Buffer {
  const buf = Buffer.alloc(13);
  MAGIC.copy(buf, 0);
  buf.writeUInt16BE(op, 5);
  buf[12] = bodyByte;
  return buf;
}

export function isGeneralAck(payload: Buffer): boolean {
  return payload.length >= 7 && readOpCode(payload) === 0x800e;
}

export function parseGeneralAckCounter(payload: Buffer): number | undefined {
  if (!isGeneralAck(payload) || payload.length < 13) return undefined;
  return payload[12];
}

export function buildUploadPluAck(seq: number): Buffer {
  const buf = Buffer.alloc(13);
  MAGIC.copy(buf, 0);
  buf.writeUInt16BE(0x602e, 5);
  // buf[8] is a sequence counter that mirrors seq (observed in capture 05).
  buf[8] = seq;
  buf[12] = 0x38 + seq;
  return buf;
}

/** Verify CRC-16/CCITT-FALSE stored big-endian at crcOffset. Span = buf[bodyStart..crcOffset). */
export function verifyPacketCrc(buf: Buffer, crcOffset: number, bodyStart = 13): boolean {
  if (buf.length < crcOffset + 2) return false;
  const expected = (buf[crcOffset]! << 8) | buf[crcOffset + 1]!;
  return crc16CcittFalse(buf.subarray(bodyStart, crcOffset)) === expected;
}
