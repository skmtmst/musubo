import type { FeatureJobMetadata } from './feature-job-types.js';

// 機能が無効でも保存期限の処理は続ける。各サービスの店舗方針・保持・データ保護は維持する。
export const PERSONAL_DATA_RETENTION_JOB = {
  name: 'personal data retention',
  classification: { kind: 'core', reason: '店が承認した保存期限に従う個人情報の削除' },
  // 機能スイッチで期限処理は止めないが、店舗の明示承認と保持条件は検査して監査する。
  enforcement: {
    mode: 'gated',
    sources: ['apps/worker/src/services/personal-data-retention.ts'],
    markers: [
      'if (!policy.enabled) continue;',
      'if (policy.hold) { held++; continue; }',
      'if (JSON.stringify(current)!==JSON.stringify(policy)) { held++; continue accounts; }',
    ],
  },
} as const satisfies FeatureJobMetadata;

export const TENANT_DATA_RETENTION_JOB = {
  name: 'tenant data retention purge',
  classification: { kind: 'core', reason: '退会後の顧客データ保存期限（★V6 36-2）' },
  enforcement: {
    mode: 'exempt',
    reason: '契約が終わった統括のデータ削除で、機能スイッチのon/offに関係なく実行する',
  },
} as const satisfies FeatureJobMetadata;

export const GOOGLE_CONTENT_RETENTION_JOB = {
  name: 'google business content retention',
  classification: { kind: 'core', reason: 'Googleから受け取った内容の保存期限（暦日30日）' },
  enforcement: {
    mode: 'exempt',
    reason:
      'Googleの利用者データポリシーで決まった保存期限の掃除で、機能をoffにした店舗の古いコピーが残り続けるほうが違反になる',
  },
} as const satisfies FeatureJobMetadata;

/** 利用申込は統括の所属前に作られるため、店舗の機能設定に関係なく期限を守る。 */
export const REGISTRATION_APPLICATION_RETENTION_JOB = {
  name: 'registration application retention',
  classification: { kind: 'core', reason: '未成立・却下の利用申込の保存期限' },
  enforcement: { mode: 'exempt', reason: '統括の所属前の申込であり、機能スイッチに依存しない' },
} as const satisfies FeatureJobMetadata;
