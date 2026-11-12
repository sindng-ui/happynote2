# 🗺️ APP_MAP: Obsidian Ear-Coach (YouTube + Obsidian + `agy` CLI)

본 문서는 프로젝트 내 모든 파일, 모듈 역할, 데이터 인터페이스 및 아키텍처 흐름을 관리하는 **마스터 아키텍처 맵**입니다.  
새로운 UI, 로직, 파일이 추가되거나 수정될 때마다 본 문서를 즉시 업데이트합니다.

---

## 1. 아키텍처 및 성능 원칙 요약

- **단일 책임 및 파일 크기 제한**: 모든 파일은 단일 책임(Single Responsibility)을 가지며, 한 파일이 900줄을 절대 넘지 않도록(목표: 100~350줄) 세분화합니다.
- **Zero-Blur 고성능 UI**: `backdrop-filter: blur` 등 GPU 합성 부하를 유발하는 CSS를 일절 사용하지 않습니다.
- **Web Worker & 메모이제이션**:
  - 대용량 자막 세그먼트 병합 및 WPM(분당 단어 수) 계산은 `TranscriptWorker`에서 비동기로 처리합니다.
  - 재생 시간(`currentTime`) 동기화는 $O(\log N)$ 이진 탐색(`findSegmentIndexByTime`)과 최근 인덱스 메모이제이션을 통해 60fps 반응성을 유지합니다.

---

## 2. 모듈 및 파일 인터페이스 명세

### 2.1 빌드 및 설정 루트 파일
| 파일 경로 | 역할 설명 | 핵심 Export / 설정 |
| :--- | :--- | :--- |
| `package.json` | 프로젝트 메타데이터, 의존성 및 빌드/테스트 스크립트 | `dev`, `build`, `test` |
| `tsconfig.json` | TypeScript 컴파일러 설정 (Strict 모드, ES2022, WebWorker 지원) | `compilerOptions` |
| `esbuild.config.mjs` | `src/workers/transcript.worker.ts` 인라인 번들링 및 `main.js` 고속 번들러 | `__INLINE_WORKER_CODE__` |
| `manifest.json` | Obsidian 플러그인 매니페스트 (`obsidian-ear-coach`) | `id`, `name`, `version` |
| `styles.css` | Zero-Blur 고성능 스타일시트 (다크/라이트 테마 변수 완벽 대응) | `.ear-coach-*` 클래스 |
| `.gitignore` | 개인 Vault(`gemzzang/`), 의존성(`node_modules/`), 빌드 산출물(`main.js`), OS/IDE 임시 파일 Git 추적 제외 설정 | Git 제외 규칙 |

### 2.2 데이터 타입 레이어 (`src/types/`)
| 파일 경로 | 역할 설명 | 핵심 인터페이스 / 타입 |
| :--- | :--- | :--- |
| `src/types/transcript.ts` | 자막 큐, 병합 문장 세그먼트, 3단계 언락 상태, 음운 함정 태그, 리스닝 세션 데이터 모델 | `ListeningTrapType`, `UnlockStep`, `RawTranscriptCue`, `SegmentPhoneticAnalysis`, `SegmentTutorNote`, `TranscriptSegment`, `ListeningSessionData` |
| `src/types/agy.ts` | `agy` CLI 배치 분석 요청/응답(JSON Schema 대응) 및 실시간 1:1 사운드 닥터 스트리밍 인터페이스 | `AgyBatchAnalysisRequest`, `AgyBatchAnalysisItem`, `AgyBatchAnalysisResponse`, `AgySoundDoctorRequest`, `AgyStreamCallbacks` |
| `src/types/settings.ts` | 플러그인 환경설정 인터페이스 및 기본값 정의 (`tutorPanelHeightPx` 사운드 닥터 높이 영구 저장 필드 포함) | `EarCoachSettings`, `DEFAULT_EAR_COACH_SETTINGS` |

