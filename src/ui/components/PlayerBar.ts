import { TranscriptSegment } from "../../types/transcript";
import { formatSecondsToTimestamp } from "../../utils/youtubeUrlParser";

export interface PlayerBarCallbacks {
  onTimeUpdate: (currentTimeSec: number) => void;
  onLoopToggle: (
    isLooping: boolean,
    segment: TranscriptSegment | null,
    previousSegment?: TranscriptSegment | null
  ) => void;
}

declare global {
  interface Window {
    YT?: any;
    onYouTubeIframeAPIReady?: () => void;
  }
}

/**
 * High-performance YouTube controller with A-B sentence infinite loop.
 * Features dual-mode time tracking: native YouTube IFrame API + wall-clock hybrid fallback
 * to guarantee 100% reliable sentence looping even if YouTube cross-origin messaging is restricted.
 */
export class PlayerBar {
  private iframeEl: HTMLIFrameElement | null = null;
  private ytPlayer: any = null;
  private playerMountEl: HTMLElement | null = null;
  private statusLabelEl: HTMLElement | null = null;
  private loopBtnEl: HTMLButtonElement | null = null;
  private currentVideoId = "";
  private containerId = "";
  private isMounted = false;
  private isEmbedLoaded = false;
  private mountTimeoutId: number | null = null;
  private pendingStartSec: number | null = null;
  private thumbnailEl: HTMLElement | null = null;
  private currentTimeSec = 0;
  private isPlaying = false;
  private playbackRate = 1.0;
  private activeLoopSegment: TranscriptSegment | null = null;
  private loopPaddingSec = 0.25;
  private boundMessageListener: (ev: MessageEvent) => void;
  private pollIntervalId: number | null = null;
  private lastSeekWallTime = 0;
  private lastSeekVideoTime = 0;
  private hasReportedYtTime = false;
  private seekLockUntil = 0;
  private lockedSeekTime = 0;

  constructor(
    private containerEl: HTMLElement,
    private callbacks: PlayerBarCallbacks,
    initialRate = 1.0,
    loopPadding = 0.25
  ) {
    this.playbackRate = initialRate;
    this.loopPaddingSec = loopPadding;
    this.boundMessageListener = this.handlePostMessage.bind(this);
    window.addEventListener("message", this.boundMessageListener);
    this.ensureYouTubeIframeApiScript();
  }

  private ensureYouTubeIframeApiScript(): void {
    if (window.YT && window.YT.Player) return;
    if (document.getElementById("ear-coach-yt-api-script")) return;

    try {
      const tag = document.createElement("script");
      tag.id = "ear-coach-yt-api-script";
      tag.src = "https://www.youtube.com/iframe_api";
      document.head.appendChild(tag);
    } catch {
      // Ignore if CSP blocks
    }
  }

  public render(videoId: string): void {
    if (this.isMounted) {
      this.loadVideo(videoId);
      return;
    }

    this.currentVideoId = videoId;
    this.isMounted = true;
    this.isEmbedLoaded = false;
    this.containerEl.empty();
    this.containerEl.addClass("ear-coach-player-wrapper");

    const videoBox = this.containerEl.createDiv({ cls: "ear-coach-video-box" });
    this.thumbnailEl = videoBox.createDiv({ cls: "ear-coach-video-thumbnail" });
    this.thumbnailEl.style.backgroundImage = `url("https://i.ytimg.com/vi/${videoId}/hqdefault.jpg")`;
    this.thumbnailEl.createDiv({
      cls: "ear-coach-thumbnail-badge",
      text: "▶ YouTube 플레이어 준비 중...",
    });

    this.containerId = `ear-coach-player-${Date.now()}`;
    this.playerMountEl = videoBox.createDiv({ attr: { id: this.containerId } });

    const controlsBar = this.containerEl.createDiv({ cls: "ear-coach-player-controls" });

    // Play / Pause button
    const playPauseBtn = controlsBar.createEl("button", {
      cls: "ear-coach-btn ear-coach-btn-primary",
      text: "⏯ 재생/일시정지",
    });
    playPauseBtn.addEventListener("click", () => this.togglePlayPause());

    // Loop toggle button
    this.loopBtnEl = controlsBar.createEl("button", {
      cls: "ear-coach-btn",
      text: "🔁 문장 무한루프: OFF",
    });
    this.loopBtnEl.addEventListener("click", () => {
      this.clearSegmentLoop();
    });

    // Playback speed buttons
    const speedGroup = controlsBar.createDiv({ cls: "ear-coach-speed-group" });
    speedGroup.createSpan({ cls: "ear-coach-speed-label", text: "배속:" });

    const speeds = [0.7, 0.85, 1.0, 1.15];
    const speedButtons: HTMLButtonElement[] = [];

    for (const spd of speeds) {
      const btn = speedGroup.createEl("button", {
        cls: `ear-coach-btn ear-coach-speed-btn ${Math.abs(this.playbackRate - spd) < 0.02 ? "is-active" : ""}`,
        text: `${spd}x`,
      });
      btn.addEventListener("click", () => {
        speedButtons.forEach((b) => b.removeClass("is-active"));
        btn.addClass("is-active");
        this.setPlaybackRate(spd);
      });
      speedButtons.push(btn);
    }

    this.statusLabelEl = controlsBar.createDiv({
      cls: "ear-coach-player-status",
      text: "⏱ 00:00",
    });

    this.startLoopEnforcementTimer();

    // Defer heavy YouTube IFrame JS boot by 300ms so initial page open + virtual list paint runs at pure 60fps
    this.mountTimeoutId = window.setTimeout(() => {
      this.mountTimeoutId = null;
      this.mountYouTubeEmbed(this.currentVideoId, this.containerId);
    }, 300);
  }

