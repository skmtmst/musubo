'use client'

import Notice from '@/components/shared/notice'
import { questionChoiceLabelProblem } from './question-choice-label-validation'
import { FieldError } from '@/components/shared/form-controls'
import { useEffect, useId, useState } from 'react'
import { useAccount } from '@/contexts/account-context'
import Checkbox from '@/components/shared/checkbox'
import RadioCard, { RadioCardGroup } from '@/components/shared/radio-card'
import Select from '@/components/shared/select'
import { EntityKindField } from '@/components/shared/entity-picker-sources'
import { scenarioReferenceData } from './scenario-reference-data'
import Button from '@/components/shared/button'
import Disclosure from '@/components/shared/disclosure'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import { TextField, TextArea } from '@/components/shared/text-field'
import ActionList from '@/components/shared/action-list'
import { EntityPickerField } from '@/components/shared/entity-picker'
import EntitySelect, { entityOptionMetadata } from '@/components/shared/entity-select'

/*
 * 質問メッセージ（分岐）の編集。
 *
 * 選択肢ごとに「押されたら何が起きるか」を全部この場に置く。別画面に
 * 分けると、2つの選択肢の差（片方だけタグを付ける等）が見比べられない。
 *
 * 文字数の上限は LINE 側の都合。超えたぶんは途中で切れて相手に届くので、
 * 入力欄の上限と残り文字数で、送れる長さを案内する。
 */

export type ChoiceBehavior = 'none' | 'url' | 'tel' | 'add_friend' | 'mail' | 'form' | 'scenario'

export interface QuestionChoice {
  /*
   * R246: 選択肢とアクションを並びの位置ではなく識別子で結ぶための鍵。
   * 削除・追加で位置がずれても、残る選択肢の設定を保持できる。
   * 質問JSONの一部として保存する（サーバーは未知の項目を残す）。
   */
  key?: string
  label: string
  behavior: ChoiceBehavior
  url?: string
  tel?: string
  email?: string
  scenario?: { op: 'start' | 'stop'; scenarioId?: string | null; restart?: 'from_start' | 'from_read'; rememberPrevious?: boolean }
  userMessage?: string
  hideUserMessage?: boolean
  reply?: string
  repeatReply?: string
  scoreChange?: number | null
  addTagIds?: string[]
  removeTagIds?: string[]
  field?: { fieldId: string; value: string }
}

/** 選択肢の鍵を作る。衝突しないよう乱数で作る。 */
export function newChoiceKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `c-${crypto.randomUUID()}`
  }
  return `c-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffff).toString(36)}`
}

/*
 * R246: 鍵の無い選択肢（既存データ）に鍵を振る。ある鍵は変えない。
 * 通の編集を開くときと保存の直前に通し、編集中の差し替え・削除・追加を
 * 鍵で追えるようにする。
 */
export function withChoiceKeys(question: ScenarioQuestion): ScenarioQuestion {
  const seen = new Set<string>()
  const choices = question.choices.map((choice) => {
    let key = typeof choice.key === 'string' && choice.key ? choice.key : ''
    if (!key || seen.has(key)) key = newChoiceKey()
    seen.add(key)
    return key === choice.key ? choice : { ...choice, key }
  })
  return choices.every((choice, index) => choice === question.choices[index])
    ? question
    : { ...question, choices }
}

export interface ChoiceActionRow {
  id: string
  choiceIndex: number | null
}

export interface ChoiceActionRemap {
  /** 消えた選択肢にだけ紐づいていた動作。消す。 */
  removeIds: string[]
  /** 残る選択肢の動作。新しい位置へ付け替える。 */
  moveTo: { id: string; choiceIndex: number }[]
}

/*
 * R246: 質問の保存時に、選択肢別アクションの紐づけを付け替える段取り。
 * 鍵で old と new を突き合わせ、消えた鍵の行は消し、残る鍵の行は新しい
 * 位置へ移す。新しい選択肢には行が無い（0件から始める）。
 * 鍵が無い古い行は位置で突き合わせる（移行期の救済）。
 */