### 2.3 유틸리티 및 고성능 탐색 레이어 (`src/utils/`)
| 파일 경로 | 역할 설명 | 핵심 함수 / 클래스 |
| :--- | :--- | :--- |
| `src/utils/youtubeUrlParser.ts` | 다양한 유튜브 URL(`watch?v=`, `youtu.be/`, `shorts/`, `?t=1m20s`) 파싱 및 브라우저 원클릭 북마클릿 생성 | `parseYouTubeUrl(input): ParsedYouTubeUrl \| null`, `parseTimestampToSeconds(raw): number \| undefined`, `formatSecondsToTimestamp(sec): string`, `generateBookmarkletCode(vaultName?): string` |
| `src/utils/binarySearch.ts` | 재생 타임스탬프에 해당하는 문장 인덱스를 $O(\log N)$ 이진 탐색 + 히트 캐시로 고속 조회. 문장 간 시간 오버랩(Overlap) 시 최신 시작 문장 우선(Latest-Start-Priority) 및 전진 편향(Forward-Biased) 알고리즘으로 이전 카드로 역류하는 포커스 튐 문제 완벽 차단 | `SegmentTimeIndex` 클래스 (`findActiveSegmentIndex(timeSec): number`, `findNearestSegmentIndex(timeSec): number`, `setLastHitIndex(idx): void`) |

### 2.4 워커 레이어 (`src/workers/`)
| 파일 경로 | 역할 설명 | 핵심 함수 / 인터페이스 |
| :--- | :--- | :--- |
| `src/workers/transcriptProcessor.ts` | 파편화된 자막 큐(`RawTranscriptCue[]`)를 자연스러운 문장 단위로 병합하고, 문장별 WPM 및 과속 여부 계산, 기본 뼈대/빈칸 인덱스 자동 추출 | `mergeCuesIntoSegments(cues, options): TranscriptSegment[]`, `computeFallbackAnalysis(segment): SegmentPhoneticAnalysis` |
| `src/workers/transcript.worker.ts` | 브라우저/Electron 환경에서 대용량 자막 전처리 및 세션 JSON 백그라운드 파싱(`PARSE_SESSION`)을 메인 스레드 블로킹 없이 수행하는 Web Worker 엔트리 | `onmessage` 핸들러 (`PROCESS_TRANSCRIPT`, `PARSE_SESSION` 액션 처리) |
| `src/workers/WorkerPoolManager.ts` | 인라인 번들된 Web Worker 풀을 관리하고 대용량 자막 병합 및 세션 JSON 비동기 파싱을 워커 스레드로 분산 처리하는 매니저 | `TranscriptWorkerManager` (`processCuesAsync(cues, options)`, `parseSessionAsync(markdown)`) |

### 2.5 서비스 레이어 (`src/services/`)
| 파일 경로 | 역할 설명 | 핵심 클래스 / 메서드 |
| :--- | :--- | :--- |
| `src/services/TranscriptService.ts` | 유튜브 영상 메타데이터 및 자막 추출 (1순위: 내장 YouTube Innertube/Watch 페이지 파서, 2순위: 로컬 `yt-dlp` 폴백) | `TranscriptService` (`fetchTranscript(videoId, lang): Promise<FetchedVideoTranscript>`, `parseTrackPayload(rawText): RawTranscriptCue[]`) |
| `src/services/AgyCliService.ts` | 로컬 `agy` CLI 프로세스 연동 (`--output-format json --json-schema` 배치 분석 및 `--output-format text` 실시간 1:1 스트리밍 사운드 코칭, ANSI 코드 스트립, stderr 실시간 에러 핸들링 및 Windows `.exe` 자동 정규화 포함) | `AgyCliService` (`analyzeSegmentsBatch(req): Promise<AgyBatchAnalysisResponse>`, `streamSoundDoctor(req, callbacks): ChildProcessWithoutNullStreams`, `checkAgyAvailable(): Promise<boolean>`) |
| `src/services/NoteGenerator.ts` | 대용량 세션 데이터를 압축 JSON 사이드카(`.obsidian/plugins/obsidian-ear-coach/sessions/<videoId>.json`)로 분리 저장해 마크다운 노트를 30줄 내외로 초경량화, 메모리 캐시(`0.00ms` 반환) 및 기존 인라인 대용량 노트 자동 백그라운드 마이그레이션 지원 | `NoteGenerator` (`saveSessionToNote`, `loadSessionFromNote`, `getCachedSession`, `appendTutorCalloutToNote`) |
| `src/services/WeaknessTracker.ts` | 유저가 안 들림 핀을 꽂거나 질문한 음운 현상(`LINKING`, `FLAP_T` 등)을 집계하여 `My_Listening_Weakness.md` 대시보드를 자동 갱신 | `WeaknessTracker` (`recordWeakSegment(params): Promise<void>`) |

