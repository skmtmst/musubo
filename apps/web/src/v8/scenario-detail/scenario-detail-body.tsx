'use client'

import { useInsertTokenNames } from '@/lib/use-insert-token-names'

import { type OnCompleteMode } from '@/components/scenarios/scenario-dialogs'
import Button from '@/components/shared/button'
import { emptyValue } from '@/components/shared/empty-value'
import IconButton from '@/components/shared/icon-button'
import { InsertText } from '@/components/shared/insert-text-field'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import LinePreview from '@/components/shared/line-preview'
import { fillPreviewSample } from '@/components/shared/preview-sample'
import Link from '@/components/shared/list-navigation'
import Notice from '@/components/shared/notice'
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import { reorderMoveReason } from '@/components/shared/reorder-handle'
import { RowMenu } from '@/components/shared/row-actions'
import { useSaveFormErrors } from '@/components/shared/save-form-errors'
import StatusBadge from '@/components/shared/status-badge'
import StatusChip from '@/components/shared/status-chip'
import TagPill from '@/components/shared/tag-pill'
import type { ScenarioSimulation } from '@/lib/api'
import { formatNumber } from '@/lib/format'
import type { DeliveryMode, ScenarioStep } from '@line-crm/shared'
import { ArrowDown, ArrowUp, CircleCheck, FilePlus2, GitBranch, Pause, Pencil, Play, Plus, SlidersHorizontal } from 'lucide-react'
import type { Dispatch, SetStateAction } from 'react'
import { Fragment } from 'react'
import { formatSavedAt, formatScheduleLabel, ON_COMPLETE_SENTENCE, ScenarioStats, ScenarioWithSteps, stepKindShort, stepRowTitle, stepWhenLabel, TagOpt, TemplateOpt } from './detail-model'
import styles from './detail.module.css'
import { scenarioReachBarWidth, scenarioReachCountLabel, scenarioReachPercent, scenarioReachPercentLabel } from './scenario-reach-display'
import { describeAfterSend, describeStepAudience } from './scenario-step-audience'

