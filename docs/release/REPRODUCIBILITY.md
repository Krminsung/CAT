# 설치본 입력과 재현 범위

## 고정 입력

P14 standalone artifact는 다음 tracked 입력과 P14의 유일한 compiler output만 소비한다.

- `src/**/*.ts`, `tsconfig.json`, `package.json`, `package-lock.json`
- `bin/cat`
- `scripts/package-installer.mjs`, `scripts/installer-header.sh`
- `packaging/runtime-manifest.json`
- `README.md`, `LICENSE`, `THIRD_PARTY_NOTICES.md`, `docs/release/`
- 한 번의 `npm run build`가 만든 기존 `dist/`

runtime manifest는 Node.js v24.21.0의 다음 공식 archive를 고정한다.

| target | archive | SHA-256 |
|---|---|---|
| Linux x64 | `node-v24.21.0-linux-x64.tar.xz` | `fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6` |
| Linux arm64 | `node-v24.21.0-linux-arm64.tar.xz` | `6ad1325edbdb5649c379b75a237147a666c95d4f9ae8d340fef2d1575d289ad2` |

## 생성 경계

1. 모든 source와 packaging 입력을 고정한 뒤 `npm run build`를 한 번만 실행한다.
2. 성공한 같은 checkout에서 `npm run package:installer`를 한 번 실행한다.
3. packager는 build/typecheck/test/app/help/version을 호출하지 않고 기존 `dist/`를 복사한다.
4. production dependency는 stage에서 같은 lockfile과
   `npm ci --ignore-scripts --omit=dev --no-audit --no-fund` 한 번으로만 설치한다.
5. 두 Node archive를 공식 고정 URL에서 받고 SHA-256을 확인한다.
6. GNU tar의 이름 정렬, epoch mtime, 숫자 owner/group 고정 옵션으로 architecture별 payload를 만들고,
   installer 및 sidecar/통합 checksum을 임시 경로에 모두 만든 뒤 `artifacts/`로 rename한다.

`artifacts/`, `dist/`, production dependency stage와 내려받은 runtime은 Git에 넣지 않는다. packaging은
기존 `artifacts/`를 덮어쓰지 않으며 root `package-lock.json`의 전후 SHA-256이 달라지면 게시하지 않는다.

## 한계

고정 lockfile/integrity, runtime checksum과 deterministic tar 옵션은 입력 drift를 줄이지만, host
Node/npm/GNU tar/gzip/xz 구현과 npm package registry 가용성까지 동일하게 고정하지는 않는다. 따라서
bit-for-bit 재현성과 설치/앱 실행은 아직 runtime으로 검증되지 않았다. 생성된 실제 artifact의 경로,
크기와 SHA-256은 P14 packaging 뒤 단계 기록에 별도로 남긴다.