### 2.6 인터랙티브 UI 레이어 (`src/ui/`)
| 파일 경로 | 역할 설명 | 핵심 클래스 / 컴포넌트 |
| :--- | :--- | :--- |
| `src/ui/EarCoachView.ts` | Obsidian `ItemView` 기반 전용 리스닝 코치 워크스페이스 뷰 (레이아웃 골격 및 YouTube IFrame 재사용으로 노트 전환 시 0.02초 고속 로딩, `VirtualSegmentList` 연동, 마우스 리사이저 드로어 agy 튜터, 시크 락킹 포커스 동기화, ESC 탭 이탈 방지, 탭 타이틀 실시간 동기화) | `EarCoachView`, `VIEW_TYPE_EAR_COACH` |
| `src/ui/UrlInputModal.ts` | 유튜브 URL 및 집중 분석 타임스탬프를 수동 입력하거나 클립보드에서 즉시 불러오는 모달 | `UrlInputModal` |
| `src/ui/SettingsTab.ts` | 플러그인 설정 탭 (`agy` 경로 테스트, 사용할 AI 모델 선택(기본값: `gemini-3.8-flash`), 기본 배속, WPM 임계값, 원클릭 브라우저 북마클릿 복사 버튼 제공) | `EarCoachSettingTab` |
| `src/ui/components/PlayerBar.ts` | YouTube IFrame/API 임베드 플레이어 (고화질 썸네일 즉시 표시 + 300ms 지연 마운트 및 클릭 시 즉시 재생으로 초반 UI 프레임 블로킹 제로화, 노트 전환 시 IFrame 파괴 없이 `loadVideo`/`cueVideoById` 재활용, 하이브리드 시간 추적, A-B 무한 루프, $O(1)$ 루프 버튼 갱신) | `PlayerBar` (`playSegment`, `loadVideo`, `setSegmentLoop`, `clearSegmentLoop`, `isSegmentLooping`) |
| `src/ui/components/VirtualSegmentList.ts` | 동적 높이(Dynamic-Height) 기반 가상 스크롤 엔진 (`ResizeObserver` 높이 실측 + 누적 오프셋 이진 탐색 + 스크롤 앵커링 + 차분(In-place) DOM 삽입으로 화면당 15개 카드만 상시 유지하여 60fps 보장) | `VirtualSegmentList` (`setSegments`, `setActiveHighlight`, `setLoopStateForSegment`, `scrollToSegment`) |
| `src/ui/components/SegmentCard.ts` | 개별 문장 카드 렌더링 (3단계 블라인드 언락커, CSS `contain: layout style` 격리, 루프 버튼 $O(1)$ 부분 갱신 `setLoopState`, `isActivePlaying` 하이라이트 상태 보존) | `SegmentCard` |
| `src/ui/components/MicroDictationBox.ts` | Step 1 상태에서 핵심 연음/약화 단어 빈칸 맞추기 및 '내가 들은 발음' 오답 비교 위젯 | `MicroDictationBox` |
| `src/ui/components/AgyTutorPanel.ts` | 선택한 문장에 대해 "내 귀엔 이렇게 들리는데 왜 이래?" 실시간 `agy` 스트리밍 질의응답, 토글/닫기 제어 및 노트 박제 드로어 | `AgyTutorPanel` (`openForSegment`, `toggleForSegment`, `close`) |

### 2.7 엔트리 포인트 및 테스트/문서 레이어
| 파일 경로 | 역할 설명 | 핵심 클래스 / 산출물 |
| :--- | :--- | :--- |
| `src/main.ts` | 플러그인 라이프사이클 관리, `WorkspaceLeaf.prototype.openFile` 선제 인터셉터로 CodeMirror 6 에디터 파싱을 0ms 스킵하고 곧바로 단일 `EarCoachView` 탭으로 전환, `obsidian://ear-coach` URI 및 클립보드 트리거 등록 | `EarCoachPlugin` (`isEarCoachNoteFast`) |
| `tests/runTests.ts` | URL/타임스탬프 파서, 자막 병합 및 음성학 함정 태깅, 5,000개 대용량 세그먼트 이진 탐색($O(\log N)$) 성능 벤치마크, 900줄 제한 및 Zero-Blur 감사 스크립트 | `runAllTests()` |
| `docs/implementation_plan.md` | 상세 구현 계획서 (7일 경과 시 `docs/history/`로 이동 대상) | 마크다운 계획서 |
| `docs/test_result.txt` | 단위 테스트, 대용량 성능 벤치마크 및 코드 품질 감사 결과 리포트 | 테스트 결과 로그 |
