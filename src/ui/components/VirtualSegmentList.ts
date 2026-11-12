import { TranscriptSegment } from "../../types/transcript";
import { SegmentCard, SegmentCardCallbacks } from "./SegmentCard";

const DEFAULT_CARD_HEIGHT = 132;
const CARD_GAP_PX = 10;
const OVERSCAN_COUNT = 4;

/**
 * High-performance Dynamic-Height Virtual Scroll List for Obsidian Ear-Coach.
 * Maintains only ~15 visible SegmentCard DOM nodes in memory regardless of video length
 * (even 2-hour videos with 2,000+ sentences), ensuring 60fps UI & O(1) reflow.
 */
export class VirtualSegmentList {
  private segments: TranscriptSegment[] = [];
  private indexMap = new Map<number, number>(); // segment.index -> array position
  private heights: number[] = [];
  private prefixOffsets: number[] = [0];

  private spacerTopEl: HTMLElement;
  private itemsContainerEl: HTMLElement;
  private spacerBottomEl: HTMLElement;

  private mountedCards = new Map<number, SegmentCard>(); // segment.index -> SegmentCard
  private resizeObserver: ResizeObserver | null = null;
  private rafScrollPending = false;
  private rafResizePending = false;

  private renderedStart = -1;
  private renderedEnd = -1;
  private activeHighlightSegmentIdx = -1;
  private boundOnScroll: () => void;

  constructor(
    private scrollContainerEl: HTMLElement,
    private hostEl: HTMLElement,
    private cardCallbacks: SegmentCardCallbacks
  ) {
    this.hostEl.empty();
    this.spacerTopEl = this.hostEl.createDiv({ cls: "ear-coach-virtual-spacer" });
    this.itemsContainerEl = this.hostEl.createDiv({ cls: "ear-coach-virtual-items" });
    this.spacerBottomEl = this.hostEl.createDiv({ cls: "ear-coach-virtual-spacer" });

    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver((entries) => {
        let changed = false;
        let scrollDelta = 0;
        const firstVis = this.findIndexAtOffset(this.scrollContainerEl.scrollTop);

        let viewportResized = false;
        for (const entry of entries) {
          const el = entry.target as HTMLElement;
          if (el === this.scrollContainerEl) {
            viewportResized = true;
            continue;
          }
          const segIdxAttr = el.getAttribute("data-segment-index");
          if (segIdxAttr === null) continue;
          const segIdx = Number(segIdxAttr);
          const pos = this.indexMap.get(segIdx);
          if (pos === undefined) continue;

          const measured = entry.borderBoxSize?.[0]?.blockSize ?? el.getBoundingClientRect().height;
          const totalH = Math.max(60, Math.round(measured) + CARD_GAP_PX);

          if (Math.abs(this.heights[pos] - totalH) > 1) {
            const diff = totalH - this.heights[pos];
            this.heights[pos] = totalH;
            changed = true;
            if (pos < firstVis) {
              scrollDelta += diff;
            }
          }
        }

        if (changed) {
          this.rebuildOffsets();
          if (scrollDelta !== 0) {
            this.scrollContainerEl.scrollTop += scrollDelta;
          }
          if (!this.rafResizePending) {
            this.rafResizePending = true;
            window.requestAnimationFrame(() => {
              this.rafResizePending = false;
              this.updateSpacersOnly();
            });
          }
        } else if (viewportResized && !this.rafScrollPending) {
          this.rafScrollPending = true;
          window.requestAnimationFrame(() => {
            this.rafScrollPending = false;
            this.renderVisibleWindow(false);
          });
        }
      });
      this.resizeObserver.observe(this.scrollContainerEl);
    }

