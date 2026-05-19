/**
 * Thrown by AclasScale methods when a scale operation fails.
 * Distinguishes scale protocol errors from network/timeout errors.
 */
export class ScaleError extends Error {
  /** Hex string of the op code involved, e.g. "980e". */
  readonly op: string;
  /** Zero-based packet or sequence index within the operation, if applicable. */
  readonly seqIndex: number | undefined;

  constructor(message: string, op: number, seqIndex?: number) {
    super(message);
    this.name = "ScaleError";
    this.op = op.toString(16).padStart(4, "0");
    this.seqIndex = seqIndex;
  }
}
