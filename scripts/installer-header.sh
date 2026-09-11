#!/bin/sh
set -eu

LC_ALL=C
export LC_ALL
umask 077

package_version='@@PACKAGE_VERSION@@'
node_version='@@NODE_VERSION@@'
target_architecture='@@TARGET_ARCH@@'
node_archive_name='@@NODE_ARCHIVE@@'
node_archive_sha256='@@NODE_SHA256@@'
payload_sha256='@@PAYLOAD_SHA256@@'

log() {
    printf '[cat 설치] %s\n' "$*"
}

warn() {
    printf '[cat 설치] 알림: %s\n' "$*" >&2
}

fail() {
    printf '[cat 설치] 오류: %s\n' "$*" >&2
    exit 1
}

for required_tool in base64 chmod dirname find grep id ln mkdir mktemp mv readlink realpath rm sed sha256sum stat tar tr uname; do
    command -v "$required_tool" >/dev/null 2>&1 || fail "필수 도구가 없습니다: $required_tool"
done

installer_uid=$(id -u)
[ "$installer_uid" -ne 0 ] || fail "root 또는 sudo 실행을 지원하지 않습니다. 일반 사용자로 실행하세요."
[ -n "${HOME:-}" ] || fail "HOME 환경변수가 필요합니다."
case "$HOME" in
    /*) ;;
    *) fail "HOME은 절대 경로여야 합니다." ;;
esac

cat_home_real=$(realpath -e -- "$HOME") || fail "HOME의 실제 경로를 확인할 수 없습니다."
[ -d "$cat_home_real" ] || fail "HOME이 디렉터리가 아닙니다: $cat_home_real"
[ "$cat_home_real" != "/" ] || fail "HOME이 루트 디렉터리일 수 없습니다."
[ "$(stat -c '%u' -- "$cat_home_real")" = "$installer_uid" ] || fail "현재 사용자가 HOME을 소유하지 않습니다."

normalize_user_path() {
    path_candidate=$1
    path_label=$2
    [ -n "$path_candidate" ] || fail "$path_label 경로가 비어 있습니다."
    [ "${#path_candidate}" -le 4096 ] || fail "$path_label 경로가 너무 깁니다."
    path_without_controls=$(printf '%s' "$path_candidate" | tr -d '[:cntrl:]')
    [ "$path_candidate" = "$path_without_controls" ] || fail "$path_label 경로에 제어 문자를 사용할 수 없습니다."
    case "$path_candidate" in
        /*) ;;
        *) fail "$path_label 경로는 절대 경로여야 합니다: $path_candidate" ;;
    esac
    [ ! -L "$path_candidate" ] || fail "$path_label 자체가 심볼릭 링크일 수 없습니다: $path_candidate"

    normalized_path=$(realpath -m -- "$path_candidate") || fail "$path_label 경로를 정규화할 수 없습니다."
    case "$normalized_path" in
        "$cat_home_real"/*) ;;
        *) fail "$path_label 경로는 사용자 HOME 아래여야 합니다: $normalized_path" ;;
    esac
    printf '%s\n' "$normalized_path"
}

path_identity() {
    stat -c '%d:%i:%u:%F' -- "$1"
}

cat_install_input=${CAT_INSTALL_DIR:-"$HOME/.local/lib/cat-agent-cli"}
cat_bin_input=${CAT_BIN_DIR:-"$HOME/.local/bin"}
cat_install_dir=$(normalize_user_path "$cat_install_input" "설치")
cat_bin_dir=$(normalize_user_path "$cat_bin_input" "명령")

case "$cat_bin_dir" in
    "$cat_install_dir"|"$cat_install_dir"/*) fail "명령 경로가 설치 경로와 겹칠 수 없습니다." ;;
esac
case "$cat_install_dir" in
    "$cat_bin_dir"|"$cat_bin_dir"/*) fail "설치 경로가 명령 경로와 겹칠 수 없습니다." ;;
esac

case "${CAT_INSTALL_CAT_COMMAND:-0}" in
    0) install_cat_command=0 ;;
    1) install_cat_command=1 ;;
    *) fail "CAT_INSTALL_CAT_COMMAND는 0 또는 1이어야 합니다." ;;
esac

case "$(uname -s)" in
    Linux) ;;
    *) fail "이 설치본은 Linux에서만 사용할 수 있습니다." ;;
esac
case "$(uname -m)" in
    x86_64|amd64) host_architecture=x64 ;;
    aarch64|arm64) host_architecture=arm64 ;;
    *) fail "지원하지 않는 CPU architecture입니다: $(uname -m)" ;;
esac
[ "$host_architecture" = "$target_architecture" ] || {
    fail "설치본 architecture($target_architecture)와 현재 시스템($host_architecture)이 다릅니다."
}

cat_install_parent=$(dirname -- "$cat_install_dir")
mkdir -p -- "$cat_install_parent" "$cat_bin_dir"
[ "$(realpath -e -- "$cat_install_parent")" = "$cat_install_parent" ] || fail "설치 부모 경로가 설치 중 변경되었습니다."
[ "$(realpath -e -- "$cat_bin_dir")" = "$cat_bin_dir" ] || fail "명령 경로가 설치 중 변경되었습니다."
[ ! -L "$cat_install_parent" ] || fail "설치 부모 경로가 심볼릭 링크일 수 없습니다."
[ ! -L "$cat_bin_dir" ] || fail "명령 경로가 심볼릭 링크일 수 없습니다."
[ "$(stat -c '%u' -- "$cat_install_parent")" = "$installer_uid" ] || fail "현재 사용자가 설치 부모 경로를 소유하지 않습니다."
[ "$(stat -c '%u' -- "$cat_bin_dir")" = "$installer_uid" ] || fail "현재 사용자가 명령 경로를 소유하지 않습니다."
install_parent_identity=$(path_identity "$cat_install_parent")
bin_dir_identity=$(path_identity "$cat_bin_dir")

existing_install=0
existing_install_identity=
install_action=설치
if [ -L "$cat_install_dir" ]; then
    fail "설치 경로가 심볼릭 링크일 수 없습니다: $cat_install_dir"
elif [ -e "$cat_install_dir" ]; then
    [ -d "$cat_install_dir" ] || fail "설치 경로에 디렉터리가 아닌 항목이 있습니다: $cat_install_dir"
    [ "$(stat -c '%u' -- "$cat_install_dir")" = "$installer_uid" ] || fail "현재 사용자가 기존 설치 경로를 소유하지 않습니다."
    existing_install=1
    existing_install_identity=$(path_identity "$cat_install_dir")
    if [ -n "$(find "$cat_install_dir" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
        managed_marker=$cat_install_dir/.cat-agent-cli-managed
        [ -f "$managed_marker" ] && [ ! -L "$managed_marker" ] || {
            fail "cat-agent-cli가 관리하는 설치 경로가 아니므로 보존합니다: $cat_install_dir"
        }
        [ "$(sed -n '1p' "$managed_marker")" = "cat-agent-cli:v1" ] || {
            fail "알 수 없는 관리 표식이 있어 기존 경로를 보존합니다: $cat_install_dir"
        }
        [ -f "$cat_install_dir/package.json" ] && [ ! -L "$cat_install_dir/package.json" ] || {
            fail "기존 관리 설치본의 package manifest가 올바르지 않습니다: $cat_install_dir"
        }
        grep -Eq '"name"[[:space:]]*:[[:space:]]*"cat-agent-cli"' "$cat_install_dir/package.json" || {
            fail "기존 관리 설치본의 package 이름이 올바르지 않습니다: $cat_install_dir"
        }
        [ -f "$cat_install_dir/bin/cat" ] && [ ! -L "$cat_install_dir/bin/cat" ] || {
            fail "기존 관리 설치본의 launcher가 올바르지 않습니다: $cat_install_dir"
        }
        install_action=업데이트
    fi
fi

cat_work_dir=$(mktemp -d "$cat_install_parent/.cat-agent-cli-install.XXXXXX") || fail "임시 설치 경로를 만들 수 없습니다."
case "$cat_work_dir" in
    "$cat_install_parent"/.cat-agent-cli-install.*) ;;
    *) fail "임시 설치 경로가 관리 범위를 벗어났습니다: $cat_work_dir" ;;
esac
[ -d "$cat_work_dir" ] && [ ! -L "$cat_work_dir" ] || fail "임시 설치 경로가 안전하지 않습니다."

install_succeeded=0
previous_moved=0
new_install_committed=0
staged_install_identity=
cat_stage=
cat_tui_link_created=0
cat_link_created=0
previous_install=$cat_work_dir/previous
failed_install=$cat_work_dir/failed-new
launcher_target=$cat_install_dir/bin/cat

link_is_managed() {
    managed_link_path=$1
    [ -L "$managed_link_path" ] || return 1
    [ "$(readlink -- "$managed_link_path")" = "$launcher_target" ]
}

finish_installation() {
    install_exit_status=$?
    trap - EXIT HUP INT TERM
    set +e
    rollback_ok=1

    if [ "$install_succeeded" -ne 1 ]; then
        if [ ! -L "$cat_bin_dir" ] && [ "$(path_identity "$cat_bin_dir" 2>/dev/null)" = "$bin_dir_identity" ]; then
            if [ "$cat_link_created" -eq 1 ] && link_is_managed "$cat_bin_dir/cat"; then
                rm -f -- "$cat_bin_dir/cat" || rollback_ok=0
            fi
            if [ "$cat_tui_link_created" -eq 1 ] && link_is_managed "$cat_bin_dir/cat-tui"; then
                rm -f -- "$cat_bin_dir/cat-tui" || rollback_ok=0
            fi
        elif [ "$cat_link_created" -eq 1 ] || [ "$cat_tui_link_created" -eq 1 ]; then
            warn "명령 경로 identity가 바뀌어 생성 link를 자동 제거하지 않습니다: $cat_bin_dir"
            rollback_ok=0
        fi

        current_install_identity=$(path_identity "$cat_install_dir" 2>/dev/null || printf '')
        remaining_stage_identity=$(path_identity "$cat_stage" 2>/dev/null || printf '')
        if [ "$new_install_committed" -eq 1 ] && [ ! -L "$cat_install_dir" ] && \
            [ "$current_install_identity" = "$staged_install_identity" ]; then
            if ! mv -T -- "$cat_install_dir" "$failed_install"; then
                warn "실패한 새 설치본을 격리하지 못했습니다: $cat_install_dir"
                rollback_ok=0
            fi
        elif [ "$new_install_committed" -eq 1 ] && [ "$remaining_stage_identity" != "$staged_install_identity" ]; then
            warn "새 설치본 identity를 확인할 수 없어 자동 이동하지 않습니다: $cat_install_dir"
            rollback_ok=0
        fi

        if [ "$previous_moved" -eq 1 ]; then
            previous_identity=$(path_identity "$previous_install" 2>/dev/null || printf '')
            current_install_identity=$(path_identity "$cat_install_dir" 2>/dev/null || printf '')
            if [ ! -L "$cat_install_dir" ] && [ "$current_install_identity" = "$existing_install_identity" ]; then
                :
            elif [ ! -L "$previous_install" ] && [ "$previous_identity" = "$existing_install_identity" ] && \
                [ ! -e "$cat_install_dir" ] && [ ! -L "$cat_install_dir" ] && \
                mv -T -- "$previous_install" "$cat_install_dir"; then
                    warn "이전 관리 설치본을 복구했습니다."
            else
                warn "이전 설치본 자동 복구에 실패했습니다: $previous_install"
                rollback_ok=0
            fi
        fi
    fi

    if [ "$rollback_ok" -eq 1 ]; then
        rm -rf -- "$cat_work_dir"
    else
        warn "수동 복구 자료를 보존했습니다: $cat_work_dir"
    fi
    exit "$install_exit_status"
}

trap finish_installation EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

file_sha256() {
    checksum_output=$(sha256sum -- "$1") || return 1
    printf '%s\n' "${checksum_output%% *}"
}

log "payload 검증"
payload_archive=$cat_work_dir/payload.tar.gz
sed '1,/^__CAT_PAYLOAD__$/d' "$0" | base64 -d > "$payload_archive"
[ "$(file_sha256 "$payload_archive")" = "$payload_sha256" ] || fail "내장 payload SHA-256이 일치하지 않습니다."

payload_root=$cat_work_dir/payload
mkdir -- "$payload_root"
tar -xzf "$payload_archive" --no-same-owner --no-same-permissions -C "$payload_root"

cat_stage=$payload_root/app
runtime_archive=$payload_root/runtime/$node_archive_name
[ -d "$cat_stage" ] && [ ! -L "$cat_stage" ] || fail "payload application 경로가 손상되었습니다."
[ -f "$cat_stage/bin/cat" ] && [ ! -L "$cat_stage/bin/cat" ] || fail "payload launcher가 없습니다."
[ -f "$cat_stage/dist/cli/main.js" ] && [ ! -L "$cat_stage/dist/cli/main.js" ] || fail "payload 진입점이 없습니다."
[ -f "$cat_stage/package.json" ] && [ ! -L "$cat_stage/package.json" ] || fail "payload package manifest가 없습니다."
grep -Eq '"name"[[:space:]]*:[[:space:]]*"cat-agent-cli"' "$cat_stage/package.json" || {
    fail "payload package 이름이 올바르지 않습니다."
}
for direct_dependency in @earendil-works/pi-tui ajv undici; do
    [ -d "$cat_stage/node_modules/$direct_dependency" ] || fail "payload production dependency가 없습니다: $direct_dependency"
done
[ -f "$cat_stage/LICENSE" ] && [ ! -L "$cat_stage/LICENSE" ] || fail "payload license 자료가 없습니다."
[ -f "$cat_stage/THIRD_PARTY_NOTICES.md" ] && [ ! -L "$cat_stage/THIRD_PARTY_NOTICES.md" ] || {
    fail "payload third-party notice가 없습니다."
}
[ -f "$payload_root/runtime-manifest.json" ] && [ ! -L "$payload_root/runtime-manifest.json" ] || {
    fail "payload runtime manifest가 없습니다."
}
[ -f "$runtime_archive" ] && [ ! -L "$runtime_archive" ] || fail "고정 Node.js archive가 없습니다."
[ "$(file_sha256 "$runtime_archive")" = "$node_archive_sha256" ] || fail "Node.js archive SHA-256이 일치하지 않습니다."

log "Node.js $node_version ($target_architecture) staging"
node_unpack=$cat_work_dir/node-unpack
mkdir -- "$node_unpack"
tar -xJf "$runtime_archive" --no-same-owner --no-same-permissions -C "$node_unpack"
node_source=$node_unpack/node-$node_version-linux-$target_architecture
[ -d "$node_source" ] && [ ! -L "$node_source" ] || fail "Node.js archive 루트가 올바르지 않습니다."
[ -f "$node_source/bin/node" ] && [ ! -L "$node_source/bin/node" ] && [ -x "$node_source/bin/node" ] || {
    fail "Node.js 실행 파일이 올바르지 않습니다."
}
[ -f "$node_source/LICENSE" ] && [ ! -L "$node_source/LICENSE" ] || fail "Node.js license가 없습니다."
mkdir -- "$cat_stage/.runtime"
mv -- "$node_source" "$cat_stage/.runtime/node"
chmod 755 "$cat_stage/bin/cat" "$cat_stage/.runtime/node/bin/node"
printf 'cat-agent-cli:v1\nversion=%s\nruntime=%s\narchitecture=%s\n' \
    "$package_version" "$node_version" "$target_architecture" > "$cat_stage/.cat-agent-cli-managed"
staged_install_identity=$(path_identity "$cat_stage")

log "사용자 영역 $install_action 준비"
[ ! -L "$cat_install_parent" ] && [ "$(path_identity "$cat_install_parent")" = "$install_parent_identity" ] || {
    fail "설치 부모 경로 identity가 staging 중 변경되었습니다."
}
[ ! -L "$cat_bin_dir" ] && [ "$(path_identity "$cat_bin_dir")" = "$bin_dir_identity" ] || {
    fail "명령 경로 identity가 staging 중 변경되었습니다."
}
if [ "$existing_install" -eq 1 ]; then
    previous_moved=1
    [ ! -L "$cat_install_dir" ] && [ "$(path_identity "$cat_install_dir")" = "$existing_install_identity" ] || {
        fail "기존 설치 경로 identity가 staging 중 변경되었습니다."
    }
    mv -T -- "$cat_install_dir" "$previous_install" || fail "기존 설치본을 backup으로 옮길 수 없습니다."
    [ "$(path_identity "$previous_install")" = "$existing_install_identity" ] || fail "기존 설치 backup identity가 다릅니다."
else
    [ ! -e "$cat_install_dir" ] && [ ! -L "$cat_install_dir" ] || fail "설치 경로가 staging 중 새로 생겼습니다."
fi
new_install_committed=1
mv -T -- "$cat_stage" "$cat_install_dir" || fail "staging 설치본을 최종 경로로 옮길 수 없습니다."
[ ! -L "$cat_install_dir" ] && [ "$(path_identity "$cat_install_dir")" = "$staged_install_identity" ] || {
    fail "최종 설치 경로 identity가 staging과 다릅니다."
}

create_command_link() {
    command_name=$1
    command_path=$cat_bin_dir/$command_name
    [ ! -L "$cat_bin_dir" ] && [ "$(path_identity "$cat_bin_dir")" = "$bin_dir_identity" ] || return 1
    if [ -L "$command_path" ]; then
        if link_is_managed "$command_path"; then
            return 3
        fi
        warn "기존 명령 링크를 보존했습니다: $command_path -> $(readlink -- "$command_path")"
        return 2
    fi
    if [ -e "$command_path" ]; then
        warn "기존 명령을 보존했습니다: $command_path"
        return 2
    fi
    ln -s -- "$launcher_target" "$command_path" || return 1
    return 0
}

cat_tui_link_state=보존
if create_command_link cat-tui; then
    cat_tui_link_created=1
    cat_tui_link_state=생성
else
    link_result=$?
    case "$link_result" in
        2) cat_tui_link_state=충돌보존 ;;
        3) cat_tui_link_state=기존관리링크 ;;
        *) fail "cat-tui 명령 링크를 만들 수 없습니다: $cat_bin_dir/cat-tui" ;;
    esac
fi

cat_link_state=선택안함
if [ "$install_cat_command" -eq 1 ]; then
    if create_command_link cat; then
        cat_link_created=1
        cat_link_state=생성
    else
        link_result=$?
        case "$link_result" in
            2) cat_link_state=충돌보존 ;;
            3) cat_link_state=기존관리링크 ;;
            *) fail "선택한 cat 명령 링크를 만들 수 없습니다: $cat_bin_dir/cat" ;;
        esac
    fi
fi

install_succeeded=1
log "cat-agent-cli $package_version $install_action 완료"
printf '설치 경로: %s\n' "$cat_install_dir"
printf 'cat-tui 링크: %s (%s)\n' "$cat_bin_dir/cat-tui" "$cat_tui_link_state"
if [ "$install_cat_command" -eq 1 ]; then
    printf '선택적 cat 링크: %s (%s)\n' "$cat_bin_dir/cat" "$cat_link_state"
else
    printf '%s\n' '선택적 cat 링크: 생성하지 않음 (CAT_INSTALL_CAT_COMMAND=1일 때만 시도)'
fi
case ":${PATH:-}:" in
    *:"$cat_bin_dir":*) ;;
    *) printf '현재 shell에서만 PATH에 추가: export PATH="%s:$PATH"\n' "$cat_bin_dir" ;;
esac
if [ "$cat_tui_link_state" = 충돌보존 ]; then
    printf '직접 실행: %s\n' "$launcher_target"
else
    printf '실행: %s\n' "$cat_bin_dir/cat-tui"
fi
printf '%s\n' '설치 과정에서는 애플리케이션과 내장 Node.js를 실행하지 않았습니다.'
exit 0

__CAT_PAYLOAD__
@@PAYLOAD@@
