export const DEFAULT_PORT = 5002;
export const MAGIC = Buffer.from([0xaa, 0x00, 0x00, 0x00, 0x00]);

export const OP_DISCOVERY              = 0x7103;
export const OP_HANDSHAKE_WRAPPER      = 0x7108;
export const OP_HANDSHAKE              = 0x6588;
export const OP_READ_PARAMS            = 0x6028;
export const OP_WRITE_PARAMS           = 0x9850;
export const OP_CLOCK_SYNC             = 0x7003;
export const OP_DOWNLOAD_PLU           = 0x982e;
export const OP_UPLOAD_PLU_START       = 0x6033;
export const OP_UPLOAD_PLU             = 0x602e;
export const OP_GENERAL_ACK            = 0x800e;

// Clear device data op (98 30 — confirmed capture 12)
export const OP_CLEAR_DATA             = 0x9830;  // PLU Info clear; counter = PLU_COUNTER_BASE (0x72)

// Table download ops (all use 80 0e ACK per packet)
export const OP_DOWNLOAD_DEPT          = 0x9814;
export const OP_DOWNLOAD_CATEGORY      = 0x9815;
export const OP_DOWNLOAD_UNIT          = 0x9823;
export const OP_DOWNLOAD_HOTKEY        = 0x9812;

// Hotkey upload ops (Scale→PC data, no 80 0e)
export const OP_UPLOAD_HOTKEY_PREAMBLE = 0x6013;  // preamble round-trips
export const OP_UPLOAD_HOTKEY_DATA     = 0x6012;  // actual hotkey records

// Label download ops (all use 80 0e ACK per packet)
export const OP_DOWNLOAD_LABEL_META    = 0x981e;  // element descriptor (175B)
export const OP_DOWNLOAD_LABEL_MAP     = 0x981f;  // LabelMap binary chunks
export const OP_DOWNLOAD_LABEL_GZIP    = 0x9820;  // gzip template stream

// Label upload ops (Scale→PC data, PC sends 60 20 ACKs)
export const OP_UPLOAD_LABEL_START     = 0x6031;
export const OP_UPLOAD_LABEL_DATA      = 0x6020;

export const HANDSHAKE_PREFIX = Buffer.from([
  0x03, 0x05, 0x01, 0x04, 0x0c, 0x04, 0x03, 0x04, 0x01, 0x04,
]);
export const HANDSHAKE_MAGIC = Buffer.from("ACLAS", "ascii");

export const PLU_RECORD_SIZE = 512;
export const PLU_PACKET_SIZE = 527;
export const PLU_COUNTER_BASE = 0x72;
export const PLU_UPLOAD_COUNTER_BASE = 0x3a;

// Table download: direction byte at buf[10] (0x01 for non-last, 0x00 for last)
// Counter formula (per research §4.9–4.12): 0x58 + (op_low_byte − 0x15)
export const DEPT_COUNTER_BASE     = 0x57;  // 98 14
export const CATEGORY_COUNTER_BASE = 0x58;  // 98 15
export const UNIT_COUNTER_BASE     = 0x66;  // 98 23
export const HOTKEY_COUNTER_BASE   = 0x55;  // 98 12

// Hotkey upload counters
export const HOTKEY_UPLOAD_PREAMBLE_COUNTER = 0x1d;  // byte 12 of initial 60 13
export const HOTKEY_UPLOAD_DATA_COUNTER_BASE = 0x1c; // byte 12 of 60 12 ACK = 0x1c + seq

// Label download counters (byte 12 unless noted)
export const LABEL_META_B11        = 0xa0;  // byte 11 of 98 1e (special)
export const LABEL_MAP_COUNTER_BASE  = 0x62;  // byte 12 of 98 1f
export const LABEL_GZIP_COUNTER_BASE = 0x62;  // byte 12 of 98 20 (assumed same base)

// Label upload counters
export const LABEL_UPLOAD_START_COUNTER   = 0x3b;  // byte 12 of 60 31 PC request
export const LABEL_UPLOAD_ACK_COUNTER_BASE = 0x2a; // byte 12 of 60 20 PC ACKs

export const PARAM_MARKER = Buffer.from([0xaa, 0x55, 0xaa, 0x55]);
export const PARAM_BLOB_LEN = 251;
