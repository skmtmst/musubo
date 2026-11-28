import type { Webinar, WebinarEditor } from '@/lib/api'
import { formatNumber } from '@/lib/format'

/** 保存済みの値だけを要約し、未取得を完了した設定へ見せかけない。 */
export function webinarStepSummaries(webinar: Webinar, editor: WebinarEditor, ctaCount: number) {
  const count = Number.isSafeInteger(ctaCount) && ctaCount >= 0 ? `${formatNumber(ctaCount)}件` : '—'
  const messages: unknown = editor.notificationMessages
  const validMessages = !!messages && typeof messages === 'object' && !Array.isArray(messages) && Object.values(messages).every(value => typeof value === 'string')
  const notifications = validMessages ? `通知文 ${Object.values(messages).filter(value => (value as string).trim()).length}種類` : '通知文を確認できません'
  return {
    basic: webinar.title,
    video: `${webinar.videoPrefix || webinar.videoMediaId ? '動画あり' : '動画未設定'}・配信枠 ${formatNumber(webinar.schedule.length)}件`,
    cta: `案内ボタン ${count}・${editor.publicPage.form?.name ?? '申込フォーム未設定'}`,
    notifications,
  }
}
