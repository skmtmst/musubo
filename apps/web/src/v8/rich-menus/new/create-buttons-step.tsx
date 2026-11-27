'use client'

import { AreaProperties } from '@/components/rich-menus/area-properties'
import { CanvasEditor, areaDisplayName } from '@/components/rich-menus/canvas-editor'
import { type Area } from '../../../components/rich-menus/area-types'
import { NEW_MENU_INTENTS_WITH_SWITCH } from '../../../components/rich-menus/rich-menu-create-model'
import Button from '@/components/shared/button'
import Card from '@/components/shared/card'
import { SaveErrorField, SaveErrorScope } from '@/components/shared/save-form-errors'
import SectionHeader from '@/components/shared/section-header'
import SegmentedControl from '@/components/shared/segmented'
import TapAreaEditor from '@/components/shared/tap-area-editor'
import { HQ_RICH_MENU_INTENTS } from '@/lib/hq-rich-menu-create'
import type { RichMenuCreateHost } from '@/lib/rich-menu-create-host'
import { useFormErrors } from '@/lib/use-form-errors'
import type { Dispatch,SetStateAction } from 'react'
import { type StepKey } from './create-options'
import { type Group,type Page } from './create-types'
import styles from '../../../app/rich-menus/new/create-v8.module.css'

type RenderButtonsStepContext = {
  activePage: Page
  addArea: (pageId: string, area: Area) => void
  areaActionSummary: (area: Area) => string
  deleteArea: (pageId: string, areaId: string) => void
  fields: ReturnType<typeof useFormErrors>
  forms: { id: string; name: string; folderId?: string | null; updatedAt?: string | null; }[]
  goToStep: (key: StepKey) => void
  group: Group | null
  host: RichMenuCreateHost | undefined
  pageImageUrl: string | null
  pages: Page[]
  publishLabelErrors: ReturnType<typeof useFormErrors>
  selectedArea: Area | null
  selectedAreaId: string | null
  setActivePageId: Dispatch<SetStateAction<string | null>>
  setSelectedAreaId: Dispatch<SetStateAction<string | null>>
  size: "large" | "compact"
  tags: { id: string; name: string; }[]
  templates: { id: string; name: string; }[]
  trackedLinks: { id: string; name: string; }[]
  updateArea: (pageId: string, areaId: string, patch: Partial<Area>) => void
}

function areaLabelCode(index: number): string {
  if (index < 0) return ''
  return index < 26 ? String.fromCharCode(65 + index) : String(index + 1)
}

export function renderButtonsStep({ activePage, addArea, areaActionSummary, deleteArea, fields, forms, goToStep, group, host, pageImageUrl, pages, publishLabelErrors, selectedArea, selectedAreaId, setActivePageId, setSelectedAreaId, size, tags, templates, trackedLinks, updateArea }: RenderButtonsStepContext) {
    if (!activePage) return <div className={styles.stateCard}>ページがありません</div>
    const activeIndex = activePage.areas.findIndex((a) => a.id === selectedAreaId)
    const matchedArea = activeIndex >= 0 ? activePage.areas[activeIndex]! : null
    const activeArea = matchedArea ? (selectedArea?.id === matchedArea.id ? selectedArea : matchedArea) : null
    const hasArea = (id: string) => activePage.areas.some((a) => a.id === id)
    const selectArea = (id: string | null) => {
      if (id === null) { setSelectedAreaId(null); return }
      if (!hasArea(id)) return
      setSelectedAreaId(id)
    }
    const updateExistingArea = (id: string, patch: Partial<Area>) => {
      if (!hasArea(id)) return
      updateArea(activePage.id, id, patch)
    }
    const deleteExistingArea = (id: string) => {
      if (!hasArea(id)) return
      deleteArea(activePage.id, id)
    }
    const areaPages = pages
      .filter((p) => host || !p.id.startsWith('tmp-'))
      .map((p) => ({ id: p.id, name: p.name }))

    /*
     * 採用案 K6Ot7O：切替タブは①で決め、②は「直すタブ」の切り替えだけ（タブがないときは出さない）。
     * 採用案 Wmch0：画像（幅 320）を左、面の一覧を右、その下に選んだ面の動き（共通部品 TapAreaEditor）。
     */
    const tabSwitch = pages.length > 1 ? (
      <div className={styles.tabSwitchRow}>
        <span className={styles.segLabel}>直すタブ</span>
        <SaveErrorField names={["id","activePage.id","activePageId"]}><SegmentedControl
          aria-label="直すタブ"
          size="compact"
          options={pages.map((p, i) => ({ value: p.id, label: `タブ${i + 1}「${p.name}」` }))}
          value={activePage.id}
          onChange={(id) => {
            const nextPage = pages.find((p) => p.id === id)
            if (!nextPage) return
            setActivePageId(nextPage.id)
            setSelectedAreaId(nextPage.areas[0]?.id ?? null)
          }}
        /></SaveErrorField>
        <Button type="button" variant="text" textTone="ink" className={styles.tabSwitchLink} onClick={() => goToStep('shape')}>
          タブの数・名前・画像は ①形と画像 で変えます
        </Button>
      </div>
    ) : null

    return (
      <TapAreaEditor
        head={tabSwitch}
        description="面を押すと、下に動きを決める欄が出ます。線を動かして区切り直せます"
        items={activePage.areas.map((area, i) => ({
          id: area.id,
          name: areaDisplayName(area, i),
          summary: areaActionSummary(area) || null,
          errorCount: fields.countIn(`area-${area.id}`),
        }))}
        selectedId={selectedAreaId}
        onSelect={selectArea}
        emptyNote="画像の上をドラッグすると、面を足せます。"
        canvas={
          <CanvasEditor
            appearance="v8"
            showAreaList={false}
            showTools
            showZoom={false}
            maxWidth={320}
            areas={activePage.areas}
            size={group?.size ?? size}
            imageUrl={pageImageUrl}
            selectedAreaId={selectedAreaId}
            onSelectArea={selectArea}
            onAddArea={(area) => addArea(activePage.id, area)}
            onUpdateArea={updateExistingArea}
            onDeleteArea={deleteExistingArea}
          />
        }
        detail={
          activeArea && activeIndex >= 0 ? (
            <div {...fields.bind(`area-${activeArea.id}`)}>
            <Card padding="roomy" layout="vertical">
              <SectionHeader title={`面 ${areaLabelCode(activeIndex)}「${areaDisplayName(activeArea, activeIndex)}」の動き`} />
              <SaveErrorScope errors={publishLabelErrors}><AreaProperties
                area={activeArea}
                pages={areaPages}
                tags={tags}
                templates={templates}
                forms={forms}
                trackedLinks={trackedLinks}
                taps={null}
                onUpdate={(patch) => updateExistingArea(activeArea.id, patch)}
                onDelete={() => deleteExistingArea(activeArea.id)}
                showManagementDetails={false}
                allowedIntents={host ? [...HQ_RICH_MENU_INTENTS] : NEW_MENU_INTENTS_WITH_SWITCH}
                error={fields.error(`area-${activeArea.id}`)}
              /></SaveErrorScope>
              <div>
                <Button type="button" variant="text" onClick={() => deleteExistingArea(activeArea.id)}>
                  この面を消す
                </Button>
              </div>
            </Card>
            </div>
          ) : (
            <Card padding="roomy" layout="vertical">
              <p className={styles.cardNote}>上の画像で面を押すと、ここで動きを決められます。</p>
            </Card>
          )
        }
      />
    )
  }
