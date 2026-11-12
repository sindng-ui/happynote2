import type {
  ListeningTrapType,
  RawTranscriptCue,
  SegmentPhoneticAnalysis,
  TranscriptSegment,
  UnlockStep,
} from "../types/transcript";

export interface TranscriptProcessOptions {
  speedSpikeWpmThreshold: number;
  defaultUnlockStep: UnlockStep;
  pinnedTimestamps?: number[];
  maxWordsPerSegment?: number;
  maxDurationPerSegment?: number;
}

const FUNCTION_WORDS = new Set([
  "a", "an", "the", "to", "of", "in", "on", "for", "at", "by", "with", "from",
  "up", "about", "into", "over", "after", "is", "am", "are", "was", "were", "be",
  "been", "being", "have", "has", "had", "do", "does", "did", "will", "would",
  "shall", "should", "can", "could", "may", "might", "must", "and", "but", "or",
  "so", "if", "as", "that", "than", "it", "he", "she", "we", "they", "you", "i",
  "me", "him", "her", "us", "them", "my", "your", "his", "their", "our", "this",
]);

interface PhoneticRule {
  pattern: RegExp;
  trap: ListeningTrapType;
  hintKr: string;
  explanation: string;
}

const PHONETIC_RULES: PhoneticRule[] = [
  {
    pattern: /\b(going\s+to|gonna)\b/i,
    trap: "WEAK_FORM",
    hintKr: "going to -> [거너 / 아머너]",
    explanation: "'going to'가 빠르게 약화되어 [거너(gonna)] 혹은 'I'm going to'일 때 [아머너(I'mma)]로 발음됩니다.",
  },
  {
    pattern: /\b(want\s+to|wanna)\b/i,
    trap: "ELISION",
    hintKr: "want to -> [워너]",
    explanation: "'want to'에서 't' 소리가 탈락하며 [워너(wanna)]로 연음됩니다.",
  },
  {
    pattern: /\b(got\s+to|gotta)\b/i,
    trap: "FLAP_T",
    hintKr: "got to -> [가러]",
    explanation: "'got to'의 't'가 모음 사이에서 플랩(Flap T) 현상을 일으켜 [가러(gotta)]로 들립니다.",
  },
  {
    pattern: /\b(should\s+have|could\s+have|would\s+have|should've|could've|would've)\b/i,
    trap: "WEAK_FORM",
    hintKr: "조동사+have -> [슈러브 / 쿠러브 / 우러브]",
    explanation: "조동사 뒤의 'have'는 강세를 잃어 'of[어브]'처럼 약화되고 앞 단어와 연음됩니다.",
  },
  {
    pattern: /\b(did\s+you|could\s+you|would\s+you|what\s+you|got\s+you)\b/i,
    trap: "LINKING",
    hintKr: "d/t + you -> [디쥬 / 쿠쥬 / 우쥬 / 왓츄]",
    explanation: "자음 'd/t'와 'y'가 만나 구개음화(Palatalization)되면서 [쥬/츄] 소리로 변합니다.",
  },
  {
    pattern: /\b(out\s+of|kind\s+of|sort\s+of|lot\s+of|bought\s+a|what\s+a|get\s+a|put\s+it|take\s+it|make\s+it)\b/i,
    trap: "FLAP_T",
    hintKr: "Flap T/D + 모음 연음 -> [아우러 / 카이너 / 바러 / 푸릿]",
    explanation: "단어 끝 't/d' 뒤에 모음(`a, of, it`)이 오면 우리말 'ㄹ'에 가까운 탄설음(Flap)으로 부드럽게 이어집니다.",
  },
  {
    pattern: /\b(give\s+them|tell\s+them|with\s+them|let\s+him|ask\s+her)\b/i,
    trap: "ELISION",
    hintKr: "h/th 탈락 -> [기븜 / 텔름 / 레림 / 애스커]",
    explanation: "대명사 'them, him, her'의 첫 자음 'th/h'가 탈락하고 앞 자음과 바로 연음됩니다.",
  },
];

/**
 * Decodes HTML entities and removes non-speech caption artifacts cleanly.
 */
export function cleanCaptionText(raw: string): string {
  return raw
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Generates instant rule-based phonetic analysis so UI cards work immediately before or without AI batch completion.
 */
export function computeFallbackAnalysis(segment: TranscriptSegment): SegmentPhoneticAnalysis {
  const traps = new Set<ListeningTrapType>();
  const hints: string[] = [];
  const explanations: string[] = [];

  if (segment.isSpeedSpike) {
    traps.add("SPEED_SPIKE");
  }

  for (const rule of PHONETIC_RULES) {
    if (rule.pattern.test(segment.text)) {
      traps.add(rule.trap);
      hints.push(rule.hintKr);
      explanations.push(rule.explanation);
    }
  }

  const skeletonWordIndices: number[] = [];
  const dictationBlankIndices: number[] = [];

  segment.words.forEach((word, idx) => {
    const clean = word.replace(/[^a-zA-Z']/g, "").toLowerCase();
    if (!clean) return;
    if (!FUNCTION_WORDS.has(clean) && clean.length >= 3) {
      skeletonWordIndices.push(idx);
    } else {
      dictationBlankIndices.push(idx);
    }
  });

  // Limit dictation blanks to 2~4 most useful linked words
  const selectedBlanks =
    dictationBlankIndices.length > 0
      ? dictationBlankIndices.slice(0, 3)
      : segment.words.length > 1
        ? [Math.min(1, segment.words.length - 1)]
        : [0];

  if (traps.size === 0) {
    traps.add("LINKING");
  }

  const rhythmParts = segment.words.map((w, idx) =>
    skeletonWordIndices.includes(idx) ? `**${w.toUpperCase()}**` : w
  );

  return {
    traps: Array.from(traps),
    phoneticKr:
      hints.length > 0
        ? hints.join(" | ")
        : "강세 단어(굵은 글씨) 사이의 기능어를 약하고 빠르게 흘려 들어보세요.",
    trapExplanation:
      explanations.length > 0
        ? explanations.join(" ")
        : "원어민은 내용어(명사·동사·형용사)만 강하게 발음하고 전치사·대명사는 뭉개어 발음합니다.",
    skeletonWordIndices,
    dictationBlankIndices: selectedBlanks,
    rhythmGuide: rhythmParts.join(" "),
    translationKr: "(AI 정밀 해석 대기 중 - 우측 [🎙️ 사운드 해부] 또는 [AI 분석]을 눌러 즉시 확인하세요)",
  };
}

/**
 * Merges fragmented raw caption cues into natural sentence-level segments and calculates WPM.
 */
export function mergeCuesIntoSegments(
  cues: RawTranscriptCue[],
  options: TranscriptProcessOptions
): TranscriptSegment[] {
  const maxWords = options.maxWordsPerSegment ?? 20;
  const maxDuration = options.maxDurationPerSegment ?? 9.5;
  const pinnedList = options.pinnedTimestamps ?? [];

  const merged: TranscriptSegment[] = [];
  let bufferText: string[] = [];
  let bufferStart = 0;
  let bufferEnd = 0;

  const flushBuffer = () => {
    const fullText = bufferText.join(" ").replace(/\s+/g, " ").trim();
    bufferText = [];
    if (!fullText) return;

    const duration = Math.max(0.6, Number((bufferEnd - bufferStart).toFixed(2)));
    const words = fullText.split(/\s+/).filter(Boolean);
    const wpm = Math.round((words.length / duration) * 60);
    const isSpeedSpike = wpm >= options.speedSpikeWpmThreshold;
    const index = merged.length;

    const isPinned = pinnedList.some(
      (pinSec) => pinSec >= bufferStart - 1.5 && pinSec <= bufferEnd + 1.5
    );

    const segment: TranscriptSegment = {
      id: `seg-${index}-${Math.round(bufferStart * 10)}`,
      index,
      start: Number(bufferStart.toFixed(2)),
      end: Number(bufferEnd.toFixed(2)),
      duration,
      text: fullText,
      words,
      wpm,
      isSpeedSpike,
      isPinned,
      unlockStep: options.defaultUnlockStep,
    };

    segment.analysis = computeFallbackAnalysis(segment);
    merged.push(segment);
  };

  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    const text = cleanCaptionText(cue.text);
    if (!text || /^\[.*\]$/.test(text)) continue;

    const cueStart = Math.max(0, cue.start);
    const cueEnd = Math.max(cueStart + 0.5, cueStart + (cue.duration || 2.0));

    if (bufferText.length === 0) {
      bufferStart = cueStart;
      bufferEnd = cueEnd;
      bufferText.push(text);
    } else {
      const gap = cueStart - bufferEnd;
      const currentWords = bufferText.join(" ").split(/\s+/).length;
      const nextWords = text.split(/\s+/).length;
      const wouldExceedDuration = cueEnd - bufferStart > maxDuration;
      const wouldExceedWords = currentWords + nextWords > maxWords;

      if (gap > 1.25 || wouldExceedDuration || wouldExceedWords) {
        flushBuffer();
        bufferStart = cueStart;
        bufferEnd = cueEnd;
        bufferText.push(text);
      } else {
        bufferEnd = Math.max(bufferEnd, cueEnd);
        bufferText.push(text);
      }
    }

    const endsWithPunctuation = /[.?!]["']?$/.test(text);
    const currentWordCount = bufferText.join(" ").split(/\s+/).length;
    if (endsWithPunctuation && currentWordCount >= 4) {
      flushBuffer();
    }
  }

  if (bufferText.length > 0) {
    flushBuffer();
  }

  return merged;
}
