#!/usr/bin/env bash
set -euo pipefail

die() {
  echo "trusted PR delivery failed: $*" >&2
  exit 1
}

default_branch() {
  local repo="${1:-.}" branch="${AFK_DEFAULT_BRANCH:-}"
  if [ -z "$branch" ]; then
    branch="$(git -C "$repo" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || true)"
    branch="${branch#origin/}"
  fi
  printf '%s\n' "${branch:-main}"
}

valid_branch() {
  local branch="$1" repo="${2:-.}"
  git check-ref-format --branch "$branch" >/dev/null || die "invalid branch: $branch"
  [ "$branch" != "$(default_branch "$repo")" ] || die "the pull request branch cannot be the default branch"
}

remote_head() {
  if [ -n "${AFK_READ_TOKEN:-}" ]; then
    auth="$(printf 'x-access-token:%s' "$AFK_READ_TOKEN" | base64 | tr -d '\n')"
    git -C "$1" -c "http.https://github.com/.extraheader=AUTHORIZATION: basic ${auth}" \
      ls-remote origin "refs/heads/$2" | awk 'NR == 1 { print $1 }'
  else
    git -C "$1" ls-remote origin "refs/heads/$2" | awk 'NR == 1 { print $1 }'
  fi
}

command="${1:-}"
case "$command" in
  prepare)
    [ "$#" -eq 5 ] || die "usage: $0 prepare REPO EXPECTED_HEAD BASE_SHA BRANCH"
    repo="$2" expected="$3" base="$4" branch="$5"
    valid_branch "$branch" "$repo"
    [ "$(git -C "$repo" rev-parse HEAD)" = "$expected" ] || die "candidate HEAD changed before preparation"
    git -C "$repo" cat-file -e "$base^{commit}" || die "trusted base commit is unavailable"
    git -C "$repo" checkout -q -B "$branch" "$expected"
    git -C "$repo" branch -f "$(default_branch "$repo")" "$base"
    git -C "$repo" config user.name "claude-code[bot]"
    git -C "$repo" config user.email "claude-code[bot]@users.noreply.github.com"
    ;;

  capture)
    [ "$#" -eq 6 ] || die "usage: $0 capture REPO EXPECTED_HEAD BRANCH BUNDLE STATE_FILE"
    repo="$2" expected="$3" branch="$4" bundle="$5" state_file="$6"
    valid_branch "$branch" "$repo"
    current_branch="$(git -C "$repo" symbolic-ref --short HEAD)"
    [ "$current_branch" = "$branch" ] || die "candidate branch changed to $current_branch"
    result="$(git -C "$repo" rev-parse HEAD)"
    git -C "$repo" merge-base --is-ancestor "$expected" "$result" || die "candidate rewrote the recorded PR head"
    git -C "$repo" diff --check "$expected..$result"
    if [ "$result" = "$expected" ]; then
      rm -f "$bundle"
      printf 'false\n' > "$state_file"
      exit 0
    fi
    git -C "$repo" bundle create "$bundle" "refs/heads/$branch" "^$expected"
    git -C "$repo" bundle verify "$bundle" >/dev/null
    printf 'true\n' > "$state_file"
    ;;

  import)
    [ "$#" -eq 5 ] || die "usage: $0 import REPO EXPECTED_HEAD BRANCH BUNDLE"
    repo="$2" expected="$3" branch="$4" bundle="$5"
    valid_branch "$branch" "$repo"
    [ -f "$bundle" ] || die "result bundle is missing"
    actual="$(remote_head "$repo" "$branch")"
    [ "$actual" = "$expected" ] || die "branch advanced during the agent run"
    git -C "$repo" fetch -q "$bundle" "refs/heads/$branch"
    result="$(git -C "$repo" rev-parse FETCH_HEAD)"
    git -C "$repo" merge-base --is-ancestor "$expected" "$result" || die "bundle does not extend the recorded PR head"
    git -C "$repo" checkout -q -B "$branch" "$result"
    ;;

  push)
    [ "$#" -eq 4 ] || die "usage: $0 push REPO EXPECTED_HEAD BRANCH"
    repo="$2" expected="$3" branch="$4"
    valid_branch "$branch" "$repo"
    actual="$(remote_head "$repo" "$branch")"
    [ "$actual" = "$expected" ] || die "branch advanced before delivery"
    git -C "$repo" push origin "HEAD:refs/heads/$branch"
    ;;

  *)
    die "usage: $0 prepare|capture|import|push ..."
    ;;
esac
