export interface ParsedYouTubeUrl {
  videoId: string;
  canonicalUrl: string;
  timestampSeconds?: number;
}

const VIDEO_ID_REGEX = /^[a-zA-Z0-9_-]{11}$/;

/**
 * Parses flexible timestamp strings (e.g. "142", "142s", "2m22s", "1h2m3s", "02:22") into seconds.
 */
export function parseTimestampToSeconds(raw?: string | number | null): number | undefined {
  if (raw === undefined || raw === null || raw === "") {
    return undefined;
  }
  if (typeof raw === "number") {
    return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : undefined;
  }

  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return undefined;

  // Pure numeric or numeric with trailing 's'
  if (/^\d+(\.\d+)?s?$/.test(trimmed)) {
    const val = parseFloat(trimmed.replace("s", ""));
    return Number.isFinite(val) && val >= 0 ? Math.floor(val) : undefined;
  }

  // Colon format: MM:SS or HH:MM:SS
  if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(trimmed)) {
    const parts = trimmed.split(":").map((p) => parseInt(p, 10));
    if (parts.length === 2) {
      return parts[0] * 60 + parts[1];
    }
    if (parts.length === 3) {
      return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }
  }

  // HMS format: 1h2m3s, 2m10s, etc.
  const hmsMatch = trimmed.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s?)?$/);
  if (hmsMatch && (hmsMatch[1] || hmsMatch[2] || hmsMatch[3])) {
    const hours = hmsMatch[1] ? parseInt(hmsMatch[1], 10) : 0;
    const minutes = hmsMatch[2] ? parseInt(hmsMatch[2], 10) : 0;
    const seconds = hmsMatch[3] ? parseFloat(hmsMatch[3]) : 0;
    return Math.floor(hours * 3600 + minutes * 60 + seconds);
  }

  return undefined;
}

/**
 * Formats seconds into MM:SS or HH:MM:SS display string.
 */
export function formatSecondsToTimestamp(seconds: number): string {
  const safeSec = Math.max(0, Math.floor(seconds));
  const hrs = Math.floor(safeSec / 3600);
  const mins = Math.floor((safeSec % 3600) / 60);
  const secs = safeSec % 60;

  const pad = (n: number) => String(n).padStart(2, "0");
  if (hrs > 0) {
    return `${hrs}:${pad(mins)}:${pad(secs)}`;
  }
  return `${pad(mins)}:${pad(secs)}`;
}

/**
 * Extracts YouTube videoId, canonical URL, and optional timestamp from any YouTube URL or ID.
 */
export function parseYouTubeUrl(input: string): ParsedYouTubeUrl | null {
  if (!input || typeof input !== "string") return null;
  const trimmed = input.trim();

  if (VIDEO_ID_REGEX.test(trimmed)) {
    return {
      videoId: trimmed,
      canonicalUrl: `https://www.youtube.com/watch?v=${trimmed}`,
    };
  }

  try {
    const normalized = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const urlObj = new URL(normalized);
    const host = urlObj.hostname.replace(/^www\./i, "").toLowerCase();

    let videoId: string | null = null;
    if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
      if (urlObj.pathname === "/watch") {
        videoId = urlObj.searchParams.get("v");
      } else if (urlObj.pathname.startsWith("/shorts/")) {
        videoId = urlObj.pathname.split("/")[2] || null;
      } else if (urlObj.pathname.startsWith("/embed/") || urlObj.pathname.startsWith("/v/")) {
        videoId = urlObj.pathname.split("/")[2] || null;
      } else if (urlObj.pathname.startsWith("/live/")) {
        videoId = urlObj.pathname.split("/")[2] || null;
      }
    } else if (host === "youtu.be") {
      videoId = urlObj.pathname.slice(1).split("/")[0] || null;
    }

    if (!videoId || !VIDEO_ID_REGEX.test(videoId)) {
      return null;
    }

    const rawTime =
      urlObj.searchParams.get("t") ||
      urlObj.searchParams.get("start") ||
      urlObj.hash.replace(/^#t=/i, "");
    const timestampSeconds = parseTimestampToSeconds(rawTime);

    return {
      videoId,
      canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
      timestampSeconds,
    };
  } catch {
    return null;
  }
}

/**
 * Generates a one-click browser bookmarklet that sends the active YouTube URL + current playback second to Obsidian.
 */
export function generateBookmarkletCode(): string {
  const code = [
    "javascript:(function(){",
    "var v=document.querySelector('video');",
    "var t=v?Math.floor(v.currentTime):0;",
    "var u=encodeURIComponent(window.location.href);",
    "window.location.href='obsidian://ear-coach?url='+u+'&t='+t+'&pin=true';",
    "})();",
  ].join("");
  return code;
}
