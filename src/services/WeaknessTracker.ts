import { App, normalizePath, TFile } from "obsidian";
import { ListeningTrapType, TranscriptSegment } from "../types/transcript";
import { formatSecondsToTimestamp } from "../utils/youtubeUrlParser";

export interface WeaknessRecordEntry {
  videoId: string;
  videoTitle: string;
  notePath: string;
  segmentStart: number;
  segmentText: string;
  phoneticKr: string;
  userHeard?: string;
  traps: ListeningTrapType[];
  recordedAt: string;
}

const TRAP_LABELS: Record<ListeningTrapType, string> = {
  LINKING: "🔗 자음+모음 연음 (Linking)",
  FLAP_T: "💧 미국식 플랩 T/D (Flap T)",
  WEAK_FORM: "👻 기능어 약화 (Weak Forms)",
  ELISION: "✂️ 자음 탈락 (Elision)",
  SLANG: "💬 원어민 구어체/슬랭 (Slang/Idiom)",
  SPEED_SPIKE: "🚀 고속 발화 구간 (Speed Spike)",
};

/**
 * Automatically aggregates the user's listening blindspots into `My_Listening_Weakness.md`.
 */
export class WeaknessTracker {
  private entries: WeaknessRecordEntry[] = [];

  constructor(
    private app: App,
    private getDashboardPath: () => string
  ) {}

  public async recordWeakSegment(params: {
    videoId: string;
    videoTitle: string;
    notePath: string;
    segment: TranscriptSegment;
    userHeard?: string;
  }): Promise<void> {
    const traps: ListeningTrapType[] = params.segment.analysis?.traps?.length
      ? params.segment.analysis.traps
      : ["LINKING"];

    const existingIdx = this.entries.findIndex(
      (e) =>
        e.videoId === params.videoId &&
        Math.abs(e.segmentStart - params.segment.start) < 0.5
    );

    const entry: WeaknessRecordEntry = {
      videoId: params.videoId,
      videoTitle: params.videoTitle,
      notePath: params.notePath,
      segmentStart: params.segment.start,
      segmentText: params.segment.text,
      phoneticKr: params.segment.analysis?.phoneticKr || "",
      userHeard: params.userHeard,
      traps,
      recordedAt: new Date().toISOString().slice(0, 10),
    };

    if (existingIdx >= 0) {
      this.entries[existingIdx] = entry;
    } else {
      this.entries.unshift(entry);
    }

    await this.writeDashboardMarkdown();
  }

  private async writeDashboardMarkdown(): Promise<void> {
    const targetPath = normalizePath(
      this.getDashboardPath() || "YouTube Listening/My_Listening_Weakness.md"
    );

    const folder = targetPath.split("/").slice(0, -1).join("/");
    if (folder && !this.app.vault.getAbstractFileByPath(folder)) {
      await this.app.vault.createFolder(folder);
    }

    const counts: Record<ListeningTrapType, number> = {
      LINKING: 0,
      FLAP_T: 0,
      WEAK_FORM: 0,
      ELISION: 0,
      SLANG: 0,
      SPEED_SPIKE: 0,
    };

    for (const item of this.entries) {
      for (const trap of item.traps) {
        counts[trap] = (counts[trap] || 0) + 1;
      }
    }

    const sortedTraps = (Object.keys(counts) as ListeningTrapType[]).sort(
      (a, b) => counts[b] - counts[a]
    );

    const statsRows = sortedTraps
      .map((t) => `| ${TRAP_LABELS[t]} | **${counts[t]}회** |`)
      .join("\n");

    const recentRows = this.entries
      .slice(0, 50)
      .map((e) => {
        const timeStr = formatSecondsToTimestamp(e.segmentStart);
        const trapBadges = e.traps.map((t) => `\`${t}\``).join(" ");
        const heardInfo = e.userHeard ? ` (내 귀엔: *"${e.userHeard}"*)` : "";
        return `- **[${timeStr}]** [[${e.notePath}|${e.videoTitle}]] — ||${e.segmentText}|| $\\rightarrow$ **소리**: \`${e.phoneticKr}\`${heardInfo} ${trapBadges}`;
      })
      .join("\n");

    const markdown = [
      "---",
      "tags:",
      "  - ear-coach-dashboard",
      `updated_at: "${new Date().toISOString()}"`,
      "---",
      "",
      "# 📊 내 귀의 사각지대 (My Ear Blindspots)",
      "",
      "> [!important] **나만의 취약 발음 레이더**",
      "> 유튜브 리스닝 중 `📌 안 들림 핀`을 꽂거나 `1:1 agy 사운드 해부`를 요청한 문장들이 자동으로 분류·누적됩니다.",
      "",
      "## 🏆 내가 가장 자주 놓치는 소리 변화 TOP 순위",
      "",
      "| 소리 변화(음운 현상) 유형 | 누적 빈도 |",
      "| :--- | :--- |",
      statsRows,
      "",
      "## 🔁 집중 복습이 필요한 문장 리스트 (최근 50개)",
      "",
      recentRows || "- 아직 등록된 취약 문장이 없습니다.",
      "",
    ].join("\n");

    const existing = this.app.vault.getAbstractFileByPath(targetPath);
    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, markdown);
    } else {
      await this.app.vault.create(targetPath, markdown);
    }
  }
}
