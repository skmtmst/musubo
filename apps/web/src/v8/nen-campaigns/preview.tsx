'use client'

import type { NenColumn } from '@/lib/api'
import LinePreview, { LinePreviewFlex, LinePreviewMessage } from '@/components/shared/line-preview'

export const COLUMN_PET_NAME_FALLBACK = '大切なご家族'
export const replaceColumnSamples = (value: string) => value.replaceAll('{{pet_name}}', COLUMN_PET_NAME_FALLBACK)

export function replaceCampaignSamples(value: string): string {
  return Object.entries({ '{{pet_name}}': 'むぎちゃん', '{{coupon_code}}': 'NENBDAY-1234', '{{coupon_expiry}}': '2026-09-30' })
    .reduce((result, [from, to]) => result.replaceAll(from, to), value)
}

const SAFE_HTTP_URL = /^https?:\/\//i

/** 旧一覧の紹介文→記事カードの見本を、共通のLINE表示へ引き継ぐ。送信はしない。 */
export function ColumnPreviewCard({ column, buttonLabel }: { column: Pick<NenColumn, 'imageUrl' | 'category' | 'title' | 'excerpt' | 'articleUrl'>; buttonLabel: string }) {
  const imageUrl = column.imageUrl?.trim() ?? ''
  const category = column.category?.trim() ?? ''
  const title = column.title.trim() || '（題名がまだありません）'
  const excerpt = column.excerpt?.trim() ?? ''
  const label = buttonLabel.trim()
  const articleUrl = column.articleUrl.trim()
  const hasSafeImage = SAFE_HTTP_URL.test(imageUrl)
  const hasSafeButton = Boolean(label) && SAFE_HTTP_URL.test(articleUrl)
  const content = JSON.stringify({
    type: 'bubble',
    ...(hasSafeImage ? { hero: { type: 'image', url: imageUrl, size: 'full', aspectRatio: '16:9', aspectMode: 'cover' } } : {}),
    body: { type: 'box', layout: 'vertical', contents: [
      ...(category ? [{ type: 'text', text: category, size: 'sm', wrap: true }] : []),
      { type: 'text', text: title, weight: 'bold', wrap: true },
      ...(excerpt ? [{ type: 'text', text: replaceColumnSamples(excerpt), wrap: true }] : []),
    ] },
    ...(hasSafeButton ? { footer: { type: 'box', layout: 'vertical', contents: [{ type: 'button', action: { type: 'uri', label, uri: articleUrl } }] } } : {}),
  })
  return <LinePreviewFlex content={content} />
}

export default function ColumnPreview({ column, introText, buttonLabel }: { column: NenColumn; introText: string; buttonLabel: string }) {
  return <LinePreview fit>
    {introText.trim() ? <LinePreviewMessage accountName="NEN" avatar={null} time="">{replaceColumnSamples(introText)}</LinePreviewMessage> : null}
    <ColumnPreviewCard column={column} buttonLabel={buttonLabel} />
  </LinePreview>
}
