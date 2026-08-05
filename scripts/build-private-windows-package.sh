#!/usr/bin/env bash
set -euo pipefail

umask 077

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repository_root"

model_api_key="${AUTO_TEST_MODEL_API_KEY:-}"
model_base_url="${AUTO_TEST_CODEX_BASE_URL:-}"
model_id="${AUTO_TEST_CODEX_MODEL:-}"
if [[ -z "$model_api_key" && ! -t 0 ]]; then
  # A pipe may end without a newline (for example printf '%s' "$key").
  # Bash read stores the value but returns 1 at EOF; do not let set -e
  # terminate before the explicit empty-key validation below.
  IFS= read -r model_api_key || :
fi
if [[ -z "$model_api_key" ]]; then
  echo "缺少模型 API Key；请通过标准输入或私有构建进程环境提供。" >&2
  exit 1
fi
if [[ -z "$model_base_url" || ! "$model_base_url" =~ ^https?:// ]]; then
  echo "缺少有效的模型 API Base URL；请通过 AUTO_TEST_CODEX_BASE_URL 提供。" >&2
  exit 1
fi
if [[ -z "$model_id" ]]; then
  echo "缺少模型 ID；请通过 AUTO_TEST_CODEX_MODEL 提供。" >&2
  exit 1
fi

if [[ -n "$(git status --porcelain --untracked-files=all)" ]]; then
  echo "工作树存在未提交改动；私有包只允许从已验证提交构建。" >&2
  exit 1
fi

if ! command -v zip >/dev/null 2>&1; then
  echo "缺少 zip 命令，无法构建 Windows 私有包。" >&2
  exit 1
fi

output_directory="$repository_root/artifacts/private-release"
output_path="$output_directory/Auto-Test-Windows-private-$(git rev-parse --short HEAD).zip"
temporary_directory="$(mktemp -d)"
trap 'rm -rf -- "$temporary_directory"' EXIT

mkdir -p "$output_directory"
git archive --format=zip --output="$output_path" HEAD
printf '%s' "$model_api_key" >"$temporary_directory/Auto-Test.private-key"
unset model_api_key
node -e 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify({ baseUrl: process.argv[2], model: process.argv[3] }))' \
  "$temporary_directory/Auto-Test.private-provider.json" "$model_base_url" "$model_id"
unset model_base_url model_id
node -e 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify({ packageVersion: require(process.argv[2]).version, commit: process.argv[3] }))' \
  "$temporary_directory/Auto-Test.build.json" "$repository_root/package.json" "$(git rev-parse --short HEAD)"
zip -q -j "$output_path" \
  "$temporary_directory/Auto-Test.private-key" \
  "$temporary_directory/Auto-Test.private-provider.json" \
  "$temporary_directory/Auto-Test.build.json"
chmod 600 "$output_path"

echo "私有 Windows 包已生成：$output_path"
echo "SHA-256：$(sha256sum "$output_path" | cut -d' ' -f1)"
echo "该文件包含可提取的模型 API Key 和私有 Provider 元数据；禁止上传 GitHub、网盘或公开制品库。"
