/**
 * Phonetic and listening trap categories that commonly block non-native listeners.
 */
export type ListeningTrapType =
  | "LINKING"     // Word boundary linking (e.g., "kept it" -> "kep-tit")
  | "FLAP_T"      // American English alveolar flap (e.g., "bought a" -> "ba-ra")
  | "WEAK_FORM"   // Function word reduction (e.g., "should have" -> "should've")
  | "ELISION"     // Consonant deletion (e.g., "next day" -> "nex-day")
  | "SLANG"       // Idiomatic or colloquial chunk (e.g., "out of pocket")
  | "SPEED_SPIKE"; // High speech rate (WPM threshold exceeded)

/**
 * Step-by-step reveal state for a sentence card (3-Step Ear Unlocker).
 */
export type UnlockStep = 0 | 1 | 2 | 3;
// 0 = Blind (Audio + badges only)
// 1 = Skeleton + Micro-Dictation blanks
// 2 = Sound Hint (Korean/phonetic approximation + trap explanation)
// 3 = Full Reveal (Original script + translation + shadowing rhythm guide)

/**
 * Raw caption cue extracted from YouTube or yt-dlp before sentence merging.
 */
export interface RawTranscriptCue {
  start: number;    // Start time in seconds
  duration: number; // Duration in seconds
  text: string;     // Raw caption text
}

/**
 * AI-enriched phonetic analysis for a single merged sentence segment.
 */
export interface SegmentPhoneticAnalysis {
  traps: ListeningTrapType[];
  phoneticKr: string;           // Korean/phonetic sound approximation (e.g., "[바러 카]")
  trapExplanation: string;      // Concise explanation of why this sounds muffled/linked
  skeletonWordIndices: number[]; // Indices of stressed content words shown in Step 1
  dictationBlankIndices: number[]; // Indices of linked/weak words used for Micro-Dictation
  rhythmGuide: string;          // Stress & pause notation (e.g., "I **BOUGHT** a **CAR** / **YES**terday")
  translationKr: string;        // Natural Korean translation
}

/**
 * Interactive Q&A entry saved from a 1:1 agy Sound Doctor session on a segment.
 */
export interface SegmentTutorNote {
  id: string;
  createdAt: string;
  userHeard: string;  // What the user thought they heard (e.g., "아마나 고")
  question: string;   // User's question
  answer: string;     // agy CLI coaching response
  detectedTrap?: ListeningTrapType;
}

/**
 * Merged, sentence-level transcript segment with WPM metrics and optional AI analysis.
 */
export interface TranscriptSegment {
  id: string;
  index: number;
  start: number;       // Start time in seconds
  end: number;         // End time in seconds
  duration: number;    // Duration in seconds
  text: string;        // Clean sentence text
  words: string[];     // Tokenized words
  wpm: number;         // Words per minute for this sentence
  isSpeedSpike: boolean;
  isPinned: boolean;   // Marked by user or URI ?t= trigger as "Unclear Spot"
  unlockStep: UnlockStep;
  userDictationAttempts?: Record<number, string>;
  analysis?: SegmentPhoneticAnalysis;
  tutorNotes?: SegmentTutorNote[];
}

/**
 * Complete listening session payload stored in an Obsidian note.
 */
export interface ListeningSessionData {
  videoId: string;
  videoUrl: string;
  title: string;
  channelName?: string;
  createdAt: string;
  updatedAt: string;
  agyConversationId?: string;
  pinnedTimestamps: number[];
  segments: TranscriptSegment[];
}
