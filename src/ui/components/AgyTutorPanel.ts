import { Notice } from "obsidian";
import type { ChildProcessWithoutNullStreams } from "child_process";
import { AgyCliService } from "../../services/AgyCliService";
import {
  ListeningSessionData,
  ListeningTrapType,
  SegmentTutorNote,
  TranscriptSegment,
} from "../../types/transcript";
import { formatSecondsToTimestamp } from "../../utils/youtubeUrlParser";

export interface AgyTutorPanelCallbacks {
  onTutorNoteSaved: (
    segment: TranscriptSegment,
    note: SegmentTutorNote,
    conversationId?: string
  ) => Promise<void>;
  onVisibilityChange?: (isOpen: boolean) => void;
}

/**
 * Interactive 1:1 `agy` CLI Sound Doctor drawer.
 * Streams real-time phonetic explanations for why a specific sentence sounded muffled or linked.
 */
export class AgyTutorPanel {
  private activeSegment: TranscriptSegment | null = null;
  private activeProcess: ChildProcessWithoutNullStreams | null = null;
  private latestAnswer = "";
  private latestDetectedTrap: ListeningTrapType | undefined;

  constructor(
    private containerEl: HTMLElement,
    private agyService: AgyCliService,
    private getSession: () => ListeningSessionData | null,
    private callbacks: AgyTutorPanelCallbacks
  ) {}

  public openForSegment(segment: TranscriptSegment, initialHeardText = ""): void {
    this.stopActiveStream();
    this.activeSegment = segment;
    this.latestAnswer = "";
    this.latestDetectedTrap = undefined;
    this.containerEl.removeClass("is-hidden");
    this.callbacks.onVisibilityChange?.(true);
    this.render(initialHeardText);
  }

  public toggleForSegment(segment: TranscriptSegment, initialHeardText = ""): void {
    if (
      this.activeSegment &&
      this.activeSegment.index === segment.index &&
      !this.containerEl.hasClass("is-hidden")
    ) {
      this.close();
      return;
    }
    this.openForSegment(segment, initialHeardText);
  }

  public close(): void {
    this.stopActiveStream();
    this.activeSegment = null;
    this.containerEl.addClass("is-hidden");
    this.callbacks.onVisibilityChange?.(false);
    this.containerEl.empty();
  }

