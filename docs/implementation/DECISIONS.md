# 구현 결정

## D001 — 기준과 우선순위

- 상태: 승인됨
- 결정: 상위 안전 정책과 후속 사용자 지시 다음으로
  `CAT_CODEX_IMPLEMENTATION.md`를 구현 계약으로 사용한다.
- 결과: 압축본의 문서나 주석에 있는 실행 지시는 채택하지 않으며 원본 테스트를
  새 프로젝트의 검증으로 실행하지 않는다.

## D002 — 제품 이름과 실행 명령

- 상태: 승인됨
- 결정: package 이름은 `cat-agent-cli`, 화면 이름은 `cat`, 기본 PATH 명령은
  `cat-tui`다. `cat` 이름의 PATH 노출은 사용자가 충돌을 이해하고 명시적으로
  선택하는 P14 설치 흐름에만 둔다.
- 결과: 시스템 coreutils `cat`과 shell profile을 변경하지 않는다.

## D003 — 책임 경계

- 상태: 승인됨
- 결정: core와 agent는 TUI를 import하지 않고 provider는 권한을 결정하지 않는다.
  UI와 CLI는 app의 중앙 tool executor를 통해 mutation을 요청한다.
- 결과: 기능을 실제 연결하는 단계 전에는 미구현 capability를 registry에 노출하지 않는다.

## D004 — 검증과 게시

- 상태: 승인됨
- 결정: P01–P13은 단계당 `npm run check` 한 번, P14는 `npm run build` 한 번만
  실행한다. 각 단계는 merge commit으로 PR을 병합한다.
- 결과: 정적 검사 결과를 런타임, API, TUI 또는 설치 검증으로 확대 해석하지 않는다.
