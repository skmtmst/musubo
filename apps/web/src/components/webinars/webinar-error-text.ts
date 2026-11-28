import { ApiError, extractApiErrorCode } from '@/lib/api'

/**
 * ウェビナー画面に出す失敗文。`ApiError.message` は `invalid_slug` 等の
 * 素の英字コードのことがあり、利用者に意味が伝わらない。知っている
 * コードは日本語文に直し、知らないものは渡された予備文を出す。
 */
const WEBINAR_ERROR_TEXT: Record<string, string> = {
  title_required: 'タイトルを入力してください。',
  invalid_slug: 'URL用の名前が正しくありません。半角英数字と-だけ使えます。',
  slug_taken: 'そのURL用の名前は使われています。別の名前にしてください。',
  invalid_status: '状態の値が正しくありません。選び直してください。',
  invalid_duration: '動画の長さが正しくありません。',
  invalid_folder: 'フォルダを選び直してください。',
  invalid_publication_period: '公開期間が正しくありません。開始より終了を後にしてください。',
  invalid_schedule: '配信枠が正しくありません。日時を見直してください。',
  invalid_cta: 'ボタンの案内先が正しくありません。URLを見直してください。',
  invalid_url: 'URLが正しくありません。httpsから始めてください。',
  invalid_settings: '設定が正しくありません。入力を見直してください。',
  invalid_actions: 'アクションの設定が正しくありません。',
  invalid_comment: 'コメントの内容が正しくありません。',
  comments_required: 'コメントが必要です。',
  too_many_comments: 'コメントが多すぎます。少し待ってから試してください。',
  ctas_required: '案内ボタンのカードが必要です。',
  too_many_ctas: '案内ボタンのカードは20件までです。',
  form_id_required: 'フォームを選んでください。',
  form_not_found: '選んだフォームが見つかりません。',
  form_inactive: '選んだフォームは停止中です。',
  form_inactive_or_missing: 'フォームが無効か見つかりません。',
  form_account_mismatch: '別のアカウントのフォームは使えません。',
  invalid_delivery_kind: '配信方法が正しくありません。',
  account_id_required: 'LINE公式アカウントを選んでください。',
  version_conflict: '別の画面で更新されました。開き直してから試してください。',
  publish_via_publish_endpoint: '公開は確認ステップから行ってください。',
  publish_validation_failed: '公開前の確認で問題があります。表示された項目を直してください。',
  webinar_pause_required: '先にウェビナーを一時停止してください。',
  no_upcoming_session: 'これからの配信枠がありません。',
  not_found: '見つかりませんでした。開き直してください。',
  forbidden: '権限がありません。',
  unauthorized: 'ログインし直してください。',
}

export function webinarErrorText(error: unknown, fallback: string): string {
  const code = error instanceof ApiError
    ? error.code
    : extractApiErrorCode(error instanceof Error ? error.message : String(error))
  if (code && Object.prototype.hasOwnProperty.call(WEBINAR_ERROR_TEXT, code)) return WEBINAR_ERROR_TEXT[code]
  return fallback
}
