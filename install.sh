#!/bin/sh
set -eu

LC_ALL=C
export LC_ALL
umask 077

repository='Krminsung/CAT'
latest_release_url="https://github.com/$repository/releases/latest"

log() {
    printf '[cat 설치 준비] %s\n' "$*"
}

fail() {
    printf '[cat 설치 준비] 오류: %s\n' "$*" >&2
    exit 1
}

for required_tool in chmod curl grep mktemp rm sha256sum uname; do
    command -v "$required_tool" >/dev/null 2>&1 || fail "필수 도구가 없습니다: $required_tool"
done

case "$(uname -s)" in
    Linux) ;;
    *) fail "Linux에서만 설치할 수 있습니다." ;;
esac

case "$(uname -m)" in
    x86_64|amd64) target_architecture=x64 ;;
    aarch64|arm64) target_architecture=arm64 ;;
    *) fail "지원하지 않는 CPU architecture입니다: $(uname -m)" ;;
esac

log "최신 GitHub Release 확인"
resolved_release_url=$(curl --proto '=https' --tlsv1.2 -fsSL \
    -o /dev/null -w '%{url_effective}' "$latest_release_url") || {
    fail "최신 GitHub Release를 확인하지 못했습니다."
}
case "$resolved_release_url" in
    "https://github.com/$repository/releases/tag/"*) ;;
    *) fail "예상하지 않은 GitHub Release 주소입니다: $resolved_release_url" ;;
esac

release_tag=${resolved_release_url##*/}
printf '%s\n' "$release_tag" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$' || {
    fail "Release tag 형식이 올바르지 않습니다: $release_tag"
}

installer_name="cat-agent-cli-$release_tag-linux-$target_architecture-install.sh"
asset_root="https://github.com/$repository/releases/download/$release_tag"
download_directory=$(mktemp -d) || fail "임시 다운로드 경로를 만들지 못했습니다."

cleanup() {
    cleanup_status=$?
    trap - EXIT HUP INT TERM
    rm -rf -- "$download_directory"
    exit "$cleanup_status"
}

trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

log "$release_tag Linux $target_architecture 설치본 다운로드"
curl --proto '=https' --tlsv1.2 -fL \
    "$asset_root/$installer_name" -o "$download_directory/$installer_name" || {
    fail "설치본을 다운로드하지 못했습니다."
}
curl --proto '=https' --tlsv1.2 -fL \
    "$asset_root/$installer_name.sha256" -o "$download_directory/$installer_name.sha256" || {
    fail "checksum을 다운로드하지 못했습니다."
}

log "설치본 SHA-256 확인"
(
    cd "$download_directory"
    sha256sum -c "$installer_name.sha256"
) || fail "설치본 SHA-256이 일치하지 않습니다."

chmod 700 "$download_directory/$installer_name"
log "$release_tag 설치 실행"
"$download_directory/$installer_name"
