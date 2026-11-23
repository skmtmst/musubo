/**
 * 機能設定を保存したときの合図の名前。
 *
 * feature-settings.ts はメニュー定義（アイコンの図形を含む）を読み込むので、
 * 合図の名前を取り出すためにそこを import すると、メニューごと各画面に乗る。
 * 表示可否の共有（feature-visibility-cache）はここから読む（V6R-S0-b）。
 */
export const FEATURE_SETTINGS_UPDATED_EVENT = 'line-harness:feature-settings-updated'

export type FeatureSettingsUpdate = { accountId: string; source?: 'account-style' }
