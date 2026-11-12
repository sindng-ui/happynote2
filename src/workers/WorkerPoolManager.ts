import type { ListeningSessionData, RawTranscriptCue, TranscriptSegment } from "../types/transcript.ts";
import { mergeCuesIntoSegments, type TranscriptProcessOptions } from "./transcriptProcessor.ts";
import type { WorkerRequestMessage, WorkerResponseMessage } from "./transcript.worker.ts";

declare const __INLINE_WORKER_CODE__: string | undefined;

/**
 * Manages background Web Workers for heavy transcript merging, phonetic analysis,
 * and large session JSON parsing.
 * Automatically scales across multiple workers for large datasets and falls back cleanly in Node CLI tests.
 */
export class TranscriptWorkerManager {
  private workers: Worker[] = [];
  private roundRobinIdx = 0;
  private poolSize: number;
  private pendingCallbacks = new Map<
    string,
    {
      resolve: (data: any) => void;
      reject: (err: Error) => void;
    }
  >();

  constructor(poolSize = 2) {
    this.poolSize = poolSize;
    this.initWorkerPool();
  }

  private initWorkerPool(): void {
    if (typeof Worker === "undefined" || typeof Blob === "undefined") {
      return;
    }

    const code = typeof __INLINE_WORKER_CODE__ !== "undefined" ? __INLINE_WORKER_CODE__ : "";
    if (!code) return;

    try {
      const blob = new Blob([code], { type: "application/javascript" });
      const url = URL.createObjectURL(blob);

      for (let i = 0; i < this.poolSize; i++) {
        const worker = new Worker(url);
        worker.onmessage = (event: MessageEvent<WorkerResponseMessage>) => {
          const data = event.data;
          const pending = this.pendingCallbacks.get(data.id);
          if (!pending) return;
          this.pendingCallbacks.delete(data.id);

          if (data.type === "PROCESS_TRANSCRIPT_RESULT") {
            pending.resolve(data.segments || []);
          } else if (data.type === "PARSE_SESSION_RESULT") {
            pending.resolve(data.session ?? null);
          } else {
            pending.reject(new Error(data.error || "Unknown worker error"));
          }
        };
        this.workers.push(worker);
      }
    } catch {
      // Fallback to async main-thread execution if CSP blocks Blob workers
      this.workers = [];
    }
  }

  public async processCuesAsync(
    cues: RawTranscriptCue[],
    options: TranscriptProcessOptions
  ): Promise<TranscriptSegment[]> {
    if (this.workers.length === 0) {
      return mergeCuesIntoSegments(cues, options);
    }

    const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const worker = this.workers[this.roundRobinIdx % this.workers.length];
    this.roundRobinIdx++;

    return new Promise<TranscriptSegment[]>((resolve, reject) => {
      this.pendingCallbacks.set(requestId, { resolve, reject });
      const payload: WorkerRequestMessage = {
        id: requestId,
        type: "PROCESS_TRANSCRIPT",
        cues,
        options,
      };
      worker.postMessage(payload);
    });
  }

  public async parseSessionAsync(markdown: string): Promise<ListeningSessionData | null> {
    if (this.workers.length === 0) {
      const startTag = "```ear-coach-session";
      const startIdx = markdown.indexOf(startTag);
      if (startIdx === -1) return null;
      const jsonStart = startIdx + startTag.length;
      const endIdx = markdown.indexOf("```", jsonStart);
      if (endIdx === -1) return null;
      const rawJson = markdown.slice(jsonStart, endIdx).trim();
      try {
        return JSON.parse(rawJson) as ListeningSessionData;
      } catch {
        return null;
      }
    }

    const requestId = `parse-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const worker = this.workers[this.roundRobinIdx % this.workers.length];
    this.roundRobinIdx++;

    return new Promise<ListeningSessionData | null>((resolve, reject) => {
      this.pendingCallbacks.set(requestId, { resolve, reject });
      const payload: WorkerRequestMessage = {
        id: requestId,
        type: "PARSE_SESSION",
        markdown,
      };
      worker.postMessage(payload);
    });
  }

  public destroy(): void {
    for (const worker of this.workers) {
      worker.terminate();
    }
    this.workers = [];
    this.pendingCallbacks.clear();
  }
}
