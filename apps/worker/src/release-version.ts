// 開発用の版情報。公開 bundle は apps/worker/scripts/inject-version.ts、検証環境は apps/worker/scripts/stamp-staging-version.ts がビルド前に版と SHA を書き込む。
export const BUNDLE_VERSION = '0.0.0-dev';
export const WORKER_HASH = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
export const ADMIN_HASH = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
export const LIFF_HASH = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
export const RELEASED_AT = '1970-01-01T00:00:00Z';
export const GIT_COMMIT = 'unknown';
