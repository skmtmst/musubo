import { AUTOMATION_ACTION_LABELS } from '@line-crm/shared'
import { EntityKindField } from '@/components/shared/entity-picker-sources'
import { FieldError, RequiredBadge } from '@/components/shared/form-controls'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import { Bell, FileText, Play, Tag as TagIcon, Zap, type LucideIcon } from 'lucide-react'
import styles from './create.module.css'

/* することの行の見出し（行の種類が変わっても番号は動かない）。 */
/* 行の印：タグ＝札・メッセージ＝紙・知らせ＝ベル・シナリオ＝再生・共通アクション＝稲妻。 */
export function actionRowIcon(type: string): LucideIcon {
  if (type === 'add_tag') return TagIcon
  if (type === 'start_scenario') return Play
  if (type === 'common_action') return Zap
  if (type === 'notify_staff') return Bell
  return FileText
}

export function actionRowTitle(type: string): string {
  if (type === 'add_tag') return 'タグを付ける'
  if (type === 'start_scenario') return 'シナリオを始める'
  if (type === 'common_action') return '共通アクションを実行'
  if (type === 'notify_staff') return '担当へ知らせる'
  if (type === 'wait') return '待つ'
  if (type === 'send_message') return 'メッセージを送る'
  if (typeof type === 'string' && Object.prototype.hasOwnProperty.call(AUTOMATION_ACTION_LABELS, type)) {
    return AUTOMATION_ACTION_LABELS[type]
  }
  return '登録した処理'
}

/* することで使う選択肢の行（タグ・シナリオ・共通アクション）。選ぶ窓で1つ選ぶ。 */
export function ResourcePick(props: {
  kind: 'tag' | 'scenario' | 'common_action'
  title: string
  id: string
  selectLabel: string
  value: string
  onPick: (value: string) => void
  options: ReadonlyArray<{ id: string; name: string }>
  loading: boolean
  failed: boolean
  failedNote: string
  error?: string
}) {
    const {
  kind, title, id, selectLabel,
  value, onPick, options, loading,
  failed, failedNote,
} = props
  return (
    <div className={styles.field}>
      <span className={styles.label}>{title}<RequiredBadge /></span>
      <SaveErrorField names={["value"]}><EntityKindField
        kind={kind}
        id={id}
        label={selectLabel}
        value={value}
        invalid={Boolean(props.error)}
        disabled={loading || failed}
        placeholder="（選んでください）"
        onChange={(picked) => onPick(picked)}
        options={options}
      /></SaveErrorField>
      {props.error ? <FieldError id={`${id}-error`}>{props.error}</FieldError> : null}
      {loading ? <p className={styles.cardDesc}>読み込んでいます</p> : null}
      {failed ? <p className={styles.cardDesc}>{failedNote}</p> : null}
    </div>
  )
}