  public render(initialHeardText = ""): void {
    this.containerEl.empty();
    this.containerEl.addClass("ear-coach-tutor-panel");

    if (!this.activeSegment) {
      this.containerEl.addClass("is-hidden");
      return;
    }

    this.containerEl.removeClass("is-hidden");
    const seg = this.activeSegment;
    const header = this.containerEl.createDiv({ cls: "ear-coach-tutor-header" });
    header.createEl("h4", {
      text: `🎙️ 1:1 agy 사운드 닥터 — #${seg.index + 1} [${formatSecondsToTimestamp(seg.start)}]`,
    });

    const closeBtn = header.createEl("button", {
      cls: "ear-coach-btn ear-coach-tutor-close-btn",
      text: "✕ 닫기",
    });
    closeBtn.addEventListener("click", () => this.close());

    const targetQuote = this.containerEl.createDiv({
      cls: "ear-coach-tutor-target-sentence",
      text: `원문: "${seg.text}" (${seg.wpm} WPM)`,
    });
    if (seg.unlockStep < 3) {
      targetQuote.setText(
        `원문 (스포일러 방지 중 — 클릭 시 보기): || ${seg.text} ||`
      );
      targetQuote.addEventListener("click", () => {
        targetQuote.setText(`원문: "${seg.text}" (${seg.wpm} WPM)`);
      });
    }

    const formEl = this.containerEl.createDiv({ cls: "ear-coach-tutor-form" });

    const heardInput = formEl.createEl("input", {
      cls: "ear-coach-input",
      type: "text",
      value: initialHeardText,
      attr: {
        placeholder: "내 귀에 들린 소리를 적어주세요 (예: 아마나 고, 켑팃)",
      },
    });

    const questionInput = formEl.createEl("input", {
      cls: "ear-coach-input",
      type: "text",
      value: "왜 내 귀에는 이렇게 들리는지 연음·약화·강세 원리를 해부해 줘!",
      attr: {
        placeholder: "질문을 입력하세요",
      },
    });

    // Quick preset chips
    const chipRow = formEl.createDiv({ cls: "ear-coach-chip-row" });
    const presets = [
      "왜 이렇게 뭉개져 들려?",
      "입으로 따라 읽는 쉐도잉 호흡 알려줘",
      "이 연음 패턴이 쓰인 다른 짧은 예문 3개 줘",
    ];
    for (const preset of presets) {
      const chip = chipRow.createEl("button", {
        cls: "ear-coach-chip-btn",
        text: preset,
      });
      chip.addEventListener("click", () => {
        questionInput.value = preset;
      });
    }

    const actionRow = formEl.createDiv({ cls: "ear-coach-tutor-actions" });
    const askBtn = actionRow.createEl("button", {
      cls: "ear-coach-btn ear-coach-btn-primary",
      text: "🚀 agy CLI 실시간 분석 시작",
    });

    const saveBtn = actionRow.createEl("button", {
      cls: "ear-coach-btn ear-coach-btn-accent",
      text: "📝 노트에 콜아웃 박제 & 내 약점북 등록",
    });
    saveBtn.disabled = true;

    const outputBox = this.containerEl.createDiv({
      cls: "ear-coach-tutor-stream-output",
      text: "질문 버튼을 누르면 agy CLI 스트리밍 답변이 여기에 표시됩니다...",
    });

    askBtn.addEventListener("click", () => {
      this.startStreamingQuery(
        seg,
        heardInput.value.trim(),
        questionInput.value.trim(),
        outputBox,
        askBtn,
        saveBtn
      );
    });

    saveBtn.addEventListener("click", async () => {
      if (!this.latestAnswer) return;
      const note: SegmentTutorNote = {
        id: `tutor-${Date.now()}`,
        createdAt: new Date().toISOString(),
        userHeard: heardInput.value.trim(),
        question: questionInput.value.trim(),
        answer: this.latestAnswer,
        detectedTrap: this.latestDetectedTrap,
      };
      const session = this.getSession();
      await this.callbacks.onTutorNoteSaved(
        seg,
        note,
        session?.agyConversationId
      );
      new Notice("노트에 사운드 해부 콜아웃을 저장하고 약점 대시보드를 업데이트했습니다!");
    });
  }

  private startStreamingQuery(
    seg: TranscriptSegment,
    userHeard: string,
    userQuestion: string,
    outputBox: HTMLElement,
    askBtn: HTMLButtonElement,
    saveBtn: HTMLButtonElement
  ): void {
    this.stopActiveStream();
    const session = this.getSession();
    if (!session) return;

    const prevSeg = session.segments[seg.index - 1];
    const nextSeg = session.segments[seg.index + 1];

    outputBox.setText("⏳ agy CLI 코치가 소리를 해부하고 있습니다...\n");
    askBtn.disabled = true;
    saveBtn.disabled = true;

    this.activeProcess = this.agyService.streamSoundDoctor(
      {
        videoTitle: session.title,
        segmentIndex: seg.index,
        segmentText: seg.text,
        previousSegmentText: prevSeg?.text,
        nextSegmentText: nextSeg?.text,
        wpm: seg.wpm,
        userHeard,
        userQuestion,
        conversationId: session.agyConversationId,
      },
      {
        onToken: (_delta, fullText) => {
          outputBox.setText(fullText);
        },
        onConversationId: (convId) => {
          if (session) {
            session.agyConversationId = convId;
          }
        },
        onDetectedTrap: (trap) => {
          this.latestDetectedTrap = trap;
        },
        onComplete: (fullText) => {
          this.latestAnswer = fullText;
          askBtn.disabled = false;
          saveBtn.disabled = !fullText;
          if (fullText) {
            outputBox.setText(fullText);
          } else {
            outputBox.setText(
              "⚠️ agy CLI에서 내용이 반환되지 않았습니다. agy가 로그인되어 있는지 터미널에서 확인해 주세요."
            );
          }
          this.activeProcess = null;
        },
        onError: (err) => {
          outputBox.setText(
            `⚠️ agy CLI 호출 오류: ${err.message}\n(설정에서 agy 경로를 확인하거나 로컬 터미널 인증 상태를 확인해 주세요.)`
          );
          askBtn.disabled = false;
          this.activeProcess = null;
        },
      }
    );
  }

  public stopActiveStream(): void {
    if (this.activeProcess) {
      this.activeProcess.kill();
      this.activeProcess = null;
    }
  }
}
