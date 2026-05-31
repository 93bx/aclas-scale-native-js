# @93bx/aclas-scale-native-js

Node.js/TypeScript client for **AClas Link69 / Link66** label-weighing scales over a LAN.

Communicates via UDP port 5002 — the same binary protocol used by the official
AClas Link69 PC software. All major operations are supported: PLU management,
department/category/unit/hotkey tables, label upload/download, clock sync,
parameter read/write, and device discovery.

Protocol reverse-engineered from Wireshark captures of an AClas LS5Z7 scale.

---

## What's new in 0.2.0

This is a **breaking** release that fixes two protocol issues uncovered by live
testing on 2026-05-31. Upgrading from `0.1.x` requires changes if you set PLU
prices in your application.

### Fixes

- **PLU download silently dropped by the scale for `LFCode ≥ 100`** — the
  `98 2e` packet CRC range was wrong. The CRC now covers `buf[13..525]` (which
  includes the LFCode HIGH byte at `buf[14]`), matching every captured Link69
  packet (5/5 in capture 14, 30/30 in capture 14B). Previously a CRC that
  excluded `buf[14]` produced wrong checksums whenever `buf[14] != 0`, so the
  scale dropped those packets without an ACK and the client saw a 5-second UDP
  receive timeout. `LFCode < 100` packets happened to verify because a leading
  zero byte does not change a CCITT-FALSE CRC. Symptom: `setScalePLUs` worked
  for `LFCode 1–99` and timed out for `LFCode 100–9999`.

### Breaking API changes

- **`unitPrice` and `memberPrice` are now integers 0–9999**, stored as-is in
  BCD at `rec[139-140]` and `rec[250-251]`. There is no implicit `×100` (cents)
  conversion on the wire. Decimal placement is governed by the scale's own
  display setting.

  | Before (0.1.x) | After (0.2.0) | Wire bytes |
  | --- | --- | --- |
  | `unitPrice: 15.00`   | `unitPrice: 1500` | `[0x15, 0x00]` |
  | `unitPrice: 0.15`    | `unitPrice: 15`   | `[0x00, 0x15]` |
  | `unitPrice: 99.99`   | `unitPrice: 9999` | `[0x99, 0x99]` |

  The decoder side (`decodePluRecord` / `getScalePLUs`) is symmetric: it now
  returns the raw integer instead of dividing by 100. The previous "cents"
  interpretation was a misread of the same evidence — Link69 PC also reads back
  the raw value, which is why setting `unitPrice: 10` in 0.1.x and reading via
  Link69 showed `1001` (storing 1000 cents) instead of `10`.

  **Migration:** if your old code did `unitPrice: dollars`, change it to
  `unitPrice: Math.round(dollars * 100)` (or just type the integer you want the
  scale to display).

- **`lfCode` now accepts 0–9999** (was effectively 0–99 in 0.1.x — the high byte
  was missing from the wire). 2-byte BCD split across `buf[14]` (header) and
  `rec[0]` (record body). Calling `buildDownloadPluPacket` / `setScalePLUs`
  with `lfCode > 9999` throws `RangeError`.

- **`code` now accepts 0–999999** (3-byte BCD at `rec[8-10]`; was effectively
  0–99 in 0.1.x).

- **`name1` / `name2` are encoded as Windows-1256 (CP-1256)**, supporting
  Arabic characters. ASCII-only text is byte-for-byte identical to the previous
  ASCII encoding, so existing English-only PLUs continue to work unchanged.

### Internal

- New regression tests lock in the CRC range against captures 14/14B and the
  new `unitPrice` integer semantics (`tests/plu-encoding.mjs`, 23/23 pass).
- `scripts/verify_crc.py` now exercises the `buf[14] != 0` cases too.

---

## Requirements

- **Node.js ≥ 18**
- Scale reachable over UDP on port 5002 (default)
- No extra OS drivers needed; pure UDP sockets

---

## Installation

```bash
npm install @93bx/aclas-scale-native-js
```

---

## Quick Start

```typescript
import { AclasScale } from '@93bx/aclas-scale-native-js';

// One-liner: discover → handshake → ready
const scale = await AclasScale.connect('192.168.1.100');

// Write a PLU
await scale.setScalePLUs([{
  lfCode:           1,
  code:             100,
  barcodeStartCode: 99,
  name1:            'Fresh Apples',
  unitPrice:        350,    // integer 0–9999, stored as-is; scale's decimal setting governs display
  unitId:           4,      // 4 = kg
  barcodeType1:     7,      // 7 = EAN-13 weight (Link69 default)
}]);

// Read PLUs back from the scale
const plus = await scale.getScalePLUs();
console.log(plus);

scale.close();
```

---

## API Reference

### `AclasScale.connect(host, options?)` → `Promise<AclasScale>`

