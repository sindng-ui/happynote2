import { spawn, execFile, type ChildProcessWithoutNullStreams } from "child_process";
import { promisify } from "util";
import type {
  AgyBatchAnalysisRequest,
  AgyBatchAnalysisResponse,
  AgySoundDoctorRequest,
  AgyStreamCallbacks,
} from "../types/agy";
import type { ListeningTrapType } from "../types/transcript";

const execFileAsync = promisify(execFile);

const BATCH_ANALYSIS_JSON_SCHEMA = JSON.stringify({
  type: "object",
  required: ["summaryKr", "keyListeningPoints", "items"],
  properties: {
    summaryKr: { type: "string" },
    keyListeningPoints: {
      type: "array",
      items: { type: "string" },
    },
    items: {
      type: "array",
      items: {
        type: "object",
        required: [
          "segmentIndex",
          "traps",
          "phoneticKr",
          "trapExplanation",
          "skeletonWordIndices",
          "dictationBlankIndices",
          "rhythmGuide",
          "translationKr",
        ],
        properties: {
          segmentIndex: { type: "integer" },
          traps: {
            type: "array",
            items: {
              type: "string",
              enum: [
                "LINKING",
                "FLAP_T",
                "WEAK_FORM",
                "ELISION",
                "SLANG",
                "SPEED_SPIKE",
              ],
            },
          },
          phoneticKr: { type: "string" },
          trapExplanation: { type: "string" },
          skeletonWordIndices: {
            type: "array",
            items: { type: "integer" },
          },
          dictationBlankIndices: {
            type: "array",
            items: { type: "integer" },
          },
          rhythmGuide: { type: "string" },
          translationKr: { type: "string" },
        },
      },
    },
  },
});

/**
 * Bridge service connecting Obsidian Ear-Coach directly to the local `agy` CLI.
 * Supports structured JSON batch phonetic diagnosis and real-time streaming 1:1 Sound Doctor sessions.
 */
export class AgyCliService {
  private getAgyPath: () => string;
  private getAgyModel: () => string;

  constructor(
    getAgyPath: () => string,
    getAgyModel: () => string
  ) {
    this.getAgyPath = getAgyPath;
    this.getAgyModel = getAgyModel;
  }

  private resolveBinary(): string {
    const raw = (this.getAgyPath() || "agy").trim();
    if (process.platform === "win32" && !/\.(exe|cmd|bat)$/i.test(raw)) {
      return `${raw}.exe`;
    }
    return raw;
  }

