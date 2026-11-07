#!/usr/bin/env bash

set -u

issues=()

record_issue() {
  issues+=("$1")
}

print_version() {
  local label="$1"
  local command_name="$2"

  if command -v "$command_name" >/dev/null 2>&1; then
    printf '%s: %s\n' "$label" "$("$command_name" --version 2>/dev/null | head -n 1)"
  else
    printf '%s: 未インストール\n' "$label"
    record_issue "${label}が利用できない"
  fi
}

http_code() {
  local url="$1"

  curl \
    --silent \
    --show-error \
    --output /dev/null \
    --write-out '%{http_code}' \
    --connect-timeout 5 \
    --max-time 10 \
    "$url" 2>/dev/null
}

check_allowed_endpoint() {
  local label="$1"
  local url="$2"
  local code

  if code="$(http_code "$url")" && [[ "$code" != "000" ]]; then
    printf '%s: HTTP %s\n' "$label" "$code"
  else
    printf '%s: 到達不可\n' "$label"
    record_issue "${label}へ到達できない"
  fi
}

# Cloudflare API の到達検査。到達の成否だけを見る。

# 認証なしで叩く確認用 URL は到達しても 404 等を返すので、
# 通信できなかったとき(000)だけ失敗。到達した HTTP 応答は成功として説明する。
check_cloudflare_api() {
  local url="$1"
  local code

  if code="$(http_code "$url")" && [[ "$code" != "000" ]]; then
    if [[ "$code" == "404" ]]; then
      printf 'Cloudflare API: HTTP 404（到達成功。認証なしの確認用 URL のため 404 は正常）\n'
    else
      printf 'Cloudflare API: HTTP %s（到達成功）\n' "$code"
    fi
  else
    printf 'Cloudflare API: 到達不可\n'
    record_issue "Cloudflare APIへ到達できない"
  fi
}

# Cloudflare の資格情報はローカルへ保存しないのが原則。
# 1 つでも設定されていたら値は表示せず、設定されていることだけ出して要確認にする。
check_local_cloudflare_credential() {
  local variable_name="$1"

  if [[ "${!variable_name+x}" == "x" ]]; then
    printf '%s: 設定あり（値は非表示）\n' "$variable_name"
    record_issue "${variable_name}が設定されている"
    return 0
  fi

  printf '%s: 未設定\n' "$variable_name"
  return 1
}

# GitHub staging Environment の秘密名だけを照合する。値は取得・表示しない。
# 役割ごとに「この中のどれか 1 つあればよい」を契約どおりに判定する。
check_staging_role() {
  local label="$1"
  local secret_names="$2"
  shift 2
  local candidate

  for candidate in "$@"; do
    if printf '%s\n' "$secret_names" | grep -qxF "$candidate"; then
      printf '%s: staging に設定あり（%s。値は非表示）\n' "$label" "$candidate"
      return 0
    fi
  done

  printf '%s: staging に不足（%s のいずれかが必要）\n' "$label" "$*"
  record_issue "${label}が GitHub staging にない"
  return 1
}

check_staging_secrets() {
  local repo="$1"
  local environment="$2"
  local secret_names

  printf 'GitHub staging secrets: %s の %s（秘密名だけ照合。値は取得しない）\n' "$repo" "$environment"

  if ! command -v gh >/dev/null 2>&1; then
    printf 'GitHub staging secrets: gh が無いため確認不可\n'
    record_issue "GitHub staging の秘密名を確認できない（gh 未利用）"
    return
  fi

  if ! gh auth status >/dev/null 2>&1; then
    printf 'GitHub staging secrets: gh 未認証のため確認不可\n'
    record_issue "GitHub staging の秘密名を確認できない（gh 未認証）"
    return
  fi

  if ! secret_names="$(gh secret list -R "$repo" -e "$environment" --json name --jq '.[].name' 2>/dev/null)"; then
    printf 'GitHub staging secrets: 一覧を取得できない（通信・権限・repo/env を確認）\n'
    record_issue "GitHub staging の秘密名を確認できない（一覧取得失敗）"
    return
  fi

  check_staging_role "Worker 用 token" "$secret_names" \
    "CLOUDFLARE_WORKERS_API_TOKEN" "CF_API_TOKEN" || true
  check_staging_role "Pages 用 token" "$secret_names" \
    "CLOUDFLARE_PAGES_API_TOKEN" "CF_API_TOKEN" || true
  check_staging_role "Account ID" "$secret_names" \
    "CLOUDFLARE_ACCOUNT_ID" "CF_ACCOUNT_ID" || true
}

print_version "Node.js" "node"
print_version "pnpm" "pnpm"

if command -v curl >/dev/null 2>&1; then
  check_allowed_endpoint "GitHub API" "https://api.github.com"
  check_allowed_endpoint "npm registry" "https://registry.npmjs.org"
  # Cloudflare への到達検査は **検証反映の可否**を見るもの。
  # 通信できなかったとき(000)だけ失敗し、認証なしの確認用 URL が返す
  # 404 等は「届いた証拠」として成功に数える。
  #
  # **既定は検査したまま。** 外すときだけ `DOCTOR_LOCAL=1` を明示する。
  # 逆（クラウドのときだけ検査する）にすると、クラウド側で付け忘れたときに
  # 境界の検査が黙って飛ぶ。付け忘れても検査が残る側に倒す。
  #
  # **外したことは必ず出す。** 黙って飛ばすと、検査したのかどうかが
  # 最終行から読み取れなくなる。
  if [[ "${DOCTOR_LOCAL:-}" == "1" ]]; then
    printf 'Cloudflare API: 判定なし（DOCTOR_LOCAL=1。クラウド環境の検査項目です）\n'
  else
    check_cloudflare_api "https://api.cloudflare.com/client/v4"
  fi
else
  printf 'curl: 未インストール\n'
  record_issue "接続先を確認できない"
fi

# Cloudflare の資格情報はローカルへ保存せず、GitHub staging Environment を正本にする。
# ローカルに 1 つでもあれば要確認し、staging の照合は行わない。
# 以下の検査は **`DOCTOR_LOCAL=1` でも常に走る。**
local_cloudflare_credential_set=0
for local_cloudflare_variable in \
  "CLOUDFLARE_API_TOKEN" \
  "CLOUDFLARE_WORKERS_API_TOKEN" \
  "CLOUDFLARE_PAGES_API_TOKEN" \
  "CF_API_TOKEN" \
  "CLOUDFLARE_ACCOUNT_ID" \
  "CF_ACCOUNT_ID"; do
  if check_local_cloudflare_credential "$local_cloudflare_variable"; then
    local_cloudflare_credential_set=1
  fi
done

if [[ "$local_cloudflare_credential_set" == "0" ]]; then
  check_staging_secrets "skmtmst/musubo" "staging"
fi

if ((${#issues[@]} == 0)); then
  printf '合格\n'
  exit 0
fi

printf '要確認：%s\n' "$(IFS='、'; printf '%s' "${issues[*]}")"
exit 1