export function planChoiceActionRemap(
  oldChoices: Pick<QuestionChoice, 'key'>[],
  newChoices: Pick<QuestionChoice, 'key'>[],
  rows: ChoiceActionRow[],
): ChoiceActionRemap {
  const keyAt = (choices: Pick<QuestionChoice, 'key'>[], index: number) =>
    choices[index]?.key || `__index:${index}`
  const newIndexOf = new Map(newChoices.map((choice, index) => [choice.key || `__index:${index}`, index]))
  const removeIds: string[] = []
  const moveTo: { id: string; choiceIndex: number }[] = []
  for (const row of rows) {
    if (row.choiceIndex === null || row.choiceIndex === undefined) continue
    const newIndex = newIndexOf.get(keyAt(oldChoices, row.choiceIndex))
    if (newIndex === undefined) {
      removeIds.push(row.id)
    } else if (newIndex !== row.choiceIndex) {
      moveTo.push({ id: row.id, choiceIndex: newIndex })
    }
  }
  return { removeIds, moveTo }
}

export interface ScenarioQuestion {
  intro?: string
  text: string
  altText?: string
  tapMode: 'single' | 'multiple'
  choices: QuestionChoice[]
}

const BEHAVIORS: { value: ChoiceBehavior; label: string }[] = [
  { value: 'none', label: '何もしない' },
  { value: 'url', label: 'URLを開く' },
  { value: 'tel', label: '電話をかける' },
  { value: 'add_friend', label: 'LINEアカウントを友だち追加' },
  { value: 'mail', label: 'メールを送る' },
  { value: 'form', label: '回答フォームを開く' },
  { value: 'scenario', label: 'シナリオを移動・停止' },
]

export function emptyQuestion(): ScenarioQuestion {
  return {
    text: '',
    tapMode: 'single',
    choices: [
      { key: newChoiceKey(), label: 'はい', behavior: 'none' },
      { key: newChoiceKey(), label: 'いいえ', behavior: 'none' },
    ],
  }
}

/*
 * SCENARIO-22: LINE のボタンは動作を1つしか持てない。URL・電話・
 * メール・友だち追加・回答フォームは「開く」uri action になり、
 * 押された通知（postback）はこちらへ届かない。届かないと返信・タグ・
 * 友だち情報・選択肢アクションは動かせない。「何もしない」と
 * 「シナリオを移動・停止」は postback で届くので対象外。
 */
export const isUriOnlyBehavior = (behavior: ChoiceBehavior): boolean =>
  behavior === 'url' ||
  behavior === 'tel' ||
  behavior === 'mail' ||
  behavior === 'add_friend' ||
  behavior === 'form'

/**
 * URI だけの挙動では実行されない、いま設定済みの項目名を返す。
 * 保存済みデータを黙って消さないよう、何が残っているかを画面で示す。
 */
export function deadAnswerSettings(choice: QuestionChoice): string[] {
  const dead: string[] = []
  if (choice.reply?.trim()) dead.push('選択時の返信')
  if (choice.repeatReply?.trim()) dead.push('二度押し時の返信')
  if (choice.userMessage?.trim()) dead.push('ユーザーメッセージ')
  if ((choice.addTagIds?.length ?? 0) > 0 && (choice.behavior === 'tel' || choice.behavior === 'mail')) dead.push('追加するタグ')
  if (choice.scoreChange && (choice.behavior === 'tel' || choice.behavior === 'mail')) dead.push('足すスコア')
  if ((choice.removeTagIds?.length ?? 0) > 0) dead.push('はずすタグ')
  if (choice.field?.fieldId) dead.push('友だち情報欄')
  return dead
}

/*
 * R214: 選択後の挙動ごとの行き先の検査。URLを開く・友だち追加・
 * 回答フォームは https:// から始まるURL、電話は番号、
 * メールはメールアドレスでなければ、LINE側で開けない。
 * 検査せずに保存すると「設定済み」に見えて実際は開けない通になる。
 * 空のままも通さない（空だと押しても何も起きないボタンになる）。
 * 戻り値は最初に見つけた不備の文。なければ null。
 */
