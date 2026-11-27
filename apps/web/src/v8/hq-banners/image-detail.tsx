'use client'

/*
 * ★V8 画像の詳細（Pencil ）と、そこから開く「一覧から外す」の確かめ（）。
 * 共通の窓に絵の幅 860・上からの位置を渡し、中身を絵どおりに組む：
 * 左に画像とダウンロード・お気に入り、右に「アカウントへ配る」（探す・タグの札・アカウントの一覧・渡す）、
 * 下に「生成時の条件」（2列）、いちばん下に 一覧から外す（左）・参照画像にする・同じ設定でもう一度生成（右）。
 * 渡す・外す・お気に入り・もう一度生成は、現役の画面のAPIと動作試験で守る。
 */
import { Download, ImagePlus, RefreshCw, Send, Star, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import Button from '@/components/shared/button'
import { HqAccountPickerField } from '@/components/shared/hq-account-picker'
import type { AccountWithStats } from '@/contexts/account-context'
import { generationConditionRows, type BannerImage, type BannerPreset } from '@/lib/hq-banners'
import { BannerConfirmDialogV8 } from './dialogs'
import BannerDialogFrame from './frame'
import { monthDayTime } from './words'
import styles from './image-detail.module.css'

/** 生成時の条件の行。色は値だけ、作成は「9/30 10:12・1枚目」（絵どおり）。 */
export function conditionRows(image: BannerImage, presets: BannerPreset[]): Array<{ label: string; value: string }> {
  return generationConditionRows(image, presets).map((row) => {
    if (row.label === '色' && image.generation) {
      const g = image.generation
      const colors = [g.baseColor, g.mainColor, g.subColor, g.accentColor].filter(Boolean)
      return colors.length > 0 ? { label: '色', value: colors.join('・') } : row
    }
    if (row.label === '作成') return { label: '作成', value: `${monthDayTime(image.createdAt)}・${image.sequence} 枚目` }
    return row
  })
}

export function BannerImageDetailV8({
  image,
  presets,
  accounts,
  canManage,
  busy,
  error,
  onClose,
  onToggleFavorite,
  onDeliver,
  onRemove,
  onRegenerate,
  onUseAsReference,
}: {
  image: BannerImage
  presets: BannerPreset[]
  accounts: AccountWithStats[]
  /** 閲覧のみ（オーナー・管理者でない）は、渡す・外す・お気に入り・もう一度生成を置かない。 */
  canManage: boolean
  busy?: boolean
  error?: string
  onClose: () => void
  onToggleFavorite: () => void
  /** WEB204：成功したら true。失敗したら false（窓・選択を片付けない）。 */
  onDeliver: (lineAccountIds: string[]) => Promise<boolean>
  onRemove: () => Promise<boolean>
  /** 生成画像だけ。取り込み画像では出さない。 */
  onRegenerate?: () => void
  /** 「参照画像にする」。プロジェクトの中から開いたときだけ渡す。 */
  onUseAsReference?: () => void
}) {
  const [selected, setSelected] = useState<string[]>([])
  const [confirmRemove, setConfirmRemove] = useState(false)
  // 読めない画像は壊れた印を出さず、地の色のままにする。
  const [failedPreviewUrl, setFailedPreviewUrl] = useState<string | null>(null)

  // アーカイブしたアカウントへは渡さない（受け取る口が止まっている）。
  const targets = useMemo(() => accounts.filter((a) => !a.archivedAt), [accounts])
  const delivered = useMemo(() => new Set(image.deliveredAccountIds), [image.deliveredAccountIds])
  // 名前のほか LINE ID・タグの名前でも探せる（前の探す欄と同じ）。
  const pickerAccounts = useMemo(() => targets.map((a) => ({ id: a.id, name: a.displayName ?? a.name,
    keywords: `${a.basicId ?? ''} ${a.channelId ?? ''} ${(a.tags ?? []).map((t) => t.name).join(' ')}` })), [targets])
  const rows = conditionRows(image, presets)

  if (confirmRemove) {
    // 絵 ：詳細の窓は閉じ、確かめる窓だけを出す。やめると詳細へ戻る。
    return (
      <BannerConfirmDialogV8
        open
        title="この画像を一覧から外しますか？"
        description="統括の一覧に出なくなります。すでにアカウントへ配った画像は、そのアカウントの登録メディアに残ります。"
        confirmLabel="一覧から外す"
        tone="danger"
        busy={busy}
        error={error}
        designNode="B24oNg"
        onConfirm={() => onRemove().then((ok) => { if (ok) setConfirmRemove(false) })}
        onCancel={() => setConfirmRemove(false)}
      />
    )
  }

  return (
    <BannerDialogFrame
      open
      kind="detail"
      title="画像の詳細"
      onClose={onClose}
      busy={busy}
      error={error || undefined}
      designNode="rI5uh"
      actionsAlign="split"
      actions={(
        <>
          {canManage ? (
            <button type="button" className={styles.remove} onClick={() => setConfirmRemove(true)} disabled={busy}>
              <Trash2 aria-hidden="true" className={styles.icon} />一覧から外す
            </button>
          ) : null}
          <span className={styles.spacer} />
          {canManage && onUseAsReference ? (
            <Button onClick={onUseAsReference} disabled={busy}>
              <ImagePlus aria-hidden="true" className={styles.icon} />参照画像にする
            </Button>
          ) : null}
          {canManage && onRegenerate ? (
            <Button onClick={onRegenerate} disabled={busy}>
              <RefreshCw aria-hidden="true" className={styles.icon} />同じ設定でもう一度生成
            </Button>
          ) : null}
        </>
      )}
    >
      <div className={styles.body}>
        <div className={styles.top}>
          <div className={styles.left}>
            <div className={styles.preview}>
              {failedPreviewUrl === image.media.url ? null : (
                // eslint-disable-next-line @next/next/no-img-element
                <img width={1200} height={628} src={image.media.url} alt="" onError={() => setFailedPreviewUrl(image.media.url)} />
              )}
            </div>
            <div className={styles.buttons}>
              <Button href={image.media.url} target="_blank" rel="noreferrer" download={image.media.filename}>
                <Download aria-hidden="true" className={styles.icon} />ダウンロード
              </Button>
              {canManage ? (
                <Button onClick={onToggleFavorite} disabled={busy} aria-pressed={image.isFavorite}>
                  <Star aria-hidden="true" className={image.isFavorite ? `${styles.icon} ${styles.starOn}` : styles.icon} />お気に入り
                </Button>
              ) : null}
            </div>
          </div>

          <section className={styles.deliver} aria-label="アカウントへ配る">
            <h3 className={styles.sectionTitle}>アカウントへ配る</h3>
            <p className={styles.note}>配ったアカウントの登録メディア（フォルダ「02_バナー」）に入ります</p>
            <HqAccountPickerField label="配るアカウント" accounts={pickerAccounts} value={selected} onChange={setSelected}
              disabledIds={image.deliveredAccountIds} readOnly={!canManage} disabled={busy}
              meta={(account) => delivered.has(account.id) ? '配布済み' : undefined} />
            {targets.length === 0 ? <p className={styles.note}>この統括にアカウントがありません。</p> : null}
            {canManage ? (
              <div className={styles.deliverFoot}>
                <span className={styles.note}>{selected.length > 0 ? `${selected.length} アカウントを選んでいます` : 'アカウントを選んでください'}</span>
                <span className={styles.spacer} />
                <Button
                  variant="primary"
                  disabled={busy || selected.length === 0}
                  title={selected.length === 0 ? '配るアカウントを選んでください。' : undefined}
                  onClick={() => void onDeliver(selected).then((ok) => { if (ok) setSelected([]) })}
                  busy={busy}
                  busyLabel="配っています…"
                >
                  <Send aria-hidden="true" className={styles.icon} />{`${selected.length}アカウントへ配る`}
                </Button>
              </div>
            ) : null}
          </section>
        </div>

        <section className={styles.conditions} aria-label={image.generation ? '生成時の条件' : 'この画像について'}>
          <h3 className={styles.sectionTitle}>{image.generation ? '生成時の条件' : 'この画像について'}</h3>
          <div className={styles.conditionCols}>
            {[rows.slice(0, 3), rows.slice(3)].map((column, index) => (
              <dl key={index} className={styles.conditionCol}>
                {column.map((row) => (
                  <div key={row.label} className={styles.conditionRow}>
                    <dt>{row.label}</dt>
                    <dd className={row.label === 'テキスト' ? styles.multiline : undefined} title={row.value}>{row.value}</dd>
                  </div>
                ))}
              </dl>
            ))}
          </div>
        </section>

      </div>
    </BannerDialogFrame>
  )
}
