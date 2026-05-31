export { AclasScale } from "./AclasScale.js";
export { ScaleError } from "./ScaleError.js";
export type {
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

// PLU helpers
export { buildDownloadPluPacket, decodePluRecord, encodePluRecord } from "./protocol/plu.js";

// Windows-1256 (CP-1256) text encoding — used for PLU Name1/Name2 (supports Arabic).
export { decodeCp1256, encodeCp1256 } from "./protocol/cp1256.js";

// Table record helpers
export {
  buildDeptTable,
  decodeDeptRecord,
  encodeDeptRecord,
} from "./protocol/department.js";
export {
  buildCategoryTable,
  decodeCategoryRecord,
  encodeCategoryRecord,
} from "./protocol/category.js";
export {
  buildUnitTable,
  decodeUnitRecord,
  encodeUnitRecord,
} from "./protocol/unit.js";
export {
  buildHotkeyTable,
  buildHotkeyUploadAck,
  decodeHotkeyRecord,
  encodeHotkeyRecord,
} from "./protocol/hotkey.js";
export { buildLabelUploadAck, extractGzipFromBodies, parseLabelTbz } from "./protocol/label.js";

// Handshake / connection helpers
export {
  buildZeroBodyHandshake,
  buildHandshakeFromCapture,
  handshakePacketFromHex,
  isHandshakeAck,
  validateHandshakeReplay,
  HANDSHAKE_PACKET_LEN,
  OP_HANDSHAKE_ACK,
} from "./protocol/handshake.js";

// CRC helpers
export {
  appendPacketCrcBe,
  appendPluPacketCrc,
  crc16CcittFalse,
  verifyPacketCrcBe,
} from "./protocol/crc.js";
// crc16Modbus is intentionally NOT exported — it was a failed hypothesis during
// protocol research and is not part of the public API.

// Discovery helper
export { buildDiscoveryRequest } from "./protocol/discovery.js";
