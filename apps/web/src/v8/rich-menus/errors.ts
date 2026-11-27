/*
 * リッチメニュー一覧の、失敗を運用者向けの文へ置き換える共有の関数。
 * 一覧・詳細の失敗を同じ文で案内する。
 */
import { ApiError } from '@/lib/api'

/** 部分的な取り下げ失敗は、内部のIDや英語を出さず種類ごとにまとめる。 */
export function unpublishWarningText(warning: string): string {
  if (warning.startsWith('delete alias ')) return '切り替え設定の一部を取り下げきれていません'
  if (warning.startsWith('delete richmenu ')) return 'メニュー本体の一部を取り下げきれていません'
  if (warning.startsWith('default lookup/clear')) return '標準表示の解除を確認できませんでした'
  return '一部を取り下げきれていません'
}

export type RichMenuAction = 'load' | 'reorder' | 'delete' | 'unpublish' | 'externalDelete' | 'import' | 'externalLoad'

/** APIや通信の内部表現を、運用者が次の行動を選べる文へ置き換える。 */
export type RichMenuActionAll = RichMenuAction | 'duplicate'

/** APIや通信の内部表現を、運用者が次の行動を選べる文へ置き換える。 */
export function richMenuErrorAll(error: unknown, action: RichMenuActionAll): string {
  if (action === 'duplicate') {
    if (error instanceof ApiError) {
      if (error.status === 403) return 'このLINEアカウントのリッチメニューを操作する権限がありません。'
      if (error.status === 404) return '対象のリッチメニューが見つかりません。一覧を読み直してください。'
      if (error.status === 409) {
        return '複製がほかの操作と重なりました。一覧を読み直してから、もう一度お試しください。'
      }
      if (error.status === 429) return 'LINEへの操作が混み合っています。少し待ってから、もう一度お試しください。'
    }
    return 'リッチメニューを複製できませんでした。もう一度お試しください。'
  }
  return richMenuError(error, action)
}

export function richMenuError(error: unknown, action: RichMenuAction): string {
  if (action === 'externalLoad') {
    if (error instanceof ApiError) {
      if (error.code === 'INVALID_LINE_ACCESS_TOKEN') return 'LINE連携の認証情報を確認できません。連携の設定を確認してください。'
      if (error.code === 'LINE_RATE_LIMITED') return 'LINEへの問い合わせが集中しています。少し待ってから、もう一度読み込んでください。'
      if (error.status === 429) return '管理画面への操作が集中しています。少し待ってから、もう一度読み込んでください。'
      if (error.status === 403) return 'このLINEアカウントのメニューを見る権限がありません。オーナーか管理者に頼んでください。'
    }
    return 'LINE上のメニューを読み込めませんでした。LINE公式アカウントの連携状態を確認し、もう一度読み込んでください。'
  }
  if (error instanceof ApiError) {
    if (error.status === 403) return 'このLINEアカウントのリッチメニューを操作する権限がありません。'
    if (error.status === 404) return '対象のリッチメニューが見つかりません。一覧を読み直してください。'
    if (error.status === 409) {
      return action === 'delete' || action === 'externalDelete'
        ? '使用中のため削除できませんでした。表示先を確認してから、もう一度お試しください。'
        : 'ほかの変更と重なりました。一覧を読み直してから、もう一度お試しください。'
    }
    if (error.status === 429) return 'LINEへの操作が混み合っています。少し待ってから、もう一度お試しください。'
  }

  switch (action) {
    case 'load':
      return 'リッチメニューを読み込めませんでした。通信状態を確認して、もう一度読み込んでください。'
    case 'reorder':
      return 'リッチメニューの順番を変更できませんでした。一覧を読み直してから、もう一度お試しください。'
    case 'delete':
      return 'リッチメニューを削除できませんでした。状態を確認して、もう一度お試しください。'
    case 'unpublish':
      return 'リッチメニューをLINEから取り下げられませんでした。状態を確認して、もう一度お試しください。'
    case 'externalDelete':
      return 'LINE上のリッチメニューを削除できませんでした。LINEの状態を確認して、もう一度お試しください。'
    case 'import':
      return 'LINE上のリッチメニューを取り込めませんでした。LINEの状態を確認して、もう一度お試しください。'
  }
}
