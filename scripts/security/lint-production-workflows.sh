#!/usr/bin/env bash
set -euo pipefail
# Pinned upstream release and archive digests; no machine-wide installation.
case "$(uname -s)/$(uname -m)" in
  Darwin/arm64) platform=darwin_arm64; expected=2693315b9093aeacb4ebd91a993fea54fc215057bf0da2659056b4bc033873db ;;
  Darwin/x86_64) platform=darwin_amd64; expected=28e5de5a05fc558474f638323d736d822fff183d2d492f0aecb2b73cc44584f5 ;;
  Linux/aarch64) platform=linux_arm64; expected=401942f9c24ed71e4fe71b76c7d638f66d8633575c4016efd2977ce7c28317d0 ;;
  Linux/x86_64) platform=linux_amd64; expected=023070a287cd8cccd71515fedc843f1985bf96c436b7effaecce67290e7e0757 ;;
  *) echo 'actionlint_platform: FAIL'; exit 1 ;;
esac
lint_temp=$(mktemp -d)
trap 'rm -rf "$lint_temp"' EXIT
curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location \
  "https://github.com/rhysd/actionlint/releases/download/v1.7.7/actionlint_1.7.7_${platform}.tar.gz" \
  -o "$lint_temp/actionlint.tar.gz"
actual=$(shasum -a 256 "$lint_temp/actionlint.tar.gz" | cut -d ' ' -f 1)
test "$actual" = "$expected"
tar -xzf "$lint_temp/actionlint.tar.gz" -C "$lint_temp" actionlint
"$lint_temp/actionlint" -shellcheck='' \
  -ignore '^unexpected key "queue" for "concurrency" section\.' \
  .github/workflows/deploy-cloudflare-production.yml
# GitHubが受け付ける queue: max を固定版actionlintがまだ認識しない。
# 値・組み合わせは check_production_workflows.py で厳密に確認する。
"$lint_temp/actionlint" -shellcheck='' \
  -ignore '^unexpected key "queue" for "concurrency" section\.' \
  .github/workflows/migrate-d1.yml
"$lint_temp/actionlint" -shellcheck='' \
  .github/workflows/migrate-d1-production.yml \
  .github/workflows/deploy-cloudflare-worker.yml \
  .github/workflows/deploy-cloudflare-admin.yml \
  .github/workflows/migrate-line-credentials.yml
echo 'production_actionlint: PASS'
