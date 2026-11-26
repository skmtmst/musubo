'use client'

import CloseButton from '@/components/shared/close-button'
import type { EventQuestion } from '@/lib/api'
import Button from '@/components/shared/button'
import Checkbox from '@/components/shared/checkbox'
import Select from '@/components/shared/select'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import { TextField as SharedTextField } from '@/components/shared/text-field'

const TYPE_LABELS: Record<EventQuestion['type'], string> = {
  text: '1行テキスト',
  textarea: '複数行テキスト',
  radio: '単一選択',
  checkbox: '複数選択',
}

const NEEDS_OPTIONS = new Set<EventQuestion['type']>(['radio', 'checkbox'])
export const EVENT_QUESTIONS_MAX = 10

/** 質問のid。過去の回答と紐付けるため、編集で変わらないよう付けたら保持する。 */
function newQuestionId(questions: EventQuestion[]): string {
  let n = questions.length + 1
  const used = new Set(questions.map((q) => q.id))
  while (used.has(`q${n}`)) n += 1
  return `q${n}`
}

/** Worker の questions_json 文字列をフォームの配列に戻す。壊れていたら空。 */
export function parseEventQuestions(raw: string | EventQuestion[] | null | undefined): EventQuestion[] {
  if (!raw) return []
  if (Array.isArray(raw)) return raw
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/**
 * イベント申込のカスタム質問を並べる編集欄 (#841)。
 * 申込のたびに友だちへ聞く質問を、イベントごとに最大10件まで定義する。
 */
export default function EventQuestionsEditor({
  questions,
  onChange,
}: {
  questions: EventQuestion[]
  onChange: (next: EventQuestion[]) => void
}) {
  function setAt(index: number, patch: Partial<EventQuestion>) {
    onChange(questions.map((q, i) => (i === index ? { ...q, ...patch } : q)))
  }

  return (
    <div className="space-y-3">
      {questions.length === 0 && (
        <p className="text-ink-faint text-xs">
          質問はまだありません。申込のたびに聞きたいことがあれば追加してください。
        </p>
      )}
      {questions.map((q, index) => (
        <div key={q.id} className="border-hairline rounded-control space-y-2 border p-3">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <label htmlFor={`eq-label-${q.id}`} className="sr-only">
                質問{index + 1}の文面
              </label>
              <SaveErrorField names={[`questions.${index}.label`,"label","q.label","at"]}><SharedTextField
                id={`eq-label-${q.id}`}
                value={q.label}
                onChange={(e) => setAt(index, { label: e.target.value })}
                maxLength={100}
                placeholder={`質問${index + 1}（例：アレルギーはありますか）`}
                className="border-hairline rounded-control w-full border px-3 py-2 text-sm"
              /></SaveErrorField>
            </div>
            <Button
              variant="text" textTone="danger"
              size="field"
              onClick={() => onChange(questions.filter((_, i) => i !== index))}
            >
              削除する
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <label htmlFor={`eq-type-${q.id}`} className="text-ink-faint text-xs">
              回答の形
            </label>
            <SaveErrorField names={[`questions.${index}.type`,"type","q.type","at"]}><Select
              aria-label="回答の形"
              id={`eq-type-${q.id}`}
              value={q.type}
              onChange={(value) => {
                const type = value as EventQuestion['type']
                setAt(index, { type, options: NEEDS_OPTIONS.has(type) ? (q.options ?? ['']) : null })
              }}
              options={(Object.keys(TYPE_LABELS) as EventQuestion['type'][]).map((t) => ({
                value: t,
                label: TYPE_LABELS[t],
              }))}
            /></SaveErrorField>
            <SaveErrorField names={[`questions.${index}.required`,"required","q.required","at"]}><Checkbox
              checked={q.required}
              onCheckedChange={(checked) => setAt(index, { required: checked })}
            >必須にする</Checkbox></SaveErrorField>
          </div>
          {NEEDS_OPTIONS.has(q.type) && (
            <div className="space-y-1.5">
              {(q.options ?? []).map((opt, oi) => (
                <div key={oi} className="flex items-center gap-2">
                  <label htmlFor={`eq-opt-${q.id}-${oi}`} className="sr-only">
                    選択肢{oi + 1}
                  </label>
                  <SaveErrorField names={["opt","at"]}><SharedTextField
                    id={`eq-opt-${q.id}-${oi}`}
                    value={opt}
                    onChange={(e) =>
                      setAt(index, {
                        options: (q.options ?? []).map((o, i) => (i === oi ? e.target.value : o)),
                      })
                    }
                    maxLength={100}
                    placeholder={`選択肢${oi + 1}`}
                    className="border-hairline rounded-control flex-1 border px-3 py-1.5 text-sm"
                  /></SaveErrorField>
                  <CloseButton aria-label={`選択肢${oi + 1}を削除`} onClick={() =>
                      setAt(index, { options: (q.options ?? []).filter((_, i) => i !== oi) })
                    } />
                </div>
              ))}
              <button
                type="button"
                onClick={() => setAt(index, { options: [...(q.options ?? []), ''] })}
                className="text-action text-xs font-medium hover:underline"
              >
                選択肢を追加する
              </button>
            </div>
          )}
        </div>
      ))}
      {questions.length < EVENT_QUESTIONS_MAX && (
        <Button
          variant="secondary"
          className="w-full"
          onClick={() =>
            onChange([
              ...questions,
              { id: newQuestionId(questions), label: '', type: 'text', required: false, options: null },
            ])
          }
        >
          質問を追加する
        </Button>
      )}
    </div>
  )
}
