#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repository_root"

base_url="${AUTO_TEST_CODEX_BASE_URL:-}"
model_id="${AUTO_TEST_CODEX_MODEL:-}"
if [[ -z "$base_url" ]]; then
  read -r -p "Model API Base URL: " base_url
fi
if [[ -z "$model_id" ]]; then
  read -r -p "Model ID: " model_id
fi
if [[ -z "$base_url" || -z "$model_id" ]]; then
  echo "Base URL 和模型 ID 都不能为空。" >&2
  exit 1
fi

printf 'API Key（输入不回显）: ' >&2
IFS= read -r -s model_api_key || :
printf '\n' >&2
if [[ -z "$model_api_key" ]]; then
  echo "API Key 不能为空。" >&2
  exit 1
fi

trap 'unset model_api_key base_url model_id' EXIT
printf '%s\n' "$model_api_key" | \
  AUTO_TEST_CODEX_BASE_URL="$base_url" \
  AUTO_TEST_CODEX_MODEL="$model_id" \
  bash "$repository_root/scripts/build-private-windows-package.sh"
