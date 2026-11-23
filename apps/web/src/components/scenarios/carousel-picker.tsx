'use client'

import { useEffect, useRef, useState } from 'react'
import TextLink from '@/components/shared/text-link'
import Select from '@/components/shared/select'
import { scenarioReferenceData } from './scenario-reference-data'
import Button from '@/components/shared/button'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import EntitySelect, { entityOptionMetadata } from '@/components/shared/entity-select'


/*
 * カルーセルを選ぶ。
 *
 * この画面では作らない。テンプレート側に作成画面（/templates/carousel）が
 * あるので、そこで作ったものから選ぶ。同じ編集画面を2つ持つと、片方だけ
 * 直して食い違う。10枚のパネルとボタンを組み立てる画面なので、なおさら。
 *
 * 1枚も無いときに選択欄だけ出しても進めないので、作りに行く導線を出す。
 */

interface SendableTemplateCandidate {
  accountId?: string | null
  publishedVersion?: number | null
  publishedAt?: string | null
}

/** 公開済みかつ選択中アカウントの候補だけを、元の順番で返す。 */
export function filterSendableTemplates<T extends SendableTemplateCandidate>(
  templates: T[],
  selectedAccountId?: string | null,
): T[] {
  return templates.filter((template) => {
    if (template.publishedAt === null || template.publishedVersion === 0) return false
    return !selectedAccountId
      || template.accountId === selectedAccountId
  })
}

/** 遅れて返った古い読み込み結果を描画しないための世代番号。 */
export function createLoadGeneration() {
  let current = 0
  return {
    next: () => {
      current += 1
      return current
    },
    isCurrent: (generation: number) => generation === current,
  }
}

export interface CarouselTemplate {
  id: string
  name: string
  /** パネルの枚数。選ぶときの目印。 */
  panels: number
  /** 1枚目の題。同じ名前が並んだときの手がかり。 */
  firstTitle: string
  /**
   * 中身そのもの。
   *
   * 通の控え（message_content）に入れる。テンプレートを消したときは
   * これが使われるので、枚数などの要約ではなく**実物**でないといけない。
   */
  messageContent: string
}

export interface CarouselPickerProps {
  /** 選んでいるテンプレートID。 */
  value: string
  onChange: (templateId: string, template: CarouselTemplate | null) => void
  /** 選んでいるLINEアカウント。渡すとその持ち主の公開版だけを候補にする。 */
  accountId?: string | null
}

/** テンプレートの中身から、枚数と1枚目の題を読む。 */
function summarize(content: string): { panels: number; firstTitle: string } {
  try {
    const parsed = JSON.parse(content) as unknown
    if (!Array.isArray(parsed)) return { panels: 0, firstTitle: '' }
    const first = parsed[0] as { title?: unknown; text?: unknown } | undefined
    const title =
      typeof first?.title === 'string' && first.title
        ? first.title
        : typeof first?.text === 'string'
          ? first.text
          : ''
    return { panels: parsed.length, firstTitle: title }
  } catch {
    return { panels: 0, firstTitle: '' }
  }
}

export default function CarouselPicker({ value, onChange, accountId }: CarouselPickerProps) {
  const [items, setItems] = useState<CarouselTemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [retry, setRetry] = useState(0)
  const generationRef = useRef(createLoadGeneration())

  useEffect(() => {
    // 独立審査(指摘4): 持ち主の公開版だけを候補にし、古い応答は世代で捨てる。
    const generation = generationRef.current.next()
    setLoading(true)
    setItems([])
    setError(false)
    void scenarioReferenceData.templates(accountId ?? undefined).then((res) => {
      if (!generationRef.current.isCurrent(generation)) return
      if (!res.success) { setError(true); return }
      if (res.success) {
        setItems(
          filterSendableTemplates(res.data, accountId)
            .filter((t) => t.messageType === 'carousel')
            .map((t) => ({
              id: t.id,
              name: t.name,
              messageContent: t.messageContent,
              ...summarize(t.messageContent),
            })),
        )
      }
    }).catch(() => { if (generationRef.current.isCurrent(generation)) setError(true) }).finally(() => { if (generationRef.current.isCurrent(generation)) setLoading(false) })
    return () => { generationRef.current.next() }
  }, [accountId, retry])

  if (loading) {
    return <p className="text-ink-faint py-6 text-center text-sm">読み込み中…</p>
  }

  if (error) return <div className="text-body" role="alert">カルーセルを読み込めませんでした。<Button onClick={() => setRetry(value => value + 1)}>もう一度読み込む</Button></div>

  if (items.length === 0) {
    return (
      <div className="border-hairline rounded-card border border-dashed px-4 py-6 text-center">
        <p className="text-ink text-sm font-bold">カルーセルがまだありません</p>
        <p className="text-ink-secondary mt-1 text-xs leading-relaxed">
          パネルを並べて作る画面が別にあります。そこで作ると、ここから選べるようになります。
        </p>
        <Button variant="secondary" className="text-ink-secondary mt-3 items-center px-4 whitespace-normal" href="/templates/carousel">
          カルーセルを作りに行く
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <label className="block">
        <span className="text-ink-secondary mb-1 block text-xs font-medium">
          カルーセル <span className="text-danger">*</span>
        </span>
        <SaveErrorField names={["value"]}><EntitySelect
          value={value}
          onChange={(next) => {
            const picked = items.find((t) => t.id === next) ?? null
            onChange(next, picked)
          }}
          aria-label="カルーセル"
          options={[
            { value: '', label: '選んでください' },
            ...items.map((t) => ({ ...entityOptionMetadata(t),
              value: t.id,
              label: `${t.name}（${t.panels}枚${t.firstTitle ? `／${t.firstTitle}` : ''}）`,
            })),
          ]}
          size="full"
        /></SaveErrorField>
      </label>
      <p className="text-ink-faint text-xs leading-relaxed">
        カルーセルを直すと、この通の中身も一緒に変わります。
      </p>
      <TextLink href="/templates/carousel">
        新しいカルーセルを作る
      </TextLink>
    </div>
  )
}