Static factory: creates an instance, runs discovery + handshake, and returns the
connected object. Equivalent to `new AclasScale({ host }) + scale.connect()`.

```typescript
const scale = await AclasScale.connect('192.168.1.100', { timeoutMs: 8000 });
```

### `new AclasScale(options)`

```typescript
interface AclasScaleOptions {
  host:             string;   // Scale IP address
  port?:            number;   // Default: 5002
  localAddress?:    string;   // Bind to a specific local interface
  timeoutMs?:       number;   // UDP timeout per operation (default: 5000 ms)
  handshakeReplay?: Buffer;   // Optional: 116-byte captured handshake packet (legacy)
  handshakeNonce?:  number;   // Optional: override nonce in handshakeReplay
}
```

> **Zero-body handshake (default):** The scale does not validate the session body.
> No Wireshark capture is required — `buildZeroBodyHandshake()` is used automatically.

### `scale.connect()` → `Promise<void>`

Run discovery (op `71 03`) then handshake (op `65 88`). Must be called before
any data operation. The static `AclasScale.connect()` factory calls this for you.

### `scale.close()`

Stop the heartbeat timer and close all UDP sockets. Always call this when done.

---

### PLU

#### `scale.setScalePLUs(plus, options?)` → `Promise<void>`

Download PLU records to the scale (op `98 2e`). Sends a clock sync first unless
`{ syncClock: false }` is passed.

```typescript
await scale.setScalePLUs([
  { lfCode: 1, code: 100, barcodeStartCode: 99, name1: 'Banana', unitPrice: 120, unitId: 4, barcodeType1: 7 },
  { lfCode: 2, code: 200, barcodeStartCode: 99, name1: 'Apple',  unitPrice: 350, unitId: 4, barcodeType1: 7 },
]);
```

#### `scale.getScalePLUs(options?)` → `Promise<PluRecord[]>`

Upload all PLU records from the scale (ops `60 33` + `60 2e` × N).

#### `scale.clearScalePLUs(options?)` → `Promise<void>`

Clear all PLU Info on the scale (op `98 30` — "Clear Device Data → PLU Info").

#### `PluRecord`

```typescript
interface PluRecord {
  lfCode:            number;   // 0–9999. 2-byte BCD split across packet header buf[14] and rec[0]
  code:              number;   // 0–999999. 3-byte BCD at rec[8-10]
  barcodeStartCode:  number;   // BCD, e.g. 99 (typical EAN-13 weight prefix)
  name1:             string;   // Up to 20 chars, Windows-1256 (CP-1256) — supports Arabic
  unitPrice:         number;   // Integer 0–9999, stored as-is (no implicit ×100). 1500 → "1500"; 15 → "15"
  unitId:            number;   // 1=g, 4=kg (see UnitPrintRecord for custom names)
  barcodeType1:      number;   // Binary type ID (e.g. 1=EAN13, 7=EAN13 weight, 11=Code128)
  // optional
  categoryId?:       number;
  name2?:            string;   // Up to 20 chars, Windows-1256 (CP-1256)
  memberPrice?:      number;   // Integer 0–9999, same semantics as unitPrice
  shelfDate?:        number;   // Shelf life in days
  mainLabelId?:      number;
  tare?:             number;   // Grams (BCD, 0–99)
  tax1Percent?:      number;   // Percentage (BCD, 0–99)
  message1Id?:       number;
}
```

---

### Department / Category / Unit / Hotkey

#### `scale.setScaleDepartments(depts)` → `Promise<void>`

Download the full 99-slot department table (op `98 14`).
Only provided entries are set active; all other slots are cleared.

```typescript
await scale.setScaleDepartments([
  { id: 1, name: 'Produce', active: true },
  { id: 2, name: 'Dairy' },
]);
```

#### `scale.setScaleCategories(cats)` → `Promise<void>`

Download the full 99-slot category name table (op `98 15`).
Department/parent assignment is managed by the PC — not sent on the wire.

#### `scale.setScaleUnits(units)` → `Promise<void>`

Download custom display/print names for unit slots (op `98 23`).
Firmware preset names (g, kg, …) are not overwritten by this command.

```typescript
await scale.setScaleUnits([{ id: 0, printName: 'grams' }]);
```

#### `scale.setScaleHotkeys(hotkeys)` → `Promise<void>`

Download the full 160-slot hotkey assignment table (op `98 12`).

```typescript
await scale.setScaleHotkeys([{ slot: 0, lfCode: 1 }, { slot: 1, lfCode: 2 }]);
```

#### `scale.getScaleHotkeys()` → `Promise<HotkeyRecord[]>`

Upload the hotkey table from the scale (ops `60 13` + `60 12` × 3).
Returns only the assigned (non-empty) slots.

---

### Label

#### `scale.setScaleLabel(data)` → `Promise<void>`

