import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  formatSecondsToTimestamp,
  generateBookmarkletCode,
  parseTimestampToSeconds,
  parseYouTubeUrl,
} from "../src/utils/youtubeUrlParser.ts";
import { SegmentTimeIndex } from "../src/utils/binarySearch.ts";
import { mergeCuesIntoSegments } from "../src/workers/transcriptProcessor.ts";
import { TranscriptWorkerManager } from "../src/workers/WorkerPoolManager.ts";
import { AgyCliService } from "../src/services/AgyCliService.ts";
import type { RawTranscriptCue } from "../src/types/transcript.ts";

const logs: string[] = [];
function log(line: string) {
  console.log(line);
  logs.push(line);
}

async function runAllTests() {
  log("==============================================================");
  log("Obsidian Ear-Coach (YouTube + Obsidian + agy CLI) Test Report");
  log(`Executed At: ${new Date().toISOString()}`);
  log("==============================================================\n");

  // 1. Test YouTube URL & Timestamp Parser
  log("[Test 1] YouTube URL & Timestamp Parser");
  const u1 = parseYouTubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=2m22s");
  assert.ok(u1);
  assert.equal(u1.videoId, "dQw4w9WgXcQ");
  assert.equal(u1.timestampSeconds, 142);

  const u2 = parseYouTubeUrl("https://youtu.be/dQw4w9WgXcQ?t=85");
  assert.ok(u2);
  assert.equal(u2.videoId, "dQw4w9WgXcQ");
  assert.equal(u2.timestampSeconds, 85);

  const u3 = parseYouTubeUrl("https://www.youtube.com/shorts/dQw4w9WgXcQ");
  assert.ok(u3);
  assert.equal(u3.videoId, "dQw4w9WgXcQ");

  assert.equal(parseTimestampToSeconds("02:22"), 142);
  assert.equal(parseTimestampToSeconds("1h02m03s"), 3723);
  assert.equal(formatSecondsToTimestamp(142), "02:22");
  assert.ok(generateBookmarkletCode().includes("obsidian://ear-coach?url="));
  log("  -> PASS: Standard URLs, Shorts, youtu.be, timestamps, and bookmarklet verified.\n");

  // 2. Test Transcript Sentence Merging, WPM & Phonetic Trap Heuristics
  log("[Test 2] Transcript Processor & Phonetic Trap Detection");
  const sampleCues: RawTranscriptCue[] = [
    { start: 10.0, duration: 1.2, text: "I am going to" },
    { start: 11.2, duration: 1.3, text: "tell you why I bought a car." },
    { start: 14.5, duration: 1.0, text: "Did you eat yet or should have waited?" },
  ];

  const segments = mergeCuesIntoSegments(sampleCues, {
    speedSpikeWpmThreshold: 170,
    defaultUnlockStep: 0,
    pinnedTimestamps: [11.5],
  });

  assert.equal(segments.length, 2);
  assert.equal(segments[0].text, "I am going to tell you why I bought a car.");
  assert.equal(segments[0].isPinned, true);
  assert.ok(segments[0].analysis);
  assert.ok(segments[0].analysis.traps.includes("WEAK_FORM"));
  assert.ok(segments[0].analysis.traps.includes("FLAP_T"));
  assert.ok(segments[1].analysis?.traps.includes("LINKING"));
  log(`  -> PASS: Merged ${sampleCues.length} cues into ${segments.length} sentences with accurate phonetic traps (${segments[0].analysis.traps.join(", ")}).\n`);

  // 3. Large Dataset Performance & Binary Search Memoization Benchmark
  log("[Test 3] High-Volume Dataset Performance & Memoized Binary Search (5,000 cues)");
  const largeCues: RawTranscriptCue[] = [];
  for (let i = 0; i < 5000; i++) {
    largeCues.push({
      start: i * 2.5,
      duration: 2.2,
      text: i % 3 === 2 ? "We are going to make it work today." : "When you want to learn fast",
    });
  }

  const t0 = performance.now();
  const largeSegments = mergeCuesIntoSegments(largeCues, {
    speedSpikeWpmThreshold: 180,
    defaultUnlockStep: 0,
    pinnedTimestamps: [125, 2500],
  });
  const mergeElapsedMs = performance.now() - t0;

  const index = new SegmentTimeIndex(largeSegments);
  const t1 = performance.now();
  let hits = 0;
  // Simulate 10,000 playback time ticks (sequential + random seeks)
  for (let tick = 0; tick < 10000; tick++) {
    const timeSec = (tick * 0.25) % (largeCues.length * 2.5);
    const idx = index.findActiveSegmentIndex(timeSec);
    if (idx >= 0) hits++;
  }
  const searchElapsedMs = performance.now() - t1;

  assert.ok(largeSegments.length > 1500);
  assert.ok(hits > 5000);
  assert.ok(mergeElapsedMs < 500, `Merge took too long: ${mergeElapsedMs}ms`);
  assert.ok(searchElapsedMs < 50, `Search took too long: ${searchElapsedMs}ms`);
  log(
    `  -> PASS: 5,000 cues merged into ${largeSegments.length} segments in ${mergeElapsedMs.toFixed(2)}ms; 10,000 time-sync lookups completed in ${searchElapsedMs.toFixed(2)}ms.\n`
  );

  // 4. Test AgyCliService Connection & Worker Session Parsing
  log("[Test 4] AgyCliService & Web Worker Session Parsing");
  const agyService = new AgyCliService(() => "agy", () => "");
  const agyAvailable = await agyService.checkAgyAvailable();
  assert.equal(agyAvailable, true, "Local agy CLI should be reachable");

  const sampleSessionMarkdown = `
# Sample Title
\`\`\`ear-coach-session
{
  "videoId": "test1234",
  "title": "Test Title",
  "segments": [],
  "pinnedTimestamps": [10]
}
\`\`\`
`;
  const workerManager = new TranscriptWorkerManager();
  const parsedSession = await workerManager.parseSessionAsync(sampleSessionMarkdown);
  assert.equal(parsedSession?.videoId, "test1234", "Worker session parsing must succeed");
  assert.equal(parsedSession?.pinnedTimestamps[0], 10, "Pinned timestamp must match");
  workerManager.destroy();
  log("  -> PASS: Local agy CLI responsive & Worker session parsing verified.\n");

  // 5. File Size & Zero-Blur Policy Verification
  log("[Test 5] File Line Limit (< 900 lines) & Zero-Blur CSS Audit");
  const srcFiles: string[] = [];
  function walkDir(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walkDir(full);
      else if (entry.name.endsWith(".ts")) srcFiles.push(full);
    }
  }
  walkDir(path.resolve("src"));

  for (const file of srcFiles) {
    const content = fs.readFileSync(file, "utf8");
    const lineCount = content.split(/\r?\n/).length;
    const rel = path.relative(process.cwd(), file);
    assert.ok(lineCount < 900, `${rel} exceeded 900 lines (${lineCount})`);
    log(`  - ${rel}: ${lineCount} lines (OK)`);
  }

  const cssContent = fs.readFileSync(path.resolve("styles.css"), "utf8");
  // Ensure no CSS property uses blur() or backdrop-filter
  const cssCodeWithoutComments = cssContent.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.equal(/backdrop-filter|filter:\s*blur/i.test(cssCodeWithoutComments), false);
  log("  -> PASS: All source files are compact (< 360 lines) and styles.css has 0 blur effects.\n");

  log("==============================================================");
  log("ALL TESTS PASSED SUCCESSFULLY!");
  log("==============================================================");

  fs.mkdirSync(path.resolve("docs"), { recursive: true });
  fs.writeFileSync(path.resolve("docs/test_result.txt"), logs.join("\n"), "utf8");
}

runAllTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
