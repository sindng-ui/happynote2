import { Notice, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import {
  DEFAULT_EAR_COACH_SETTINGS,
  EarCoachSettings,
} from "./types/settings";
import { ListeningSessionData } from "./types/transcript";
import {
  parseTimestampToSeconds,
  parseYouTubeUrl,
} from "./utils/youtubeUrlParser";
import { SegmentTimeIndex } from "./utils/binarySearch";
import { TranscriptWorkerManager } from "./workers/WorkerPoolManager";
import { TranscriptService } from "./services/TranscriptService";
import { AgyCliService } from "./services/AgyCliService";
import { NoteGenerator } from "./services/NoteGenerator";
import { WeaknessTracker } from "./services/WeaknessTracker";
import { EarCoachView, VIEW_TYPE_EAR_COACH } from "./ui/EarCoachView";
import { UrlInputModal } from "./ui/UrlInputModal";
import { EarCoachSettingTab } from "./ui/SettingsTab";

/**
 * Main Obsidian Plugin class for Ear-Coach (YouTube + Obsidian + agy CLI).
 */
export default class EarCoachPlugin extends Plugin {
  public settings: EarCoachSettings = DEFAULT_EAR_COACH_SETTINGS;
  public workerManager!: TranscriptWorkerManager;
  public transcriptService!: TranscriptService;
  public agyService!: AgyCliService;
  public noteGenerator!: NoteGenerator;
  public weaknessTracker!: WeaknessTracker;
  public bypassOpenInterceptor = false;

  public async onload(): Promise<void> {
    await this.loadSettings();

    this.workerManager = new TranscriptWorkerManager(2);
    this.transcriptService = new TranscriptService(
      () => this.settings.ytDlpBinaryPath
    );
    this.agyService = new AgyCliService(
      () => this.settings.agyBinaryPath,
      () => this.settings.agyModel
    );
    this.noteGenerator = new NoteGenerator(
      this.app,
      () => this.settings.notesFolder
    );
    this.weaknessTracker = new WeaknessTracker(
      this.app,
      () => this.settings.weaknessDashboardPath
    );

    // 1. Register Custom Interactive Workspace View
    this.registerView(
      VIEW_TYPE_EAR_COACH,
      (leaf: WorkspaceLeaf) => new EarCoachView(leaf, this)
    );

    // 2. Register Custom URI Handler: obsidian://ear-coach?url=...&t=142&pin=true
    this.registerObsidianProtocolHandler("ear-coach", async (params) => {
      const rawUrl = params.url;
      if (!rawUrl) {
        new Notice("Ear-Coach URI에 유튜브 url 파라미터가 없습니다.");
        return;
      }
      const pinSec = parseTimestampToSeconds(params.t);
      await this.handleYouTubeTrigger(rawUrl, pinSec);
    });

    // 3. Register Ribbon Icon
    this.addRibbonIcon(
      "headphones",
      "Ear-Coach: 유튜브 영어 리스닝 노트 생성 / 열기",
      () => {
        this.openUrlInputModal();
      }
    );

    // 4. Register Commands
    this.addCommand({
      id: "ear-coach-create-from-url-modal",
      name: "유튜브 URL로 리스닝 노트 생성 및 열기 (Create Listening Note from URL)",
      callback: () => {
        this.openUrlInputModal();
      },
    });

    this.addCommand({
      id: "ear-coach-create-from-clipboard",
      name: "클립보드 유튜브 URL로 즉시 리스닝 노트 생성 (Zero-Friction Clipboard Trigger)",
      callback: async () => {
        try {
          const clip = await navigator.clipboard.readText();
          const parsed = parseYouTubeUrl(clip);
          if (!parsed) {
            new Notice("클립보드에 유효한 유튜브 URL이 없습니다. 입력창을 엽니다.");
            this.openUrlInputModal();
            return;
          }
          await this.handleYouTubeTrigger(clip, parsed.timestampSeconds);
        } catch {
          this.openUrlInputModal();
        }
      },
    });

    this.addCommand({
      id: "ear-coach-open-current-note",
      name: "현재 마크다운 노트의 인터랙티브 리스닝 코치 워크스페이스 열기",
      checkCallback: (checking: boolean) => {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile) return false;
        if (!checking) {
          this.openEarCoachForNoteFile(activeFile);
        }
        return true;
      },
    });

    // 5. Register Markdown Codeblock Processor for `ear-coach-session`
    this.registerMarkdownCodeBlockProcessor(
      "ear-coach-session",
      (source, el, ctx) => {
        el.empty();
        const card = el.createDiv({ cls: "ear-coach-inline-banner" });
        try {
          const parsed = JSON.parse(source);
          const isSidecar = parsed && parsed.storage === "sidecar";
          const title = parsed.title || "Ear-Coach 리스닝 세션";
          const segCount = isSidecar
            ? parsed.segmentCount ?? 0
            : Array.isArray(parsed.segments)
              ? parsed.segments.length
              : 0;
          const pinCount = isSidecar
            ? parsed.pinnedCount ?? 0
            : Array.isArray(parsed.segments)
              ? parsed.segments.filter((s: any) => s.isPinned).length
              : 0;

          card.createEl("h4", {
            text: `🎧 ${title} — 총 ${segCount}문장 (📌 핀 ${pinCount}개)`,
          });
          const openBtn = card.createEl("button", {
            cls: "ear-coach-btn ear-coach-btn-primary",
            text: "🚀 인터랙티브 리스닝 워크스페이스 열기 (구간반복 + 3단계 블라인드 + agy 튜터)",
          });
          openBtn.addEventListener("click", async () => {
            const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
            if (file instanceof TFile) {
              const fullSession = isSidecar
                ? await this.noteGenerator.loadSessionFromNote(file, this.workerManager)
                : (parsed as ListeningSessionData);
              if (fullSession) {
                await this.activateWorkspaceView(fullSession, file);
              }
            } else if (!isSidecar) {
              await this.activateWorkspaceView(parsed as ListeningSessionData, null);
            }
          });
        } catch {
          card.setText("⚠️ 리스닝 세션 JSON 데이터를 파싱할 수 없습니다.");
        }
      }
    );

    // 6. Settings Tab
    this.addSettingTab(new EarCoachSettingTab(this.app, this));

    // 7. Intercept WorkspaceLeaf.openFile BEFORE CodeMirror parses giant Markdown files (0ms skip)
    const plugin = this;
    const origOpenFile = WorkspaceLeaf.prototype.openFile;
    WorkspaceLeaf.prototype.openFile = async function (
      this: WorkspaceLeaf,
      file: TFile,
      openState?: any
    ): Promise<void> {
      if (
        file &&
        file.extension === "md" &&
        !plugin.bypassOpenInterceptor &&
        plugin.isEarCoachNoteFast(file)
      ) {
        const session = await plugin.noteGenerator.loadSessionFromNote(
          file,
          plugin.workerManager
        );
        if (session) {
          const coachLeaves = plugin.app.workspace.getLeavesOfType(VIEW_TYPE_EAR_COACH);
          if (coachLeaves.length > 0) {
            const targetLeaf = coachLeaves[0];
            if (this !== targetLeaf && this.view.getViewType() === "empty") {
              this.detach();
            }
            plugin.app.workspace.revealLeaf(targetLeaf);
            if (targetLeaf.view instanceof EarCoachView) {
              await targetLeaf.view.loadSession(session, file);
            }
            return;
          } else {
            await this.setViewState({
              type: VIEW_TYPE_EAR_COACH,
              active: true,
            });
            plugin.app.workspace.revealLeaf(this);
            if (this.view instanceof EarCoachView) {
              await this.view.loadSession(session, file);
            }
            return;
          }
        }
      }
      return origOpenFile.call(this, file, openState);
    };
    this.register(() => {
      WorkspaceLeaf.prototype.openFile = origOpenFile;
    });

    // 8. Fallback Auto-open when metadataCache wasn't warm yet or layout ready
    this.registerEvent(
      this.app.workspace.on("file-open", async (file) => {
        if (!file || !file.path.endsWith(".md") || this.bypassOpenInterceptor) return;
        await this.tryAutoOpenEarCoachForFile(file);
      })
    );

    this.app.workspace.onLayoutReady(async () => {
      const activeFile = this.app.workspace.getActiveFile();
      if (activeFile && activeFile.path.endsWith(".md")) {
        await this.tryAutoOpenEarCoachForFile(activeFile);
      }
    });
  }

  public isEarCoachNoteFast(file: TFile): boolean {
    const cache = this.app.metadataCache.getFileCache(file);
    const tags = cache?.frontmatter?.tags;
    return Boolean(
      cache?.frontmatter?.video_id ||
        (Array.isArray(tags) &&
          (tags.includes("ear-coach") || tags.includes("english-listening"))) ||
        tags === "ear-coach"
    );
  }

  private isAutoSwitching = false;

  private async tryAutoOpenEarCoachForFile(file: TFile): Promise<void> {
    if (this.isAutoSwitching) return;
    const cache = this.app.metadataCache.getFileCache(file);
    const tags = cache?.frontmatter?.tags;
    let isEarCoach =
      cache?.frontmatter?.video_id ||
      (Array.isArray(tags) && (tags.includes("ear-coach") || tags.includes("english-listening"))) ||
      tags === "ear-coach";

    let prefetchedContent: string | undefined;
    if (!isEarCoach) {
      try {
        const content = await this.app.vault.read(file);
        if (content.includes("ear-coach-session") || content.includes("video_id:")) {
          isEarCoach = true;
          prefetchedContent = content;
        }
      } catch {
        // Ignore read errors
      }
    }

    if (isEarCoach) {
      try {
        this.isAutoSwitching = true;
        const session = await this.noteGenerator.loadSessionFromNote(
          file,
          this.workerManager,
          prefetchedContent
        );
        if (session) {
          await this.activateWorkspaceView(session, file, undefined, true);
        }
      } finally {
        setTimeout(() => {
          this.isAutoSwitching = false;
        }, 150);
      }
    }
  }

  public onunload(): void {
    this.workerManager?.destroy();
  }

  public openUrlInputModal(): void {
    new UrlInputModal(this.app, async ({ url, pinTimestampSeconds }) => {
      await this.handleYouTubeTrigger(url, pinTimestampSeconds);
    }).open();
  }

  /**
   * Core pipeline triggered by URI, Clipboard hotkey, or Modal.
   * If a note for this video already exists, adds the new timestamp pin and opens it immediately.
   * Otherwise extracts transcript -> merges sentences in Web Worker -> creates note -> opens interactive view -> runs optional `agy` batch analysis.
   */
  public async handleYouTubeTrigger(
    rawUrl: string,
    pinTimestampSeconds?: number
  ): Promise<void> {
    const parsed = parseYouTubeUrl(rawUrl);
    if (!parsed) {
      new Notice("유효한 유튜브 URL이 아닙니다.");
      return;
    }

    const effectivePin = pinTimestampSeconds ?? parsed.timestampSeconds;
    const existingFile = this.noteGenerator.findExistingNoteByVideoId(
      parsed.videoId
    );

    if (existingFile) {
      const existingSession =
        await this.noteGenerator.loadSessionFromNote(
          existingFile,
          this.workerManager
        );
      if (existingSession) {
        if (effectivePin !== undefined) {
          if (!existingSession.pinnedTimestamps.includes(effectivePin)) {
            existingSession.pinnedTimestamps.push(effectivePin);
          }
          const idx = new SegmentTimeIndex(
            existingSession.segments
          ).findNearestSegmentIndex(effectivePin);
          if (idx >= 0) {
            existingSession.segments[idx].isPinned = true;
          }
          await this.noteGenerator.saveSessionToNote(
            existingSession,
            existingFile
          );
          new Notice(
            `기존 노트에 📌 집중 분석 핀(${effectivePin}초)을 추가했습니다!`
          );
        }
        await this.activateWorkspaceView(
          existingSession,
          existingFile,
          effectivePin
        );
        return;
      }
    }

    new Notice("⏳ 유튜브 자막을 추출하고 문장 단위로 조립하고 있습니다...");

    try {
      const fetched = await this.transcriptService.fetchTranscript(
        parsed.videoId,
        this.settings.preferredCaptionLang
      );

      const pinnedTimestamps =
        effectivePin !== undefined ? [effectivePin] : [];

      const segments = await this.workerManager.processCuesAsync(fetched.cues, {
        speedSpikeWpmThreshold: this.settings.speedSpikeWpmThreshold,
        defaultUnlockStep: this.settings.defaultUnlockStep,
        pinnedTimestamps,
      });

      const now = new Date().toISOString();
      const session: ListeningSessionData = {
        videoId: parsed.videoId,
        videoUrl: parsed.canonicalUrl,
        title: fetched.title,
        channelName: fetched.channelName,
        createdAt: now,
        updatedAt: now,
        pinnedTimestamps,
        segments,
      };

      const noteFile = await this.noteGenerator.saveSessionToNote(session);
      new Notice(`✅ 리스닝 노트 생성 완료: ${fetched.title}`);

      await this.activateWorkspaceView(session, noteFile, effectivePin);

      if (this.settings.autoRunAgyBatchOnCreate) {
        this.runAgyBatchEnrichment(session, noteFile).catch(() => {
          // Fallback heuristics are already active; non-blocking background enrichment
        });
      }
    } catch (err) {
      new Notice(
        `❌ 자막 추출 실패: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Runs `agy` CLI structured batch analysis on pinned + speed-spike + key segments.
   */
  public async runAgyBatchEnrichment(
    session: ListeningSessionData,
    noteFile: TFile | null
  ): Promise<void> {
    const prioritized = [...session.segments]
      .sort((a, b) => {
        if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
        if (a.isSpeedSpike !== b.isSpeedSpike) return a.isSpeedSpike ? -1 : 1;
        return a.index - b.index;
      })
      .slice(0, this.settings.maxBatchSegmentsPerRequest);

    const response = await this.agyService.analyzeSegmentsBatch({
      videoTitle: session.title,
      segments: prioritized.map((s) => ({
        index: s.index,
        text: s.text,
        wpm: s.wpm,
        isPinned: s.isPinned,
      })),
    });

    for (const item of response.items) {
      const seg = session.segments[item.segmentIndex];
      if (!seg) continue;
      seg.analysis = {
        traps: item.traps,
        phoneticKr: item.phoneticKr,
        trapExplanation: item.trapExplanation,
        skeletonWordIndices: item.skeletonWordIndices,
        dictationBlankIndices: item.dictationBlankIndices,
        rhythmGuide: item.rhythmGuide,
        translationKr: item.translationKr,
      };
    }

    if (noteFile) {
      await this.noteGenerator.saveSessionToNote(session, noteFile);
    }
  }

  private async openEarCoachForNoteFile(file: TFile): Promise<void> {
    const session = await this.noteGenerator.loadSessionFromNote(
      file,
      this.workerManager
    );
    if (!session) {
      new Notice("이 노트에는 Ear-Coach 리스닝 세션 데이터가 없습니다.");
      return;
    }
    await this.activateWorkspaceView(session, file);
  }

  public async activateWorkspaceView(
    session: ListeningSessionData,
    noteFile: TFile | null,
    focusTimestampSec?: number,
    closeOriginMarkdownLeaf: boolean = false
  ): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = null;
    const coachLeaves = workspace.getLeavesOfType(VIEW_TYPE_EAR_COACH);

    // noteFile을 표시하고 있는 마크다운 리프 찾기
    const mdLeavesToClose: WorkspaceLeaf[] = [];
    if (closeOriginMarkdownLeaf && noteFile) {
      workspace.iterateAllLeaves((l) => {
        if (l.view.getViewType() === "markdown") {
          const mdView = l.view as any;
          if (mdView.file && mdView.file.path === noteFile.path) {
            mdLeavesToClose.push(l);
          }
        }
      });
    }

    if (coachLeaves.length > 0) {
      // 1. 이미 EarCoachView 탭이 열려있으면 기존 탭을 재사용!
      leaf = coachLeaves[0];
      // 파일 클릭 시 새로 생긴 마크다운 에디터 탭 닫기
      for (const mdLeaf of mdLeavesToClose) {
        try {
          mdLeaf.detach();
        } catch {
          // ignore detach error
        }
      }
    } else {
      // 2. EarCoachView 탭이 없으면, 새로 열린 마크다운 탭을 EarCoachView로 즉시 전환!
      if (mdLeavesToClose.length > 0) {
        leaf = mdLeavesToClose[0];
        for (let i = 1; i < mdLeavesToClose.length; i++) {
          try {
            mdLeavesToClose[i].detach();
          } catch {
            // ignore
          }
        }
        await leaf.setViewState({
          type: VIEW_TYPE_EAR_COACH,
          active: true,
        });
      } else {
        leaf = workspace.getLeaf("tab");
        await leaf.setViewState({
          type: VIEW_TYPE_EAR_COACH,
          active: true,
        });
      }
    }

    workspace.revealLeaf(leaf);
    if (leaf.view instanceof EarCoachView) {
      await leaf.view.loadSession(session, noteFile, focusTimestampSec);
    }
  }

  public async loadSettings(): Promise<void> {
    this.settings = Object.assign(
      {},
      DEFAULT_EAR_COACH_SETTINGS,
      await this.loadData()
    );
  }

  public async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
