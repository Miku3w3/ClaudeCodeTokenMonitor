/**
 * Incremental JSONL line buffer.
 *
 * Transcript files are appended while Claude Code writes them, so a read can
 * end in the middle of a line (even in the middle of a multi-byte UTF-8
 * character). This buffer holds the incomplete tail until the terminating
 * newline arrives, and only ever returns complete lines.
 */
export class JsonlLineBuffer {
  private partial: Buffer = Buffer.alloc(0);

  /** Feed newly read bytes; returns every complete, non-empty line now available. */
  push(chunk: Buffer): string[] {
    if (!chunk || chunk.length === 0) return [];
    const combined = this.partial.length > 0
      ? Buffer.concat([this.partial, chunk])
      : chunk;

    const lastNewline = combined.lastIndexOf(0x0A);
    if (lastNewline < 0) {
      this.partial = Buffer.from(combined);
      return [];
    }

    this.partial = Buffer.from(combined.subarray(lastNewline + 1));
    return combined
      .subarray(0, lastNewline + 1)
      .toString('utf-8')
      .split('\n')
      .filter(line => line.trim().length > 0);
  }

  /** Number of bytes waiting for their newline. */
  get pendingBytes(): number {
    return this.partial.length;
  }

  reset(): void {
    this.partial = Buffer.alloc(0);
  }
}