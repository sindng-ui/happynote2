import { TranscriptSegment, UnlockStep } from "../../types/transcript";
import { formatSecondsToTimestamp } from "../../utils/youtubeUrlParser";
import { MicroDictationBox } from "./MicroDictationBox";

export interface SegmentCardCallbacks {
  onPlaySegment: (segment: TranscriptSegment, loop: boolean) => void;
  onTogglePin: (segment: TranscriptSegment) => void;
  onUnlockStepChange: (segment: TranscriptSegment, step: UnlockStep) => void;
  onOpenTutor: (segment: TranscriptSegment, userHeardText?: string) => void;
  isLooping?: (segment: TranscriptSegment) => boolean;
}

/**
 * Renders an individual sentence card with the 3-Step Ear Unlocker, WPM/trap badges,
 * A-B loop trigger, and Shadowing rhythm guide.
 */
export class SegmentCard {
  private cardEl: HTMLElement;
  private loopBtnEl: HTMLButtonElement | null = null;
  private isActivePlaying = false;

  constructor(
    parentEl: HTMLElement,
    private segment: TranscriptSegment,
    private callbacks: SegmentCardCallbacks
  ) {
    this.cardEl = parentEl.createDiv({
      cls: "ear-coach-segment-card",
      attr: { "data-segment-index": String(segment.index) },
    });
    this.render();
  }

  public getElement(): HTMLElement {
    return this.cardEl;
  }

  public setActiveHighlight(isActive: boolean): void {
    this.isActivePlaying = isActive;
    if (isActive) {
      this.cardEl.addClass("is-active-playing");
    } else {
      this.cardEl.removeClass("is-active-playing");
    }
  }

  public setLoopState(isLooping: boolean): void {
    if (!this.loopBtnEl) return;
    this.loopBtnEl.toggleClass("is-loop-active-btn", isLooping);
    this.loopBtnEl.setText(isLooping ? "🔁 루프 중 (해제)" : "🔁 이 문장 루프");
  }

  public updateSegment(segment: TranscriptSegment): void {
    this.segment = segment;
    this.render();
  }

  public render(): void {
    this.cardEl.empty();
    this.cardEl.toggleClass("is-pinned", this.segment.isPinned);
    this.cardEl.toggleClass("is-active-playing", this.isActivePlaying);

    // 1. Top Header Bar: Timestamp, Loop, Pin, WPM & Trap Badges
    const headerEl = this.cardEl.createDiv({ cls: "ear-coach-card-header" });

    const leftControls = headerEl.createDiv({ cls: "ear-coach-card-left-controls" });

    const timeBtn = leftControls.createEl("button", {
      cls: "ear-coach-time-btn",
      text: `▶ ${formatSecondsToTimestamp(this.segment.start)}`,
    });
    timeBtn.addEventListener("click", () =>
      this.callbacks.onPlaySegment(this.segment, false)
    );

    const isCurrentlyLooping = this.callbacks.isLooping?.(this.segment) ?? false;
    this.loopBtnEl = leftControls.createEl("button", {
      cls: `ear-coach-mini-btn ${isCurrentlyLooping ? "is-loop-active-btn" : ""}`,
      text: isCurrentlyLooping ? "🔁 루프 중 (해제)" : "🔁 이 문장 루프",
    });
    this.loopBtnEl.addEventListener("click", () =>
      this.callbacks.onPlaySegment(this.segment, true)
    );

    const pinBtn = leftControls.createEl("button", {
      cls: `ear-coach-mini-btn ${this.segment.isPinned ? "is-pinned-btn" : ""}`,
      text: this.segment.isPinned ? "📌 집중핀 해제" : "📌 안 들림 핀",
    });
    pinBtn.addEventListener("click", () => {
      this.segment.isPinned = !this.segment.isPinned;
      this.callbacks.onTogglePin(this.segment);
      this.render();
    });

    // Badges (WPM + Traps)
    const badgeRow = headerEl.createDiv({ cls: "ear-coach-badge-row" });
    badgeRow.createSpan({
      cls: `ear-coach-badge ${this.segment.isSpeedSpike ? "badge-speed-spike" : "badge-wpm"}`,
      text: `${this.segment.wpm} WPM${this.segment.isSpeedSpike ? " 🚀과속" : ""}`,
    });

    if (this.segment.analysis?.traps) {
      for (const trap of this.segment.analysis.traps) {
        badgeRow.createSpan({
          cls: `ear-coach-badge badge-trap-${trap.toLowerCase()}`,
          text: trap,
        });
      }
    }

    // 2. Step Switcher Bar (3-Step Ear Unlocker)
    const stepBar = this.cardEl.createDiv({ cls: "ear-coach-step-bar" });
    const stepDefinitions: Array<{ step: UnlockStep; label: string }> = [
      { step: 0, label: "🙈 0. 블라인드" },
      { step: 1, label: "🦴 1. 뼈대·빈칸" },
      { step: 2, label: "💡 2. 소리 힌트" },
      { step: 3, label: "📖 3. 정답·쉐도잉" },
    ];

    for (const def of stepDefinitions) {
      const btn = stepBar.createEl("button", {
        cls: `ear-coach-step-btn ${this.segment.unlockStep === def.step ? "is-current-step" : ""}`,
        text: def.label,
      });
      btn.addEventListener("click", () => {
        this.segment.unlockStep = def.step;
        this.callbacks.onUnlockStepChange(this.segment, def.step);
        this.render();
      });
    }

    const askBtn = stepBar.createEl("button", {
      cls: "ear-coach-step-btn ear-coach-tutor-trigger-btn",
      text: "🎙️ 1:1 사운드 해부",
    });
    askBtn.addEventListener("click", () => this.callbacks.onOpenTutor(this.segment));

    // 3. Body Content based on current UnlockStep
    const bodyEl = this.cardEl.createDiv({ cls: "ear-coach-card-body" });
    this.renderStepContent(bodyEl, this.segment.unlockStep);
  }

