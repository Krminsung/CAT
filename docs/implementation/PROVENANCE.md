# 출처와 재구현 범위

## 사용자 제공 기준 자료

- 파일: `code-agent-cli-typescript.tar.gz`
- SHA-256: `03a19f434b2c6a378c1828bc401449be87b72c175f692f98cf147a35dc361855`
- 내부 package/version: `smilecode-typescript` 0.14.6
- 확인 수치: `src/*.ts` 28개, 10,554줄; `test/*.test.ts` 16개
- package metadata의 license 표기: MIT

압축 항목 976개와 총 비압축 크기 45,665,574 bytes를 검사했다. 절대 경로,
`..` 경로, 밖으로 나가는 link, 장치/FIFO, 20MiB 초과 단일 항목은 없었다.
`.reference/smilecode/`에는 필요한 `src`, 설정, README, docs, scripts, tests와
wrapper만 전개했다. 원본의 `node_modules`, `dist`, `.git`은 가져오지 않았으며
참조 영역과 archive는 Git에 포함하지 않는다.

## 외부 설계 참고

`tanbiralam/claude-code`의 문서에 기록된 고정 commit
`6f6f12b37f529488b10e53928dd5508bb93535c7`은 도구 계약, 명시적 loop state,
budget과 compaction 분리라는 설계 원칙에만 참고한다. 해당 코드를 dependency,
배포 payload 또는 장문의 복제 소스로 사용하지 않는다. 공개 저장소라는 사실을
재배포 권리로 해석하지 않는다.

## 새 구현

cat 소스는 기능 계약을 토대로 새 디렉터리 경계와 새 코드를 작성한다. 제공 archive의
license metadata만으로 모든 참조 자료의 권리가 확인됐다고 주장하지 않는다. 공개
배포 전 권리 확인은 별도이며, P14 완료도 공개 배포 승인을 의미하지 않는다.

## P13 legacy 호환 표식

legacy import의 입력 형식은 제공 archive의 `src/auth.ts`, `src/sessions.ts`, `src/settings.ts`를 읽어
재구현했다. 새 저장 형식이나 실행 코드를 원본에서 복사하지 않고 bounded reader와 새 credential,
profile, session schema 사이의 명시적 변환으로 분리했다.

새 제품 화면 이름과 network `User-Agent`는 `cat`이다. 제품 source에 남은 `Smile Code`, `smilecode`,
`.smileserv`, `SMILECODE_*`, `SMILESERV_*`, `SMILESERV.md`, `CAGENT.md`는 다음 legacy 호환 경계에서만
사용한다.

- 사용자가 실행하는 기존 데이터 이관의 source label과 보존 provenance field
- 기존 API key 환경변수와 provider alias
- 기존 지침 파일 탐색과 민감 경로 차단

이 문자열들은 새 제품명이나 새 기본 데이터 경로로 노출하기 위한 것이 아니며, 범위 정리에서 임의로
삭제하지 않는다. 실제 legacy 자료는 저장소에 추가하거나 개발 중 읽지 않았다.

## P10 schema validator 의존성

- package: `ajv@8.20.0` (MIT)
- npm metadata 확인 integrity:
  `sha512-Thbli+OlOj+iMPYFBVBfJ3OmCAnaSyNn4M1vz9T6Gka5Jt9ba/HIR56joy65tY6kx/FCF5VXNB819Y7/GUrBGA==`
- 설치 방식: `--save-exact --ignore-scripts --no-audit --no-fund`를 사용한 1회 설치
- 사용 범위: MCP가 제공한 JSON Schema 2020-12의 host-side compile·validation. 원격 schema
  load와 사용자 정의 keyword·format은 사용하지 않는다.
