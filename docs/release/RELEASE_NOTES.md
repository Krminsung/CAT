# cat-agent-cli 0.1.2 배포 기록

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

지정된 TypeScript 정적 검사와 최종 컴파일 외에 앱, TUI, provider, web, MCP, shell/process,
worktree, SSH/clipboard, legacy import, installer 또는 bundled Node runtime을 실행해 검증하지 않았다.
artifact 생성 성공도 실환경 설치·운영 준비나 보안 검증 완료를 뜻하지 않는다.

`v0.1.1`은 생성된 `dist/app/application.js`가 번들 Node.js 24에서 private name 구문 오류로 시작되지
않았고 Node.js 22에서는 파일 멘션 정규식도 거부됐다. `v0.1.2`는 해당 배포본을 대체한다.
