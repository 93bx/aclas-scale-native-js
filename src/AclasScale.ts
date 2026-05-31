import type {
  AclasScaleOptions,
  CategoryRecord,
  DepartmentRecord,
  DiscoveredScale,
  HotkeyRecord,
  LabelDownloadData,
  LabelUploadResult,
  PluRecord,
  ReadParamsResult,
  UnitPrintRecord,
} from "./types.js";
import {
  CATEGORY_COUNTER_BASE,
  DEFAULT_PORT,
  DEPT_COUNTER_BASE,
  HOTKEY_COUNTER_BASE,
  HOTKEY_UPLOAD_PREAMBLE_COUNTER,
  LABEL_GZIP_COUNTER_BASE,
  LABEL_MAP_COUNTER_BASE,
  LABEL_META_B11,
  LABEL_UPLOAD_START_COUNTER,
  MAGIC,
  OP_CLEAR_DATA,
  OP_CLOCK_SYNC,
  OP_DOWNLOAD_CATEGORY,
  OP_DOWNLOAD_DEPT,
  OP_DOWNLOAD_HOTKEY,
  OP_DOWNLOAD_LABEL_GZIP,
  OP_DOWNLOAD_LABEL_MAP,
  OP_DOWNLOAD_LABEL_META,
  OP_DOWNLOAD_UNIT,
  OP_GENERAL_ACK,
  OP_READ_PARAMS,
  OP_UPLOAD_HOTKEY_DATA,
  OP_UPLOAD_HOTKEY_PREAMBLE,
  OP_UPLOAD_LABEL_DATA,
  OP_UPLOAD_LABEL_START,
  OP_UPLOAD_PLU,
  OP_UPLOAD_PLU_START,
  PARAM_BLOB_LEN,
  PARAM_MARKER,
  PLU_COUNTER_BASE,
  UNIT_COUNTER_BASE,
} from "./protocol/constants.js";
import { buildDiscoveryRequest, parseDiscoveryResponse, DISCOVERY_OP } from "./protocol/discovery.js";
import {
  buildHandshakeFromCapture,
  buildZeroBodyHandshake,
  isHandshakeAck,
  parseHandshakeResponse,
  validateHandshakeReplay,
} from "./protocol/handshake.js";
import { appendPacketCrcBe } from "./protocol/crc.js";
import { toBcdByte } from "./protocol/bcd.js";
import {
  buildDownloadPluPacket,
  decodePluRecord,
  extractPluFromUploadPacket,
} from "./protocol/plu.js";
import { buildDeptTable } from "./protocol/department.js";
import { buildCategoryTable } from "./protocol/category.js";
import { buildUnitTable } from "./protocol/unit.js";
import {
  buildHotkeyTable,
  buildHotkeyUploadAck,
  decodeHotkeyRecord,
  HOTKEY_RECORD_SIZE,
} from "./protocol/hotkey.js";
import { buildLabelUploadAck, extractGzipFromBodies } from "./protocol/label.js";
import {
  buildShortRequest,
  buildUploadPluAck,
  isGeneralAck,
  readOpCode,
  stripToPayload,
} from "./protocol/packet.js";
import { UdpClient } from "./transport/udp.js";
import { ScaleError } from "./ScaleError.js";

const DEFAULT_HEARTBEAT_INTERVAL_MS = 5000;

