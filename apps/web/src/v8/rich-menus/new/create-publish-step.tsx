'use client'

import { canManageRole } from '@/lib/staff-role'
import {
type PublishPlanInput
} from '@/v8/rich-menus/edit/publish-plan-draft'
import { isAreaActionConfigured } from '@/components/rich-menus/action-drafts'
import { areaDisplayName } from '@/components/rich-menus/canvas-editor'
import { type Area } from '../../../components/rich-menus/area-types'
import Button from '@/components/shared/button'
import Card from '@/components/shared/card'
import Toggle from '@/components/shared/toggle'
import DateTimeField from '@/components/shared/date-time-field'
import EntitySelect,{ entityOptionMetadata } from '@/components/shared/entity-select'
import { Field,OptionalBadge } from '@/components/shared/form-controls'
import RadioCard,{ RadioCardGroup } from '@/components/shared/radio-card'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import SectionHeader from '@/components/shared/section-header'
import {
type RichMenuTargetPreview
} from '@/lib/api'
import { formatDateTime,formatNumber } from '@/lib/format'
import type { RichMenuCreateHost } from '@/lib/rich-menu-create-host'
import { RichMenuSchedules } from '@/v8/rich-menu-edit/public/schedules/index'
import { RichMenuTestApply } from '@/v8/rich-menu-edit/public/test-apply/index'
import {
RICH_MENU_DIMENSIONS
} from '@line-crm/shared'
import {
CalendarClock,
CircleAlert,
CircleCheck,
CopyPlus,
Info,
RefreshCw,
Repeat,
Smartphone,
Zap
} from 'lucide-react'
import type { Dispatch,JSX,SetStateAction } from 'react'
import { SIZE_OPTIONS,type StepKey } from './create-options'
import { CheckIcon,MenuContent } from './create-preview'
import { type Group,type Page,type PrepublishState } from './create-types'
import styles from '../../../app/rich-menus/new/create-v8.module.css'
import Notice from '@/components/shared/notice'

type RenderHqPublishStepContext = {
  areaActionSummary: (area: Area) => string
  goToStep: (key: StepKey) => void
  group: Group | null
  host: RichMenuCreateHost | undefined
  hqDuplicateMode: "overwrite" | "alias"
  pages: Page[]
  setHqDuplicateMode: Dispatch<SetStateAction<"overwrite" | "alias">>
  size: "large" | "compact"
  tabCount: number
  totalAreaCount: number
}

function areaLetter(index: number): string {
  return index >= 0 && index < 26 ? String.fromCharCode(65 + index) : String(index + 1)
}

function dimensionsLabel(sizeKey: string): string {
  if (!Object.prototype.hasOwnProperty.call(RICH_MENU_DIMENSIONS, sizeKey)) return 'サイズ不明'
  const dims = RICH_MENU_DIMENSIONS[sizeKey as keyof typeof RICH_MENU_DIMENSIONS]
  return `${dims.width}×${dims.height}`
}