  public loadVideo(videoId: string): void {
    this.clearSegmentLoop();
    this.currentTimeSec = 0;
    this.isPlaying = false;
    this.hasReportedYtTime = false;
    this.lastSeekWallTime = 0;
    this.lastSeekVideoTime = 0;
    this.seekLockUntil = 0;
    this.pendingStartSec = null;
    this.statusLabelEl?.setText("⏱ 00:00");

    if (this.thumbnailEl) {
      this.thumbnailEl.style.backgroundImage = `url("https://i.ytimg.com/vi/${videoId}/hqdefault.jpg")`;
    }

    if (this.currentVideoId === videoId) return;
    this.currentVideoId = videoId;

    if (!this.isEmbedLoaded) {
      return;
    }

    if (this.ytPlayer && typeof this.ytPlayer.cueVideoById === "function") {
      try {
        this.ytPlayer.cueVideoById(videoId);
        this.ytPlayer.setPlaybackRate(this.playbackRate);
        return;
      } catch {
        // Fallback to iframe src update
      }
    }

    if (this.iframeEl) {
      const origin = encodeURIComponent(window.location.origin || "https://www.youtube.com");
      this.iframeEl.src = `https://www.youtube.com/embed/${videoId}?enablejsapi=1&rel=0&modestbranding=1&playsinline=1&origin=${origin}&widget_referrer=${origin}`;
    }
  }

  private mountYouTubeEmbed(videoId: string, containerId: string): void {
    if (!this.playerMountEl || this.isEmbedLoaded) return;
    this.isEmbedLoaded = true;
    const origin = encodeURIComponent(window.location.origin || "https://www.youtube.com");

    const onPlayerInitialized = () => {
      this.thumbnailEl?.remove();
      this.thumbnailEl = null;
      this.ytPlayer?.setPlaybackRate?.(this.playbackRate);
      if (this.pendingStartSec !== null) {
        const sec = this.pendingStartSec;
        this.pendingStartSec = null;
        this.seekTo(sec);
        this.play();
      }
    };

    if (window.YT && window.YT.Player) {
      try {
        this.ytPlayer = new window.YT.Player(containerId, {
          width: "100%",
          height: "100%",
          videoId,
          playerVars: {
            enablejsapi: 1,
            rel: 0,
            modestbranding: 1,
            playsinline: 1,
            origin: window.location.origin,
          },
          events: {
            onReady: () => onPlayerInitialized(),
            onStateChange: (ev: any) => {
              this.isPlaying = ev.data === 1;
            },
          },
        });
      } catch {
        this.ytPlayer = null;
      }
    }

    if (!this.ytPlayer) {
      this.iframeEl = this.playerMountEl.createEl("iframe", {
        cls: "ear-coach-youtube-iframe",
        attr: {
          src: `https://www.youtube.com/embed/${videoId}?enablejsapi=1&rel=0&modestbranding=1&playsinline=1&origin=${origin}&widget_referrer=${origin}`,
          allow: "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture",
          allowfullscreen: "true",
        },
      });

      this.iframeEl.addEventListener("load", () => {
        this.sendRawMessage({ event: "listening" });
        onPlayerInitialized();
      });
    }
  }

