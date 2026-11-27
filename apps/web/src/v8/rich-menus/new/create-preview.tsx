import { AreaIcon } from '@/components/rich-menus/canvas-editor'
import { type Area } from '../../../components/rich-menus/area-types'
import type { RichMenuTargetPreview } from '@/lib/api'
import { formatNumber } from '@/lib/format'
import { RICH_MENU_DIMENSIONS } from '@line-crm/shared'
import { Circle,CircleAlert,CircleCheck } from 'lucide-react'
import type { CheckState } from './create-types'
import styles from '../../../app/rich-menus/new/create-v8.module.css'
/* ---------- 小部品 ---------- */

export function MetricValue({ metric }: { metric: RichMenuTargetPreview['matched'] | undefined }) {
  if (!metric) return <>—</>
  if (metric.state !== 'available' || metric.value === null || !Number.isFinite(metric.value)) {
    return <>数えられません</>
  }
  return <>{formatNumber(metric.value)}人</>
}

export function CheckIcon({ state }: { state: CheckState }) {
  if (state === 'ok') return <CircleCheck className={`${styles.checkIcon} ${styles.checkIconOk}`} aria-hidden />
  if (state === 'ng') return <CircleAlert className={`${styles.checkIcon} ${styles.checkIconNg}`} aria-hidden />
  return <Circle className={`${styles.checkIcon} ${styles.checkIconYet}`} aria-hidden />
}

/**
 * LINEでの見え方の中身（スマホの下・入力の帯の位置に出すリッチメニュー）。画像があれば実画像に面の線を重ね、
 * 無ければ面の線（点線）だけ出し「画像を選ぶと、ここに出ます」（仕様書・公式照合より）。
 * 下の帯（トーク画面の下の文言 ∨）は LinePreview が1本だけ描く（gobhu）。
 */
export function MenuContent({
  size,
  imageUrl,
  areas,
  pages,
  activePageId,
}: {
  size: 'large' | 'compact'
  imageUrl: string | null
  areas: Array<{ x: number; y: number; w: number; h: number; label?: string; intent?: Area['intent'] }> | null
  pages: Array<{ id: string; name: string }>
  activePageId: string | null
}) {
  const dims = RICH_MENU_DIMENSIONS[size]
  const pct = (value: number, base: number) => (Number.isFinite(value) && base > 0 ? Math.max(0, Math.min(100, (value / base) * 100)) : 0)
  const areaBoxes = areas && areas.length > 0 ? (
    <div className={styles.previewMenuAreas} aria-hidden="true">
      {areas.map((a, i) => (
        <span
          key={i}
          className={styles.previewMenuAreaBox}
          style={{
            left: `${pct(a.x, dims.width)}%`,
            top: `${pct(a.y, dims.height)}%`,
            width: `${pct(a.w, dims.width)}%`,
            height: `${pct(a.h, dims.height)}%`,
          }}
        >{a.label ? <><AreaIcon intent={a.intent} size={16} presentation="preview" /><span className={styles.previewMenuAreaName}>{a.label}</span></> : null}</span>
      ))}
    </div>
  ) : null
  return (
    <div>
      {pages.length > 1 ? (
        <div className={styles.previewMenuTabs} aria-hidden="true">
          {pages.map((p) => (
            <span key={p.id} className={p.id === activePageId ? `${styles.previewMenuTab} ${styles.previewMenuTabOn}` : styles.previewMenuTab}>
              {p.name}
            </span>
          ))}
        </div>
      ) : null}
      {imageUrl ? (
        /* 枠の比は大きさ（大 2500×1686・小 2500×843）で決める。画像が別の比・読み途中でも高さが潰れない。 */
        <div className={styles.previewMenuImage} data-rich-menu-size={size} style={{ aspectRatio: `${dims.width} / ${dims.height}` }}>
          {/* eslint-disable-next-line @next/next/no-img-element -- 認証つきの管理用URL */}
          <img width={dims.width} height={dims.height} src={imageUrl} alt="メニューの画像" />
          {areaBoxes}
        </div>
      ) : (
        <div
          className={styles.previewMenuEmpty}
          data-rich-menu-size={size}
          style={{ aspectRatio: `${dims.width} / ${dims.height}` }}
        >
          {areaBoxes}
          <span className={styles.previewMenuEmptyText}>
            画像を選ぶと、ここに出ます
            {areas && areas.length > 0 ? `（${areas.length}面）` : ''}
          </span>
        </div>
      )}
    </div>
  )
}

export { MenuContent as MenuPreview }
