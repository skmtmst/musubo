import { clearPrefetchedReads } from './api/transport/prefetch'
import { clearReportedServerFailures } from './api/transport/request'
import { clearFeatureSettingsCache } from './feature-settings-cache'
import { clearFeatureVisibilityCache } from './feature-visibility-cache'
import { clearLineAccountsCache } from './line-accounts-cache'
import { clearOperatorsCache } from './operators-cache'

/*
 * タブ内で使い回している共通の答えを、まとめて捨てる口。
 *
 * 呼ぶのは2か所だけ:
 * - ログアウト（lib/logout.ts）
 * - セッション切れ・別タブでの認証情報の書き換え（AuthGuard の invalidate）
 *
 * 古い権限や別アカウントのデータを残さない。版番号（公開情報）は
 * 捨てない（誰が見ても同じで、捨てると余計に取り直す）。
 */
export function clearCommonCaches(): void {
  clearPrefetchedReads()
  clearReportedServerFailures()
  clearFeatureSettingsCache()
  clearFeatureVisibilityCache()
  clearLineAccountsCache()
  clearOperatorsCache()
}