  /**
   * Verifies that `agy` CLI is reachable on the system.
   */
  public async checkAgyAvailable(): Promise<boolean> {
    try {
      const bin = this.resolveBinary();
      await execFileAsync(bin, ["--help"], { timeout: 5000, windowsHide: true });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Runs non-interactive `agy -p --output-format json --json-schema` to analyze phonetic traps across segments.
   */
  public async analyzeSegmentsBatch(
    request: AgyBatchAnalysisRequest
  ): Promise<AgyBatchAnalysisResponse> {
    const bin = this.resolveBinary();
    const model = this.getAgyModel() || "gemini-3.8-flash";

    const prompt = [
      "You are an expert American/British English phonetics and listening coach for Korean learners.",
      `Analyze the following YouTube transcript segments from "${request.videoTitle}".`,
      "Focus on WHY a Korean learner might fail to hear each sentence (linking, Flap T, weak forms, consonant elision, fast speech, slang).",
      "For each segment, provide:",
      "1. traps: Array of applicable trap categories (LINKING, FLAP_T, WEAK_FORM, ELISION, SLANG, SPEED_SPIKE).",
      "2. phoneticKr: Realistic Korean phonetic approximation of the linked/reduced chunk (e.g. 'did you eat -> [쥣 / 디쥬잇]', 'bought a -> [바러]').",
      "3. trapExplanation: Concise Korean explanation of the sound change.",
      "4. skeletonWordIndices: 0-based word indices of stressed content words.",
      "5. dictationBlankIndices: 0-based word indices (2-3 words max) of the trickiest linked/reduced words for micro-dictation.",
      "6. rhythmGuide: Sentence with stressed words capitalized/bolded and '/' for natural pauses.",
      "7. translationKr: Natural Korean meaning.",
      "",
      "Segments JSON:",
      JSON.stringify(request.segments),
    ].join("\n");

    const args = [
      "-p",
      prompt,
      "--output-format",
      "json",
      "--json-schema",
      BATCH_ANALYSIS_JSON_SCHEMA,
      "--disable-slash-commands",
    ];

    if (model) {
      args.push("--model", model);
    }

    const { stdout } = await execFileAsync(bin, args, {
      maxBuffer: 10 * 1024 * 1024,
    });

    return this.extractStructuredResponse(stdout);
  }

  private extractStructuredResponse(stdout: string): AgyBatchAnalysisResponse {
    const trimmed = stdout.trim();
    const parsed = JSON.parse(trimmed);

    if (parsed && Array.isArray(parsed.items)) {
      return parsed as AgyBatchAnalysisResponse;
    }

    // Handle CLI envelope formats (e.g. { response: "...", result: {...} })
    const inner = parsed.result || parsed.response || parsed.output || parsed.content;
    if (typeof inner === "string") {
      return JSON.parse(inner) as AgyBatchAnalysisResponse;
    }
    if (inner && Array.isArray(inner.items)) {
      return inner as AgyBatchAnalysisResponse;
    }

    throw new Error("Unexpected JSON structure from agy CLI batch analysis.");
  }

  /**
   * Streams interactive 1:1 Sound Doctor coaching using `agy -p --output-format stream-json`
   * and preserves context across sessions via `--conversation <id>`.
   */
  public streamSoundDoctor(
    request: AgySoundDoctorRequest,
    callbacks: AgyStreamCallbacks
  ): ChildProcessWithoutNullStreams {
    const bin = this.resolveBinary();
    const model = this.getAgyModel() || "gemini-3.8-flash";

    const prompt = [
      "당신은 한국인 학습자의 영어 귀를 뚫어주는 1:1 음성학·리스닝 전담 코치(Sound Doctor)입니다.",
      `영상 제목: "${request.videoTitle}"`,
      `앞 문장 맥락: "${request.previousSegmentText || "(없음)"}"`,
      `현재 안 들리는 타겟 문장 (#${request.segmentIndex + 1}, 속도 ${request.wpm} WPM): "${request.segmentText}"`,
      `뒤 문장 맥락: "${request.nextSegmentText || "(없음)"}"`,
      `학습자가 들은 소리: "${request.userHeard || "(미입력 - 그냥 안 들림)"}"`,
      `학습자 질문: "${request.userQuestion || "왜 이렇게 들리는지 연음/약화/발음 원리를 해부해 주세요!"}"`,
      "",
      "다음 형식으로 명확하고 친근하게 답변해 주세요:",
      "1. 🎯 **소리 해부 (왜 그렇게 들렸을까?)**: 학습자가 들은 소리와 실제 원어민 발음(연음, 플랩T, 기능어 약화, 자음 탈락 등)을 비교하여 정확히 짚어주세요.",
      "2. 🔊 **실전 발음 가이드**: 소리 내어 따라 해볼 수 있도록 강세와 한글 발음 힌트를 제시해 주세요.",
      "3. 🏷️ 답변 마지막 줄에 가장 핵심적인 함정 태그 하나를 `[TRAP:LINKING]`, `[TRAP:FLAP_T]`, `[TRAP:WEAK_FORM]`, `[TRAP:ELISION]`, `[TRAP:SLANG]`, `[TRAP:SPEED_SPIKE]` 중 하나로 표기해 주세요.",
    ].join("\n");

    const args = [
      "-p",
      prompt,
      "--output-format",
      "text",
      "--disable-slash-commands",
    ];

    if (request.conversationId) {
      args.push("--conversation", request.conversationId);
    }
    if (model) {
      args.push("--model", model);
    }

    const child = spawn(bin, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
      },
    });

    let fullText = "";
    let stderrBuffer = "";
    let detectedConversationId = request.conversationId;

    const stripAnsi = (str: string) =>
      str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\r/g, "");

    const extractTextFromChunk = (raw: string): string => {
      const cleaned = stripAnsi(raw);
      if (!cleaned) return "";

      // If agy outputs NDJSON lines
      if (cleaned.startsWith("{") && cleaned.endsWith("}")) {
        try {
          const evt = JSON.parse(cleaned);
          if (evt.conversation_id || evt.conversationId) {
            detectedConversationId = evt.conversation_id || evt.conversationId;
            callbacks.onConversationId?.(detectedConversationId!);
          }
          if (typeof evt.delta === "string") return evt.delta;
          if (typeof evt.content === "string") return evt.content;
          if (typeof evt.text === "string") return evt.text;
          if (typeof evt.response === "string") return evt.response;
          if (Array.isArray(evt.content)) {
            return evt.content
              .map((c: any) => (typeof c === "string" ? c : c?.text || ""))
              .join("");
          }
          if (Array.isArray(evt.parts)) {
            return evt.parts.map((p: any) => p?.text || "").join("");
          }
        } catch {
          // Fall through to plain text
        }
      }
      return cleaned;
    };

    child.stdout.on("data", (chunk: Buffer) => {
      const textChunk = chunk.toString("utf8");
      const processed = extractTextFromChunk(textChunk);
      if (processed) {
        fullText += processed;
        callbacks.onToken(processed, fullText);
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      callbacks.onError(err);
    });

    child.on("close", (code) => {
      if (code !== 0 && !fullText) {
        const errDetail = stripAnsi(stderrBuffer).trim();
        callbacks.onError(
          new Error(
            errDetail || `agy CLI가 코드 ${code}로 종료되었습니다.`
          )
        );
        return;
      }

      if (!fullText && stderrBuffer.trim()) {
        const errDetail = stripAnsi(stderrBuffer).trim();
        callbacks.onError(new Error(errDetail));
        return;
      }

      const trapMatch = fullText.match(
        /\[TRAP:(LINKING|FLAP_T|WEAK_FORM|ELISION|SLANG|SPEED_SPIKE)\]/
      );
      if (trapMatch) {
        callbacks.onDetectedTrap?.(trapMatch[1] as ListeningTrapType);
      }

      callbacks.onComplete(fullText.trim(), detectedConversationId);
    });

    return child;
  }
}
