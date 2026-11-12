import { TranscriptSegment } from "../../types/transcript";

export interface MicroDictationCallbacks {
  onDictationSolved: (segment: TranscriptSegment) => void;
  onAskTutorWithHeardText: (segment: TranscriptSegment, userHeardText: string) => void;
}

/**
 * Interactive Micro-Dictation component for Step 1 of the Ear Unlocker.
 * Turns only the key linked/weak words into input blanks so the user isn't overwhelmed by typing the entire sentence.
 */
export class MicroDictationBox {
  constructor(
    private containerEl: HTMLElement,
    private segment: TranscriptSegment,
    private callbacks: MicroDictationCallbacks
  ) {}

  public render(): void {
    this.containerEl.empty();
    this.containerEl.addClass("ear-coach-dictation-box");

    const blankIndices = new Set(
      this.segment.analysis?.dictationBlankIndices ?? [0]
    );
    const skeletonIndices = new Set(
      this.segment.analysis?.skeletonWordIndices ?? []
    );

    const tokenRow = this.containerEl.createDiv({ cls: "ear-coach-dictation-tokens" });
    const inputs: Array<{ idx: number; expected: string; inputEl: HTMLInputElement }> = [];

    this.segment.words.forEach((rawWord, idx) => {
      const cleanExpected = rawWord.replace(/^[^a-zA-Z0-9']+|[^a-zA-Z0-9']+$/g, "");

      if (blankIndices.has(idx) && cleanExpected.length > 0) {
        const inputEl = tokenRow.createEl("input", {
          cls: "ear-coach-blank-input",
          type: "text",
          attr: {
            placeholder: "_".repeat(Math.max(3, cleanExpected.length)),
            "aria-label": `Blank word ${idx + 1}`,
          },
        });
        inputEl.style.width = `${Math.max(4.5, cleanExpected.length * 0.75 + 1.5)}em`;

        const savedAttempt = this.segment.userDictationAttempts?.[idx];
        if (savedAttempt) {
          inputEl.value = savedAttempt;
          this.validateSingleInput(inputEl, cleanExpected);
        }

        inputEl.addEventListener("input", () => {
          if (!this.segment.userDictationAttempts) {
            this.segment.userDictationAttempts = {};
          }
          this.segment.userDictationAttempts[idx] = inputEl.value;
          this.validateSingleInput(inputEl, cleanExpected);
          this.checkAllSolved(inputs);
        });

        inputs.push({ idx, expected: cleanExpected, inputEl });
      } else {
        const isStressed = skeletonIndices.has(idx);
        tokenRow.createSpan({
          cls: `ear-coach-word-token ${isStressed ? "is-stressed-skeleton" : "is-context-word"}`,
          text: rawWord + " ",
        });
      }
    });

    // "What did it sound like to you?" phonetic memo + instant tutor ask
    const heardRow = this.containerEl.createDiv({ cls: "ear-coach-heard-row" });
    const heardInput = heardRow.createEl("input", {
      cls: "ear-coach-heard-input",
      type: "text",
      attr: {
        placeholder: "👂 내 귀에 들린 대로 적어보세요 (예: 아마나 고 / 바러 카)",
      },
    });

    const askWhyBtn = heardRow.createEl("button", {
      cls: "ear-coach-btn ear-coach-btn-accent",
      text: "🎙️ 왜 이렇게 들리는지 agy에게 묻기",
    });
    askWhyBtn.addEventListener("click", () => {
      this.callbacks.onAskTutorWithHeardText(this.segment, heardInput.value.trim());
    });
  }

  private validateSingleInput(inputEl: HTMLInputElement, expected: string): boolean {
    const normalizedUser = inputEl.value.trim().toLowerCase().replace(/[^a-z0-9']/g, "");
    const normalizedExpected = expected.toLowerCase().replace(/[^a-z0-9']/g, "");

    if (!normalizedUser) {
      inputEl.removeClass("is-correct", "is-wrong");
      return false;
    }

    if (normalizedUser === normalizedExpected) {
      inputEl.addClass("is-correct");
      inputEl.removeClass("is-wrong");
      return true;
    } else {
      inputEl.addClass("is-wrong");
      inputEl.removeClass("is-correct");
      return false;
    }
  }

  private checkAllSolved(
    inputs: Array<{ idx: number; expected: string; inputEl: HTMLInputElement }>
  ): void {
    if (inputs.length === 0) return;
    const allCorrect = inputs.every((item) =>
      this.validateSingleInput(item.inputEl, item.expected)
    );
    if (allCorrect) {
      this.callbacks.onDictationSolved(this.segment);
    }
  }
}