export function ScenarioDetailBody({
  FlexPreview,
  canEdit, justStarted, stats, simulation, simulationRefreshing,
  id, startedAt, error, duplicateRemainder,
  duplicating, handleDuplicate, discardingDuplicate, setDiscardDuplicateError,
  setDiscardDuplicateOpen, editDirty, scenario, triggerHeadline,
  audienceConditionLabel, setTriggerOpen, setStopError, setStopOpen,
  setStartError, setStartConfirmed, setStartOpen, sortedSteps,
  biggestDrop, setOnCompleteOpen, templates, shownStepId,
  openInsertStep, setSelectedStepId, deliveryMode, previewLabels,
  editingStepId, closeStepForm, openEditStep, handleMoveStep,
  stepMenuId, setStepMenuId, canTestSend, setTestSend,
  actionCounts, setActionTarget, duplicatingStepId, handleDuplicateStep,
  setDeleteStepError, setDeleteStepTarget, renderStepForm, showStepForm,
  tags, openAddStep, openAddTemplateStep, openAddQuestionStep,
  shownStep, startAccountLabel, shownTpl, saveErrors,
}: {
  FlexPreview: React.ComponentType<{ content: string }>
  canEdit: boolean
  justStarted: boolean
  stats: ScenarioStats | null
  simulation: ScenarioSimulation | null
  simulationRefreshing: boolean
  id: string
  startedAt: string
  error: string
  duplicateRemainder: { copyId: string; copyName: string; stage: string; detail: string; } | null
  duplicating: boolean
  handleDuplicate: (name?: string) => Promise<void>
  discardingDuplicate: boolean
  setDiscardDuplicateError: Dispatch<SetStateAction<string>>
  setDiscardDuplicateOpen: Dispatch<SetStateAction<boolean>>
  editDirty: boolean
  scenario: ScenarioWithSteps
  triggerHeadline: string
  audienceConditionLabel: string
  setTriggerOpen: Dispatch<SetStateAction<boolean>>
  setStopError: Dispatch<SetStateAction<string>>
  setStopOpen: Dispatch<SetStateAction<boolean>>
  setStartError: Dispatch<SetStateAction<string>>
  setStartConfirmed: Dispatch<SetStateAction<boolean>>
  setStartOpen: Dispatch<SetStateAction<boolean>>
  sortedSteps: ScenarioStep[]
  biggestDrop: { fromOrder: number; toOrder: number; lost: number; rate: number; } | null
  setOnCompleteOpen: Dispatch<SetStateAction<boolean>>
  templates: TemplateOpt[]
  shownStepId: string | null
  openInsertStep: (afterOrder: number) => void
  setSelectedStepId: Dispatch<SetStateAction<string | null>>
  deliveryMode: DeliveryMode
  previewLabels: Record<number, string>
  editingStepId: string | null
  closeStepForm: () => void
  openEditStep: (step: ScenarioStep) => void
  handleMoveStep: (stepId: string, direction: "up" | "down") => Promise<void>
  stepMenuId: string | null
  setStepMenuId: Dispatch<SetStateAction<string | null>>
  canTestSend: boolean
  setTestSend: Dispatch<SetStateAction<{ stepId: string | null; label: string; } | null>>
  actionCounts: Record<string, number>
  setActionTarget: Dispatch<SetStateAction<{ hook: "step_sent" | "scenario_completed" | "choice_selected"; stepId: string | null; choiceIndex: number | null; title: string; } | null>>
  duplicatingStepId: string | null
  handleDuplicateStep: (step: ScenarioStep) => Promise<void>
  setDeleteStepError: Dispatch<SetStateAction<string>>
  setDeleteStepTarget: Dispatch<SetStateAction<ScenarioStep | null>>
  renderStepForm: () => React.JSX.Element
  showStepForm: boolean
  tags: TagOpt[]
  openAddStep: () => void
  openAddTemplateStep: () => void
  openAddQuestionStep: () => void
  shownStep: ScenarioStep | null
  startAccountLabel: string
  shownTpl: TemplateOpt | null
  saveErrors: ReturnType<typeof useSaveFormErrors>
}) {
  const tokenNames = useInsertTokenNames(scenario.lineAccountId)
  const startedAudience = stats?.activeNow ?? simulation?.audience.newStartPlanned
  const displayOrder = (order: number) => { const index = sortedSteps.findIndex((step) => step.stepOrder === order); return index < 0 ? '—' : String(index + 1) }
  return (      <div className={styles.body} data-design="Body" data-template-region="body">
        <div className={styles.left}>
          {!canEdit ? (
            <div className={styles.viewerBand}><ReadOnlyNotice role="status"></ReadOnlyNotice></div>
          ) : null}

          {/* 始めた直後の知らせ（nMSiE）。始めた記録への行き先を添える。 */}
          {justStarted && (
            <div className={styles.startedBand} role="status">
              <CircleCheck aria-hidden />
              <span className={styles.startedText}>
                {startedAudience == null ? '配信を始めました。人数を確認できません。' : `配信を始めました。予約中の ${formatNumber(startedAudience)} 人へ、条件を満たした人から順に送ります`}
              </span>
              <Link href={`/scenarios/results?id=${id}`} className={styles.startedLink}
                title={startedAt ? `開始日時：${startedAt}` : '開始日時を読み込めませんでした。始めた記録を読み直してください。'}>
                始めた記録を見る
              </Link>
            </div>
          )}

          {error ? <Notice tone="danger" message={error} /> : null}

          {/* 複製が途中で止まって残った作りかけの知らせ（SCENARIO-09）。 */}
          {duplicateRemainder && (
        <Notice tone="warn" action={<>
          <div className={styles.remainderActions}>
            <Button type="button" disabled={duplicating} onClick={() => void handleDuplicate()} variant="text" size="inline" busy={duplicating} busyLabel="複製中…">
              続きからやり直す
            </Button>
            <Link href={`/scenarios/detail?id=${duplicateRemainder.copyId}`}>コピーを確認する</Link>
            <Button variant="text" size="inline" data-notice-inline-action textTone="danger"
              type="button"
              disabled={discardingDuplicate}
              onClick={() => {
                setDiscardDuplicateError('')
                setDiscardDuplicateOpen(true)
              }}
            >
              作りかけのコピーを削除する
            </Button>
          </div>
        </>}>
          <p>前回の複製が途中で止まり、作りかけのコピーが残っています</p>
          <p className={styles.remainderDetail}>
            「{duplicateRemainder.copyName}」は{duplicateRemainder.stage}の途中で止まりました。
            続きからやり直すか、作りかけのコピーを削除してください。
          </p>
        </Notice>
          )}

          {/* 上の3つの箱：保存・開始のきっかけ・配信。ボタンは箱の下にそろう。 */}
          <div className={styles.stageCards}>
            <section className={styles.stageCard}>
              <p className={styles.stageHead}>
                <span className={styles.stageNum} aria-hidden>1</span>
                <span className={styles.stageTitle}>保存</span>
              </p>
              <p className={styles.stageMain}>
                {editDirty ? '未保存の変更があります' : `保存済み ${formatSavedAt(scenario.updatedAt)}`}
              </p>
              <p className={styles.stageNote}>保存しただけでは誰にも届きません</p>
            </section>

            <section className={styles.stageCard}>
              <p className={styles.stageHead}>
                <span className={styles.stageNum} aria-hidden>2</span>
                <span className={styles.stageTitle}>開始のきっかけ</span>
              </p>
              <p className={styles.stageMain}>{triggerHeadline}</p>
              <p className={styles.stageNote}>{`対象：${audienceConditionLabel}。きっかけが来た人から始まります`}</p>
              {canEdit ? (
                <div className={styles.stageAction}>
                  <Button variant="secondary" onClick={() => setTriggerOpen(true)}>
                    <SlidersHorizontal aria-hidden />
                    設定を変える
                  </Button>
                </div>
              ) : null}
            </section>

            <section className={styles.stageCard}>
              <p className={styles.stageHead}>
                <span className={styles.stageNum} aria-hidden>3</span>
                <span className={styles.stageTitle}>配信</span>
              </p>
              <div className={styles.stageState}>
                <StatusChip status={scenario.isActive ? 'running' : 'paused'} />
                <span className={styles.stageStateText}>{scenario.isActive ? '送っています' : '止めています'}</span>
              </div>
              <p className={styles.stageNote}>
                {scenario.isActive ? '止めても、途中の人の記録は残ります' : '再開すると、止めたところから続きを送ります'}
              </p>
              {canEdit ? (
                <div className={styles.stageAction}>
                  {scenario.isActive ? (
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setStopError('')
                        setStopOpen(true)
                      }}
                    >
                      <Pause aria-hidden />
                      一時停止する
                    </Button>
                  ) : (
                    <Button
                      variant="primary"
                      onClick={() => {
                        setStartError('')
                        setStartConfirmed(false)
                        setStartOpen(true)
                      }}
                      disabled={sortedSteps.length === 0}
                      title={sortedSteps.length === 0 ? '配る内容がまだありません' : undefined}
                    >
                      <Play aria-hidden />
                      配信を再開する
                    </Button>
                  )}
                </div>
              ) : null}
            </section>
          </div>

          {/* 数の帯：購読中・読み終えた・始まる見込み・離脱が多い所。 */}
          <KpiBand data-design="KPIs">
            <KpiCard title="購読中" value={stats?.activeNow} unit="人" detail="いま途中にいる人" />
            <KpiCard title="読み終えた" value={stats?.completed} unit="人" detail="最後の1通まで届いた人" />
            <KpiCard title="始まる見込み（試算）" value={simulation?.audience.newStartPlanned} loading={simulationRefreshing} unit="人" detail={simulationRefreshing ? "試算中です" : "きっかけが来たら始まる見込み。確定ではない"} />
            <KpiCard title="離脱が多い所" value={null} valueText={biggestDrop ? `${displayOrder(biggestDrop.fromOrder)}→${displayOrder(biggestDrop.toOrder)}通目` : '—'} unit="" detail={biggestDrop ? `${displayOrder(biggestDrop.fromOrder)}通目で ${formatNumber(biggestDrop.lost)}人（${Math.round(biggestDrop.rate * 100)}%）が離れています` : '大きく離れている所はまだありません'} />
          </KpiBand>

          {/* 最後の1通の後（行）。変える入口はこの行の右。 */}
          <div className={styles.onComplete}>
            <p className={styles.onCompleteLabel}>最後の1通の後</p>
            <p className={styles.onCompleteValue}>
              {ON_COMPLETE_SENTENCE[(scenario.onCompleteMode ?? 'pause') as OnCompleteMode]}
            </p>
            <p className={styles.onCompleteNote}>読み終えた人を次のシナリオへ送ることもできます</p>
            {canEdit ? (
              <Button variant="text" onClick={() => setOnCompleteOpen(true)}>
                <Pencil aria-hidden />
                変える
              </Button>
            ) : null}
          </div>

          {/* メッセージの行。選んだ通が右の欄に出る。 */}
          <h2 className={styles.sectionTitle}>{`メッセージ（${sortedSteps.length} 通）`}</h2>
          {sortedSteps.length === 0 ? (
            <p className={styles.emptyNote}>
              まだ配るものがありません。下の「メッセージを追加する」から1通目を作ってください。
            </p>
          ) : (
            <ol className={styles.stepList}>
              {sortedSteps.map((step, index) => {
                const tpl = step.templateId
                  ? templates.find((t) => t.id === step.templateId) ?? null
                  : null
                const kindLabel = stepKindShort(step, tpl?.name ?? null)
                const title = stepRowTitle(step, tpl?.name ?? null)
                const isShown = step.id === shownStepId
                return (
                  <Fragment key={step.id}>
                    {index > 0 && (
                      <li className={styles.insertRow}>
                        {canEdit ? (
                          <button
                            type="button"
                            onClick={() => openInsertStep(sortedSteps[index - 1].stepOrder)}
                            title={`${index} 通目と${index + 1} 通目のあいだに足します`}
                          >
                            ＋ ここに挿入
                          </button>
                        ) : (
                          <span className={styles.insertSpacer} aria-hidden />
                        )}
                      </li>
                    )}
                    <li
                      className={isShown ? styles.stepRowSelected : styles.stepRow}
                      onClick={() => setSelectedStepId(step.id)}
                    >
                      <span className={styles.stepNo}>{`${index + 1} 通目`}</span>
                      <span className={styles.stepWhen}>
                        <span className={styles.stepWhenMain}>{stepWhenLabel(deliveryMode, step, index)}</span>
                        {previewLabels[step.stepOrder] ? (
                          <span className={styles.stepWhenSub}>{previewLabels[step.stepOrder]}</span>
                        ) : null}
                      </span>
                      {canEdit ? (
                        <button
                          type="button"
                          className={styles.stepTitle}
                          onClick={(e) => {
                            e.stopPropagation()
                            if (editingStepId === step.id) {
                              closeStepForm()
                            } else {
                              openEditStep(step)
                            }
                          }}
                          title="この通を編集する"
                        >
                          <InsertText tokenNames={tokenNames} value={title} />
                        </button>
                      ) : (
                        <span className={styles.stepTitle}><InsertText tokenNames={tokenNames} value={title} /></span>
                      )}
                      {step.isDraft === true && <StatusChip status="draft" />}
                      <TagPill size="sm" name={kindLabel} color="var(--color-status-info)" aria-label={`種類「${kindLabel}」`} />
                      {canEdit ? (
                        <span className={styles.stepOps}>
                          <IconButton
                            type="button"
                            size="row"
                            aria-label={`${index + 1} 通目を上へ`}
                            disabled={index === 0}
                            title={reorderMoveReason(index, sortedSteps.length, -1) ?? undefined}
                            onClick={(e) => {
                              e.stopPropagation()
                              void handleMoveStep(step.id, 'up')
                            }}
                          >
                            <ArrowUp aria-hidden />
                          </IconButton>
                          <IconButton
                            type="button"
                            size="row"
                            aria-label={`${index + 1} 通目を下へ`}
                            disabled={index === sortedSteps.length - 1}
                            title={reorderMoveReason(index, sortedSteps.length, 1) ?? undefined}
                            onClick={(e) => {
                              e.stopPropagation()
                              void handleMoveStep(step.id, 'down')
                            }}
                          >
                            <ArrowDown aria-hidden />
                          </IconButton>
                          <span className={styles.menuBox} onClick={(e) => e.stopPropagation()}>
                            <RowMenu
                              appearance="plain"
                              size="row"
                              label={`${index + 1} 通目のその他操作`}
                              menuLabel={`${index + 1} 通目の操作`}
                              open={stepMenuId === step.id}
                              onOpenChange={(next) => setStepMenuId(next ? step.id : null)}
                              items={[
                                { id: 'edit', label: '編集', onSelect: () => openEditStep(step) },
                                { id: 'preview', label: 'プレビュー', onSelect: () => setSelectedStepId(step.id) },
                                ...(canTestSend ? [{
                                  id: 'test',
                                  label: 'テスト',
                                  onSelect: () => setTestSend({ stepId: step.id, label: `${index + 1} 通目` }),
                                }] : []),
                                /* この通を送ったあとに動かすアクション。件数を出すのは、設定済みを忘れて二重に足すのを防ぐため。 */
                                {
                                  id: 'action',
                                  label: `アクション${actionCounts[step.id] ? ` ${actionCounts[step.id]}` : ''}`,
                                  onSelect: () =>
                                    setActionTarget({
                                      hook: 'step_sent',
                                      stepId: step.id,
                                      choiceIndex: null,
                                      title: `${index + 1} 通目を送ったあと`,
                                    }),
                                },
                                {
                                  id: 'duplicate',
                                  label: 'この通を複製',
                                  disabled: duplicatingStepId === step.id,
                                  disabledReason: 'この通を複製しています',
                                  onSelect: () => {
                                    void handleDuplicateStep(step)
                                  },
                                },
                                {
                                  id: 'delete',
                                  label: 'この通を削除',
                                  tone: 'danger' as const,
                                  dividerBefore: true,
                                  onSelect: () => {
                                    setDeleteStepError('')
                                    setDeleteStepTarget(step)
                                  },
                                },
                              ]}
                            />
                          </span>
                        </span>
                      ) : null}
                    </li>
                    {editingStepId === step.id && <li className={styles.stepEdit}>{renderStepForm()}</li>}
                  </Fragment>
                )
              })}
            </ol>
          )}
          {/* 新規に足すときのフォーム（編集中の行の下ではなく、追加用）。 */}
          {showStepForm && <div className={styles.stepEdit}>{renderStepForm()}</div>}

          {/* 通ごとの数：配信対象・届いた数・配信後。行を見比べられるようにする。 */}
          {sortedSteps.length > 0 && (
            <section className={styles.statPanel}>
              <h2 className={styles.statPanelTitle}>通ごとの数</h2>
              <ol className={styles.statList}>
                {sortedSteps.map((step, index) => {
                  const stat = stats?.steps.find((v) => v.stepOrder === step.stepOrder)
                  const pct = scenarioReachPercent(stat?.reachRate)
                  const reachBarWidth = scenarioReachBarWidth(pct)
                  const after = describeAfterSend(step.afterSend)
                  const reachTag = step.onReachTagId
                    ? tags.find((t) => t.id === step.onReachTagId)?.name ?? null
                    : null
                  const audience = describeStepAudience(step.targetCondition, tags)
                  return (
                    <li key={step.id} className={styles.statRow}>
                      <span className={styles.statNo}>{`${index + 1} 通目`}</span>
                      <span className={styles.statAudience} title={audience}>
                        {audience}
                      </span>
                      <span className={styles.statBarCell}>
                        {step.isDraft === true ? (
                          <StatusBadge status="draft" size="compact" />
                        ) : (
                          <span className={styles.statBar} aria-hidden>
                            {/* WEB227：幅は scenarioReachBarWidth が「50%」の形で返す。もう一度 % を付けない。 */}
                            <span className={styles.statBarFill} style={{ width: reachBarWidth ?? '0%' }} />
                          </span>
                        )}
                      </span>
                      <span className={styles.statReachText}>
                        {step.isDraft === true || !stat
                          ? emptyValue('unknown')
                          : `到達 ${scenarioReachCountLabel(stat.reachedCount)}${pct !== null ? `・${scenarioReachPercentLabel(pct)}` : ''}`}
                      </span>
                      <span className={after.paused && !reachTag ? styles.statAfterPause : styles.statAfter}>
                        {reachTag ? `到達タグ：${reachTag}` : after.label}
                      </span>
                    </li>
                  )
                })}
              </ol>
            </section>
          )}

          {/* 行の下の文字ボタン 3 つ。押すと追加フォームが開く。閲覧のみには置かない。 */}
          {canEdit ? (
            <div className={styles.addRow}>
              <Button variant="text" onClick={openAddStep}>
                <Plus aria-hidden />
                メッセージを追加する
              </Button>
              <Button variant="text" onClick={openAddTemplateStep}>
                <FilePlus2 aria-hidden />
                テンプレートを追加する
              </Button>
              <Button
                variant="text"
                onClick={openAddQuestionStep}
                title="質問メッセージを足します。選択肢ごとにタグ・友だち情報・シナリオを動かせます"
              >
                <GitBranch aria-hidden />
                分岐を追加する
              </Button>
            </div>
          ) : null}
        </div>

        {/* 右の欄：選んだ通のスマホ。 */}
        {!showStepForm && editingStepId === null ? <aside className={styles.right} data-template-region="preview" data-preview-narrow="hidden">
            <LinePreview
              title={`選んだ通（${shownStep ? `${displayOrder(shownStep.stepOrder)}通目` : emptyValue('unknown')}）の見え方`}
              accountName={startAccountLabel === '全アカウント共通' ? '公式アカウント' : startAccountLabel}
              caption={
                shownStep
                  ? previewLabels[shownStep.stepOrder] ?? formatScheduleLabel(deliveryMode, shownStep)
                  : undefined
              }
              empty={shownStep ? false : '配る内容がまだありません'}
              note={shownStep && (shownTpl?.messageContent ?? shownStep.messageContent).trim() ? '名前や日時は見本の値です。' : undefined}
            >
              {shownStep
                ? (() => {
                    const t = shownTpl ? shownTpl.messageType : shownStep.messageType
                    const c = shownTpl ? shownTpl.messageContent : shownStep.messageContent
                    if (t === 'flex') return <FlexPreview content={c} />
                    if (t === 'image') {
                      try {
                        const parsed = JSON.parse(c)
                        const url = parsed.previewImageUrl || parsed.originalContentUrl
                        return url ? (
                          <img src={url} alt="配信画像の見え方" className={styles.talkImage} />
                        ) : (
                          <p className={styles.talkBubble}>画像（プレビューなし）</p>
                        )
                      } catch (saveFailure) {
                        saveErrors.capture(saveFailure);

                        return <p className={styles.talkBubble}>画像</p>
                      }
                    }
                    if (shownStep.question) {
                      const q = shownStep.question as { text?: string; choices?: { label?: string }[] }
                      return (
                        <div className={styles.talkBubble}>
                          {fillPreviewSample(q.text ?? shownStep.messageContent).text}
                          {(q.choices ?? []).map((choice, i) => (
                            <span key={i} className={styles.talkChoice}>
                              {choice.label ?? `選択肢${i + 1}`}
                            </span>
                          ))}
                        </div>
                      )
                    }
                    const sample = fillPreviewSample(c)
                    return <div className={styles.talkBubble}>{sample.text}</div>
                  })()
                : null}
            </LinePreview>
        </aside> : null}
      </div>
)
}