  private renderStepContent(bodyEl: HTMLElement, step: UnlockStep): void {
    const analysis = this.segment.analysis;

    if (step === 0) {
      const blindBox = bodyEl.createDiv({ cls: "ear-coach-blind-box" });
      blindBox.createSpan({
        cls: "ear-coach-blind-prompt",
        text: `🎧 눈을 감고 소리에만 집중해 보세요! (총 ${this.segment.words.length}단어, ${this.segment.duration}초) — 안 들리면 [1. 뼈대·빈칸]이나 [2. 소리 힌트]를 클릭하세요.`,
      });
      return;
    }

    if (step === 1) {
      const dictContainer = bodyEl.createDiv();
      const dictBox = new MicroDictationBox(dictContainer, this.segment, {
        onDictationSolved: () => {
          this.segment.unlockStep = 3;
          this.callbacks.onUnlockStepChange(this.segment, 3);
          this.render();
        },
        onAskTutorWithHeardText: (seg, heardText) => {
          this.callbacks.onOpenTutor(seg, heardText);
        },
      });
      dictBox.render();
      return;
    }

    if (step === 2) {
      const hintBox = bodyEl.createDiv({ cls: "ear-coach-sound-hint-box" });
      hintBox.createDiv({
        cls: "ear-coach-phonetic-kr",
        text: `🔊 실제 발음 힌트: ${analysis?.phoneticKr || "분석 데이터 없음"}`,
      });
      hintBox.createDiv({
        cls: "ear-coach-trap-explanation",
        text: `💡 왜 안 들렸을까?: ${analysis?.trapExplanation || ""}`,
      });
      return;
    }

    // Step 3: Full Reveal + Translation + Shadowing Rhythm Guide
    const fullBox = bodyEl.createDiv({ cls: "ear-coach-full-reveal-box" });
    fullBox.createDiv({
      cls: "ear-coach-full-script",
      text: this.segment.text,
    });

    if (analysis) {
      fullBox.createDiv({
        cls: "ear-coach-translation-kr",
        text: `🇰🇷 ${analysis.translationKr}`,
      });
      fullBox.createDiv({
        cls: "ear-coach-phonetic-kr",
        text: `🔊 발음 포인트: ${analysis.phoneticKr} — ${analysis.trapExplanation}`,
      });
      fullBox.createDiv({
        cls: "ear-coach-rhythm-guide",
        text: `🗣️ 쉐도잉 리듬 악보: ${analysis.rhythmGuide}`,
      });
    }

    if (this.segment.tutorNotes && this.segment.tutorNotes.length > 0) {
      const notesBox = fullBox.createDiv({ cls: "ear-coach-saved-tutor-notes" });
      for (const note of this.segment.tutorNotes) {
        const item = notesBox.createDiv({ cls: "ear-coach-saved-tutor-item" });
        item.createDiv({
          cls: "ear-coach-saved-tutor-q",
          text: `🙋 내가 들은 소리: "${note.userHeard || "미입력"}" | 질문: ${note.question}`,
        });
        item.createDiv({
          cls: "ear-coach-saved-tutor-a",
          text: note.answer,
        });
      }
    }
  }
}
