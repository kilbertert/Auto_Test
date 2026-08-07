#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repository_root"

base_url="${AUTO_TEST_MODEL_BASE_URL:-${AUTO_TEST_CODEX_BASE_URL:-https://api.deepseek.com}}"
model_id="${AUTO_TEST_MODEL_ID:-${AUTO_TEST_CODEX_MODEL:-deepseek-v4-flash}}"
configured_base_url=''
configured_model_id=''
read -r -p "Model API Base URL [$base_url]: " configured_base_url || :
read -r -p "Model ID [$model_id]: " configured_model_id || :
base_url="${configured_base_url:-$base_url}"
model_id="${configured_model_id:-$model_id}"
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
  AUTO_TEST_MODEL_BASE_URL="$base_url" \
  AUTO_TEST_MODEL_ID="$model_id" \
  bash "$repository_root/scripts/build-private-windows-package.sh"
