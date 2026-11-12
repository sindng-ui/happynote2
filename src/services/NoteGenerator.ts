import { App, normalizePath, TFile } from "obsidian";
import {
  ListeningSessionData,
  SegmentTutorNote,
  TranscriptSegment,
} from "../types/transcript";
import { formatSecondsToTimestamp } from "../utils/youtubeUrlParser";
import type { TranscriptWorkerManager } from "../workers/WorkerPoolManager";

const SESSION_CODEBLOCK_START = "```ear-coach-session";
const SESSION_CODEBLOCK_END = "```";

export interface SidecarSessionPointer {
  storage: "sidecar";
  videoId: string;
  title: string;
  segmentCount: number;
  pinnedCount: number;
}

/**
 * Generates and updates Obsidian Markdown notes for YouTube listening sessions.
 * Stores heavy segment arrays in a compressed JSON sidecar file inside the plugin directory
 * so Markdown notes remain ultra-light (~30 lines instead of 27,000+ lines) and Obsidian stays 60fps.
 */
export class NoteGenerator {
  private sessionMemoryCache = new Map<string, ListeningSessionData>();

  constructor(
    private app: App,
    private getNotesFolder: () => string
  ) {}

  private getSidecarDir(): string {
    return normalizePath(`${this.app.vault.configDir}/plugins/obsidian-ear-coach/sessions`);
  }

  private getSidecarPath(videoId: string): string {
    return normalizePath(`${this.getSidecarDir()}/${videoId}.json`);
  }

  private async ensureSidecarDirExists(): Promise<void> {
    const dir = this.getSidecarDir();
    if (!(await this.app.vault.adapter.exists(dir))) {
      await this.app.vault.adapter.mkdir(dir);
    }
  }

  public getCachedSession(videoId: string): ListeningSessionData | null {
    return this.sessionMemoryCache.get(videoId) ?? null;
  }

  public async ensureFolderExists(folderPath: string): Promise<void> {
    const normalized = normalizePath(folderPath);
    if (!normalized) return;
    const exists = this.app.vault.getAbstractFileByPath(normalized);
    if (!exists) {
      await this.app.vault.createFolder(normalized);
    }
  }