export function validateChoiceUris(question: ScenarioQuestion): string | null {
  for (const [i, choice] of question.choices.entries()) {
    const n = i + 1
    if (choice.behavior === 'url' || choice.behavior === 'add_friend' || choice.behavior === 'form') {
      const url = (choice.url ?? '').trim()
      if (!/^https?:\/\/\S+$/.test(url)) {
        return `選択肢${n}のURLが正しくありません。https:// から始まるURLを入力してください。`
      }
    } else if (choice.behavior === 'tel') {
      const tel = (choice.tel ?? '').trim()
      if (!/[0-9]/.test(tel) || !/^[0-9+\-() ]+$/.test(tel)) {
        return `選択肢${n}の電話番号が正しくありません。数字で入力してください。`
      }
    } else if (choice.behavior === 'mail') {
      const email = (choice.email ?? '').trim()
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return `選択肢${n}のメールアドレスが正しくありません。`
      }
    }
  }
  return null
}

/*
 * R248: 選択肢の差し替え。`undefined` の項目は消す（残さない）。
 * `setChoice` の部分マージ `{...今, ...差分}` では `delete` した属性が
 * 復活してしまい、「実行されない設定を消す」が効かなかった。
 */
export function mergeChoice(base: QuestionChoice, patch: Partial<QuestionChoice>): QuestionChoice {
  const next: QuestionChoice = { ...base, ...patch }
  for (const key of Object.keys(patch) as (keyof QuestionChoice)[]) {
    if (patch[key] === undefined) delete next[key]
  }
  return next
}

/*
 * URI だけの挙動では届かない、回答依存の設定をまとめて外す。
 * `undefined` を付けて返す（消してしまわない）。`setChoice` の部分マージでは
 * 無い項目が復活するため、`mergeChoice` が `undefined` を消す段取りにする。
 */
export function clearDeadAnswerSettings(choice: QuestionChoice): QuestionChoice {
  return {
    ...choice,
    reply: undefined,
    repeatReply: undefined,
    userMessage: undefined,
    addTagIds: choice.behavior === 'tel' || choice.behavior === 'mail' ? undefined : choice.addTagIds,
    scoreChange: choice.behavior === 'tel' || choice.behavior === 'mail' ? undefined : choice.scoreChange,
    removeTagIds: undefined,
    field: undefined,
  }
}

/** 上限に対する残りを出す。超えた時点で赤くする。 */
function CharCount({ value, max }: { value: string; max: number }) {
  const over = value.length > max
  return (
    <span className={`text-xs tabular-nums ${over ? 'text-danger font-medium' : 'text-ink-faint'}`}>
      {value.length}/{max}
    </span>
  )
}

export interface QuestionEditorProps {
  value: ScenarioQuestion
  onChange: (next: ScenarioQuestion) => void
  /** 選択肢ごとのアクション設定を開く。保存済みの通でだけ使える。 */
  onOpenChoiceActions?: (choiceIndex: number) => void
  /** 質問テンプレートのように、選択肢を横に見比べる画面。 */
  accountId?: string | null
  choiceOnly?: number
  choiceColumns?: boolean
}

