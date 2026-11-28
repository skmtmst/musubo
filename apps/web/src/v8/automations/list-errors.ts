import { ApiError } from '@/lib/api'

/** 旧一覧の編集失敗の案内を現役で共用する。 */
export function describeAutomationEditFailure(caught: unknown): string {
  if (caught instanceof ApiError && Number.isInteger(caught.status) && caught.status >= 100 && caught.status <= 599) {
    switch (caught.status) {
      case 401: return 'ログインの状態が切れています。ログインし直してから、もう一度お試しください。'
      case 403: return 'このルールを編集する権限がありません。選んでいるアカウントと権限を確認してください。'
      case 404: return 'ルールが見つかりませんでした。削除されたか、別のLINEアカウントのルールです。一覧を読み直しました。'
      case 409: return 'ほかの人の変更と重なりました。一覧を読み直してから、もう一度お試しください。'
      case 429: return '短い時間に操作が集中しました。少し待ってから、もう一度お試しください。'
      default: return caught.status >= 500
        ? 'サーバー側で編集用の下書きを作れませんでした。時間をおいて、もう一度お試しください。'
        : '編集用の下書きを作れませんでした。もう一度お試しください。'
    }
  }
  return '編集用の下書きを作れませんでした。通信状態を確かめて、もう一度お試しください。'
}
