import { gzipSync } from "node:zlib";
import AdmZip from "adm-zip";
import type { LabelDownloadData } from "../types.js";
import { MAGIC, LABEL_UPLOAD_ACK_COUNTER_BASE, OP_UPLOAD_LABEL_DATA } from "./constants.js";

/** Build the 13-byte PC ACK for a Scale→PC 60 20 label data packet. */
export function buildLabelUploadAck(seq: number): Buffer {
  const buf = Buffer.alloc(13, 0);
  MAGIC.copy(buf, 0);
  buf.writeUInt16BE(OP_UPLOAD_LABEL_DATA, 5);
  buf[8] = seq;
  buf[12] = LABEL_UPLOAD_ACK_COUNTER_BASE + seq;
  return buf;
}

/**
 * Parse an AClas label `.tbz` archive (a ZIP file despite the extension) and return the
 * raw wire-protocol components ready for `AclasScale.setScaleLabel()`.
 *
 * Wire mapping (confirmed by byte-for-byte comparison with capture 11):
 *   `0.lf`  (160 B)   → `98 1e` metadata body (`metadataBody`)
 *   `0.lm`  (10 000 B)→ `98 1f` LabelMap bodies split into 256-byte chunks (`labelMapBodies`)
 *   `0.tbl` (CSV)     → gzip-compressed → `98 20` gzip stream (`gzip`)
 *
 * @param tbzBuffer  Raw bytes of the `.tbz` file.
 */
export function parseLabelTbz(tbzBuffer: Buffer): LabelDownloadData {
  const zip = new AdmZip(tbzBuffer);

  const metadataBody = requireZipEntry(zip, "0.lf");
  const lmData = requireZipEntry(zip, "0.lm");
  const tblData = requireZipEntry(zip, "0.tbl");

  const CHUNK = 256;
  const labelMapBodies: Buffer[] = [];
  for (let i = 0; i < lmData.length; i += CHUNK) {
    labelMapBodies.push(Buffer.from(lmData.subarray(i, Math.min(i + CHUNK, lmData.length))));
  }

  return {
    metadataBody: Buffer.from(metadataBody),
    labelMapBodies,
    gzip: gzipSync(tblData),
  };
}

function requireZipEntry(zip: AdmZip, name: string): Buffer {
  const entry = zip.getEntry(name);
  if (!entry) {
    throw new Error(`Invalid .tbz label archive: missing required entry "${name}"`);
  }
  return entry.getData();
}

/**
 * Extract the gzip stream from a sequence of 60 20 Scale→PC packet bodies.
 *
 * The scale sends the gzip in the first N non-zero 256-byte bodies, then
 * 60-something all-zero padding bodies, then a short end packet.
 * This function concatenates all non-zero bodies to recover the gzip stream.
 */
export function extractGzipFromBodies(bodies: Buffer[]): Buffer {
  const nonZero = bodies.filter((b) => b.some((byte) => byte !== 0));
  return Buffer.concat(nonZero);
}
