#!/usr/bin/env bash
set -euo pipefail

umask 077

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repository_root"

model_api_key="${AUTO_TEST_MODEL_API_KEY:-}"
if [[ -z "$model_api_key" && ! -t 0 ]]; then
  IFS= read -r model_api_key
fi
if [[ -z "$model_api_key" ]]; then
  echo "缺少模型 API Key；请通过标准输入或私有构建进程环境提供。" >&2
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
zip -q -j "$output_path" "$temporary_directory/Auto-Test.private-key"
chmod 600 "$output_path"

echo "私有 Windows 包已生成：$output_path"
echo "SHA-256：$(sha256sum "$output_path" | cut -d' ' -f1)"
echo "该文件包含可提取的模型 API Key；禁止上传 GitHub、网盘或公开制品库。"
