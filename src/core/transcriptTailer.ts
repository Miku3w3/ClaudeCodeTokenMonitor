/**
 * Incremental transcript tailer.
 *
 * Reads only the bytes appended since the previous call and returns complete
 * parsed events. Incomplete trailing lines are retained until their newline
 * arrives. When the file shrinks (truncated/rotated), the tailer resets and
 * replays the file from byte 0, reporting `truncated: true` so the caller can
 * clear its accumulators before applying the replayed events.
 */
import * as fs from 'fs';
import { parseLine } from '../parsers/TranscriptParser';
import type { ParsedEvent } from '../model/types';
import { JsonlLineBuffer } from './lineBuffer';

export interface TailReadResult {
  events: ParsedEvent[];
  /** The file shrank; events are a full replay from byte 0. */
  truncated: boolean;
  /** The file could not be read (missing or permission error). */
  missing: boolean;
  bytesRead: number;
  lineCount: number;
}

export class TranscriptTailer {
  private offset = 0;
  private readonly buffer = new JsonlLineBuffer();

  constructor(private readonly parser: (line: string) => ParsedEvent | null = parseLine) {}

  read(filePath: string): TailReadResult {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return { events: [], truncated: false, missing: true, bytesRead: 0, lineCount: 0 };
    }

    let truncated = false;
    if (stat.size < this.offset) {
      this.reset();
      truncated = true;
    }

    if (stat.size === this.offset) {
      return { events: [], truncated, missing: false, bytesRead: 0, lineCount: 0 };
    }

    const bytesToRead = stat.size - this.offset;
    const chunk = Buffer.alloc(bytesToRead);
    let fd: number | undefined;
    try {
      fd = fs.openSync(filePath, 'r');
      const read = fs.readSync(fd, chunk, 0, bytesToRead, this.offset);
      this.offset = stat.size;
      if (read < bytesToRead) {
        // File shrank between stat and read; let the next call handle it.
        this.offset = this.offset - (bytesToRead - read);
      }
    } catch {
      return { events: [], truncated: false, missing: true, bytesRead: 0, lineCount: 0 };
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }

    const lines = this.buffer.push(chunk);
    const events: ParsedEvent[] = [];
    for (const line of lines) {
      const event = this.parser(line);
      if (event) events.push(event);
    }
    return { events, truncated, missing: false, bytesRead: bytesToRead, lineCount: lines.length };
  }

  reset(): void {
    this.offset = 0;
    this.buffer.reset();
  }

  get position(): number {
    return this.offset;
  }

  get pendingBytes(): number {
    return this.buffer.pendingBytes;
  }
}