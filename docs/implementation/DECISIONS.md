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

## D005 — package 게시와 license 표시

- 상태: 승인됨
- 결정: package는 `private: true`와 `UNLICENSED`로 시작한다. 원본 package의 MIT
  metadata만으로 새 프로젝트와 모든 참조 자료의 공개 재배포 권리를 추정하지 않는다.
- 결과: P14도 npm publish나 GitHub Release를 자동 수행하지 않으며 공개 배포 전
  사용자가 별도로 license와 권리를 확인한다.

## D006 — 커밋 언어

- 상태: 사용자 후속 지시로 승인됨
- 결정: P01.2부터 모든 커밋 제목과 필요한 본문을 알기 쉬운 한국어로 작성한다.
  추적성을 위해 `P01.2`와 같은 단계 식별자는 유지한다.
- 결과: 기준 문서에 제시된 영문 예시 문구보다 이 후속 사용자 지시를 우선한다.

## D007 — CAT_HOME과 프로젝트 설정 신뢰

- 상태: 승인됨
- 결정: `CAT_HOME`은 CWD에 따라 credential 위치가 달라지지 않도록 절대 경로만
  허용한다. user 설정은 항상 읽지만 `.cat/settings.json`과
  `.cat/settings.local.json`은 workspace가 명시적으로 신뢰된 뒤에만 읽는다.
- 결과: 신뢰 전 프로젝트 설정에 포함될 수 있는 hook/MCP 값이 실행 경로로 유입되지
  않는다. 환경변수와 CLI overlay는 파일 layer 뒤에 적용한다.

## D008 — API key와 profile 분리

- 상태: 승인됨
- 결정: profile에는 API key 대신 endpoint origin에 묶인 불투명 `secretRef`만
  저장한다. `CAT_API_KEY`가 우선하고, 기존 `SMILECODE_API_KEY`와
  `SMILESERV_API_KEY`는 internal provider에서 서로 충돌하지 않을 때만 읽는다.
  외부 provider의 기존 API key 환경변수도 유지하되 여러 후보 값이 충돌하면
  명시적인 `CAT_API_KEY`를 요구한다.
- 결과: base URL의 origin이 달라지면 기존 key를 재사용하지 않는다. 기존
  `~/.smileserv` credential 파일은 P02에서 읽거나 자동 이관하지 않는다. 저장된
  key를 사용할 때는 secret reference, endpoint origin과 provider를 함께 확인한다.

## D009 — workspace trust와 자식 프로세스 경계

- 상태: 승인됨
- 결정: workspace trust는 canonical path와 장치·inode가 모두 일치할 때만
  유지한다. trust 추가는 사용자 확인으로 생성한 grant만 허용한다. 자식 프로세스는
  최소 환경변수 allowlist로 시작하며 secret과 실행 주입 변수는 명시적 pass-through도
  거부한다.
- 결과: 기존 `~/.smileserv`는 알려진 항목의 존재만 탐지한다. 일반 파일 도구는
  `.cat`과 `.smileserv`의 credential/profile secret 및 이를 가리키는 symbolic
  link나 hard-link alias에 접근할 수 없다.

## D010 — 인증된 모델 transport의 재시도와 proxy

- 상태: 승인됨
- 결정: 모델 HTTP transport만 `HTTP_PROXY`·`HTTPS_PROXY`·`NO_PROXY`를 읽고
  소유한 dispatcher를 종료한다. transport가 재시도 판단의 유일한 소유자이며
  호출자가 전달한 공통 retry budget port의 승인을 얻은 최대 2회만 재시도한다.
- 결과: 응답 body를 읽기 시작한 뒤에는 재시도하지 않는다. 인증 요청 redirect는
  같은 origin에서 method를 보존하는 경우만 제한적으로 따르며 public web transport와
  dispatcher를 공유하지 않는다.

## D011 — provider 전환과 streaming tool call

- 상태: 승인됨
- 결정: 각 provider 요청은 원격 response ID 대신 로컬 대화 기록 전체에서 protocol별
  입력을 다시 만든다. streaming tool call은 ID·이름·인자가 모두 완성되고 전체 모델
  응답이 성공적으로 완료된 뒤에만 공통 event로 내보낸다.
- 결과: provider나 model을 바꿔도 이전 원격 상태를 잘못 이어 붙이지 않는다. 중단되거나
  JSON이 완성되지 않은 tool call은 실행 가능한 event가 되지 않는다.

## D012 — provider capability와 model 선택

- 상태: 승인됨
- 결정: 압축본의 12개 기본 provider와 `custom`을 고정 catalog로 유지하되 기본
  endpoint는 호환 초기값으로 취급한다. 선택 parameter는 protocol별 capability가
  허용할 때만 보내며 오류 응답을 이용한 기능 탐색은 하지 않는다.
- 결과: model 목록은 크기와 개수를 제한해 읽고 실패나 빈 결과를 그대로 오류로
  전달한다. 수동 model ID 검증은 목록 조회와 독립적으로 제공하여 조회 실패를 빈 목록
  성공으로 바꾸지 않고도 사용자가 직접 선택할 수 있게 한다.

## D013 — 중앙 도구 실행과 승인 범위

- 상태: 승인됨
- 결정: 등록 handler는 module-private registry에 보관하고 모델에는 이름·설명·복제한
  schema만 제공한다. 모든 호출은 schema, trust와 hard deny, hook, permission,
  재확인, handler, 후처리 순서를 강제하는 중앙 executor를 통한다. session/project
  승인은 tool·canonical workspace·실제 path/command/server 대상을 함께 해시한 규칙에
  묶는다.
- 결과: UI와 모델은 handler reference를 얻지 못한다. 한 파일이나 command 승인이 다른
  대상에 확대되지 않으며 deny는 자동 모드와 기존 allow보다 우선한다. P09 전 no-op
  hook은 `implementation: none`으로 드러내어 hook 완성을 가장하지 않는다.
