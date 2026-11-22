export const SECURITY_RULES = {
  meeting_revoke_review: { label: '外部接続の解除に要確認', threshold: 1 },
  login_failures: { label: 'ログイン失敗の増加', threshold: 20 },
  api_mutations: { label: '記録対象APIの変更操作の増加', threshold: 1000 },
  export_requests: { label: '書き出し操作の増加', threshold: 10 },
  export_records: { label: '書き出した件数の増加', threshold: 10000 },
  permission_changes: { label: '権限・所属の変更', threshold: 1 },
  admin_additions: { label: '管理者候補の追加・招待', threshold: 1 },
  key_rotations: { label: '鍵・二段階認証の作り直し', threshold: 1 },
  impersonation: { label: '代理ログイン・個人情報の開示', threshold: 1 },
  night_activity: { label: '夜間の記録対象操作の増加', threshold: 100 },
} as const;
export type SecurityRuleKey = keyof typeof SECURITY_RULES;
export type SecurityThresholds = Record<SecurityRuleKey, number>;
export const SECURITY_WINDOW_MINUTES = 15;

/** 不正設定で監視を黙って無効にせず、設定から動的 SQL を作らない。 */
export function securityThresholds(raw?: string): { values: SecurityThresholds; invalid: boolean } {
  const values = Object.fromEntries(Object.entries(SECURITY_RULES).map(([key, rule]) => [key, rule.threshold])) as SecurityThresholds;
  if (!raw) return { values, invalid: false };
  try {
    const input = JSON.parse(raw) as unknown;
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error();
    for (const [key, value] of Object.entries(input)) {
      if (!Object.hasOwn(SECURITY_RULES, key) || !Number.isSafeInteger(value) || value < 1 || value > 10000000) throw new Error();
    }
    return { values: { ...values, ...input }, invalid: false };
  } catch { return { values, invalid: true }; }
}

export function securityRule(key: string) {
  return Object.hasOwn(SECURITY_RULES, key) ? SECURITY_RULES[key as SecurityRuleKey] : null;
}
