/** Single-byte BCD (e.g. 15 → 0x15). Range 0–99. Throws on out-of-range. */
export function toBcdByte(n: number): number {
  const v = Math.trunc(n);
  if (v < 0 || v > 99) {
    throw new RangeError(`toBcdByte: value ${n} out of range (must be 0–99)`);
  }
  return ((Math.floor(v / 10) << 4) | (v % 10)) & 0xff;
}

/** Decode one BCD byte → integer 0–99. */
export function fromBcdByte(b: number): number {
  return ((b >> 4) & 0xf) * 10 + (b & 0xf);
}

/**
 * Two-byte BCD, big-endian.
 * 9999 → [0x99, 0x99]; 256 → [0x02, 0x56]; 100 → [0x01, 0x00].
 * Range 0–9999. Used for LFCode (rec[139-140]) and Unit Price (rec[140-141]).
 */
export function toBcd2BE(n: number): { hi: number; lo: number } {
  const v = Math.trunc(n);
  if (v < 0 || v > 9999) {
    throw new RangeError(`toBcd2BE: value ${n} out of range (must be 0–9999)`);
  }
  return { hi: toBcdByte(Math.floor(v / 100)), lo: toBcdByte(v % 100) };
}

/** Decode two big-endian BCD bytes → integer 0–9999. */
export function fromBcd2BE(hi: number, lo: number): number {
  return fromBcdByte(hi) * 100 + fromBcdByte(lo);
}

/**
 * Three-byte BCD, big-endian.
 * 99999 → [0x09, 0x99, 0x99]; 1 → [0x00, 0x00, 0x01].
 * Range 0–999999. Used for PLU Code at rec[8-10].
 */
export function toBcd3BE(n: number): { hi: number; mid: number; lo: number } {
  const v = Math.trunc(n);
  if (v < 0 || v > 999999) {
    throw new RangeError(`toBcd3BE: value ${n} out of range (must be 0–999999)`);
  }
  return {
    hi: toBcdByte(Math.floor(v / 10000)),
    mid: toBcdByte(Math.floor(v / 100) % 100),
    lo: toBcdByte(v % 100),
  };
}

/** Decode three big-endian BCD bytes → integer 0–999999. */
export function fromBcd3BE(hi: number, mid: number, lo: number): number {
  return fromBcdByte(hi) * 10000 + fromBcdByte(mid) * 100 + fromBcdByte(lo);
}

/**
 * Two-byte BCD unit price (big-endian), range 0–9999.
 *
 * The value is stored on the scale as-is in BCD — no implicit cents conversion.
 * What you set is what the scale stores and displays. If the scale firmware is
 * configured for 2 decimal places, the value 1500 is displayed as "15.00"; with
 * 0 decimals it shows as "1500". Decimal placement is a scale-side setting.
 *
 * Examples: 15 → [0x00, 0x15];  1500 → [0x15, 0x00];  9999 → [0x99, 0x99].
 *
 * Confirmed live 2026-05-31: setting `unitPrice = 1500` then reading the PLU
 * back via Link69 / scale display showed `1500`. The earlier "cents (×100)"
 * interpretation was a misread of the same evidence.
 */
export function toBcdPrice(price: number): { hi: number; lo: number } {
  const n = Math.round(price);
  if (n < 0 || n > 9999) {
    throw new RangeError(`toBcdPrice: price ${price} out of range (must be 0–9999 integer)`);
  }
  return toBcd2BE(n);
}
