import {
  HANDSHAKE_MAGIC,
  HANDSHAKE_PREFIX,
  MAGIC,
  OP_HANDSHAKE_WRAPPER,
} from "./constants.js";

export const HANDSHAKE_PACKET_LEN = 116;
export const HANDSHAKE_BODY_LEN = 87;

/**
 * Op code the scale returns when it accepts a zero-body handshake (confirmed May 2026).
 * The full captured-replay path returns a 116-byte `65 88` echo instead.
 */
export const OP_HANDSHAKE_ACK = 0x800d;

/**
 * Build a minimal zero-body PC→Scale handshake packet (116 bytes).
 *
 * The scale does NOT validate the 103-byte body — confirmed experimentally:
 * a fully zeroed body is accepted and all subsequent operations (clock sync,
 * PLU upload/download, dept/cat/hotkey download) work normally. The scale
 * responds with op `80 0d` (19 bytes) instead of the full `65 88` echo.
 *
 * This is the preferred path — no Wireshark capture required.
 */
export function buildZeroBodyHandshake(): Buffer {
  const pkt = Buffer.alloc(HANDSHAKE_PACKET_LEN, 0);
  MAGIC.copy(pkt, 0);
  pkt.writeUInt16BE(OP_HANDSHAKE_WRAPPER, 5);
  pkt.writeUInt16BE(0x6588, 11);
  return pkt;
}

/** Validate captured PC→Scale handshake UDP payload (116 bytes). */
export function validateHandshakeReplay(packet: Buffer): Buffer {
  return validateHandshakePacket(packet, "PC→Scale");
}

export function validateHandshakePacket(packet: Buffer, label = "packet"): Buffer {
  if (packet.length !== HANDSHAKE_PACKET_LEN) {
    throw new Error(`${label}: expected ${HANDSHAKE_PACKET_LEN} bytes (got ${packet.length})`);
  }
  if (!packet.subarray(0, 5).equals(MAGIC)) {
    throw new Error(`${label}: missing aa 00 00 00 00 magic`);
  }
  if (packet.readUInt16BE(5) !== OP_HANDSHAKE_WRAPPER) {
    throw new Error(`${label}: expected op 71 08 wrapper`);
  }
  if (packet.readUInt16BE(11) !== 0x6588) {
    throw new Error(`${label}: expected op 65 88`);
  }
  if (!packet.subarray(13, 18).equals(HANDSHAKE_MAGIC)) {
    throw new Error(`${label}: missing "ACLAS" magic`);
  }
  if (!packet.subarray(18, 28).equals(HANDSHAKE_PREFIX)) {
    throw new Error(`${label}: unexpected fixed prefix at bytes 18-27`);
  }
  return Buffer.from(packet);
}

/**
 * Build a PC→Scale handshake from a captured template.
 * Only byte [28] (nonce) can be changed safely; the 87-byte body is session-specific ciphertext.
 * Prefer `buildZeroBodyHandshake()` — the scale doesn't validate the body.
 */
export function buildHandshakeFromCapture(
  capturedPcToScale: Buffer,
  options?: { nonce?: number },
): Buffer {
  const pkt = validateHandshakeReplay(capturedPcToScale);
  const out = Buffer.from(pkt);
  if (options?.nonce !== undefined) {
    out[28] = options.nonce & 0xff;
  }
  return out;
}

/** Parse hex string (optional spaces) into a 116-byte handshake packet. */
export function handshakePacketFromHex(hex: string): Buffer {
  const cleaned = hex.replace(/\s+/g, "");
  if (cleaned.length !== HANDSHAKE_PACKET_LEN * 2) {
    throw new Error(`Expected ${HANDSHAKE_PACKET_LEN * 2} hex chars, got ${cleaned.length}`);
  }
  return validateHandshakeReplay(Buffer.from(cleaned, "hex"));
}

/**
 * Parse the scale's response to a full captured-replay handshake (116-byte `65 88` echo).
 * Returns null if the payload doesn't match — use `isHandshakeAck` for the zero-body path.
 */
export function parseHandshakeResponse(payload: Buffer): { nonce: number; body: Buffer } | null {
  if (payload.length < HANDSHAKE_PACKET_LEN) return null;
  if (!payload.subarray(0, 5).equals(MAGIC)) return null;
  if (payload.readUInt16BE(5) !== OP_HANDSHAKE_WRAPPER) return null;
  if (payload.readUInt16BE(11) !== 0x6588) return null;
  const nonce = payload[28]!;
  const body = payload.subarray(29, 29 + HANDSHAKE_BODY_LEN);
  return { nonce, body };
}

/**
 * Returns true if the payload is the scale's `80 0d` ACK to a zero-body handshake.
 * The 19-byte response confirms the session is established.
 */
export function isHandshakeAck(payload: Buffer): boolean {
  return (
    payload.length >= 7 &&
    payload.subarray(0, 5).equals(MAGIC) &&
    payload.readUInt16BE(5) === OP_HANDSHAKE_ACK
  );
}

/** Scale→PC body has fixed zeros at [22] and [71..73] (status + separator). */
export function parseScaleHandshakeBody(body: Buffer): {
  payload: Buffer;
  statusByte: number;
  authTail: Buffer;
} | null {
  if (body.length !== HANDSHAKE_BODY_LEN) return null;
  return {
    payload: body.subarray(0, 71),
    statusByte: body[22]!,
    authTail: body.subarray(74, 87),
  };
}