  public isSegmentLooping(segment: TranscriptSegment): boolean {
    return this.activeLoopSegment !== null && this.activeLoopSegment.index === segment.index;
  }

  public playSegment(segment: TranscriptSegment, toggleLoop = false): void {
    if (toggleLoop && this.isSegmentLooping(segment)) {
      this.clearSegmentLoop();
      return;
    }

    const startSec = Math.max(0, segment.start);
    if (!this.isEmbedLoaded) {
      this.pendingStartSec = startSec;
      if (this.mountTimeoutId !== null) {
        window.clearTimeout(this.mountTimeoutId);
        this.mountTimeoutId = null;
      }
      this.mountYouTubeEmbed(this.currentVideoId, this.containerId);
    } else {
      this.seekTo(startSec);
      this.play();
    }

    if (toggleLoop) {
      this.setSegmentLoop(segment);
    } else {
      this.clearSegmentLoop();
    }
  }

  public setSegmentLoop(segment: TranscriptSegment): void {
    const prev = this.activeLoopSegment;
    this.activeLoopSegment = segment;
    this.lastSeekWallTime = performance.now();
    this.lastSeekVideoTime = segment.start;
    this.isPlaying = true;

    if (this.loopBtnEl) {
      this.loopBtnEl.addClass("is-loop-active");
      this.loopBtnEl.setText(
        `🔁 루프 중: [${formatSecondsToTimestamp(segment.start)} ~ ${formatSecondsToTimestamp(segment.end)}] (해제 클릭)`
      );
    }
    this.callbacks.onLoopToggle(true, segment, prev);
  }

  public clearSegmentLoop(): void {
    const prev = this.activeLoopSegment;
    if (!prev) return;
    this.activeLoopSegment = null;
    if (this.loopBtnEl) {
      this.loopBtnEl.removeClass("is-loop-active");
      this.loopBtnEl.setText("🔁 문장 무한루프: OFF");
    }
    this.callbacks.onLoopToggle(false, null, prev);
  }

  public seekTo(seconds: number): void {
    this.currentTimeSec = Math.max(0, seconds);
    this.lockedSeekTime = this.currentTimeSec;
    this.seekLockUntil = performance.now() + 1000;
    this.lastSeekWallTime = performance.now();
    this.lastSeekVideoTime = this.currentTimeSec;

    if (this.ytPlayer && typeof this.ytPlayer.seekTo === "function") {
      this.ytPlayer.seekTo(this.currentTimeSec, true);
    } else {
      this.sendCommand("seekTo", [this.currentTimeSec, true]);
    }
  }

  public play(): void {
    this.isPlaying = true;
    this.lastSeekWallTime = performance.now();

    if (this.ytPlayer && typeof this.ytPlayer.playVideo === "function") {
      this.ytPlayer.playVideo();
    } else {
      this.sendCommand("playVideo", []);
    }
  }

  public pause(): void {
    this.isPlaying = false;

    if (this.ytPlayer && typeof this.ytPlayer.pauseVideo === "function") {
      this.ytPlayer.pauseVideo();
    } else {
      this.sendCommand("pauseVideo", []);
    }
  }

  public togglePlayPause(): void {
    if (this.isPlaying) {
      this.pause();
    } else {
      this.play();
    }
  }

  public setPlaybackRate(rate: number): void {
    this.playbackRate = rate;
    this.lastSeekWallTime = performance.now();
    this.lastSeekVideoTime = this.getEffectiveCurrentTime();

    if (this.ytPlayer && typeof this.ytPlayer.setPlaybackRate === "function") {
      this.ytPlayer.setPlaybackRate(rate);
    } else {
      this.sendCommand("setPlaybackRate", [rate]);
    }
  }

  private sendCommand(func: string, args: unknown[]): void {
    const iframe = this.getIframeElement();
    if (!iframe?.contentWindow) return;
    const message = JSON.stringify({
      event: "command",
      func,
      args,
    });
    iframe.contentWindow.postMessage(message, "*");
  }