export default function QuestionEditor({
  value,
  onChange,
  onOpenChoiceActions,
  choiceColumns = false,
  choiceOnly,
  accountId,
}: QuestionEditorProps) {
  const { selectedAccountId: contextAccountId } = useAccount()
  const selectedAccountId = accountId === undefined ? contextAccountId : accountId
  /* 見出しの文字と欄をつなぐための番号。同じ画面に複数置いても重ならない。 */
  const fieldBase = useId()
  const [referenceLoading, setReferenceLoading] = useState(true)
  const [referenceError, setReferenceError] = useState(false)
  const [referenceRetry, setReferenceRetry] = useState(0)
  const [tags, setTags] = useState<{ id: string; name: string }[]>([])
  const [fields, setFields] = useState<{ id: string; name: string }[]>([])
  const [scenarios, setScenarios] = useState<{ id: string; name: string }[]>([])
  const [openChoice, setOpenChoice] = useState<number | null>(0)

  useEffect(() => {
    let cancelled = false
    setTags([]); setFields([]); setScenarios([]); setReferenceError(false)
    setReferenceLoading(Boolean(selectedAccountId))
    if (!selectedAccountId) return
    void (async () => {
      try {
        const [tagRes, fieldRes, scenarioRes] = await Promise.all([
          scenarioReferenceData.tags(selectedAccountId),
          scenarioReferenceData.friendFields(selectedAccountId),
          scenarioReferenceData.scenarios(selectedAccountId),
        ])
        if (cancelled) return
        if (!tagRes.success || !fieldRes.success || !scenarioRes.success) throw new Error('候補を読み込めませんでした')
        if (tagRes.success) setTags(tagRes.data.map((t) => ({ id: t.id, name: t.name })))
        if (fieldRes.success) setFields(fieldRes.data.map((f) => ({ id: f.id, name: f.name })))
        if (scenarioRes.success) setScenarios(scenarioRes.data.map((s) => ({ id: s.id, name: s.name })))
      } catch { if (!cancelled) setReferenceError(true) }
      finally { if (!cancelled) setReferenceLoading(false) }
    })()
    return () => { cancelled = true }
  }, [selectedAccountId, referenceRetry])

  const setChoice = (index: number, patch: Partial<QuestionChoice>) => {
    const choices = [...value.choices]
    choices[index] = mergeChoice(choices[index], patch)
    onChange({ ...value, choices })
  }

  return (
    <div className="space-y-5">
      {referenceError && <p role="alert">候補を読み込めませんでした。<Button onClick={() => setReferenceRetry(value => value + 1)}>もう一度読み込む</Button></p>}
      {choiceOnly === undefined ? <>
      <div>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <label htmlFor={`${fieldBase}-intro`} className="text-ink-secondary text-xs font-medium">前文</label>
          <CharCount value={value.intro ?? ''} max={4500} />
        </div>
        <p className="text-ink-faint mt-0.5 mb-1.5 text-xs leading-relaxed">
          質問の前に、ふつうのテキストメッセージとして流れます。空なら送りません。名前などの差し込みが使えます。
        </p>
        <SaveErrorField names={["intro","value.intro"]}><TextArea
          id={`${fieldBase}-intro`}
          rows={3}
          value={value.intro ?? ''}
          onChange={(e) => onChange({ ...value, intro: e.target.value })}
        /></SaveErrorField>
      </div>

      <div>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <label htmlFor={`${fieldBase}-text`} className="text-ink-secondary text-xs font-medium">
            質問文 <span className="text-danger">*</span>
          </label>
          <CharCount value={value.text} max={160} />
        </div>
        <SaveErrorField names={["text","value.text"]}><TextField
          id={`${fieldBase}-text`}
          value={value.text}
          onChange={(e) => onChange({ ...value, text: e.target.value })}
          placeholder="例：体調はいかがですか？"
          className="mt-1.5"
        /></SaveErrorField>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor={`${fieldBase}-tapmode`} className="text-ink-secondary text-xs font-medium">質問の回答は</label>
        <SaveErrorField names={["tapMode","value.tapMode","tap_mode","value.tap_mode"]}><Select
          aria-label="質問の回答は"
          id={`${fieldBase}-tapmode`}
          value={value.tapMode}
          onChange={(next) => onChange({ ...value, tapMode: next as 'single' | 'multiple' })}
          options={[
            { value: 'single', label: '1つのみタップ可能' },
            { value: 'multiple', label: 'すべてタップ可能' },
          ]}
        /></SaveErrorField>
      </div>

      </> : null}
      <div className={choiceColumns && choiceOnly === undefined ? 'grid gap-3 xl:grid-cols-2' : 'space-y-3'}>
        {value.choices.map((choice, index) => {
          if (choiceOnly !== undefined && index !== choiceOnly) return null
          /*
           * SCENARIO-22: URI を開くだけの挙動では押された通知が届かない。
           * 届かないのに返信・タグ・アクションを設定できると、実行されると
           * 思って保存する人が出る。未設定なら欄を出さず、残っている設定は
           * 警告で名指しして、本人の操作でだけ消す。
           */
          const labelError = questionChoiceLabelProblem(choice.label)
          const labelErrorId = `${fieldBase}-choice-${index}-label-error`
          const uriOnly = isUriOnlyBehavior(choice.behavior)
          const dead = uriOnly ? deadAnswerSettings(choice) : []
          return (
          <div key={index} className="border-hairline rounded-card border">
            {choiceOnly === undefined ?
            <div className="border-hairline bg-canvas-sunken flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5">
              <button
                type="button"
                onClick={() => {
                  if (!choiceColumns) setOpenChoice(openChoice === index ? null : index)
                }}
                aria-expanded={choiceColumns || openChoice === index || Boolean(labelError)}
                className="text-ink flex min-w-0 flex-1 items-center text-left text-sm font-bold"
              >
                <span className="shrink-0 whitespace-nowrap">選択肢{index + 1}</span>
                <span className="text-ink-secondary ml-2 min-w-0 truncate font-medium" title={choice.label || undefined}>
                  {choice.label || '（未入力）'}
                </span>
              </button>
              <div className="flex shrink-0 items-center gap-1.5">
                {/*
                  URI だけの挙動では postback が届かず、ここで設定する
                  アクションも実行されない。出すと「動く」と誤解する
                  （SCENARIO-22）。
                */}
                {onOpenChoiceActions && !uriOnly && (
                  <Button variant="secondary" className="text-ink-secondary h-9 px-3 text-xs whitespace-normal" type="button" onClick={() => onOpenChoiceActions(index)}>
                    アクション
                  </Button>
                )}
                <Button variant="text" textTone="danger" size="inline" type="button"
                  onClick={() => onChange({ ...value, choices: value.choices.filter((_, i) => i !== index) })}
                  disabled={value.choices.length <= 1}>
                  削除する
                </Button>
              </div>
            </div> : null}

            {(choiceOnly !== undefined || choiceColumns || openChoice === index || labelError) && (
              <div className="space-y-4 px-4 py-4">
                {choiceOnly === undefined ? <>
                <div>
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <label htmlFor={`${fieldBase}-choice-${index}-label`} className="text-ink-secondary text-xs font-medium">
                      ボタンの文字 <span className="text-danger">*</span>
                    </label>
                    <CharCount value={choice.label} max={20} />
                  </div>
                  <SaveErrorField names={[`choices.${index}.label`,"label","choice.label"]}><TextField
                    id={`${fieldBase}-choice-${index}-label`}
                    maxLength={20}
                    aria-invalid={Boolean(labelError) || undefined}
                    aria-describedby={labelError ? labelErrorId : undefined}
                    value={choice.label}
                    onChange={(e) => { setOpenChoice(index); setChoice(index, { label: e.target.value }) }}
                    className="mt-1.5"
                  /></SaveErrorField>
                  <FieldError id={labelErrorId}>{labelError}</FieldError>
                  <p className="text-ink-faint mt-1 text-xs leading-relaxed">
                    10文字を超えると、機種によっては途中で切れて表示されます。
                  </p>
                </div>

                </> : null}
                <div className="flex flex-wrap items-center gap-2">
                  <label htmlFor={`${fieldBase}-choice-${index}-behavior`} className="text-ink-secondary text-xs font-medium">選択後の挙動</label>
                  <SaveErrorField names={[`choices.${index}.behavior`,"behavior","choice.behavior"]}><Select
                    size="full"
                    aria-label="選択後の挙動"
                    id={`${fieldBase}-choice-${index}-behavior`}
                    value={choice.behavior}
                    onChange={(next) => setChoice(index, { behavior: next as ChoiceBehavior })}
                    options={BEHAVIORS.map((b) => ({ value: b.value, label: b.label }))}
                  /></SaveErrorField>
                </div>

                {(choice.behavior === 'url' || choice.behavior === 'add_friend' || choice.behavior === 'form') && (
                  <SaveErrorField names={[`choices.${index}.url`,"url","choice.url"]}><TextField
                    value={choice.url ?? ''}
                    onChange={(e) => setChoice(index, { url: e.target.value })}
                    placeholder="https://…"
                    aria-label={`選択肢${index + 1}のURL`}
                  /></SaveErrorField>
                )}
                {choice.behavior === 'tel' && (
                  <SaveErrorField names={[`choices.${index}.tel`,"tel","choice.tel"]}><TextField
                    value={choice.tel ?? ''}
                    onChange={(e) => setChoice(index, { tel: e.target.value })}
                    placeholder="0312345678"
                    aria-label={`選択肢${index + 1}の電話番号`}
                  /></SaveErrorField>
                )}
                {choice.behavior === 'mail' && (
                  <SaveErrorField names={[`choices.${index}.email`,"email","choice.email"]}><TextField
                    value={choice.email ?? ''}
                    onChange={(e) => setChoice(index, { email: e.target.value })}
                    placeholder="info@example.com"
                    aria-label={`選択肢${index + 1}のメールアドレス`}
                  /></SaveErrorField>
                )}
                {choice.behavior === 'scenario' && (
                  <div className="bg-canvas-sunken rounded-card space-y-2 px-3 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <SaveErrorField names={["op","choice.scenario?.op","scenario?.op"]}><Select
                        aria-label={`選択肢${index + 1}のシナリオ操作`}
                        value={choice.scenario?.op ?? 'start'}
                        onChange={(next) =>
                          setChoice(index, {
                            scenario: { ...choice.scenario, op: next as 'start' | 'stop' },
                          })
                        }
                        options={[
                          { value: 'start', label: '購読を始める' },
                          { value: 'stop', label: '購読を止める' },
                        ]}
                      /></SaveErrorField>
                      <div className="min-w-0 flex-1">
                        <SaveErrorField names={["scenarioId","choice.scenario?.scenarioId","scenario?.scenarioId","choice"]}><EntityKindField
                          kind="scenario"
                          label={`選択肢${index + 1}の移動先シナリオ`}
                          value={choice.scenario?.scenarioId ?? ''}
                          clearable
                          placeholder={choice.scenario?.op === 'stop' ? '（このシナリオ）' : '（シナリオを選ぶ）'}
                          onChange={(next) =>
                            setChoice(index, {
                              scenario: {
                                op: choice.scenario?.op ?? 'start',
                                ...choice.scenario,
                                scenarioId: next,
                              },
                            })
                          }
                          options={scenarios}
                        /></SaveErrorField>
                      </div>
                    </div>
                    {(choice.scenario?.op ?? 'start') === 'start' && (
                      <>
                        <SaveErrorField names={["value","opt.value","restart","choice.scenario?.restart","scenario?.restart","choice"]}><RadioCardGroup legend="再開するときの続きかた" className="flex flex-wrap gap-2">
                        {(
                          [
                            { value: 'from_start', label: '最初から' },
                            { value: 'from_read', label: '（再開）友だちが読んだところから' },
                          ] as const
                        ).map((opt) => (
                          <RadioCard
                            key={opt.value}
                            name={`${fieldBase}-${choice.key ?? index}-restart`}
                            value={opt.value}
                            checked={(choice.scenario?.restart ?? 'from_start') === opt.value}
                            onChange={() =>
                              setChoice(index, {
                                scenario: {
                                  op: choice.scenario?.op ?? 'start',
                                  ...choice.scenario,
                                  restart: opt.value,
                                },
                              })
                            }
                            title={opt.label}
                          />
                        ))}
                      </RadioCardGroup></SaveErrorField>
                      <SaveErrorField names={["rememberPrevious","choice.scenario?.rememberPrevious","scenario?.rememberPrevious","remember_previous","choice.scenario?.remember_previous","scenario?.remember_previous"]}><Checkbox
                        checked={choice.scenario?.rememberPrevious === true}
                        onCheckedChange={(checked) =>
                          setChoice(index, {
                            scenario: {
                              op: choice.scenario?.op ?? 'start',
                              ...choice.scenario,
                              rememberPrevious: checked,
                            },
                          })
                        }
                      >いまのシナリオを控えて、あとで戻せるようにする</Checkbox></SaveErrorField>
                      </>
                    )}
                  </div>
                )}

                {uriOnly ? (
                  <Notice tone="warn">
                    <p className="text-xs leading-relaxed">
                      この挙動はLINE側でURLなどを開くだけで、押された通知は届きません。
                      「選択時の返信」「タグ」「友だち情報」「アクション」は実行されません。
                      押した記録や返信が要るときは「何もしない」にして、本文にURLを書いてください。
                    </p>
                    {dead.length > 0 ? (
                      <>
                        <p className="text-xs font-medium">
                          いま設定されている {dead.join('・')} は実行されません。
                        </p>
                        <Button
                          variant="text"
                          size="inline"
                          onClick={() => setChoice(index, clearDeadAnswerSettings(choice))}
                        >
                          実行されない設定を消す
                        </Button>
                      </>
                    ) : null}
                  </Notice>
                ) : (
                  <>
                {choiceOnly === undefined ? <>
                <div>
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <label htmlFor={`${fieldBase}-choice-${index}-reply`} className="text-ink-secondary text-xs font-medium">選択時の返信</label>
                    <CharCount value={choice.reply ?? ''} max={4500} />
                  </div>
                  <SaveErrorField names={[`choices.${index}.reply`,"reply","choice.reply"]}><TextArea
                    id={`${fieldBase}-choice-${index}-reply`}
                    rows={3}
                    value={choice.reply ?? ''}
                    onChange={(e) => setChoice(index, { reply: e.target.value })}
                    placeholder="「〇〇」ですね。わかりました！"
                    className="mt-1.5"
                  /></SaveErrorField>
                </div>

                </> : null}
                <Disclosure defaultOpen={choiceOnly !== undefined} size="compact" title="タグ・記録などの詳しい設定">
                  <div className="space-y-4">
                    <div>
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <label htmlFor={`${fieldBase}-choice-${index}-usermsg`} className="text-ink-secondary text-xs font-medium">ユーザーメッセージ</label>
                        <CharCount value={choice.userMessage ?? ''} max={60} />
                      </div>
                      <SaveErrorField names={[`choices.${index}.userMessage`,`choices.${index}.user_message`,"userMessage","choice.userMessage","user_message","choice.user_message"]}><TextField
                        id={`${fieldBase}-choice-${index}-usermsg`}
                        value={choice.userMessage ?? ''}
                        onChange={(e) => setChoice(index, { userMessage: e.target.value })}
                        placeholder={choice.label || '空欄なら選択肢の文字が使われます'}
                        disabled={choice.hideUserMessage === true}
                        title={choice.hideUserMessage ? 'ユーザーメッセージを使用しない設定です。使う場合はチェックを外してください。' : undefined}
                        className="mt-1.5"
                      /></SaveErrorField>
                      <p className="text-ink-faint mt-1 text-xs leading-relaxed">
                        ボタンを押したときに、友だちの発言としてトークに残る文です。
                      </p>
                      <SaveErrorField names={[`choices.${index}.hideUserMessage`,`choices.${index}.hide_user_message`,"hideUserMessage","choice.hideUserMessage","hide_user_message","choice.hide_user_message"]}><Checkbox
                        checked={choice.hideUserMessage === true}
                        onCheckedChange={(checked) => setChoice(index, { hideUserMessage: checked })}
                        className="mt-1.5"
                      >ユーザーメッセージを使用しない</Checkbox></SaveErrorField>
                    </div>

                    <div>
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <label htmlFor={`${fieldBase}-choice-${index}-repeat`} className="text-ink-secondary text-xs font-medium">二度押し時の返信</label>
                        <CharCount value={choice.repeatReply ?? ''} max={4500} />
                      </div>
                      <SaveErrorField names={[`choices.${index}.repeatReply`,`choices.${index}.repeat_reply`,"repeatReply","choice.repeatReply","repeat_reply","choice.repeat_reply"]}><TextArea
                        id={`${fieldBase}-choice-${index}-repeat`}
                        rows={3}
                        value={choice.repeatReply ?? ''}
                        onChange={(e) => setChoice(index, { repeatReply: e.target.value })}
                        placeholder="すでに押されています！"
                        className="mt-1.5"
                      /></SaveErrorField>
                      <p className="text-ink-faint mt-1 text-xs leading-relaxed">
                        空欄なら「すでに押されています！」を返します。2度目はタグもシナリオも動かしません。
                      </p>
                    </div>

                    <QuestionChoiceEffects choice={choice}
                      tags={tags} fields={fields} loading={referenceLoading}
                      onChange={patch => setChoice(index, patch)}
                    />
                  </div>
                </Disclosure>
                  </>
                )}
              </div>
            )}
          </div>
          )
        })}

        {choiceOnly === undefined ? <>

        <Button variant="secondary" className="text-ink-secondary rounded-card w-full px-0 border-dashed whitespace-normal" type="button" onClick={() =>
            onChange({
              ...value,
              choices: [...value.choices, { key: newChoiceKey(), label: '', behavior: 'none' }],
            })
          } disabled={value.choices.length >= 13}>
          ＋ 選択肢を追加
        </Button>
      </> : null}

      </div>

      {choiceOnly === undefined ? <>

      <div>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <label htmlFor={`${fieldBase}-alttext`} className="text-ink-secondary text-xs font-medium">PC版・通知欄での代替テキスト</label>
          <CharCount value={value.altText ?? ''} max={400} />
        </div>
        <SaveErrorField names={["altText","value.altText","alt_text","value.alt_text"]}><TextField
          id={`${fieldBase}-alttext`}
          value={value.altText ?? ''}
          onChange={(e) => onChange({ ...value, altText: e.target.value })}
          placeholder="空欄なら質問文が使われます"
          className="mt-1.5"
        /></SaveErrorField>
      </div>
    </> : null}

    </div>
  )
}

