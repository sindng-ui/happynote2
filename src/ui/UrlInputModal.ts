import { App, Modal, Notice, Setting } from "obsidian";
import { parseTimestampToSeconds, parseYouTubeUrl } from "../utils/youtubeUrlParser";

export interface UrlSubmitPayload {
  url: string;
  pinTimestampSeconds?: number;
}

/**
 * Clean modal for entering or pasting a YouTube URL and optional timestamp pin.
 */
export class UrlInputModal extends Modal {
  private urlValue = "";
  private timestampRaw = "";

  constructor(
    app: App,
    private onSubmit: (payload: UrlSubmitPayload) => Promise<void>
  ) {
    super(app);
  }

  public async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ear-coach-modal");

    contentEl.createEl("h3", {
      text: "🎧 유튜브 영어 리스닝 노트 생성 / 핀 추가",
    });

    // Try auto-reading YouTube URL from clipboard for zero friction
    try {
      const clipText = await navigator.clipboard.readText();
      const parsed = parseYouTubeUrl(clipText);
      if (parsed) {
        this.urlValue = clipText.trim();
        if (parsed.timestampSeconds !== undefined) {
          this.timestampRaw = String(parsed.timestampSeconds);
        }
      }
    } catch {
      // Ignore clipboard permission errors
    }

    new Setting(contentEl)
      .setName("유튜브 URL")
      .setDesc("일반 영상, Shorts, youtu.be 링크 모두 지원합니다.")
      .addText((text) => {
        text
          .setPlaceholder("https://www.youtube.com/watch?v=...")
          .setValue(this.urlValue)
          .onChange((val) => {
            this.urlValue = val.trim();
          });
        text.inputEl.style.width = "100%";
      });

    new Setting(contentEl)
      .setName("📌 안 들리는 타임스탬프 핀 (선택)")
      .setDesc("예: 142, 2m22s, 02:22 — 입력하면 해당 문장에 집중 분석 마커가 찍힙니다.")
      .addText((text) => {
        text
          .setPlaceholder("예: 02:22 또는 142")
          .setValue(this.timestampRaw)
          .onChange((val) => {
            this.timestampRaw = val.trim();
          });
      });

    new Setting(contentEl).addButton((btn) =>
      btn
        .setButtonText("🚀 리스닝 노트 생성 및 열기")
        .setCta()
        .onClick(async () => {
          const parsed = parseYouTubeUrl(this.urlValue);
          if (!parsed) {
            new Notice("유효한 유튜브 URL을 입력해 주세요!");
            return;
          }
          const manualSec = parseTimestampToSeconds(this.timestampRaw);
          const finalPinSec = manualSec ?? parsed.timestampSeconds;
          this.close();
          await this.onSubmit({
            url: this.urlValue,
            pinTimestampSeconds: finalPinSec,
          });
        })
    );
  }

  public onClose(): void {
    this.contentEl.empty();
  }
}
