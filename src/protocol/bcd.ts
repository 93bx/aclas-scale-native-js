/** Single-byte BCD (e.g. 15 → 0x15). */
export function toBcdByte(n: number): number {
  const v = Math.max(0, Math.min(99, Math.trunc(n)));
  return ((Math.floor(v / 10) << 4) | (v % 10)) & 0xff;
}

/** Two-byte BCD price: 10.00 → [0x10, 0x00]. */
export function toBcdPrice(price: number): { hi: number; lo: number } {
  const cents = Math.round(price * 100);
  const hi = Math.floor(cents / 100);
  const lo = cents % 100;
  return { hi: toBcdByte(hi), lo: toBcdByte(lo) };
}
