/** 本送信はWorkerの検証環境・設定・テスト宛先の確認を必ず通す。 */
export function broadcastAbSendProblem(enabled: boolean, count: number | null): string | null {
  if (!enabled) return null
  if (count === null || !Number.isFinite(count) || count < 1) return '送る相手の人数を確認してください。'
  return null
}