export class AclasScale {
  private readonly host: string;
  private readonly port: number;
  private readonly main: UdpClient;
  private readonly clock: UdpClient;
  private readonly handshakePacket: Buffer;
  private sessionNonce = 0;
  private connected = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: AclasScaleOptions) {
    this.host = options.host;
    this.port = options.port ?? DEFAULT_PORT;
    const timeoutMs = options.timeoutMs ?? 5000;
    this.main = new UdpClient({ localAddress: options.localAddress, timeoutMs });
    this.clock = new UdpClient({ localAddress: options.localAddress, timeoutMs });
    if (options.handshakeReplay) {
      // Use captured packet (legacy path — still supported but no longer required)
      this.handshakePacket =
        options.handshakeNonce !== undefined
          ? buildHandshakeFromCapture(options.handshakeReplay, { nonce: options.handshakeNonce })
          : validateHandshakeReplay(options.handshakeReplay);
    } else {
      // Zero-body handshake — scale does not validate the body (confirmed May 2026)
      this.handshakePacket = buildZeroBodyHandshake();
    }
  }

  // ── Static factory ───────────────────────────────────────────────────────

  /**
   * Create an AclasScale instance, establish the session (discovery + handshake),
   * and return the ready-to-use object.
   *
   * @example
   * const scale = await AclasScale.connect('192.168.100.87');
   * await scale.setScalePLUs(plus);
   * scale.close();
   */
  static async connect(
    host: string,
    options?: Omit<AclasScaleOptions, "host">,
  ): Promise<AclasScale> {
    const scale = new AclasScale({ host, ...options });
    await scale.connect();
    return scale;
  }

  // ── State accessors ──────────────────────────────────────────────────────

  get isConnected(): boolean {
    return this.connected;
  }

  getSessionNonce(): number {
    return this.sessionNonce;
  }

  // ── Connection ───────────────────────────────────────────────────────────

  /**
   * Establish a session with the scale (71 03 discovery + 65 88 handshake).
   * Must be called before any data operation.
   * Use the static `AclasScale.connect(host)` factory for a one-liner.
   */
  async connect(): Promise<void> {
    // Discovery must precede the handshake — the scale ignores 65 88 without it.
    await this.sendDiscovery();

    // Accept either:
    //  • 116-byte `65 88` echo  — full captured-replay handshake
    //  • 19-byte  `80 0d` ACK  — zero-body handshake (scale ignores body, confirmed May 2026)
    const raw = await this.main.request(
      this.handshakePacket,
      this.host,
      this.port,
      (msg, rinfo) => {
        if (!this.fromScale(msg, rinfo)) return false;
        const p = stripToPayload(msg);
        return (
          (p.length >= 116 && p.readUInt16BE(11) === 0x6588) ||
          isHandshakeAck(p)
        );
      },
    );
    const resp = stripToPayload(raw);
    const fullResp = parseHandshakeResponse(resp);
    // For the zero-body path the nonce is irrelevant (clock sync uses a fixed 0x24 constant).
    this.sessionNonce = fullResp ? fullResp.nonce : 0;
    this.connected = true;
  }

  /**
   * Send a unicast 71 03 heartbeat packet to the scale and return its device info.
   * Link69 sends this every 5 seconds as a keep-alive. Also useful for connectivity checks.
   */
  async heartbeat(): Promise<DiscoveredScale> {
    return this.sendDiscovery();
  }

  /**
   * Start an automatic background heartbeat that fires every `intervalMs` ms
   * (default: 5000 ms, matching Link69's cadence). Errors are silently swallowed
   * to avoid crashing the caller — monitor the `isConnected` flag or catch errors
   * from data operations instead.
   */
  startHeartbeat(intervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS): void {
    if (this.heartbeatTimer !== null) return;
    this.heartbeatTimer = setInterval(() => {
      this.heartbeat().catch(() => { /* swallow — scale may be temporarily unreachable */ });
    }, intervalMs);
  }

  /** Stop the background heartbeat started by `startHeartbeat()`. */
  stopHeartbeat(): void {
    if (this.heartbeatTimer === null) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  // ── Clock ────────────────────────────────────────────────────────────────

  async syncClock(date: Date = new Date()): Promise<void> {
    this.assertConnected();
    const buf = Buffer.alloc(22, 0);
    MAGIC.copy(buf, 0);
    buf.writeUInt16BE(OP_CLOCK_SYNC, 5);
    buf[11] = 0x07;
    // 0x24 is a fixed protocol constant in all 22 observed clock sync packets —
    // NOT the session handshake nonce as the research initially assumed.
    buf[12] = 0x24;
    buf[13] = toBcdByte(date.getFullYear() % 100);
    buf[14] = toBcdByte(date.getMonth() + 1);
    buf[15] = toBcdByte(date.getDate());
    buf[16] = toBcdByte(date.getHours());
    buf[17] = toBcdByte(date.getMinutes());
    buf[18] = toBcdByte(date.getSeconds());
    appendPacketCrcBe(buf, 13);

    const ack = stripToPayload(
      await this.clock.request(
        buf,
        this.host,
        this.port,
        (msg, rinfo) => this.fromScale(msg, rinfo) && isGeneralAck(stripToPayload(msg)),
      ),
    );
    if (!isGeneralAck(ack)) {
      throw new ScaleError("Clock sync: expected 80 0e ACK", OP_CLOCK_SYNC);
    }
  }

  // ── Parameters ───────────────────────────────────────────────────────────

  async readParams(): Promise<ReadParamsResult> {
    this.assertConnected();
    const req = buildShortRequest(OP_READ_PARAMS, 0x32);
    await this.main.send(req, this.host, this.port);
    const resp = await this.expectOp(OP_READ_PARAMS);
    if (resp.length < 20 || !resp.subarray(13, 17).equals(PARAM_MARKER)) {
      throw new ScaleError("Read params: unexpected response", OP_READ_PARAMS);
    }
    const blob = resp.subarray(17, 17 + PARAM_BLOB_LEN);
    const crcTrailer = resp.subarray(17 + PARAM_BLOB_LEN);
    return { blob: Buffer.from(blob), marker: Buffer.from(PARAM_MARKER), crcTrailer: Buffer.from(crcTrailer) };
  }

  // ── PLU ─────────────────────────────────────────────────────────────────

  /**
   * Download PLU records to the scale (op 98 2e). Each PLU triggers an 80 0e ACK.
   * Clock sync is performed before the first PLU unless `syncClock: false`.
   */
  async setScalePLUs(plus: PluRecord[], options?: { syncClock?: boolean }): Promise<void> {
    this.assertConnected();
    if (options?.syncClock !== false) {
      await this.syncClock();
    }
    for (let i = 0; i < plus.length; i++) {
      const pkt = buildDownloadPluPacket(plus[i]!, i);
      await this.main.send(pkt, this.host, this.port);
      const ack = await this.expectOp(OP_GENERAL_ACK);
      if (!isGeneralAck(ack)) {
        throw new ScaleError(`Download PLU: missing 80 0e ACK`, OP_GENERAL_ACK, i);
      }
    }
  }

  /**
   * Upload all PLU records from the scale (ops 60 33 start + 60 2e × N).
   * Returns the decoded PLU list in the order the scale sends them.
   */
  async getScalePLUs(options?: { syncClock?: boolean }): Promise<PluRecord[]> {
    this.assertConnected();
    // Use request() so the listener is registered before the packet is sent —
    // the scale responds to 60 33 within ~1 ms and would be missed otherwise.
    const startRaw = await this.main.request(
      buildShortRequest(OP_UPLOAD_PLU_START, 0x3d),
      this.host,
      this.port,
      (msg, rinfo) =>
        this.fromScale(msg, rinfo) &&
        readOpCode(stripToPayload(msg)) === OP_UPLOAD_PLU_START,
    );
    const startResp = stripToPayload(startRaw);
    if (startResp.length < 20) {
      throw new ScaleError("Upload PLU: invalid 60 33 response", OP_UPLOAD_PLU_START);
    }
    const count = startResp.readUInt32LE(14);
    if (options?.syncClock !== false) {
      await this.syncClock();
    }
    const results: PluRecord[] = [];
    for (let seq = 0; seq < count; seq++) {
      // The scale sends the next PLU record only AFTER receiving the PC's ACK.
      // Register the listener before sending to prevent a race condition.
      const pluPromise = this.expectOp(OP_UPLOAD_PLU);
      await this.main.send(buildUploadPluAck(seq), this.host, this.port);
      const resp = await pluPromise;
      if (readOpCode(resp) !== OP_UPLOAD_PLU || resp.length < 527) {
        throw new ScaleError(`Upload PLU: expected 527-byte 60 2e packet`, OP_UPLOAD_PLU, seq);
      }
      const { record, lfCodeHighBcd } = extractPluFromUploadPacket(resp);
      results.push(decodePluRecord(record, lfCodeHighBcd));
    }
    return results;
  }

  /**
   * Clear PLU Info on the scale using op 98 30 (confirmed capture 12).
   * This is the native "Clear Device Data → PLU Info" command from Link69 —
   * a single packet that instructs the scale to wipe all PLU records immediately.
   *
   * Flow: clock sync (70 03) → 98 30 → 80 0e ACK.
   * Counter 0x72 = PLU_COUNTER_BASE (same namespace as PLU download).
   *
   * Note: only PLU Info clearing has been captured. Additional captures are needed
   * to determine whether Note 1-4 and Message use the same op with a different
   * counter, or a different op code entirely.
   */
  async clearScalePLUs(options?: { syncClock?: boolean }): Promise<void> {
    this.assertConnected();
    if (options?.syncClock !== false) {
      await this.syncClock();
    }
    const pkt = buildShortRequest(OP_CLEAR_DATA, PLU_COUNTER_BASE);
    await this.main.send(pkt, this.host, this.port);
    const ack = await this.expectOp(OP_GENERAL_ACK);
    if (!isGeneralAck(ack)) {
      throw new ScaleError("Clear PLUs: missing 80 0e ACK", OP_CLEAR_DATA);
    }
  }

  // ── Department ───────────────────────────────────────────────────────────

  /**
   * Download the full 99-slot department table to the scale (op 98 14).
   * Only the provided departments are set active; all other slots are empty.
   */
  async setScaleDepartments(depts: DepartmentRecord[]): Promise<void> {
    this.assertConnected();
    const table = buildDeptTable(depts);
    // 4 records per packet (4 × 64 = 256 bytes body)
    await this.sendTableDownload(OP_DOWNLOAD_DEPT, table, 4, DEPT_COUNTER_BASE);
  }

  // ── Category ─────────────────────────────────────────────────────────────

  /**
   * Download the full 99-slot category name table to the scale (op 98 15).
   * Dept/parent assignments are NOT sent on the wire — they are PC-side only.
   */
  async setScaleCategories(categories: CategoryRecord[]): Promise<void> {
    this.assertConnected();
    const table = buildCategoryTable(categories);
    // 8 records per packet (8 × 32 = 256 bytes body)
    await this.sendTableDownload(OP_DOWNLOAD_CATEGORY, table, 8, CATEGORY_COUNTER_BASE);
  }

  // ── Unit ─────────────────────────────────────────────────────────────────

  /**
   * Download the full 25-slot unit print-name table to the scale (op 98 23).
   * Preset names (g, kg, …) live in firmware and are NOT sent over the wire —
   * only custom display/print names need to be downloaded.
   */
  async setScaleUnits(units: UnitPrintRecord[]): Promise<void> {
    this.assertConnected();
    const table = buildUnitTable(units);
    // 16 records per packet (16 × 16 = 256 bytes body)
    await this.sendTableDownload(OP_DOWNLOAD_UNIT, table, 16, UNIT_COUNTER_BASE);
  }

  // ── Hotkey ───────────────────────────────────────────────────────────────

  /**
   * Download the full 160-slot hotkey table to the scale (op 98 12).
   * Unassigned slots are sent as [00 00 00 00].
   */
  async setScaleHotkeys(hotkeys: HotkeyRecord[]): Promise<void> {
    this.assertConnected();
    const table = buildHotkeyTable(hotkeys);
    // 64 records per packet (64 × 4 = 256 bytes body)
    await this.sendTableDownload(OP_DOWNLOAD_HOTKEY, table, 64, HOTKEY_COUNTER_BASE);
  }

  /**
   * Upload the hotkey table from the scale (ops 60 13 preamble + 60 12 × 3).
   * Returns only the assigned (non-empty) slots.
   */
  async getScaleHotkeys(): Promise<HotkeyRecord[]> {
    this.assertConnected();

    // ── Phase 1: preamble (60 13) ────────────────────────────────────────
    // Scale sends 8 × 271B zero chunks + 1 short 18B end marker in response to
    // each PC ACK. ACK format (confirmed from capture 10):
    //   b8  = chunk_index + 1   (1, 2, ... 8)
    //   b12 = mirror of scale's b12 field from the previous chunk
    // The short end marker is NOT acknowledged.
    const buildPreambleAck = (b8: number, scaleB12: number): Buffer => {
      const buf = Buffer.alloc(13, 0);
      MAGIC.copy(buf, 0);
      buf.writeUInt16BE(OP_UPLOAD_HOTKEY_PREAMBLE, 5);
      buf[8] = b8;
      buf[12] = scaleB12;
      return buf;
    };

    let currentPkt = stripToPayload(
      await this.main.request(
        buildShortRequest(OP_UPLOAD_HOTKEY_PREAMBLE, HOTKEY_UPLOAD_PREAMBLE_COUNTER),
        this.host,
        this.port,
        (msg, rinfo) =>
          this.fromScale(msg, rinfo) &&
          readOpCode(stripToPayload(msg)) === OP_UPLOAD_HOTKEY_PREAMBLE,
      ),
    );

    for (let round = 0; round < 9; round++) {
      if (currentPkt.length < 200) break; // short end marker (18B) — preamble done
      const scaleB12 = currentPkt[12] ?? 0;
      const nextChunkPromise = this.expectOp(OP_UPLOAD_HOTKEY_PREAMBLE);
      await this.main.send(buildPreambleAck(round + 1, scaleB12), this.host, this.port);
      currentPkt = await nextChunkPromise;
    }

    // ── Phase 2: data (60 12 × 3) ────────────────────────────────────────
    // PC sends trigger first (buildHotkeyUploadAck(seq)), scale then responds with data.
    // All 3 chunks are full 271B (64 records × 4B); slots 160-191 in chunk 2 are zeros.
    const hotkeys: HotkeyRecord[] = [];

    for (let seq = 0; seq < 3; seq++) {
      const dataPromise = this.expectOp(OP_UPLOAD_HOTKEY_DATA);
      await this.main.send(buildHotkeyUploadAck(seq), this.host, this.port);
      const dataPkt = await dataPromise;

      for (let i = 0; i < 64; i++) {
        const slot = seq * 64 + i;
        if (slot >= 160) break; // only 160 real hotkey slots
        const offset = 13 + i * HOTKEY_RECORD_SIZE;
        if (dataPkt.length < offset + HOTKEY_RECORD_SIZE) break;
        const hk = decodeHotkeyRecord(dataPkt.subarray(offset, offset + HOTKEY_RECORD_SIZE), slot);
        if (hk) hotkeys.push(hk);
      }
    }

    return hotkeys;
  }

  // ── Label ────────────────────────────────────────────────────────────────

  /**
   * Upload a label template from the scale (ops 60 31 start + 60 20 × N).
   * Returns the raw gzip stream (same binary content as the 98 20 download phase).
   *
   * The scale sends the gzip in the first two 271B packets, followed by ~62
   * all-zero padding packets, and a final short end packet.
   */
  async getScaleLabel(): Promise<LabelUploadResult> {
    this.assertConnected();

    // Step 1: Send 60 31 to request the label slot from the scale.
    const startResp = stripToPayload(
      await this.main.request(
        buildShortRequest(OP_UPLOAD_LABEL_START, LABEL_UPLOAD_START_COUNTER),
        this.host,
        this.port,
        (msg, rinfo) =>
          this.fromScale(msg, rinfo) &&
          readOpCode(stripToPayload(msg)) === OP_UPLOAD_LABEL_START,
      ),
    );
    if (startResp.length < 13) {
      throw new ScaleError("Upload label: invalid 60 31 response", OP_UPLOAD_LABEL_START);
    }

    // Step 2: Re-establish the session. Capture 11u shows Link69 does a full
    // discovery + handshake between the 60 31 response and the 60 20 data phase.
    await this.connect();

    // Step 3: Data phase — PC sends 60 20 trigger first, scale responds with data.
    // 65 round-trips total: first 2 carry gzip content, rest are zero padding,
    // final one is a short packet (18B) that signals end of transfer.
    const bodies: Buffer[] = [];

    for (let seq = 0; ; seq++) {
      const dataPromise = this.expectOp(OP_UPLOAD_LABEL_DATA);
      await this.main.send(buildLabelUploadAck(seq), this.host, this.port);
      const dataPkt = await dataPromise;

      const isShort = dataPkt.length < 200;
      if (!isShort) {
        bodies.push(Buffer.from(dataPkt.subarray(13, dataPkt.length - 2)));
      }
      if (isShort) break;
    }

    return { gzip: extractGzipFromBodies(bodies) };
  }

  /**
   * Download a label template to the scale (ops 98 1e + 98 1f × N + 98 20 × M).
   *
   * Because the 98 1e element-descriptor and 98 1f LabelMap formats are not
   * fully decoded, callers must supply the raw binary bodies from a capture
   * (use `scripts/parse_11_download_label.py` to extract them).
   * The gzip bytes for 98 20 can be obtained via `getScaleLabel()`.
   *
   * **`.tbz` file support:** AClas label files exported from Link69 are typically
   * tar.bz2 archives containing a `.scr` gzip stream and metadata files. A dedicated
   * parser (`parseLabelTbz`) will be added once a real exported `.tbz` file is
   * captured and analyzed. Until then, supply a `LabelDownloadData` directly.
   */
  async setScaleLabel(data: LabelDownloadData): Promise<void> {
    this.assertConnected();

    // Phase 1: 98 1e metadata (single packet, special header with byte 11 = 0xa0)
    {
      const body = data.metadataBody;
      const buf = Buffer.alloc(13 + body.length + 2, 0);
      MAGIC.copy(buf, 0);
      buf.writeUInt16BE(OP_DOWNLOAD_LABEL_META, 5);
      buf[11] = LABEL_META_B11;
      buf[12] = 0x00;
      body.copy(buf, 13);
      appendPacketCrcBe(buf, 13);
      await this.main.send(buf, this.host, this.port);
      const ack = await this.expectOp(OP_GENERAL_ACK);
      if (!isGeneralAck(ack)) throw new ScaleError("Download label meta: missing 80 0e ACK", OP_DOWNLOAD_LABEL_META);
    }

    // Re-establish session between phases. Capture 11 shows Link69 does a full
    // discovery + handshake between the 98 1e ACK and the first 98 1f packet.
    await this.connect();

    // Phase 2: 98 1f LabelMap chunks
    // Counter formula: non-last = base + i; last = (base + (N−2) + lastBodySize) & 0xff
    // This matches the sendTableDownload formula and is confirmed by capture 11 analysis.
    {
      const totalPkts = data.labelMapBodies.length;
      for (let i = 0; i < totalPkts; i++) {
        const body = data.labelMapBodies[i]!;
        const isLast = i === totalPkts - 1;
        const buf = Buffer.alloc(13 + body.length + 2, 0);
        MAGIC.copy(buf, 0);
        buf.writeUInt16BE(OP_DOWNLOAD_LABEL_MAP, 5);
        buf[8] = i;
        buf[10] = isLast ? 0x00 : 0x01;
        buf[12] = isLast
          ? (LABEL_MAP_COUNTER_BASE + (totalPkts - 2) + body.length) & 0xff
          : LABEL_MAP_COUNTER_BASE + i;
        body.copy(buf, 13);
        appendPacketCrcBe(buf, 13);
        await this.main.send(buf, this.host, this.port);
        const ack = await this.expectOp(OP_GENERAL_ACK);
        if (!isGeneralAck(ack)) throw new ScaleError(`Download label map chunk: missing 80 0e ACK`, OP_DOWNLOAD_LABEL_MAP, i);
      }
    }

    // Phase 3: 98 20 gzip (split into 256-byte body chunks)
    // Same last-packet counter formula as 98 1f.
    {
      const CHUNK = 256;
      const gzip = data.gzip;
      const gzipPkts = Math.ceil(gzip.length / CHUNK);
      for (let i = 0; i < gzipPkts; i++) {
        const body = gzip.subarray(i * CHUNK, (i + 1) * CHUNK);
        const isLast = i === gzipPkts - 1;
        const buf = Buffer.alloc(13 + body.length + 2, 0);
        MAGIC.copy(buf, 0);
        buf.writeUInt16BE(OP_DOWNLOAD_LABEL_GZIP, 5);
        buf[8] = i;
        buf[10] = isLast ? 0x00 : 0x01;
        buf[12] = isLast
          ? (LABEL_GZIP_COUNTER_BASE + (gzipPkts - 2) + body.length) & 0xff
          : LABEL_GZIP_COUNTER_BASE + i;
        body.copy(buf, 13);
        appendPacketCrcBe(buf, 13);
        await this.main.send(buf, this.host, this.port);
        const ack = await this.expectOp(OP_GENERAL_ACK);
        if (!isGeneralAck(ack)) throw new ScaleError(`Download label gzip chunk: missing 80 0e ACK`, OP_DOWNLOAD_LABEL_GZIP, i);
      }
    }
  }

  // ── Discovery ────────────────────────────────────────────────────────────

  /**
   * Broadcast a 71 03 discovery packet and collect all responding scales within
   * `timeoutMs` (default: 3000 ms).
   */
  static async discover(
    broadcastHost = "192.168.100.255",
    options?: { port?: number; timeoutMs?: number; localAddress?: string },
  ): Promise<DiscoveredScale[]> {
    const port = options?.port ?? DEFAULT_PORT;
    const timeoutMs = options?.timeoutMs ?? 3000;
    const client = new UdpClient({
      localAddress: options?.localAddress,
      timeoutMs,
      broadcast: true,
    });
    const seen = new Map<string, DiscoveredScale>();
    const off = client.onMessage((msg, rinfo) => {
      const parsed = parseDiscoveryResponse(msg, rinfo.address, rinfo.port);
      if (parsed) seen.set(`${parsed.host}:${parsed.port}`, parsed);
    });
    try {
      await client.send(buildDiscoveryRequest(), broadcastHost, port);
      await new Promise((r) => setTimeout(r, timeoutMs));
    } finally {
      off();
      client.close();
    }
    return [...seen.values()];
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  close(): void {
    this.stopHeartbeat();
    this.main.close();
    this.clock.close();
    this.connected = false;
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private fromScale(_msg: Buffer, rinfo: { address: string }): boolean {
    return rinfo.address === this.host;
  }

  private async expectOp(op: number, timeoutMs?: number): Promise<Buffer> {
    const raw = await this.main.waitFor(
      (msg, rinfo) => this.fromScale(msg, rinfo) && readOpCode(stripToPayload(msg)) === op,
      timeoutMs,
    );
    return stripToPayload(raw.payload);
  }

  /**
   * Send a unicast 71 03 discovery request and await the scale's 271-byte response.
   * Used internally for both session priming (before handshake) and public heartbeat.
   */
  private async sendDiscovery(): Promise<DiscoveredScale> {
    const raw = await this.main.request(
      buildDiscoveryRequest(),
      this.host,
      this.port,
      (msg, rinfo) =>
        this.fromScale(msg, rinfo) &&
        stripToPayload(msg).readUInt16BE(5) === DISCOVERY_OP,
    );
    const parsed = parseDiscoveryResponse(raw, this.host, this.port);
    if (!parsed) {
      throw new ScaleError("Heartbeat: failed to parse discovery response", 0x7103);
    }
    return parsed;
  }

  /**
   * Send a full table (dept / category / unit / hotkey) as multi-packet download.
   *
   * Framing rules shared across ops 98 14 / 98 15 / 98 23 / 98 12:
   *   • 13-byte header  + N × recordSize body + 2-byte CRC
   *   • buf[8]  = packet sequence (0-based)
   *   • buf[10] = 0x01 for non-last packets, 0x00 for last
   *   • buf[12] = counterBase + pktSeq
   *   • CRC over bytes [13 .. length−2]
   *   • Scale ACKs each packet with 80 0e
   */
  private async sendTableDownload(
    op: number,
    records: Buffer[],
    recordsPerPacket: number,
    counterBase: number,
  ): Promise<void> {
    const totalPackets = Math.ceil(records.length / recordsPerPacket);
    for (let pktSeq = 0; pktSeq < totalPackets; pktSeq++) {
      const isLast = pktSeq === totalPackets - 1;
      const slice = records.slice(pktSeq * recordsPerPacket, (pktSeq + 1) * recordsPerPacket);
      const bodySize = slice.reduce((s, r) => s + r.length, 0);
      const buf = Buffer.alloc(13 + bodySize + 2, 0);
      MAGIC.copy(buf, 0);
      buf.writeUInt16BE(op, 5);
      buf[8] = pktSeq;
      buf[10] = isLast ? 0x00 : 0x01;
      if (isLast) {
        // Last packet: b[11] carries the actual body length (tells the scale how
        // many partial records are present), and b[12] follows the captured formula:
        // (counterBase + (totalPackets − 2) + lastBodySize) & 0xff
        buf[11] = bodySize;
        buf[12] = (counterBase + (totalPackets - 2) + bodySize) & 0xff;
      } else {
        buf[12] = counterBase + pktSeq;
      }
      let offset = 13;
      for (const rec of slice) {
        rec.copy(buf, offset);
        offset += rec.length;
      }
      appendPacketCrcBe(buf, 13);
      await this.main.send(buf, this.host, this.port);
      const ack = await this.expectOp(OP_GENERAL_ACK);
      if (!isGeneralAck(ack)) {
        throw new ScaleError(`Table download: missing 80 0e ACK`, op, pktSeq);
      }
    }
  }

  private assertConnected(): void {
    if (!this.connected) {
      throw new Error("Not connected — call connect() first");
    }
  }
}
