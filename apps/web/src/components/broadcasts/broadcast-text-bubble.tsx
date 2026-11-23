'use client'

/*
 * 一斉配信の「LINE の見え方」のテキストの吹き出し。
 * ★V8（絵 OVCot ②）：本物の LINE の吹き出し（LinePreviewMessage・文字に合わせて伸び縮み）。
 * 差し込みは見本の値（名前＝見本 141・配信日＝今日）で見せる。
 * テーマ指定にかかわらず、現役のLINEの吹き出しを描く。
 */
import type { BroadcastMessageButton } from '@/lib/api'
import { LinePreviewMessage } from '@/components/shared/line-preview'
import { buildTemplatePreview, EMPTY_TEMPLATE_REFERENCES } from '../templates/template-preview-model'

export default function BroadcastTextBubble({ text, buttons, accountName, time = '' }: {
  text: string
  buttons: BroadcastMessageButton[]
  accountName?: string
  time?: string
}) {

  const name = accountName || '公式アカウント'
  return (
    <div>
      <LinePreviewMessage accountName={name} avatar={name.slice(0, 1)} time={time}>
        {buildTemplatePreview(text, EMPTY_TEMPLATE_REFERENCES).content || 'テキストを入力すると表示されます'}
      </LinePreviewMessage>
      {buttons.map((button) => (
        <div key={`${button.label}-${button.value}`} className="bg-accent-deep text-on-accent mt-1 ml-10 truncate rounded-control px-3 py-2 text-center text-xs font-medium" title={button.value}>
          {button.label || 'ボタン'}
        </div>
      ))}
    </div>
  )
}
