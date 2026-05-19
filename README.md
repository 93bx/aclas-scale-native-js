# @93bx/aclas-scale-native-js

Node.js/TypeScript client for **AClas Link69 / Link66** label-weighing scales over a LAN.

Communicates via UDP port 5002 — the same binary protocol used by the official
AClas Link69 PC software. All major operations are supported: PLU management,
department/category/unit/hotkey tables, label upload/download, clock sync,
parameter read/write, and device discovery.

Protocol reverse-engineered from Wireshark captures of an AClas LS5Z7 scale.

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
  unitPrice:        3.50,
  unitId:           4,     // 4 = kg
  barcodeType1:     1,
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
  { lfCode: 1, code: 100, barcodeStartCode: 99, name1: 'Banana', unitPrice: 1.20, unitId: 4, barcodeType1: 1 },
  { lfCode: 2, code: 200, barcodeStartCode: 99, name1: 'Apple',  unitPrice: 3.50, unitId: 4, barcodeType1: 1 },
]);
```

#### `scale.getScalePLUs(options?)` → `Promise<PluRecord[]>`

Upload all PLU records from the scale (ops `60 33` + `60 2e` × N).

#### `scale.clearScalePLUs(options?)` → `Promise<void>`

Clear all PLU Info on the scale (op `98 30` — "Clear Device Data → PLU Info").

#### `PluRecord`

```typescript
interface PluRecord {
  lfCode:            number;   // BCD-encoded wire ID (1–99)
  code:              number;   // Receipt/report code
  barcodeStartCode:  number;   // BCD, e.g. 99
  name1:             string;   // Up to 20 ASCII chars
  unitPrice:         number;   // Decimal price, e.g. 9.99
  unitId:            number;   // 1=g, 4=kg (see UnitPrintRecord for custom names)
  barcodeType1:      number;   // Binary type ID (e.g. 1=EAN13, 11=Code128)
  // optional
  categoryId?:       number;
  name2?:            string;   // Up to 20 ASCII chars
  memberPrice?:      number;
  shelfDate?:        number;   // Shelf life in days
  mainLabelId?:      number;
  tare?:             number;   // Grams (BCD)
  tax1Percent?:      number;   // Percentage (BCD)
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
- **BCD encoding:** price 10.00 → `[0x10, 0x00]`; value 15 → `0x15`.
- **Department↔PLU mapping:** departments are assigned to *categories*, not
  directly to PLUs. Set `categoryId` on a PLU and download the category/dept
  tables separately.
- **Label metadata:** the `98 1e` element-descriptor and `98 1f` LabelMap binary
  formats are partially decoded. Use `parseLabelTbz()` with files exported from
  the official Link69 software as the practical path.

---

## License

MIT