/** 質問の保存値（付与／解除タグ・情報欄）は固定の順。保存できない並べ替えは出さない。 */

function QuestionChoiceEffects({ choice,
  tags, fields, loading,
  onChange
}: { choice: QuestionChoice;
  tags: { id: string; name: string }[]; fields: { id: string; name: string }[]; loading: boolean;
  onChange: (patch: Partial<QuestionChoice>) => void
}) {
  type Effect = { kind: string; ids: string[]; value?: string }
  const value: Effect[] = [
    ...(choice.addTagIds?.length ? [{ kind: 'add', ids: choice.addTagIds }] : []),
    ...(choice.removeTagIds?.length ? [{ kind: 'remove', ids: choice.removeTagIds }] : []),
    ...(choice.field?.fieldId ? [{ kind: 'field', ids: [choice.field.fieldId], value: choice.field.value }] : []),
  ]
  return <ActionList<Effect> value={value} idOf={item => item.kind} reorderable={false}
    kindOf={item => item.kind === 'field' ? '友だち情報に書く' : item.kind === 'add' ? 'タグを付ける' : 'タグを外す'}
    titleOf={item => item.ids.map(id => (item.kind === 'field' ? fields: tags).find(row => row.id === id)?.name ?? '設定済みの項目').join ('・')}
            onChange={next => onChange({ addTagIds: next.find(item => item.kind === 'add')?.ids ?? [], removeTagIds: next.find(item => item.kind === 'remove')?.ids ?? [], field: next.find(item => item.kind === 'field') ? { fieldId: next.find(item => item.kind === 'field')!.ids[0], value: next.find(item => item.kind === 'field')!.value ?? '' } : undefined })}
    choices={[{ id: 'add', label: 'タグを付ける' }, { id: 'remove', label: 'タグを外す' }, { id: 'field', label: '友だち情報に書く' }].filter(kind => !value.some(item => item.kind === kind.id)).map(kind => ({ ...kind, disabled: loading, disabledReason: '候補を読み込んでいます', make: () => ({ kind: kind.id, ids: [], value: '' }), picker: {
      title: kind.id === 'field' ? '友だち情報欄を選ぶ' : 'タグを選ぶ', items: kind.id === 'field' ? fields : tags, multiple: kind.id !== 'field', apply: (item, ids) => ({ ...item, ids }),
    } }))}
    renderEditor={(item, update) => <>
      {item.kind === 'field' ? <EntityPickerField label="友だち情報欄" noun="友だち情報欄" items={fields} value={item.ids[0]} onChange={id => update({ ...item, ids : [id] })} />
        : <EntityPickerField label="タグ" noun="タグ" items={tags} multiple value={item.ids} onChange={ids => update({ ...item, ids })} />}
      {item.kind === 'field' ? <TextField aria-label="友だち情報欄に書き込む値" value={item.value ?? ''} onChange={event => update({ ...item, value: event.target.value })} /> : null}</>}/>
}
