/**
 * One PLU row for download to the scale (512-byte wire record).
 * Fields match Link69 UI columns.
 *
 * Text encoding (name1, name2): Windows-1256 (CP-1256). Plain ASCII is a
 * subset, so Latin names round-trip byte-for-byte. Arabic chars (and other
 * CP-1256 codepoints) are supported up to the 20-byte field width — note
 * the byte count, not character count, is what's bounded. A character with
 * no CP-1256 mapping (e.g. emoji, CJK) throws on encode.
 */
export interface PluRecord {
  // ── required (Link69 UI starred fields) ─────────────────────────────────
  /**
   * LFCode (commodity ID). Range: 0–9999.
   *
   * Wire encoding (capture 14B, May 2026): 2-byte BCD split across the
   * packet header and the record body:
   *   buf[14] = (lfCode / 100) BCD   ← high byte, in packet header
   *   rec[0]  = (lfCode % 100) BCD   ← low byte, in record body
   * The scale firmware stores and round-trips the full 0–9999 value
   * (verified by capture 14's upload phase: writing LFCode 9999 returned
   * `header[14]=0x99, rec[0]=0x99` ⇒ 9999 reconstructed correctly).
   */
  lfCode: number;
  /**
   * Numeric code shown on receipts / reports.
   * Range: 0–999999 (6 BCD digits at rec[8-10]). The TXP file format allows
   * up to 10 digits but the wire record only allocates 3 BCD bytes.
   */
  code: number;
  /** Barcode start code (BCD, e.g. 99 → 0x99). Range 0–99. */
  barcodeStartCode: number;
  /** Product name (CP-1256, up to 20 bytes). */
  name1: string;
  /**
   * Unit price as a raw integer 0–9999, encoded as 2-byte BCD big-endian at
   * rec[139-140]. The value is stored on the scale as-is; decimal placement
   * is a scale-side display setting. Examples:
   *   - `unitPrice: 15`   → wire bytes `[0x00, 0x15]`, scale stores 15
   *   - `unitPrice: 1500` → wire bytes `[0x15, 0x00]`, scale stores 1500
   * Confirmed live 2026-05-31: setting `unitPrice = 1500` then reading back
   * via the scale showed `1500` (no implicit ÷100 conversion).
   */
  unitPrice: number;
  /** Unit ID (binary): 1=g, 4=kg. See UnitPrintRecord for custom print names. */
  unitId: number;
  /** Barcode type (binary, e.g. 1=EAN13, 11=Code128). */
  barcodeType1: number;

  // ── optional UI columns ──────────────────────────────────────────────────
  categoryId?: number;
  /** Secondary name (CP-1256, up to 20 bytes). */
  name2?: string;
  /** Member price as a raw integer 0–9999 (same semantics as `unitPrice`). */
  memberPrice?: number;
  /** Shelf life in days (Link69 "Shelf Date" column). */
  shelfDate?: number;

  // ── additional wire fields (not shown in main PLU grid) ──────────────────
  mainLabelId?: number;
  tare?: number;
  tax1Percent?: number;
  message1Id?: number;
}

// ── Department ──────────────────────────────────────────────────────────────

/** One department row (64-byte wire record). */
export interface DepartmentRecord {
  /** UI department ID 1–99; wire slot = id − 1. */
  id: number;
  /** Name up to 28 ASCII chars. */
  name: string;
  /** Whether the slot is marked active (flag byte). Default: true */
  active?: boolean;
}

// ── Category ────────────────────────────────────────────────────────────────

/** One category row (32-byte wire record — name only; dept/parent are PC-side). */
export interface CategoryRecord {
  /** UI category ID 1–99; wire slot = id − 1. */
  id: number;
  /** Name up to 32 ASCII chars. */
  name: string;
}

// ── Unit ────────────────────────────────────────────────────────────────────

/** One unit print-name record (16-byte wire record). Only custom print names are sent. */
export interface UnitPrintRecord {
  /** Wire slot index 0–24 = UI unit ID (0=g, 4=kg, etc.). */
  id: number;
  /** Display/print name up to 14 ASCII chars. */
  printName: string;
}

// ── Hotkey ──────────────────────────────────────────────────────────────────

/** One hotkey assignment (4-byte wire record). */
export interface HotkeyRecord {
  /** Linear wire slot 0–159. LS5Z7 UI uses 0–107 (10×8 + 4×7 grid). */
  slot: number;
  /** LFCode of the assigned PLU. 0 = empty key. */
  lfCode: number;
}

// ── Label ───────────────────────────────────────────────────────────────────

/**
 * Raw data needed to download a label to the scale (ops 98 1e + 98 1f + 98 20).
 *
 * Because the 98 1e element-descriptor format and 98 1f LabelMap binary are not
 * fully decoded, callers must supply the pre-formed bodies extracted from a
 * Wireshark capture (e.g. via `scripts/parse_11_download_label.py`).
 *
 * The gzip body for 98 20 can be obtained via `getScaleLabel()` on a configured scale.
 */
export interface LabelDownloadData {
  /** Body of the single 98 1e metadata packet (between the 13-byte header and CRC). */
  metadataBody: Buffer;
  /** Array of 256-byte body chunks for 98 1f (LabelMap binary). */
  labelMapBodies: Buffer[];
  /** Raw gzip stream for the 98 20 phase (split into 256-byte chunks internally). */
  gzip: Buffer;
}

/** Result of getScaleLabel(): the raw gzip template read from the scale. */
export interface LabelUploadResult {
  /** Compressed gzip stream (same binary as the 98 20 download phase). */
  gzip: Buffer;
}

export interface DiscoveredScale {
  host: string;
  port: number;
  /** User-facing model string, e.g. "LS5Z7" (resp[20-24]). */
  model: string;
  /** Serial number string, e.g. "24210002" (resp[25-32]). */
  serialNumber: string;
  /** Firmware version string, e.g. "V7.429" — decoded from BCD at resp[36-37]. */
  firmware: string;
  /** Firmware sub-version byte at resp[38], e.g. 17 (0x11). */
  firmwareSub: number;
  /** Firmware build tag at resp[206-212], e.g. "F-HF527". */
  firmwareBuild: string;
  /** Firmware revision string at resp[214-217], e.g. "R299". */
  firmwareRev: string;
  /** Internal PCB model at resp[171-176], e.g. "LS5RZX". */
  internalModel: string;
  /**
   * Zone / location name configured on the scale (resp[55-64]).
   * "TRACE NULL" means not configured.
   */
  zoneName: string;
  /** MAC address of the PC that sent the discovery request, echoed back by the scale (resp[193-198]). */
  requesterMac: string;
  rawResponse: Buffer;
}

export interface AclasScaleOptions {
  host: string;
  port?: number;
  /** Local bind address (optional). */
  localAddress?: string;
  timeoutMs?: number;
  /**
   * Optional: full 116-byte UDP payload of a captured PC→Scale `65 88` handshake packet.
   * If omitted, a zero-body handshake is sent instead — the scale does NOT validate
   * the body and responds with op `80 0d` (fully functional session, confirmed May 2026).
   */
  handshakeReplay?: Buffer;
  /**
   * Optional: override nonce byte [28] when building from `handshakeReplay`.
   * Unused when no `handshakeReplay` is provided (zero-body handshake ignores nonce).
   */
  handshakeNonce?: number;
}

export interface ReadParamsResult {
  blob: Buffer;
  marker: Buffer;
  crcTrailer: Buffer;
}
