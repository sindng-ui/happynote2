import { UnlockStep } from "./transcript";

/**
 * User-configurable settings for the Obsidian Ear-Coach plugin.
 */
export interface EarCoachSettings {
  notesFolder: string;
  weaknessDashboardPath: string;
  agyBinaryPath: string;
  agyModel: string;
  ytDlpBinaryPath: string;
  autoRunAgyBatchOnCreate: boolean;
  maxBatchSegmentsPerRequest: number;
  speedSpikeWpmThreshold: number;
  defaultPlaybackRate: number;
  loopPaddingSeconds: number;
  defaultUnlockStep: UnlockStep;
  preferredCaptionLang: string;
  tutorPanelHeightPx: number;
}

export const DEFAULT_EAR_COACH_SETTINGS: EarCoachSettings = {
  notesFolder: "YouTube Listening",
  weaknessDashboardPath: "YouTube Listening/My_Listening_Weakness.md",
  agyBinaryPath: "agy",
  agyModel: "gemini-3.8-flash",
  ytDlpBinaryPath: "yt-dlp",
  autoRunAgyBatchOnCreate: true,
  maxBatchSegmentsPerRequest: 25,
  speedSpikeWpmThreshold: 175,
  defaultPlaybackRate: 1.0,
  loopPaddingSeconds: 0.25,
  defaultUnlockStep: 0,
  preferredCaptionLang: "en",
  tutorPanelHeightPx: 380,
};
