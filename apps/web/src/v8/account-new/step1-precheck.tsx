import { Check, CircleHelp } from 'lucide-react'
import Button from '@/components/shared/button'
import Card from '@/components/shared/card'
import Checkbox from '@/components/shared/checkbox'
import Notice, { NoticeDetailAction } from '@/components/shared/notice'
import RadioCard, { RadioCardGroup } from '@/components/shared/radio-card'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import { CreateStepColumns } from '@/components/templates/create-step-columns'
import {
  PRECHECK_CHOICES, PRECHECK_HELPS, PRECHECK_RESULT, PRECHECK_TITLES,
  type PrecheckAnswers, type PrecheckAt, type PrecheckKey,
  type PrecheckNote, type PrecheckSummaryRow,
} from './precheck'
import styles from './register.module.css'

/*
 * ★LINE新規追加_v07.pen（2026-10-18承認）①事前確認 p6zMkA の描画だけ。
 * register.tsx が行数の関所（apps/web/scripts/v8-guard/code-size.mjs）を越えたので
 * 切り出した。状態は持たず、register.tsx から受け取って出すだけ（見た目は変えていない）。
 */
export default function Step1Precheck({
  badge, draftRestored, onCloseDraftNotice,
  precheckAt, onJumpTo, precheck, onAnswer,
  rows, guide, acks, onToggleAck,
}: {
  /** 「Q2 / 全5問」などの札。 */
  badge: string
  draftRestored: boolean
  onCloseDraftNotice: () => void
  precheckAt: PrecheckAt
  /** 済んだ質問の「変更」を押したとき、その質問へ戻る。 */
  onJumpTo: (key: PrecheckKey) => void
  precheck: PrecheckAnswers
  onAnswer: (key: PrecheckKey, value: string) => void
  rows: PrecheckSummaryRow[]
  guide: PrecheckNote | null
  acks: Record<string, boolean>
  onToggleAck: (key: string, next: boolean) => void
}) {
  const ack = guide?.ack ?? null
  return (
    <CreateStepColumns data-design-node="p6zMkA" previewTitle="この5段でやること" preview={(
        <Card className={styles.aside} layout="vertical" surface="muted" contentPadding="var(--tpl-htn-aside-pad)" gap="var(--tpl-htn-aside-gap)" aria-label="この5段でやること">
        <h2 className={styles.asideH2}>この5段でやること</h2>
        <p className={styles.asideP}>① 事前確認：ご利用環境のかんたんな確認</p>
        <p className={styles.asideP}>② アカウント接続：4つのステップで1つずつ（LINE の管理画面の値を入れる）</p>
        <p className={styles.asideP}>③ 接続確認：確認がすべて通るまで登録しない</p>
        <p className={styles.asideP}>④ 使い方を選ぶ：お店に合う使い方を選ぶ（あとから変えられる）</p>
        <p className={styles.asideP}>⑤ 完了：友だちを引き継ぎ、選んだ使い方で始める</p>
      </Card>
      )}>
      <Card surface="standard" layout="vertical" contentPadding="var(--tpl-htn-panel-pad)" gap="var(--tpl-htn-panel-gap)" className={styles.panel} aria-label="ご利用環境の確認">
        {draftRestored && (
          <Notice tone="info" message="保存した入力があります。事前確認から始めます。チャネルシークレットは入れ直してください。" onClose={onCloseDraftNotice} />
        )}
        {/* カードの頭は 題・？・のび・札 の順（v07 B2SpuV）。 */}
        <div className={styles.precheckHead}>
          <h2 data-step-heading={precheckAt === 'done' ? '' : undefined} tabIndex={-1} className={styles.panelTitle}>ご利用環境の確認</h2>
          <span className={styles.precheckHelpMark} title="答えに合わせて、このあとの手順が変わります。" aria-label="答えに合わせて、このあとの手順が変わります。"><CircleHelp size={16} aria-hidden="true" /></span>
          <p className={styles.subBadge}>{badge}</p>
        </div>
        <p className={styles.precheckLead}>{precheckAt === 'done'
          ? '確認が終わりました。答えに合わせて、接続の進め方をまとめました。'
          : 'いくつかの質問に答えてください。答えに合わせて、このあとの手順をご案内します。'}</p>
        {rows.length > 0 && (
          <div className={styles.precheckSummary}>
            {rows.map((row) => (
              <div key={row.key} className={styles.precheckSummaryRow}>
                <p className={styles.precheckSummaryText}>{row.label}　→　{row.value}</p>
                <Button variant="text" size="inline" onClick={() => onJumpTo(row.key)}>変更</Button>
              </div>
            ))}
          </div>
        )}
        {precheckAt !== 'done' && (
          <div className={styles.precheckQuestion}>
            <h3 data-step-heading tabIndex={-1} className={styles.precheckQuestionTitle}>{PRECHECK_TITLES[precheckAt]}</h3>
            <p className={styles.help}>{PRECHECK_HELPS[precheckAt]}</p>
            {/* Q5 だけ説明付きの3択なので縦に積む。ほかは2列（v07 aSRi4・s70iLZ）。 */}
            <RadioCardGroup legend={PRECHECK_TITLES[precheckAt]} columns={precheckAt === 'q5' ? undefined : 2}>
              {PRECHECK_CHOICES[precheckAt].map((choice) => (
                <RadioCard
                  key={choice.value} name={`precheck-${precheckAt}`} value={choice.value}
                  title={choice.title} note={choice.note} height="fit"
                  checked={precheck[precheckAt] === choice.value}
                  onChange={() => onAnswer(precheckAt, choice.value)}
                  onClick={precheck[precheckAt] === choice.value ? () => onAnswer(precheckAt, choice.value) : undefined}
                />
              ))}
            </RadioCardGroup>
            {ack && (
              <Card className={styles.precheckAck} layout="vertical" surface="muted" corner="control" contentPadding="var(--tpl-htn-note-pad)" gap="var(--tpl-htn-gap-s)">
                <SaveErrorField names={[ack.key]}><Checkbox checked={Boolean(acks[ack.key])} onCheckedChange={(next) => onToggleAck(ack.key, next)}>{ack.label}</Checkbox></SaveErrorField>
              </Card>
            )}
            {guide && (
              <Notice tone={guide.tone}>
                {guide.title && <p className={styles.precheckNoteTitle}>{guide.title}</p>}
                <p>{guide.body}</p>
                {guide.link && (
                  <NoticeDetailAction note={guide.link.note}>
                    <Button variant="primary" external={guide.link.external} href={guide.link.href}>{guide.link.label}</Button>
                  </NoticeDetailAction>
                )}
              </Notice>
            )}
          </div>
        )}
        {precheckAt === 'done' && (
          <>
            {guide && (
              <Notice tone={guide.tone}>
                {guide.title && <p className={styles.precheckNoteTitle}>{guide.title}</p>}
                <p>{guide.body}</p>
              </Notice>
            )}
            <Card layout="vertical" surface="muted" corner="control" contentPadding="var(--tpl-htn-note-pad)" gap="var(--tpl-htn6-ack-gap)">
              <p className={styles.precheckResultHeading}>あなたの接続前チェック結果</p>
              {PRECHECK_RESULT.map((item) => (
                <div key={item.title} className={styles.precheckResultItem}>
                  <span className={styles.precheckResultMark} aria-hidden="true"><Check size={16} /></span>
                  <div className={styles.precheckResultText}>
                    <p className={styles.precheckResultTitle}>{item.title}</p>
                    <p className={styles.precheckResultBody}>{item.body}</p>
                  </div>
                </div>
              ))}
            </Card>
          </>
        )}
      </Card>
    </CreateStepColumns>
  )
}