  private sendRawMessage(obj: unknown): void {
    const iframe = this.getIframeElement();
    if (!iframe?.contentWindow) return;
    iframe.contentWindow.postMessage(JSON.stringify(obj), "*");
  }

  private getIframeElement(): HTMLIFrameElement | null {
    if (this.iframeEl) return this.iframeEl;
    if (this.ytPlayer && typeof this.ytPlayer.getIframe === "function") {
      return this.ytPlayer.getIframe();
    }
    return this.containerEl.querySelector("iframe");
  }

  private handlePostMessage(ev: MessageEvent): void {
    if (!ev.data || typeof ev.data !== "string") return;
    try {
      const data = JSON.parse(ev.data);
      if (data.event === "infoDelivery" && data.info) {
        if (typeof data.info.currentTime === "number") {
          const incoming = data.info.currentTime;
          if (performance.now() < this.seekLockUntil && incoming < this.lockedSeekTime) {
            return;
          }
          this.currentTimeSec = incoming;
          this.hasReportedYtTime = true;
          this.lastSeekWallTime = performance.now();
          this.lastSeekVideoTime = incoming;
          this.onTimeTick(incoming);
        }
        if (typeof data.info.playerState === "number") {
          this.isPlaying = data.info.playerState === 1;
        }
      }
    } catch {
      // Ignore non-YouTube JSON messages
    }
  }

  private getEffectiveCurrentTime(): number {
    if (this.ytPlayer && typeof this.ytPlayer.getCurrentTime === "function") {
      try {
        const t = this.ytPlayer.getCurrentTime();
        if (typeof t === "number" && Number.isFinite(t)) {
          if (performance.now() < this.seekLockUntil && t < this.lockedSeekTime) {
            const elapsedSec = ((performance.now() - this.lastSeekWallTime) / 1000) * this.playbackRate;
            return this.lockedSeekTime + elapsedSec;
          }
          return t;
        }
      } catch {
        // Fallback
      }
    }

    if (this.hasReportedYtTime) {
      if (performance.now() < this.seekLockUntil && this.currentTimeSec < this.lockedSeekTime) {
        const elapsedSec = ((performance.now() - this.lastSeekWallTime) / 1000) * this.playbackRate;
        return this.lockedSeekTime + elapsedSec;
      }
      return this.currentTimeSec;
    }

    // Hybrid Fallback: Calculate elapsed seconds from last seek action
    if (this.isPlaying && this.lastSeekWallTime > 0) {
      const elapsedSec = ((performance.now() - this.lastSeekWallTime) / 1000) * this.playbackRate;
      return this.lastSeekVideoTime + elapsedSec;
    }

    return this.lastSeekVideoTime;
  }

  private startLoopEnforcementTimer(): void {
    if (this.pollIntervalId !== null) {
      window.clearInterval(this.pollIntervalId);
    }

    this.pollIntervalId = window.setInterval(() => {
      const current = this.getEffectiveCurrentTime();
      this.onTimeTick(current);

      if (this.activeLoopSegment && this.isPlaying) {
        const endLimit = this.activeLoopSegment.end + this.loopPaddingSec;
        if (current >= endLimit) {
          const loopStart = Math.max(0, this.activeLoopSegment.start);
          this.seekTo(loopStart);
          this.play();
        }
      }
    }, 80);
  }

  private onTimeTick(timeSec: number): void {
    if (this.statusLabelEl) {
      this.statusLabelEl.setText(`⏱ ${formatSecondsToTimestamp(timeSec)}`);
    }
    this.callbacks.onTimeUpdate(timeSec);
  }

  public destroy(): void {
    this.isMounted = false;
    this.isEmbedLoaded = false;
    this.pendingStartSec = null;
    this.thumbnailEl = null;
    window.removeEventListener("message", this.boundMessageListener);
    if (this.mountTimeoutId !== null) {
      window.clearTimeout(this.mountTimeoutId);
      this.mountTimeoutId = null;
    }
    if (this.pollIntervalId !== null) {
      window.clearInterval(this.pollIntervalId);
      this.pollIntervalId = null;
    }
    try {
      this.ytPlayer?.destroy();
    } catch {
      // Ignore
    }
    this.ytPlayer = null;
    this.iframeEl = null;
  }
}
