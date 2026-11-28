import { ArrowRight, Upload } from 'lucide-react'
import Button from '@/components/shared/button'
import { formatNumber } from '@/lib/format'
import type { RichMenuCreateHost } from '@/lib/rich-menu-create-host'

const UNKNOWN_SIZE = 'メニューのサイズを確認できないため'
const RETRY = '。画面を読み直すか新しく作り直してください'

/** 統括のリッチメニュー作成の下の帯（キャンセル・下書きを保存・配る／次へ）。サイズが分からない間は保存も配布も止める。 */
export function HqRichMenuFooterActions({ host, publishStep, busy, saving, sizeKnown, nextText, onSave, onNext }: {
  host: RichMenuCreateHost
  publishStep: boolean
  busy: boolean
  saving: boolean
  sizeKnown: boolean
  nextText: string
  onSave: (distribute: boolean) => void
  onNext: () => void
}) {
  const saveBlocked = busy || !host.canOperate || !sizeKnown
  const saveButton = (
    <Button
      type="button"
      disabled={saveBlocked}
      title={!sizeKnown ? `${UNKNOWN_SIZE}保存できません${RETRY}` : undefined}
      busy={publishStep ? saving || host.busy : saving}
      busyLabel="保存中…"
      onClick={() => onSave(false)}
    >
      下書きを保存
    </Button>
  )
  return (
    <>
      <Button type="button" onClick={host.onCancel} disabled={busy}>キャンセル</Button>
      {saveButton}
      {publishStep ? (
        <Button
          type="button"
          variant="primary"
          disabled={saveBlocked}
          title={!sizeKnown ? `${UNKNOWN_SIZE}配布できません${RETRY}` : '保存したあとに、配る前の確認へ進みます'}
          busy={saving || host.busy}
          busyLabel="保存しています…"
          onClick={() => onSave(true)}
        >
          <Upload size={16} aria-hidden="true" />
          {host.selectedCount > 0 ? `${formatNumber(host.selectedCount)} アカウントへ配る` : 'アカウントへ配る'}
        </Button>
      ) : (
        <Button type="button" variant="primary" disabled={busy} busy={saving} busyLabel="保存中…" onClick={onNext}>
          {nextText}
          <ArrowRight size={16} aria-hidden="true" />
        </Button>
      )}
    </>
  )
}
