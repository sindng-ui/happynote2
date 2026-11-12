import { ListeningTrapType, SegmentPhoneticAnalysis } from "./transcript";

/**
 * Request payload for batch phonetic analysis via `agy -p --output-format json --json-schema`.
 */
export interface AgyBatchAnalysisRequest {
  videoTitle: string;
  segments: Array<{
    index: number;
    text: string;
    wpm: number;
    isPinned: boolean;
  }>;
}

/**
 * Structured item returned by `agy` batch analysis for a specific segment index.
 */
export interface AgyBatchAnalysisItem extends SegmentPhoneticAnalysis {
  segmentIndex: number;
}

/**
 * Top-level structured JSON response enforced by `--json-schema`.
 */
export interface AgyBatchAnalysisResponse {
  summaryKr: string;
  keyListeningPoints: string[];
  items: AgyBatchAnalysisItem[];
}

/**
 * Request payload for 1:1 interactive sound doctor coaching via `agy`.
 */
export interface AgySoundDoctorRequest {
  videoTitle: string;
  segmentIndex: number;
  segmentText: string;
  previousSegmentText?: string;
  nextSegmentText?: string;
  wpm: number;
  userHeard: string;
  userQuestion: string;
  conversationId?: string;
}

/**
 * Streaming callback handlers for real-time token updates from `agy`.
 */
export interface AgyStreamCallbacks {
  onToken: (delta: string, fullText: string) => void;
  onConversationId?: (conversationId: string) => void;
  onDetectedTrap?: (trap: ListeningTrapType) => void;
  onComplete: (fullText: string, conversationId?: string) => void;
  onError: (error: Error) => void;
}