function areaCountLabel(count: number): string {
  return typeof count === 'number' && Number.isFinite(count) && count >= 0 ? `${Math.trunc(count)}面` : '面数不明'
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

export function renderHqPublishStep({ areaActionSummary, goToStep, group, host, hqDuplicateMode, pages, setHqDuplicateMode, size, tabCount, totalAreaCount }: RenderHqPublishStepContext) {
    const resolvedSize = group?.size ?? size
    const sizeLabel = resolvedSize === 'large' ? '大きい' : resolvedSize === 'compact' ? '小さい' : 'サイズ不明'
    const pageCount = group ? pages.length : tabCount + 1
    const showTab = pageCount > 1
    const actionRows = (group ? pages : []).flatMap((page) => page.areas.map((area, index) => ({
      key: `${page.id}:${area.id}`,
      letter: areaLetter(index),
      name: `${showTab ? `${page.name}・` : ''}${areaDisplayName(area, index)}`,
      summary: areaActionSummary(area),
    })))
    const missingRows = actionRows.filter((row) => !row.summary)
    const missingImages = (group ? pages : []).filter((page) => !page.imageR2Key)
    const firstPage = group ? pages[0] ?? null : null
    const shapeUrl = firstPage?.imageR2Key && host ? host.imageUrl(firstPage.imageR2Key) : null
    return (
      <>
        <Card variant="form" gap="normal">
          <SectionHeader title="確かめる" />
          <div className={styles.hqReview}>
            <div className={styles.hqReviewShape}>
              <MenuContent
                size={group?.size ?? size}
                imageUrl={shapeUrl}
                areas={firstPage ? firstPage.areas.map((a) => ({ x: a.boundsX, y: a.boundsY, w: a.boundsWidth, h: a.boundsHeight })) : null}
                pages={[]}
                activePageId={null}
              />
              <p className={styles.cardNote}>{`${sizeLabel}・${areaCountLabel(totalAreaCount)}・${showTab ? `切替タブ ${pageCount}ページ` : '切替タブなし'}`}</p>
            </div>
            <div className={styles.hqReviewActions}>
              <p className={styles.hqReviewLabel}>面ごとの動き</p>
              <ul className={styles.hqActionList}>
                {actionRows.map((row) => (
                  <li key={row.key} className={styles.hqActionRow}>
                    <span className={styles.hqActionLetter} aria-hidden="true">{row.letter}</span>
                    <span className={styles.hqActionName} title={row.name}>{row.name}</span>
                    <span className={row.summary ? styles.hqActionValue : `${styles.hqActionValue} ${styles.summaryValueWarn}`}>{row.summary || '未設定'}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </Card>

        <Card variant="form" gap="normal">
          <SectionHeader title="足りないもの" help="配る前に、この画面で分かる足りないものです。アカウントごとに無いタグ・テンプレートなどは、保存したあとの配る前の確認で一覧にします。" helpLabel="足りないものの説明" />
          <ul className={styles.checkList}>
            {missingRows.length > 0 ? (
              <li className={styles.checkRow}>
                <CircleAlert className={`${styles.checkIcon} ${styles.checkIconWarn}`} aria-hidden />
                <div className={styles.checkBody}>
                  <p className={styles.checkName}>{`面 ${missingRows.map((row) => row.letter).join('・')} の動きが未設定`}</p>
                  <p className={styles.checkNote}>押しても何も起きません。「ボタンの動き」で設定します</p>
                </div>
                <span className={styles.checkAction}>
                  <Button type="button" variant="text" textTone="ink" size="inline" onClick={() => goToStep('buttons')}>ボタンの動きを設定する</Button>
                </span>
              </li>
            ) : null}
            {missingImages.length > 0 ? (
              <li className={styles.checkRow}>
                <CircleAlert className={`${styles.checkIcon} ${styles.checkIconWarn}`} aria-hidden />
                <div className={styles.checkBody}>
                  <p className={styles.checkName}>{showTab ? `${missingImages.map((page) => page.name).join('・')} の画像が無い` : '画像が無い'}</p>
                  <p className={styles.checkNote}>画像が無いと、配った先で公開できません。①で選びます</p>
                </div>
                <span className={styles.checkAction}>
                  <Button type="button" variant="text" textTone="ink" size="inline" onClick={() => goToStep('shape')}>①で選択する</Button>
                </span>
              </li>
            ) : (
              <li className={styles.checkRow}>
                <CircleCheck className={`${styles.checkIcon} ${styles.checkIconOk}`} aria-hidden />
                <div className={styles.checkBody}>
                  <p className={styles.checkName}>画像・大きさ・面の数</p>
                  <p className={styles.checkNote}>{`${dimensionsLabel(resolvedSize)}・${areaCountLabel(totalAreaCount)}`}</p>
                </div>
              </li>
            )}
            {missingRows.length === 0 && actionRows.length > 0 ? (
              <li className={styles.checkRow}>
                <CircleCheck className={`${styles.checkIcon} ${styles.checkIconOk}`} aria-hidden />
                <div className={styles.checkBody}>
                  <p className={styles.checkName}>ボタンの動き</p>
                  <p className={styles.checkNote}>すべての面に動きがあります</p>
                </div>
              </li>
            ) : null}
          </ul>
        </Card>

        <Card variant="form" gap="normal">
          <SectionHeader title="配ったときの扱い" help="配った先に同じ名前のリッチメニューがあるときの扱いです。公開中のメニューは上書きしません。" helpLabel="配ったときの扱いの説明" />
          <RadioCardGroup legend="配ったときの扱い" className="grid grid-cols-2 gap-3">
            <RadioCard
              name="hq-duplicate"
              value="overwrite"
              checked={hqDuplicateMode === 'overwrite'}
              onChange={() => setHqDuplicateMode('overwrite')}
              title="同じ名前があれば上書き"
              icon={<RefreshCw aria-hidden="true" />}
              note="今のメニューを入れ替える"
            />
            <RadioCard
              name="hq-duplicate"
              value="alias"
              checked={hqDuplicateMode === 'alias'}
              onChange={() => setHqDuplicateMode('alias')}
              title="新しく作る"
              icon={<CopyPlus aria-hidden="true" />}
              note="今のメニューは残し、別に作る"
            />
          </RadioCardGroup>
          <Notice tone="info" icon={<span><Info size={16} aria-hidden /></span>}>
            <span>同じ名前のメニューがあるアカウントだけ、この扱いになります。どのアカウントに同じ名前があるかは、配る前の確認で一覧にし、そこで1つずつ変えられます。</span>
          </Notice>
        </Card>
      </>
    )
  }

type RenderPublishStepContext = {
  accountId: string | null
  aggregateOnly: boolean
  areaActionSummary: (area: Area) => string
  audience: "all" | "tag" | "none" | "targeted"
  canOperate: boolean
  checks: PrepublishState | null
  checksError: boolean
  checksLoading: boolean
  conditionEmpty: boolean
  conditionUnsaved: boolean
  done: "scheduled" | "published" | null
  endEnabled: boolean
  goToStep: (key: StepKey) => void
  group: Group | null
  host: RichMenuCreateHost | undefined
  loadChecks: () => Promise<void>
  nowNote: "保存したらすぐ、個別に指定した人を除くすべての友だちの既定メニューになります" | "LINEへの登録だけで、友だちの画面は変わりません。出す相手は一覧の「表示先」で決めてください" | "いまの条件では誰にも出ません（今0人）。条件を決めてから出してください" | "保存するとLINEに登録され、条件に当てはまる人の画面に出来事のタイミングで順次出ます"
  pages: Page[]
  previewAreas: { x: number; y: number; w: number; h: number; }[] | null
  previewImageUrl: string | null
  publishEffectNote: "個別に指定した人を除く、すべての友だちのトーク画面に出ます。既定のメニューが入れ替わります。" | "LINEへの登録だけでは、友だちのトーク画面は変わりません。「表示先」で出す相手を決めてください。" | "公開しても今は誰の画面にも出ません（0人）。条件を1つ以上足してください。" | "条件に当てはまる人の画面は、その人に関係する出来事のタイミングで順次切り替わります。すぐ全員に出るわけではありません。"
  publishPlan: PublishPlanInput
  recording: boolean
  recordSeen: () => Promise<void>
  renderHqPublish: () => JSX.Element
  restoreMenus: { id: string; name: string; }[]
  setActivePageId: Dispatch<SetStateAction<string | null>>
  setEndEnabled: Dispatch<SetStateAction<boolean>>
  setSelectedAreaId: Dispatch<SetStateAction<string | null>>
  size: "large" | "compact"
  staffRole: string | null
  targetPreview: RichMenuTargetPreview | null
  totalAreaCount: number
  updatePublishPlan: (next: PublishPlanInput) => void
  validateWithLine: () => Promise<void>
  validating: boolean
}

export function renderPublishStep({ accountId, aggregateOnly, areaActionSummary, audience, canOperate, checks, checksError, checksLoading, conditionEmpty, conditionUnsaved, done, endEnabled, goToStep, group, host, loadChecks, nowNote, pages, previewAreas, previewImageUrl, publishEffectNote, publishPlan, recording, recordSeen, renderHqPublish, restoreMenus, setActivePageId, setEndEnabled, setSelectedAreaId, size, staffRole, targetPreview, totalAreaCount, updatePublishPlan, validateWithLine, validating }: RenderPublishStepContext) {
    if (host) return renderHqPublish()
    const timingIsScheduled = publishPlan.mode !== 'now'
    if (done) {
      return (
        <Card variant="form" gap="normal">
          <h2 className={styles.cardTitle}>
            {done === 'published' ? 'LINEへの登録が終わりました' : '公開予約を受け付けました'}
          </h2>
          <p className={styles.cardNote}>
            {done === 'published'
              ? '公開のようす・履歴は、リッチメニュー一覧の「公開中」から見られます。'
              : '予約の時点の内容で公開します。予約の確認・取り消しは編集画面からできます。'}
          </p>
          <div className={styles.pageTools}>
            <Button href="/rich-menus" variant="primary">一覧へ戻る</Button>
            {group ? <Button href={`/rich-menus/edit?id=${group.id}`}>編集画面を開く</Button> : null}
          </div>
        </Card>
      )
    }
    /*
     * 板 ：公開の前に「確かめる」（見本と面ごとの動き）と「足りないもの」を上に置く。
     * 面の動きは②、画像は①で決めるので、足りないときはその手順へ戻る口を出す。
     */
    const reviewSize = group?.size ?? size
    const reviewDims = dimensionsLabel(reviewSize)
    const reviewSizeLabel = SIZE_OPTIONS.find((o) => o.value === reviewSize)?.label ?? 'サイズ不明'
    const missingPages = pages.filter(page => !page.areas.length || page.areas.some(area => !isAreaActionConfigured(area)))
    const missingImages = pages.filter((p) => !p.imageR2Key)
    const review = group ? (
      <>
        <Card variant="form" gap="normal" aria-label="確かめる">
          <SectionHeader title="確かめる" />
          <div className={styles.reviewRow}>
            <div className={styles.reviewThumb}>
              <MenuContent size={reviewSize} imageUrl={previewImageUrl} areas={previewAreas} pages={[]} activePageId={null} />
              <p className={styles.reviewCaption}>{reviewSizeLabel}・{areaCountLabel(totalAreaCount)}・{pages.length > 1 ? `切替タブ${pages.length}つ` : '切替タブなし'}</p>
            </div>
            <div className={styles.reviewFaces}>
              <p className={styles.reviewFacesTitle}>面ごとの動き</p>
              <ul className={styles.faceList}>
                {pages.map((p) => (
                  <li key={p.id} className={styles.faceGroup}>
                    {pages.length > 1 ? <p className={styles.faceGroupName}>{p.name}</p> : null}
                    <ul className={styles.faceList}>
                      {p.areas.map((area, i) => {
                        const summary = areaActionSummary(area)
                        return (
                          <li key={area.id} className={styles.faceRow}>
                            <span className={styles.faceLetter} aria-hidden="true">{areaLetter(i)}</span>
                            <span className={styles.faceName} title={areaDisplayName(area, i)}>{areaDisplayName(area, i)}</span>
                            <span className={summary ? styles.faceSummary : styles.faceSummaryWarn} title={summary || undefined}>{summary || '未設定'}</span>
                          </li>
                        )
                      })}
                    </ul>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </Card>
        <Card variant="form" gap="normal" aria-label="足りないもの">
          <SectionHeader title="足りないもの" help="公開する前に、押しても何も起きない面や画像の抜けがないかを見ます。直すときは、それを決める手順へ戻ります。" helpLabel="足りないものの説明" />
          <ul className={styles.checkList}>
            {missingPages.map(page => {
              const unset = page.areas.filter(area => !isAreaActionConfigured(area))
              const prefix = pages.length > 1 ? `${page.name}：` : ''
              const label = `${prefix}${page.areas.length ? `面 ${unset.map(area => areaLetter(page.areas.indexOf(area))).join('・')} の動きが未設定` : '面が未設定'}`
              return <li key={page.id} className={styles.checkRow}>
                <CircleAlert className={`${styles.checkIcon} ${styles.checkIconWarn}`} aria-hidden />
                <div className={styles.checkBody}>
                  <p className={styles.checkName}>{label}</p>
                  <p className={styles.checkNote}>押しても何も起きません。「ボタンの動き」で設定します</p>
                </div>
                <span className={styles.checkAction}>
                  <Button type="button" variant="text" textTone="ink" size="inline" onClick={() => { setActivePageId(page.id); setSelectedAreaId(unset[0]?.id ?? null); goToStep('buttons') }}>ボタンの動きを設定する</Button>
                </span>
              </li>
            })}
            <li className={styles.checkRow}>
              {missingImages.length > 0
                ? <CircleAlert className={`${styles.checkIcon} ${styles.checkIconWarn}`} aria-hidden />
                : <CheckIcon state="ok" />}
              <div className={styles.checkBody}>
                <p className={styles.checkName}>画像・大きさ・面の数</p>
                <p className={styles.checkNote}>{missingImages.length > 0 ? '画像がまだありません。①で選びます' : `${reviewDims}・${areaCountLabel(totalAreaCount)}`}</p>
              </div>
              {missingImages.length > 0 ? (
                <span className={styles.checkAction}>
                  <Button type="button" variant="text" textTone="ink" size="inline" onClick={() => goToStep('shape')}>①で選択する</Button>
                </span>
              ) : null}
            </li>
          </ul>
        </Card>
      </>
    ) : null
    return (
      <>
        {review}
        {/* いつ公開するか */}
        <Card variant="form" gap="normal">
          <SectionHeader title="いつ公開するか" actions={!host && group ? <RichMenuSchedules key={`${accountId}:${group.id}`} groupId={group.id} canOperate={canOperate && !aggregateOnly} restoreMenus={restoreMenus} /> : undefined} />
          <SaveErrorField names={["timing","mode","publishPlan.mode","endEnabled","timingIsScheduled","publishPlan"]}><RadioCardGroup legend="いつ公開するか" className="grid grid-cols-2 gap-3">
            <RadioCard
              name="timing"
              value="now"
              checked={publishPlan.mode === 'now'}
              onChange={() => {
                // 「すぐ出す」に終わりは関係しない。選び直したら期間の設定も外す。
                setEndEnabled(false)
                updatePublishPlan({ ...publishPlan, mode: 'now' })
              }}
              title="すぐ公開する"
              icon={<Zap aria-hidden="true" />}
              note={<span title={nowNote}>確認が済んだらすぐLINEに出す</span>}
            />
            <RadioCard
              name="timing"
              value="scheduled"
              checked={timingIsScheduled}
              onChange={() => updatePublishPlan({ ...publishPlan, mode: endEnabled ? 'period' : 'scheduled' })}
              title="日時を決めて公開する"
              icon={<CalendarClock aria-hidden="true" />}
              note={<span title="指定した時刻にLINEへ登録する予約です。誰の画面に出るかは「公開すると何が変わるか」で確認してください">キャンペーンの始まりに合わせる</span>}
            />
          </RadioCardGroup></SaveErrorField>
          {timingIsScheduled ? (
            <div className={styles.field}>
              <span className={styles.fieldLabel}>始める日時</span>
              <SaveErrorField names={["startsAt","publishPlan.startsAt","starts_at","publish_plan.starts_at","publish_plan"]}><DateTimeField
                value={publishPlan.startsAt}
                onChange={(v) => updatePublishPlan({ ...publishPlan, startsAt: v })}
                aria-label="公開を始める日時"
              /></SaveErrorField>
            </div>
          ) : null}
          {/* 板 `F4gELj`：終わりを決めるは枠の箱。上の行に題とトグル、下の行に「日時 に終わり、［戻す先］に戻す」。オフのときは入力を無効化。 */}
          <div className={styles.endBox}>
            <div className={styles.endHead}>
              <span className={styles.endTitle} title="指定した期間だけLINEに登録し、終わったら切り替えを予約します。誰の画面に出るかは「公開すると何が変わるか」で確認してください">終わりを決める <OptionalBadge /></span>
              <SaveErrorField names={["endEnabled","end_enabled"]}><Toggle
                label="終わりを決める"
                checked={endEnabled}
                onChange={(on) => {
                  setEndEnabled(on)
                  updatePublishPlan({
                    ...publishPlan,
                    mode: on ? 'period' : publishPlan.mode === 'now' ? 'now' : 'scheduled',
                  })
                }}
              /></SaveErrorField>
            </div>
            <div className={styles.endRow}>
              <span className={styles.endDate}>
                <Field label="終わる日時" labelHidden optional={false}><SaveErrorField names={["endsAt","publishPlan.endsAt","ends_at","publish_plan.ends_at","publish_plan"]}><DateTimeField
                  value={publishPlan.endsAt}
                  onChange={(v) => updatePublishPlan({ ...publishPlan, endsAt: v })}
                  aria-label="終わる日時"
                  aria-describedby={!endEnabled ? 'rich-menu-end-note' : undefined} disabled={!endEnabled}
                /></SaveErrorField></Field>
              </span>
              <span>{publishPlan.endsAt ? 'に終わり、' : '終わる日時を選ぶと、'}</span>
              <Field label="終わったらどうする" labelHidden optional={false}><SaveErrorField names={["restoreGroupId","publishPlan.restoreGroupId","restore_group_id","publish_plan.restore_group_id","publish_plan"]}><EntitySelect kind="rich_menu"
                aria-label="終わったらどうする"
                aria-describedby={!endEnabled ? 'rich-menu-end-note' : undefined}
                value={publishPlan.restoreGroupId}
                onChange={(v) => updatePublishPlan({ ...publishPlan, restoreGroupId: v })}
                disabled={!endEnabled}
                options={[
                  { value: '', label: '前のメニュー' },
                  ...restoreMenus.map((item) => ({ ...entityOptionMetadata(item), value: item.id, label: item.name })),
                ]}
              /></SaveErrorField></Field>
              <span>に戻す</span>
            </div>
            {/* 欄ごとに出すと狭い欄の下で折り返すので、行の下に1つだけ出す。 */}
            {!endEnabled ? <p id="rich-menu-end-note" className={styles.endNote} role="note">「終わりを決める」をオンにすると設定できます</p> : null}
          </div>
        </Card>

        {/* 公開の前の確認 */}
        <Card variant="form" gap="normal">
          <div className={`flex flex-col ${styles.stackCompact}`}>
            <SectionHeader title="公開の前の確認" />
            <p className={styles.cardNote} title={checks && isNonNegativeFinite(checks.pages.count) && isNonNegativeFinite(checks.pages.max) ? `ページ数: ${Math.trunc(checks.pages.count)} / ${Math.trunc(checks.pages.max)}${checks.pages.state === 'ng' ? '（上限を超えています）' : ''}` : undefined}>3つそろうと公開できます</p>
          </div>
          {checksError ? (
            <p className={styles.fieldError}>確認の状態を読み込めませんでした。</p>
          ) : checksLoading && !checks ? (
            <p className={styles.cardNote}>読み込み中…</p>
          ) : checks ? (
            <ul className={styles.checkList}>
              <li className={styles.checkRow}>
                <CheckIcon state={checks.self.state} />
                <div className={styles.checkBody}>
                  <p className={styles.checkName}>自前の検査</p>
                  <p className={styles.checkNote}>
                    {checks.self.message ?? '未設定の面・重なり・画像・参照先・文字数・面の数'}
                    {conditionUnsaved && !conditionEmpty ? '・人数は未保存の条件で計算しています' : ''}
                  </p>
                </div>
                <span className={styles.checkAction}>
                  <Button type="button" variant="text" size="inline" onClick={() => void loadChecks()} disabled={checksLoading} busy={checksLoading} busyLabel="確認中…">
                    見直す
                  </Button>
                </span>
              </li>
              <li className={styles.checkRow}>
                <CheckIcon state={checks.line.state} />
                <div className={styles.checkBody}>
                  <p className={styles.checkName}>LINE の検査</p>
                  <p className={styles.checkNote}>
                    {checks.line.message ?? '下の「見直す」でLINEの受付へ確かめます。'}
                  </p>
                </div>
                <span className={styles.checkAction}>
                  <Button type="button" variant="text" size="inline" onClick={() => void validateWithLine()} disabled={validating} busy={validating} busyLabel="確認中…">
                    見直す
                  </Button>
                </span>
              </li>
              <li className={styles.checkRow}>
                {checks.device.state === 'ok'
                  ? <CheckIcon state="ok" />
                  : <CircleAlert className={`${styles.checkIcon} ${styles.checkIconWarn}`} aria-hidden />}
                <div className={styles.checkBody}>
                  <p className={styles.checkName}>スマホの LINE で見た</p>
                  <p className={styles.checkNote}>
                    {checks.device.state === 'ok'
                      ? `スマホの実機で確認済みです${checks.device.at ? `（${formatDateTime(checks.device.at)}）` : ''}。`
                      : '管理画面の見本だけでは公開できません。スマホで見た担当者が押します'}
                    {!host && group && (canManageRole(staffRole))
                      ? <RichMenuTestApply key={`${accountId}:${group.id}`} groupId={group.id} accountId={group.accountId ?? ''} /> : null}
                  </p>
                </div>
                <span className={styles.checkAction}>
                  <Button type="button" onClick={() => void recordSeen()} disabled={recording} busy={recording} busyLabel="記録中…">
                    <Smartphone size={16} aria-hidden /> スマホで見た
                  </Button>
                </span>
              </li>
            </ul>
          ) : null}
        </Card>
        {/* 板 `F4gELj`：案内の帯は段の外（左の直下）。 */}
        <Notice tone="info" icon={<Repeat size={16} aria-hidden />}>
          <span title={publishEffectNote}>
            {audience === 'all'
              ? `公開すると、すべての友だちの既定のメニューが入れ替わります。`
              : audience === 'none'
                ? 'LINEへの登録だけでは、友だちの画面は変わりません。出す相手は一覧の「表示先」で決めてください。'
                : conditionEmpty
                  ? '公開しても今は誰の画面にも出ません（0人）。条件を1つ以上足してください。'
                  : '公開すると、条件に当てはまる人に出来事のタイミングで順次出ます。'}
            {targetPreview?.higherMenus && targetPreview.higherMenus.length > 0 && isNonNegativeFinite(targetPreview.overlap?.value) && targetPreview.overlap.value > 0
              ? `${targetPreview.higherMenus[0]}の${formatNumber(Math.trunc(targetPreview.overlap.value))}人には、いままでどおり上のメニューが出ます。`
              : ''}
          </span>
        </Notice>
      </>
    )
  }
