# cat standalone 설치 안내

## 지원 범위

standalone 설치본은 Linux x64(`x86_64`)와 arm64(`aarch64`)를 대상으로 한다. 각 설치본에는 공식
Node.js v24.21.0 runtime, 컴파일된 JavaScript, 고정 production dependency, `bin/cat`, 사용 문서와
license 자료가 포함된다. glibc·terminal·배포판별 실제 호환성, 앱 실행과 설치/rollback 흐름은 아직
runtime으로 검증하지 않았다.

필요한 host 도구는 POSIX `/bin/sh`와 GNU 계열 `base64`, `chmod`, `find`, `grep`, `realpath`, `sha256sum`,
`stat`, `tar`(gzip/xz 지원), `tr`, 그리고 일반 파일 도구다. installer는 누락 도구를 자동 설치하거나
`sudo`, apt/dnf/yum, 전역 npm을 사용하지 않는다.

## artifact 확인과 설치

P14 packaging을 완료하면 Git에 포함되지 않는 `artifacts/`에 다음 파일이 생성된다.

```text
cat-agent-cli-v0.1.0-linux-x64-install.sh
cat-agent-cli-v0.1.0-linux-x64-install.sh.sha256
cat-agent-cli-v0.1.0-linux-arm64-install.sh
cat-agent-cli-v0.1.0-linux-arm64-install.sh.sha256
SHA256SUMS
```

신뢰한 경로에서 installer와 checksum을 받은 뒤 현재 architecture에 맞는 파일을 확인하고 일반 사용자로
실행한다. installer와 같은 경로에서 다음 예시의 파일명을 선택한다.

```bash
sha256sum -c cat-agent-cli-v0.1.0-linux-x64-install.sh.sha256
./cat-agent-cli-v0.1.0-linux-x64-install.sh
```

installer 옆에서 함께 받은 checksum만으로 배포자의 신원을 증명할 수는 없다. checksum 파일의 값을
신뢰한 release 공지 또는 P14 packaging 기록과 별도로 대조해야 한다. 이 프로젝트는 자동으로 GitHub
Release나 npm package를 게시하지 않는다.

## 경로와 명령 충돌 정책

기본 설치 경로는 `$HOME/.local/lib/cat-agent-cli`, 기본 user-bin 경로는 `$HOME/.local/bin`이다.
둘 다 현재 사용자가 소유한 canonical HOME 내부여야 하고 서로 겹치면 안 된다. 필요하면 실행할 때
제어 문자가 없는 절대 경로로 바꿀 수 있다.

```bash
CAT_INSTALL_DIR="$HOME/apps/cat-agent-cli" \
CAT_BIN_DIR="$HOME/bin" \
./cat-agent-cli-v0.1.0-linux-x64-install.sh
```

기본 PATH 공개 이름은 `cat-tui`다. 기존 `cat-tui` 파일이나 다른 symlink가 있으면 덮어쓰지 않고
설치 경로의 `bin/cat` 직접 실행 위치를 안내한다. Unix 기본 `cat`과의 충돌 때문에 `cat` link는 만들지
않는다. 다음과 같이 명시한 경우에만 user-bin 안에서 시도하며, 그 이름이 이미 있으면 역시 보존한다.

```bash
CAT_INSTALL_CAT_COMMAND=1 ./cat-agent-cli-v0.1.0-linux-x64-install.sh
```

installer는 `/bin/cat`, `/usr/bin/cat`, shell profile과 시스템 package를 검사하거나 바꾸지 않는다.
`$HOME/.local/bin`이 PATH에 없다면 현재 shell에서 사용할 `export PATH=...` 문구만 출력하고 파일에는
쓰지 않는다.

## update와 실패 복구

기존 설치 경로가 비어 있거나 `.cat-agent-cli-managed` 표식, `cat-agent-cli` package 이름과 일반
파일 launcher를 모두 가진 경우에만 교체한다. 다른 내용이 있으면 그대로 보존하고 중단한다. update는
기존 디렉터리를 같은 filesystem의 임시 backup으로 옮긴 뒤 완성된 staging 디렉터리를 rename한다.
후속 오류나 signal이 발생하면 새로 만든 link를 제거하고 이전 설치본을 되돌린다. 자동 복구가 끝나지
않으면 임시 경로를 삭제하지 않고 수동 복구 위치를 출력한다.

설치 과정은 embedded payload와 공식 Node archive의 SHA-256 및 예상 파일만 확인한다. Node.js,
`cat-tui --version`, `--help` 또는 앱 자체는 실행하지 않으므로 설치 완료 메시지는 runtime 동작 확인을
뜻하지 않는다.