    this.boundOnScroll = () => {
      if (this.rafScrollPending) return;
      this.rafScrollPending = true;
      window.requestAnimationFrame(() => {
        this.rafScrollPending = false;
        this.renderVisibleWindow(false);
      });
    };
    this.scrollContainerEl.addEventListener("scroll", this.boundOnScroll, { passive: true });
  }

  public setSegments(segments: TranscriptSegment[]): void {
    this.clearMountedCards();
    this.segments = segments;
    this.indexMap.clear();
    this.heights = new Array(segments.length);

    for (let i = 0; i < segments.length; i++) {
      this.indexMap.set(segments[i].index, i);
      // Estimate slightly taller default for revealed steps
      this.heights[i] = segments[i].unlockStep >= 3 ? 210 : DEFAULT_CARD_HEIGHT;
    }

    this.renderedStart = -1;
    this.renderedEnd = -1;
    this.rebuildOffsets();
    this.scrollContainerEl.scrollTop = 0;

    if (segments.length === 0) {
      this.spacerTopEl.style.height = "0px";
      this.spacerBottomEl.style.height = "0px";
      this.itemsContainerEl.createDiv({
        cls: "ear-coach-empty-filter",
        text: "해당 필터 조건에 맞는 문장이 없습니다.",
      });
      return;
    }

    this.renderVisibleWindow(true);
  }

  public setActiveHighlight(segmentIdx: number, force = false): void {
    const prevIdx = this.activeHighlightSegmentIdx;
    if (!force && prevIdx === segmentIdx) return;

    if (prevIdx >= 0 && prevIdx !== segmentIdx) {
      this.mountedCards.get(prevIdx)?.setActiveHighlight(false);
    }
    this.activeHighlightSegmentIdx = segmentIdx;
    if (segmentIdx >= 0) {
      this.mountedCards.get(segmentIdx)?.setActiveHighlight(true);
    }
  }

  public setLoopStateForSegment(segmentIdx: number, isLooping: boolean): void {
    this.mountedCards.get(segmentIdx)?.setLoopState(isLooping);
  }

  public updateCard(segment: TranscriptSegment): void {
    const card = this.mountedCards.get(segment.index);
    if (card) {
      card.updateSegment(segment);
    }
  }

  public scrollToSegment(segmentIdx: number): void {
    const pos = this.indexMap.get(segmentIdx);
    if (pos === undefined) return;

    const targetTop = this.prefixOffsets[pos];
    const viewportH = this.scrollContainerEl.clientHeight || 700;
    const cardH = this.heights[pos] || DEFAULT_CARD_HEIGHT;
    const centeredTop = Math.max(0, targetTop - Math.max(0, (viewportH - cardH) / 2));

    this.scrollContainerEl.scrollTo({ top: centeredTop, behavior: "smooth" });
    this.setActiveHighlight(segmentIdx, true);
    // Ensure window updates immediately around destination
    window.requestAnimationFrame(() => this.renderVisibleWindow(true));
  }

  private rebuildOffsets(): void {
    const len = this.segments.length;
    this.prefixOffsets = new Array(len + 1);
    this.prefixOffsets[0] = 0;
    for (let i = 0; i < len; i++) {
      this.prefixOffsets[i + 1] = this.prefixOffsets[i] + this.heights[i];
    }
  }

  private findIndexAtOffset(y: number): number {
    const len = this.segments.length;
    if (len === 0 || y <= 0) return 0;
    let low = 0;
    let high = len - 1;
    let ans = len - 1;

    while (low <= high) {
      const mid = (low + high) >>> 1;
      if (this.prefixOffsets[mid + 1] > y) {
        ans = mid;
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }
    return ans;
  }

  private updateSpacersOnly(): void {
    const len = this.segments.length;
    if (len === 0 || this.renderedStart < 0 || this.renderedEnd < 0) return;
    const topPx = this.prefixOffsets[this.renderedStart] || 0;
    const bottomPx = Math.max(0, this.prefixOffsets[len] - (this.prefixOffsets[this.renderedEnd + 1] || this.prefixOffsets[len]));
    this.spacerTopEl.style.height = `${topPx}px`;
    this.spacerBottomEl.style.height = `${bottomPx}px`;
  }

  private renderVisibleWindow(forceUpdate: boolean): void {
    const len = this.segments.length;
    if (len === 0) return;

    const scrollTop = this.scrollContainerEl.scrollTop;
    const viewportH = this.scrollContainerEl.clientHeight || 800;

    const firstVisible = this.findIndexAtOffset(scrollTop);
    const lastVisible = this.findIndexAtOffset(scrollTop + viewportH);

    const start = Math.max(0, firstVisible - OVERSCAN_COUNT);
    const end = Math.min(len - 1, lastVisible + OVERSCAN_COUNT);

    if (!forceUpdate && start === this.renderedStart && end === this.renderedEnd) {
      return;
    }

    // Remove out-of-range cards
    const activeSegIndices = new Set<number>();
    for (let i = start; i <= end; i++) {
      activeSegIndices.add(this.segments[i].index);
    }

    for (const [segIdx, card] of this.mountedCards.entries()) {
      if (!activeSegIndices.has(segIdx)) {
        this.resizeObserver?.unobserve(card.getElement());
        card.getElement().remove();
        this.mountedCards.delete(segIdx);
      }
    }

    // Update top/bottom virtual spacers
    this.renderedStart = start;
    this.renderedEnd = end;
    this.updateSpacersOnly();

    // In-place differential DOM insertion: avoids detaching already-mounted visible cards
    const tempHolder = document.createElement("div");
    let prevEl: HTMLElement | null = null;

    for (let i = start; i <= end; i++) {
      const seg = this.segments[i];
      let card = this.mountedCards.get(seg.index);
      if (!card) {
        card = new SegmentCard(tempHolder, seg, this.cardCallbacks);
        if (seg.index === this.activeHighlightSegmentIdx) {
          card.setActiveHighlight(true);
        }
        this.mountedCards.set(seg.index, card);
        this.resizeObserver?.observe(card.getElement());
      }

      const el = card.getElement();
      if (el.parentElement !== this.itemsContainerEl) {
        if (prevEl === null) {
          this.itemsContainerEl.prepend(el);
        } else {
          prevEl.after(el);
        }
      } else if (prevEl && prevEl.nextElementSibling !== el) {
        prevEl.after(el);
      }
      prevEl = el;
    }
  }

  private clearMountedCards(): void {
    for (const card of this.mountedCards.values()) {
      this.resizeObserver?.unobserve(card.getElement());
      card.getElement().remove();
    }
    this.mountedCards.clear();
    this.itemsContainerEl.empty();
  }

  public destroy(): void {
    this.scrollContainerEl.removeEventListener("scroll", this.boundOnScroll);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.clearMountedCards();
  }
}
