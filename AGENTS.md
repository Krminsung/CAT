# cat implementation instructions

구현의 기준 문서는 저장소 루트의 `CAT_CODEX_IMPLEMENTATION.md`이다.
작업 시작 시 그 문서의 0–6장, 현재 단계에 필요한 7–10장의 계약,
11장의 현재 단계, `docs/implementation/state.json`을 읽고 진행한다.
재개할 때는 기존 Git ref, PR, 검증 기록을 먼저 확인한다.

- 원본 기능을 유지하며 새 구조로 구현한다. 원본은 읽기 전용 참조다.
- P01–P14 순서로 진행하고 동시에 한 단계만 활성화한다.
- 각 하위 작업 완료 직후 커밋하며 main에 직접 구현하지 않는다.
- P01–P13은 마지막에 `npm run check` 1회, P14는 `npm run build` 1회만 실행한다.
- 실패, timeout, 결과 유실 후 재실행하지 않고 차단 사유를 남긴다.
- 테스트 suite, smoke, watch, CI runner, 리뷰 bot, 별도 검증 agent를 실행하지 않는다.
- 검증 후 실행 코드와 입력은 변경하지 않고 진행 기록 문서만 보완할 수 있다.
- 단계 완료 후 브랜치, push, main PR, merge commit, Git 정합성 확인을 수행한다.
- merge 후 typecheck, build, test 또는 앱 실행을 반복하지 않는다.
- 완료된 검증, 커밋, PR을 재개 시 다시 만들지 않는다.
- secret, 원본 archive, `node_modules`, `dist`, `artifacts`를 Git에 넣지 않는다.
- 런타임 미검증을 숨기거나 정책, 인증, 권한 차단을 우회하지 않는다.
