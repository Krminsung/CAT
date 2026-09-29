# cat-agent-cli 0.1.7 배포 기록

## 모델 주도 대화·검색·도구 흐름 보완

- 대화 맥락에서 모델이 선택한 검색어를 유지하고, 단어가 일치하지 않는 검색 후보도 보존한다.
- 검색과 원문 조회를 합쳐 최대 8회 안에서 서로 다른 접근을 선택할 수 있다. 동일 요청은 반복하지 않는다.
- 일반 답변·추가 질문·실제 조회 한계를 구분해 사용자용 본문을 유지한다. 현재 정보 답변의 실제
  원문 조회·인용 연결과 비밀정보·웹 금지·권한·DNS/redirect 경계는 유지한다.
- 실제 노출된 파일·셸·MCP 도구 능력을 안내하고 기존 공유 예산 안에서 제한된 복구를 연결한다.
- 검색 0건의 원인을 구분하고 완료한 도구에 불필요한 진행 중 표시가 남지 않도록 보완한다.

이 버전은 **TypeScript 빌드와 설치본 포장 범위**로 배포한다. 실제 대화·TUI·외부 웹·모델 API·MCP·
설치본은 이번에 실행하지 않는다. 빌드와 포장 결과, 게시 식별자는 P14-R13 기록과 GitHub Release
설명을 따른다. 모든 오타의 이해, 답변 정확성 또는 최신 Claude Code 전체 기능 동등성을 보장하지 않는다.
이전 버전의 실행 검증 결과를 이번 수정본의 실행 성공으로 간주하지 않는다.

## 이전 버전 v0.1.6 — 대화 표현의 오타와 웹 근거 판정 보완

- 대화 표현의 흔한 한 글자 오타·요청 말투·띄어쓰기 차이를 공개 검색어에서 정리한다.
- 조사와 NFC/NFD 표현을 공통 처리하며 영문이 섞여 있어도 한글 지역 키워드를 유지한다.
- 날씨 질문에서 지역 없는 입력을 구분하고 원문 제목·본문의 지역과 날씨 주제를 함께 확인한다.
- 검색 요약만으로 근거를 인정하지 않고 실제로 연 원문의 최종 URL 인용을 요구한다.
- 지명·제품명·버전은 다른 이름으로 임의 교정하지 않는다. 범용 맞춤법 교정기를 추가한 것은 아니다.
- 비밀정보·웹 금지·권한·공개 URL/DNS 경계와 검색·복구 횟수 제한을 유지한다.

사용자 요청에 따라 이 버전은 **배포용 빌드 1회와 설치본 포장만 수행하는 범위**다.
테스트·회귀 실행·앱/help/version·실시간 웹·실제 모델 답변·설치본 실행은 하지 않는다.
빌드·포장 성공 여부와 실제 게시 식별자는 P14-R11 기록 및 GitHub Release 게시 설명을 따른다.
이전 버전의 실행 확인 결과를 이번 수정본의 실행 검증 결과로 간주하지 않는다.

## 이전 버전 — 공개 웹 주소 판별 수정

- 공개 IPv4까지 비공개 주소로 판단해 모든 검색 backend를 차단하던 오류를 수정했다.
- IPv4와 IPv6의 BlockList를 분리해 mapped IPv6 차단 규칙이 일반 IPv4에 적용되지 않도록 했다.
- 사설·loopback·link-local·metadata·mapped IPv6 차단 대역은 유지한다. DNS/redirect 전체 검사,
  검증 IP 고정 연결, TLS hostname 확인, 프록시 정책과 권한 정책은 변경하지 않았다.
- 검색 backend 자체의 가용성이나 외부 사이트의 접근 제한을 우회하는 변경은 아니다.
- 이번 수정의 실행 검증·포장·지정 서버 업데이트 결과는 저장소의
  `docs/implementation/phases/P14-R10.md`와 최종 GitHub Release 기록을 따른다.

## 대화 화면과 진행 상태 개선

