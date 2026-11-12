import type { TranscriptSegment } from "../types/transcript";

/**
 * High-performance O(log N) binary search index with O(1) sequential playback memoization.
 * Designed for smooth 60fps UI updates even on 2-hour videos with thousands of segments.
 */
export class SegmentTimeIndex {
  private segments: TranscriptSegment[] = [];
  private lastHitIndex = -1;
  private secondBucketCache = new Map<number, number>();

  constructor(segments: TranscriptSegment[] = []) {
    this.setSegments(segments);
  }

  public setSegments(segments: TranscriptSegment[]): void {
    this.segments = segments;
    this.lastHitIndex = -1;
    this.secondBucketCache.clear();
  }

  public setLastHitIndex(idx: number): void {
    if (idx >= 0 && idx < this.segments.length) {
      this.lastHitIndex = idx;
    }
  }

  /**
   * Finds the exact segment active at `timeSec` (returns -1 if in a silent gap).
   * Overlap-Safe: When multiple segments overlap in time, prioritizes the most recently started segment.
   * Forward-Biased: If the next segment has already started, immediately progresses forward.
   */
  public findActiveSegmentIndex(timeSec: number): number {
    const len = this.segments.length;
    if (len === 0 || !Number.isFinite(timeSec) || timeSec < 0) {
      return -1;
    }

    const isMatch = (seg: TranscriptSegment, idx: number) => {
      if (idx === len - 1) {
        return timeSec >= seg.start && timeSec <= seg.end;
      }
      return timeSec >= seg.start && timeSec < seg.end;
    };

    // 1. O(1) Fast path: Check next segment FIRST (so forward progression takes precedence over overlapping previous segment)
    if (this.lastHitIndex >= 0 && this.lastHitIndex < len) {
      // Check immediate next segment first
      if (this.lastHitIndex + 1 < len) {
        if (isMatch(this.segments[this.lastHitIndex + 1], this.lastHitIndex + 1)) {
          this.lastHitIndex = this.lastHitIndex + 1;
          return this.lastHitIndex;
        }
      }
      // Check current segment
      if (isMatch(this.segments[this.lastHitIndex], this.lastHitIndex)) {
        return this.lastHitIndex;
      }
    }

    // 2. Binary Search for the latest-starting segment where seg.start <= timeSec
    let low = 0;
    let high = len - 1;
    let candidate = -1;

    while (low <= high) {
      const mid = (low + high) >>> 1;
      const seg = this.segments[mid];

      if (seg.start <= timeSec) {
        candidate = mid;
        low = mid + 1; // Seek further right to find the most recent segment that started
      } else {
        high = mid - 1;
      }
    }

    // Check if the latest candidate is currently active
    if (candidate >= 0 && isMatch(this.segments[candidate], candidate)) {
      this.lastHitIndex = candidate;
      return candidate;
    }

    // Check if an earlier overlapping candidate is still running (up to 2 steps back)
    for (let i = candidate - 1; i >= Math.max(0, candidate - 2); i--) {
      if (isMatch(this.segments[i], i)) {
        this.lastHitIndex = i;
        return i;
      }
    }

    return -1;
  }

  /**
   * Finds the nearest segment index to `timeSec` (useful when pinning a timestamp that lands in a pause).
   */
  public findNearestSegmentIndex(timeSec: number): number {
    const len = this.segments.length;
    if (len === 0) return -1;

    const exact = this.findActiveSegmentIndex(timeSec);
    if (exact !== -1) return exact;

    if (timeSec <= this.segments[0].start) return 0;
    if (timeSec >= this.segments[len - 1].end) return len - 1;

    let low = 0;
    let high = len - 1;
    while (low <= high) {
      const mid = (low + high) >>> 1;
      const seg = this.segments[mid];
      if (timeSec < seg.start) {
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }

    // `high` is before timeSec, `low` is after timeSec
    const beforeIdx = Math.max(0, high);
    const afterIdx = Math.min(len - 1, low);
    const distBefore = Math.abs(timeSec - this.segments[beforeIdx].end);
    const distAfter = Math.abs(this.segments[afterIdx].start - timeSec);

    return distBefore <= distAfter ? beforeIdx : afterIdx;
  }
}
