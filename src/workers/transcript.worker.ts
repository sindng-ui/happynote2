import { ListeningSessionData, RawTranscriptCue, TranscriptSegment } from "../types/transcript";
import { mergeCuesIntoSegments, TranscriptProcessOptions } from "./transcriptProcessor";

export interface WorkerRequestMessage {
  id: string;
  type: "PROCESS_TRANSCRIPT" | "PARSE_SESSION";
  cues?: RawTranscriptCue[];
  options?: TranscriptProcessOptions;
  markdown?: string;
}

export interface WorkerResponseMessage {
  id: string;
  type:
    | "PROCESS_TRANSCRIPT_RESULT"
    | "PROCESS_TRANSCRIPT_ERROR"
    | "PARSE_SESSION_RESULT"
    | "PARSE_SESSION_ERROR";
  segments?: TranscriptSegment[];
  session?: ListeningSessionData | null;
  error?: string;
}

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (event: MessageEvent<WorkerRequestMessage>) => {
  const msg = event.data;
  if (!msg) return;

  if (msg.type === "PROCESS_TRANSCRIPT" && msg.cues && msg.options) {
    try {
      const segments = mergeCuesIntoSegments(msg.cues, msg.options);
      const response: WorkerResponseMessage = {
        id: msg.id,
        type: "PROCESS_TRANSCRIPT_RESULT",
        segments,
      };
      ctx.postMessage(response);
    } catch (err) {
      const response: WorkerResponseMessage = {
        id: msg.id,
        type: "PROCESS_TRANSCRIPT_ERROR",
        error: err instanceof Error ? err.message : String(err),
      };
      ctx.postMessage(response);
    }
    return;
  }

  if (msg.type === "PARSE_SESSION" && msg.markdown) {
    try {
      const startTag = "```ear-coach-session";
      const endTag = "```";
      const startIdx = msg.markdown.indexOf(startTag);
      if (startIdx === -1) {
        ctx.postMessage({ id: msg.id, type: "PARSE_SESSION_RESULT", session: null });
        return;
      }
      const jsonStart = startIdx + startTag.length;
      const endIdx = msg.markdown.indexOf(endTag, jsonStart);
      if (endIdx === -1) {
        ctx.postMessage({ id: msg.id, type: "PARSE_SESSION_RESULT", session: null });
        return;
      }
      const rawJson = msg.markdown.slice(jsonStart, endIdx).trim();
      const session = JSON.parse(rawJson) as ListeningSessionData;
      ctx.postMessage({ id: msg.id, type: "PARSE_SESSION_RESULT", session });
    } catch (err) {
      ctx.postMessage({
        id: msg.id,
        type: "PARSE_SESSION_ERROR",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
};
