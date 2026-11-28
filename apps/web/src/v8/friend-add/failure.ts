import { extractApiErrorMessage } from '@/lib/api/transport/errors'

export type FriendAddFailureAction = 'load' | 'create' | 'delete' | 'retry'

/**
 * M006・M009〜M011: 友だち追加まわりの失敗を、状態に合った運用者の言葉にする。
 *
 * 共通部品（list-state・api-error-message・notice）は別レーンが直しているので
 * 触らず、画面側で HTTP の状態を見て文言を分ける。サーバが回復案内を返した
 * とき（400/409/422/428/429 の本文）はそれをそのまま出す。
 * 「通信を確認して」は通信が切れたときだけにし、権限不足・名前重複・
 * 対象なしでは出さない。
 *
 * `@/lib/api` は読まない。`status: number` を持つ失敗（ApiError の形）を
 * 形で見分けるので、api を丸ごと差し替える画面試験でも動く。
 */
export function describeFriendAddFailure(
  caught: unknown,
  target: string,
  action: FriendAddFailureAction,
): { status: number | null; message: string } {
  const verb = action === 'load' ? '表示' : action === 'create' ? '追加' : action === 'delete' ? '削除' : '再試行'
  const shape = caught && typeof caught === 'object' ? (caught as { status?: unknown; message?: unknown }) : null
  const status =
    typeof shape?.status === 'number' && Number.isInteger(shape.status) && shape.status >= 100 && shape.status <= 599
      ? shape.status
      : null
  const rawMessage = typeof caught === 'string' ? caught : typeof shape?.message === 'string' ? shape.message : ''
  const detail = extractApiErrorMessage(JSON.stringify({ error: rawMessage }), status ?? 400)
  const serverMessage = /[ぁ-んァ-ヶ一-龠]/u.test(detail) ? detail : ''
  if (status !== null) {
    // サーバの回復案内（利用者向けの本文）はそのまま出す。
    if (serverMessage) return { status, message: serverMessage }
    switch (status) {
      case 401:
        return { status, message: 'ログインの状態が切れています。ログインし直してから、もう一度お試しください。' }
      case 403:
        return {
          status,
          message: action === 'load'
            ? `${target}を見る権限がありません。オーナーか管理者に権限の追加を依頼してください。`
            : `${target}を${verb}する権限がありません。オーナーか管理者に依頼してください。`,
        }
      case 404:
        return {
          status,
          message: `${target}が見つかりません。削除されたか、別のLINEアカウントの記録です。一覧から選び直してください。`,
        }
      case 429:
        return { status, message: '短い時間に操作が集中しました。少し待ってから、もう一度お試しください。' }
      default:
        if (status >= 500) {
          return {
            status,
            message: `${target}を${verb}できませんでした。時間をおいて、もう一度お試しください。続く場合は管理者へ連絡してください。`,
          }
        }
        if (status === 409) {
          return {
            status,
            message: `${target}の状態が変わっています。最新の状態を読み直してから、もう一度お試しください。`,
          }
        }
        return { status, message: `${target}を${verb}できませんでした。もう一度お試しください。` }
    }
  }
  // fetchApi を通らない成功時失敗（success:false）の本文など、日本語の理由はそのまま出す。
  if (serverMessage && /[ぁ-んァ-ヶ一-龠]/.test(serverMessage)) {
    return { status: null, message: serverMessage }
  }
  return { status: null, message: `${target}を${verb}できませんでした。通信を確認して、もう一度お試しください。` }
}