Download a label template to the scale (ops `98 1e` + `98 1f` × N + `98 20`).

Because the element-descriptor (`98 1e`) and LabelMap (`98 1f`) binary formats
are not fully decoded, supply the raw bodies from a capture or use `parseLabelTbz()`
with an exported `.tbz` label file.

```typescript
import { parseLabelTbz } from '@93bx/aclas-scale-native-js';
import { readFileSync } from 'node:fs';

const tbz = readFileSync('my-label.tbz');
await scale.setScaleLabel(parseLabelTbz(tbz));
```

#### `scale.getScaleLabel()` → `Promise<LabelUploadResult>`

Upload the active label template gzip stream from the scale (ops `60 31` + `60 20` × N).

---

### Parameters

#### `scale.readParams()` → `Promise<ReadParamsResult>`

Read the scale's parameter blob (op `60 28`). Returns the raw 251-byte blob.
Use `scale.writeParams(blob)` (future) to write changes back.

---

### Discovery

#### `AclasScale.discover(broadcastHost?, options?)` → `Promise<DiscoveredScale[]>`

Broadcast a `71 03` discovery packet and collect all responding scales.

```typescript
const scales = await AclasScale.discover('192.168.1.255', { timeoutMs: 3000 });
for (const s of scales) {
  console.log(`${s.model} ${s.serialNumber} @ ${s.host} — ${s.firmware}`);
}
```

#### `DiscoveredScale`

```typescript
interface DiscoveredScale {
  host:          string;
  port:          number;
  model:         string;   // e.g. "LS5Z7"
  serialNumber:  string;   // e.g. "24210002"
  firmware:      string;   // e.g. "V7.429"
  firmwareSub:   number;
  firmwareBuild: string;   // e.g. "F-HF527"
  firmwareRev:   string;   // e.g. "R299"
  internalModel: string;   // e.g. "LS5RZX"
  zoneName:      string;   // "TRACE NULL" = not configured
  requesterMac:  string;   // PC MAC echoed back by the scale
  rawResponse:   Buffer;
}
```

---

### Heartbeat

```typescript
scale.startHeartbeat();        // fires every 5 s (matches Link69 cadence)
scale.startHeartbeat(10_000);  // custom interval
scale.stopHeartbeat();
const info = await scale.heartbeat();  // one-shot unicast 71 03
```

---

### Clock Sync

#### `scale.syncClock(date?)` → `Promise<void>`

Send a `70 03` BCD timestamp to the scale. Called automatically before PLU downloads.

---

### Error Handling

All operations throw `ScaleError` on protocol failures:

```typescript
import { ScaleError } from '@93bx/aclas-scale-native-js';

try {
  await scale.setScalePLUs(plus);
} catch (err) {
  if (err instanceof ScaleError) {
    console.error(`Scale op 0x${err.op} failed at seq ${err.seqIndex}: ${err.message}`);
  }
}
```

Network/timeout errors throw plain `Error` with a descriptive message.

---

### Low-level helpers

The package also exports protocol primitives for advanced use:

```typescript
import {
  crc16CcittFalse,
  appendPacketCrcBe,
  verifyPacketCrcBe,
  buildZeroBodyHandshake,
  buildDiscoveryRequest,
  encodePluRecord,
  decodePluRecord,
  buildDownloadPluPacket,
  encodeDeptRecord,
  decodeDeptRecord,
  encodeCategoryRecord,
  encodeUnitRecord,
  encodeHotkeyRecord,
  parseLabelTbz,
  extractGzipFromBodies,
} from '@93bx/aclas-scale-native-js';
```

---

## Protocol Notes

- All communication is **UDP port 5002** — there is no TCP.
- Tested against an **AClas LS5Z7** scale running firmware V7.429.
- **CRC:** CRC-16/CCITT-FALSE (poly 0x1021, init 0x0000), big-endian on wire.
  PLU packets (`98 2e` / `60 2e`) compute CRC over `buf[13..525]`, which
  **includes `buf[14]` (LFCode HIGH byte)**.
- **BCD encoding:** integers are packed BCD, two decimal digits per byte.
  `unitPrice: 1500 → [0x15, 0x00]`; `unitPrice: 15 → [0x00, 0x15]`; single-byte
  fields like `tare: 15 → 0x15`. Prices are stored as-is — the scale's own
  display setting (firmware-side) determines whether `1500` renders as `1500`
  or `15.00`.
- **Department↔PLU mapping:** departments are assigned to *categories*, not
  directly to PLUs. Set `categoryId` on a PLU and download the category/dept
  tables separately.
- **Label metadata:** the `98 1e` element-descriptor and `98 1f` LabelMap binary
  formats are partially decoded. Use `parseLabelTbz()` with files exported from
  the official Link69 software as the practical path.

---

## License

MIT
