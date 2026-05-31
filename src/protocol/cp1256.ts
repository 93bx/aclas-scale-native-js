/**
 * Windows-1256 ↔ Unicode helpers.
 *
 * Confirmed encoding for PLU Name1/Name2 fields (capture 13, May 2026):
 *   "احمد"     → c7 cd e3 cf            (4 bytes — alif/ha/meem/dal)
 *   "بسم الله" → c8 d3 e3 20 c7 e1 e1 e5 (8 bytes incl. space)
 *
 * Bytes 0x00-0x7F are identical to ASCII, so plain Latin names continue to
 * round-trip byte-for-byte with the prior ASCII implementation.
 *
 * The 0x80-0xFF mapping table below follows the standard
 * Windows-1256 specification (Microsoft Code Page 1256).
 */

// One Unicode codepoint per byte for bytes 0x80..0xFF. 0xFFFD = undefined slot.
const HIGH_BYTES_TO_UNICODE: number[] = [
  0x20ac, 0x067e, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021,
  0x02c6, 0x2030, 0x0679, 0x2039, 0x0152, 0x0686, 0x0698, 0x0688,
  0x06af, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x06a9, 0x2122, 0x0691, 0x203a, 0x0153, 0x200c, 0x200d, 0x06ba,
  0x00a0, 0x060c, 0x00a2, 0x00a3, 0x00a4, 0x00a5, 0x00a6, 0x00a7,
  0x00a8, 0x00a9, 0x06be, 0x00ab, 0x00ac, 0x00ad, 0x00ae, 0x00af,
  0x00b0, 0x00b1, 0x00b2, 0x00b3, 0x00b4, 0x00b5, 0x00b6, 0x00b7,
  0x00b8, 0x00b9, 0x061b, 0x00bb, 0x00bc, 0x00bd, 0x00be, 0x061f,
  0x06c1, 0x0621, 0x0622, 0x0623, 0x0624, 0x0625, 0x0626, 0x0627,
  0x0628, 0x0629, 0x062a, 0x062b, 0x062c, 0x062d, 0x062e, 0x062f,
  0x0630, 0x0631, 0x0632, 0x0633, 0x0634, 0x0635, 0x0636, 0x00d7,
  0x0637, 0x0638, 0x0639, 0x063a, 0x0640, 0x0641, 0x0642, 0x0643,
  0x00e0, 0x0644, 0x00e2, 0x0645, 0x0646, 0x0647, 0x0648, 0x00e7,
  0x00e8, 0x00e9, 0x00ea, 0x00eb, 0x0649, 0x064a, 0x00ee, 0x00ef,
  0x064b, 0x064c, 0x064d, 0x064e, 0x00f4, 0x064f, 0x0650, 0x00f7,
  0x0651, 0x00f9, 0x0652, 0x00fb, 0x00fc, 0x200e, 0x200f, 0x06d2,
];

const UNICODE_TO_HIGH_BYTE: Map<number, number> = new Map();
HIGH_BYTES_TO_UNICODE.forEach((cp, i) => {
  UNICODE_TO_HIGH_BYTE.set(cp, 0x80 + i);
});

/**
 * Encode a JS string to Windows-1256 bytes. Throws on characters that have
 * no mapping (e.g., emoji or CJK), since silently dropping data would corrupt
 * PLU names on the scale display.
 */
export function encodeCp1256(text: string): Buffer {
  const out = Buffer.alloc(text.length * 2);
  let len = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) {
      out[len++] = cp;
      continue;
    }
    const mapped = UNICODE_TO_HIGH_BYTE.get(cp);
    if (mapped === undefined) {
      throw new Error(
        `cp1256: character U+${cp.toString(16).padStart(4, "0")} (${ch}) is not representable in Windows-1256`,
      );
    }
    out[len++] = mapped;
  }
  return out.subarray(0, len);
}

/**
 * Decode Windows-1256 bytes (typically a fixed-length, null-padded field
 * from a PLU record) to a JS string. Trailing 0x00 bytes are trimmed.
 */
export function decodeCp1256(buf: Buffer): string {
  let end = buf.length;
  while (end > 0 && buf[end - 1] === 0) end -= 1;
  let out = "";
  for (let i = 0; i < end; i += 1) {
    const b = buf[i]!;
    if (b < 0x80) {
      out += String.fromCharCode(b);
    } else {
      out += String.fromCodePoint(HIGH_BYTES_TO_UNICODE[b - 0x80]!);
    }
  }
  return out;
}