- 새 대화에서 고양이 ASCII와 사용 안내를 표시한다.
- 사용자 요청과 CAT 응답의 역할·테두리·색상을 구분하고 세션 UUID 대신 대화 제목을 우선 표시한다.
- 응답 대기·도구 작업 중 spinner와 경과 시간을 유지한다. 텍스트 응답 종료만으로 완료를 표시하지 않는다.
- 권한 창은 불투명 배경, 긴 본문 페이지 이동, 고정 선택지와 작은 창에서의 승인 차단을 제공한다.
- 권한 승인 후 “승인 기다리는 중”에 머물던 상태 문구를 도구 실행 상태로 전환한다.
- 전체 작업의 고정 10분 제한을 제거했다. 사용자 취소·횟수 제한과 개별 HTTP/도구 timeout은 유지한다.
- `--no-color`와 `NO_COLOR`에서도 역할 구분을 유지하고 원문 보기·JSON에 새 UI 색상을 넣지 않는다.

## 초기 설정 보완

- custom 선택 시 종료되던 문제를 수정하고 서버 주소·통신 방식·API 경로·API key 입력을 연결했다.
- 모델 목록 조회 실패나 빈 목록에서도 모델 ID를 직접 지정할 수 있다.
- 초기 설정과 `/connect`, `/models`, `/provider`가 같은 설정·모델 선택 흐름을 사용한다.
- 실제 PTY와 로컬 모의 API로 초기 설정부터 첫 대화까지 확인한다. 상세 결과와 한계는
  `docs/implementation/phases/P14-R08.md`에 기록한다. 실제 외부 provider 전체의 호환성 확인은 아니다.

## 포함 범위

- API-key-only 13개 provider profile과 Responses/Chat streaming adapter
- bounded agent loop, permission/trust/path/secret 경계와 18개 built-in 도구
- JSONL session, compaction, checkpoint/rewind, full-screen TUI와 28개 slash 명령
- AGENTS/skills/markdown command/hooks, stdio MCP, 제한된 public web evidence 흐름
- background task, managed Git worktree, SSH/OSC52 clipboard와 명시적 legacy import
- Linux x64/arm64용 고정 Node.js v24.21.0 standalone installer 구성
- root HOME에 설치하고 UID 0으로 cat과 하위 명령을 실행할 수 있는 root 설치 지원
- 최신 정식 GitHub Release를 판별하고 architecture별 설치본을 검증·실행하는 공개 `install.sh`
- 대규모 native private 요소를 ES2021 호환 출력으로 변환해 Node.js 22/24 parser 오류 방지
- Node.js 22의 Unicode 정규식 문법에서 거부되던 불필요한 quote escape 제거

## 배포 상태와 제한

이 release 입력은 npm publish 또는 GitHub Release를 자동 생성하지 않는다. 프로젝트 자체는
`UNLICENSED`이고 공개 사용·재배포 권한이 부여됐다고 해석하면 안 된다. third-party와 Node.js의
license는 `THIRD_PARTY_NOTICES.md`와 bundle 내부 자료를 따른다.

v0.1.4 변경은 실제 PTY와 로컬 모의 API로 초기 설정, 승인 후 진행·완료, 거부·취소, 긴 권한 창과
크기 변경, 오류 복귀, 대화 이름 변경·재개, 원문 보기와 무색상 표시를 확인했다. 시간 제한 제거는
가상 시계·사용자 취소·횟수 예산 검사로 확인했다. 자세한 범위와 이전 실패 이력은
`docs/implementation/phases/P14-R09-UI.md`를 따른다.

이전 v0.1.4 배포에서는 버전 반영 빌드·포장과 기존 성공한 UI 실행 검증을 구분했다. v0.1.4 설치본,
실제 외부 provider, 실제 장시간 서버 작업, web, MCP, worktree, SSH/clipboard, legacy import,
root/arm64와 설치 rollback은 당시 실행 검증하지 않았다. v0.1.3의 Linux x64 설치본 검증 결과를
새 설치본의 실행 결과로 간주하지 않는다.
artifact 생성 성공도 모든 서버의 설치·운영 준비나 보안 검증 완료를 뜻하지 않는다.

`v0.1.1`은 생성된 `dist/app/application.js`가 번들 Node.js 24에서 private name 구문 오류로 시작되지
않았고 Node.js 22에서는 파일 멘션 정규식도 거부됐다. `v0.1.2`는 해당 배포본을 대체한다.