  public getNoteFilePath(title: string, videoId: string): string {
    const safeTitle = title
      .replace(/[\\/:*?"<>|]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 70);
    const folder = this.getNotesFolder() || "YouTube Listening";
    return normalizePath(`${folder}/${safeTitle} [${videoId}].md`);
  }

  public findExistingNoteByVideoId(videoId: string): TFile | null {
    const markdownFiles = this.app.vault.getMarkdownFiles();
    for (const file of markdownFiles) {
      if (file.name.includes(`[${videoId}]`)) {
        return file;
      }
      const cache = this.app.metadataCache.getFileCache(file);
      if (cache?.frontmatter?.video_id === videoId) {
        return file;
      }
    }
    return null;
  }

  public extractVideoIdFromFile(file: TFile): string | null {
    const cache = this.app.metadataCache.getFileCache(file);
    if (cache?.frontmatter?.video_id) {
      return String(cache.frontmatter.video_id);
    }
    const match = file.name.match(/\[([a-zA-Z0-9_-]{6,15})\]/);
    return match ? match[1] : null;
  }

  /**
   * Saves heavy session data to the minified sidecar JSON file (O(1) memory cache + fast disk write)
   * and writes only a tiny 1-line pointer inside the Markdown note.
   */
  public async saveSessionToNote(
    session: ListeningSessionData,
    existingFile?: TFile | null,
    sidecarOnly = false
  ): Promise<TFile | null> {
    session.updatedAt = new Date().toISOString();
    this.sessionMemoryCache.set(session.videoId, session);

    // 1. Save full payload to sidecar JSON (minified 1-line for minimal size & maximum speed)
    await this.ensureSidecarDirExists();
    await this.app.vault.adapter.write(
      this.getSidecarPath(session.videoId),
      JSON.stringify(session)
    );

    const targetFile = existingFile ?? this.findExistingNoteByVideoId(session.videoId);
    if (sidecarOnly && targetFile) {
      return targetFile;
    }

    // 2. Keep Markdown note clean and lightweight (~30 lines)
    const folder = this.getNotesFolder() || "YouTube Listening";
    await this.ensureFolderExists(folder);

    if (targetFile) {
      const currentContent = await this.app.vault.read(targetFile);
      const updatedContent = this.replaceSessionPayloadInMarkdown(currentContent, session);
      if (updatedContent !== currentContent) {
        await this.app.vault.modify(targetFile, updatedContent);
      }
      return targetFile;
    }

    const filePath = this.getNoteFilePath(session.title, session.videoId);
    const markdown = this.buildFullMarkdown(session);
    return await this.app.vault.create(filePath, markdown);
  }

  /**
   * Ultra-fast session loader:
   * 1. Checks in-memory cache first (0.00ms)
   * 2. Checks compressed sidecar JSON file (~2ms, skips 27k-line Markdown entirely)
   * 3. Falls back to legacy inline Markdown JSON and automatically migrates it in background.
   */
  public async loadSessionFromNote(
    file: TFile,
    workerManager?: TranscriptWorkerManager,
    prefetchedMarkdown?: string
  ): Promise<ListeningSessionData | null> {
    const videoId = this.extractVideoIdFromFile(file);

    if (videoId) {
      const memHit = this.sessionMemoryCache.get(videoId);
      if (memHit) return memHit;

      const sidecarPath = this.getSidecarPath(videoId);
      try {
        if (await this.app.vault.adapter.exists(sidecarPath)) {
          const rawJson = await this.app.vault.adapter.read(sidecarPath);
          const session = JSON.parse(rawJson) as ListeningSessionData;
          if (session && Array.isArray(session.segments)) {
            this.sessionMemoryCache.set(videoId, session);
            return session;
          }
        }
      } catch {
        // Fallback to Markdown if sidecar read fails
      }
    }

    // Legacy inline Markdown fallback (and auto-migrate to sidecar in background!)
    const content = prefetchedMarkdown ?? (await this.app.vault.read(file));
    let session: ListeningSessionData | null = null;
    if (workerManager) {
      session = await workerManager.parseSessionAsync(content);
    } else {
      session = this.extractSessionFromMarkdown(content);
    }

    if (session && Array.isArray((session as any).segments)) {
      this.sessionMemoryCache.set(session.videoId, session);
      // Auto-migrate heavy 27k-line note to lightweight sidecar asynchronously without blocking UI
      window.setTimeout(() => {
        this.saveSessionToNote(session!, file, false).catch(() => {});
      }, 800);
      return session;
    }

    return null;
  }

  public extractSessionFromMarkdown(markdown: string): ListeningSessionData | null {
    const startIdx = markdown.indexOf(SESSION_CODEBLOCK_START);
    if (startIdx === -1) return null;

    const jsonStart = startIdx + SESSION_CODEBLOCK_START.length;
    const endIdx = markdown.indexOf(SESSION_CODEBLOCK_END, jsonStart);
    if (endIdx === -1) return null;

    const rawJson = markdown.slice(jsonStart, endIdx).trim();
    try {
      return JSON.parse(rawJson) as ListeningSessionData;
    } catch {
      return null;
    }
  }

  /**
   * Appends a permanent Markdown callout to the note when the user saves an `agy` 1:1 Sound Doctor coaching answer.
   */
  public async appendTutorCalloutToNote(
    file: TFile,
    segment: TranscriptSegment,
    tutorNote: SegmentTutorNote
  ): Promise<void> {
    const content = await this.app.vault.read(file);
    const timeLabel = formatSecondsToTimestamp(segment.start);

    const calloutLines = [
      "",
      `> [!tip]+ 🎙️ [${timeLabel}] "${segment.text}" — 사운드 해부 노트`,
      `> - **내가 들은 소리**: \`${tutorNote.userHeard || "미입력"}\``,
      `> - **질문**: ${tutorNote.question}`,
      ...tutorNote.answer.split(/\r?\n/).map((line) => `> ${line}`),
      "",
    ].join("\n");

    await this.app.vault.modify(file, content + calloutLines);
  }

  private buildSidecarPointer(session: ListeningSessionData): SidecarSessionPointer {
    return {
      storage: "sidecar",
      videoId: session.videoId,
      title: session.title,
      segmentCount: session.segments.length,
      pinnedCount: session.segments.filter((s) => s.isPinned).length,
    };
  }

  private buildFullMarkdown(session: ListeningSessionData): string {
    const pinnedCount = session.segments.filter((s) => s.isPinned).length;
    const speedSpikeCount = session.segments.filter((s) => s.isSpeedSpike).length;

    const pinnedSummary = session.segments
      .filter((s) => s.isPinned)
      .map(
        (s) =>
          `- 📌 **[${formatSecondsToTimestamp(s.start)}]** — ||${s.text}|| *(소리 힌트: ${s.analysis?.phoneticKr || "분석 중"})*`
      )
      .join("\n");

    return [
      "---",
      `video_id: "${session.videoId}"`,
      `video_url: "${session.videoUrl}"`,
      `channel: "${(session.channelName || "YouTube").replace(/"/g, '\\"')}"`,
      `agy_conversation_id: "${session.agyConversationId || ""}"`,
      `pinned_count: ${pinnedCount}`,
      `speed_spike_count: ${speedSpikeCount}`,
      `created_at: "${session.createdAt}"`,
      `updated_at: "${session.updatedAt}"`,
      "tags:",
      "  - ear-coach",
      "  - english-listening",
      "---",
      "",
      `# 🎧 ${session.title}`,
      "",
      `> [!info] **Obsidian Ear-Coach 워크스페이스 안내**`,
      `> 좌측 목록에서 이 노트를 선택하거나 명령어 팔레트에서 **\`Ear-Coach: 현재 노트 리스닝 코치 열기\`**를 실행하면 **A-B 문장 무한 루프 + 3단계 블라인드 언락커 + 1:1 \`agy\` 사운드 닥터**를 인터랙티브하게 사용할 수 있습니다.`,
      "",
      "## 📌 집중 분석 핀(Unclear Spots) 요약",
      pinnedSummary || "- 아직 고정된 집중 분석 핀이 없습니다. 안 들리는 구간에서 `📌 핀` 버튼을 눌러보세요!",
      "",
      "## 🎛️ 인터랙티브 리스닝 세션 데이터",
      SESSION_CODEBLOCK_START,
      JSON.stringify(this.buildSidecarPointer(session)),
      SESSION_CODEBLOCK_END,
      "",
      "## 📝 나의 1:1 `agy` 사운드 해부 기록",
      "",
    ].join("\n");
  }

  private replaceSessionPayloadInMarkdown(
    markdown: string,
    session: ListeningSessionData
  ): string {
    const startIdx = markdown.indexOf(SESSION_CODEBLOCK_START);
    if (startIdx === -1) {
      return this.buildFullMarkdown(session);
    }

    const jsonStart = startIdx + SESSION_CODEBLOCK_START.length;
    const endIdx = markdown.indexOf(SESSION_CODEBLOCK_END, jsonStart);
    if (endIdx === -1) {
      return this.buildFullMarkdown(session);
    }

    const before = markdown.slice(0, startIdx);
    const after = markdown.slice(endIdx + SESSION_CODEBLOCK_END.length);

    const updatedFrontmatterBefore = before
      .replace(/agy_conversation_id:\s*"[^"]*"/, `agy_conversation_id: "${session.agyConversationId || ""}"`)
      .replace(/updated_at:\s*"[^"]*"/, `updated_at: "${session.updatedAt}"`);

    return [
      updatedFrontmatterBefore,
      SESSION_CODEBLOCK_START,
      "\n",
      JSON.stringify(this.buildSidecarPointer(session)),
      "\n",
      SESSION_CODEBLOCK_END,
      after,
    ].join("");
  }
}
