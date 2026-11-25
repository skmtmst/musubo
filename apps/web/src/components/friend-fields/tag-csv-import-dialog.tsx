'use client'

import { describeApiFailure } from '@/components/shared/api-error-message'
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Download, X } from 'lucide-react'
import type {
  TagCsvImportInputRow,
  TagCsvImportPreview,
  TagCsvImportResult,
  TagCsvImportRowResult,
} from '@line-crm/shared'
import { api } from '@/lib/api'
import CsvTemplateDownload from '@/components/shared/csv-template-download'
import { DialogActions } from '@/components/shared/dialog'
import Button from '@/components/shared/button'
import HelpTip from '@/components/shared/help-tip'
import FileDropzone, { AttachmentRow } from '@/components/shared/file-drop'
import SegmentedControl from '@/components/shared/segmented'
import { useOverlayFocus } from '@/components/shared/overlay-utils'
import { TableHeadRow, Th } from '@/components/shared/table'
import {
  TAG_IMPORT_HEADERS,
  failedTagRowsCsv,
  parseTagCsv,
  TAG_CSV_MAX_BYTES,
  TagCsvParseError,
} from './tag-csv-import'
import styles from './tag-csv-import-dialog.module.css'
import { formatYmd, formatNumber } from '@/lib/format'
import { useSaveFormErrors } from '@/components/shared/save-form-errors'
import Notice from '@/components/shared/notice'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import { downloadCsv } from '@/components/shared/csv-download'

const PREVIEW_ROW_STEP = 100

type Phase = 'select' | 'preview' | 'saving' | 'success' | 'partial'
type PreviewFilter = 'all' | 'ready' | 'skipped' | 'invalid'

const STATUS_LABEL: Record<TagCsvImportRowResult['status'], string> = {
  ready: '新規',
  created: '登録済み',
  skipped: '飛ばす',
  invalid: 'エラー',
  failed: 'エラー',
}

function todayInJapan() {
  return formatYmd(new Date())
}

/** 選んだCSVの大きさを行に出すだけの短い表記。 */
function formatTagCsvBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024) * 10) / 10}MB`
  return `${Math.max(1, Math.round(bytes / 1024))}KB`
}

export default function TagCsvImportDialog({
  open,
  onClose,
  onCompleted,
}: {
  open: boolean
  onClose: () => void
  onCompleted: () => void
}) {
  const saveErrors = useSaveFormErrors()

  const [mounted, setMounted] = useState(false)
  const [phase, setPhase] = useState<Phase>('select')
  const [rows, setRows] = useState<TagCsvImportInputRow[]>([])
  const [fileName, setFileName] = useState('')
  const [fileSize, setFileSize] = useState<number | null>(null)
  const [preview, setPreview] = useState<TagCsvImportPreview | null>(null)
  const [result, setResult] = useState<TagCsvImportResult | null>(null)
  const [filter, setFilter] = useState<PreviewFilter>('all')
  /*
   * 2026-10-07 速さ：確認の表は最初の 100 行だけ描き、続きは「もっと見る」で足す。
   * 500 行を全部描くと表だけで 3,500 要素になる。エラーの行は上の「エラー」で絞れる。
   */
  const [shownRows, setShownRows] = useState(PREVIEW_ROW_STEP)
  const [error, setError] = useState('')
  const busy = phase === 'saving'
  const panelRef = useOverlayFocus(open, onClose, busy)

  useEffect(() => setMounted(true), [])

  const visiblePreviewRows = useMemo(() => {
    if (!preview) return []
    if (filter === 'all') return preview.rows
    return preview.rows.filter((row) => row.status === filter)
  }, [filter, preview])

  if (!mounted || !open) return null

  const pickFile = async (file: File | undefined) => {
    setError('')
    setRows([])
    setPreview(null)
    if (!file) { setFileName(''); setFileSize(null); return }
    setFileName(file.name)
    setFileSize(file.size)
    if (file.size > TAG_CSV_MAX_BYTES) {
      setError('CSVは1MB以下にしてください')
      return
    }
    try {
      setRows(parseTagCsv(await file.text()))
    } catch (reason) {
      const fieldFailure = saveErrors.capture(reason)

      { if (!fieldFailure) setError(reason instanceof TagCsvParseError ? describeApiFailure(reason, 'CSVの読み取り') : 'CSVを読み取れませんでした') }
    }
  }

  const resetSelection = () => {
    setPhase('select')
    setRows([])
    setFileName('')
    setFileSize(null)
    setPreview(null)
    setResult(null)
    setFilter('all')
    setError('')
  }

  const confirmRows = async () => {
    if (rows.length === 0) return
    setError('')
    try {
      const response = await api.tags.importPreview(rows)
      if (!response.success) throw new Error(response.error)
      setPreview(response.data)
      setShownRows(PREVIEW_ROW_STEP)
      setPhase('preview')
    } catch (reason) {
      const fieldFailure = saveErrors.capture(reason)

      { if (!fieldFailure) setError(describeApiFailure(reason, '取り込み')) }
    }
  }

  const saveRows = async () => {
    if (!preview || preview.summary.ready === 0) return
    setPhase('saving')
    setError('')
    try {
      const response = await api.tags.importCsv(rows)
      if (!response.success) throw new Error(response.error)
      setResult(response.data)
      setPhase(response.data.outcome === 'success' ? 'success' : 'partial')
      if (response.data.summary.created > 0) onCompleted()
    } catch (reason) {
      const fieldFailure = saveErrors.capture(reason)

      setPhase('preview')
      { if (!fieldFailure) setError(describeApiFailure(reason, '登録')) }
    }
  }

  const close = () => {
    if (!busy) onClose()
  }

  const panelClass = phase === 'preview' || phase === 'saving'
    ? styles.previewPanel
    : phase === 'partial'
      ? styles.partialPanel
      : phase === 'success'
        ? styles.successPanel
        : styles.selectPanel
  const designNode = phase === 'preview' || phase === 'saving'
    ? 'sfTEW'
    : phase === 'success'
      ? 'op1rh'
      : phase === 'partial'
        ? 'QzRsJ'
        : 'H374MR'

  const content = (
    <div className={styles.overlay} role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) close()
    }}>
      <section
        ref={panelRef}
        className={`${styles.panel} ${panelClass}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tag-csv-title"
        aria-busy={busy || undefined}
        data-design-node={designNode}
        tabIndex={-1}
      >
        {/* 閉じ方は右上の×に一本化（UI-25）。 */}
        <button type="button" className="absolute right-3 top-3 z-10 inline-flex items-center justify-center rounded-mini p-1.5 text-ink-secondary hover:bg-canvas-sunken hover:text-ink" onClick={close} disabled={busy} aria-label="閉じる">
          <X aria-hidden="true" size={20} />
        </button>
        {phase === 'select' ? <>
          <header className={styles.header}>
            <h2 id="tag-csv-title" className={styles.title}>CSVでタグを一括登録</h2>
            <p className={styles.description}>タグ名とフォルダ名をCSVからまとめて読み込みます。最大500件まで確認できます。</p>
          </header>
          <div className={styles.body}>

            {/*
              登録の実行は1回のAPI呼び出しで、途中の割合を測れない。
              実測できない進みは出さない（Progress は足さない）。
            */}
            <div className="flex shrink-0 items-center justify-center gap-2">
              <CsvTemplateDownload headers={TAG_IMPORT_HEADERS} name="タグ" />
              <HelpTip label="タグCSVの列と登録手順">1列目に「タグ名」、2列目に「フォルダ名」を入れます。先頭行は「タグ名,フォルダ」の見出しにできます。確認画面で、新規・見送り・入力確認を確かめてから登録します。フォルダが見つからない行は、確認画面で知らせたうえで未分類として登録します。</HelpTip>
            </div>
            <FileDropzone
              title="ここにCSVを置く"
              hint="UTF-8・最大500件・1MB以下"
              accept=".csv,text/csv"
              chooseLabel="CSVを選択する"
              onFiles={(files) => void pickFile(files[0])}
            />
            {fileName ? (
              <div>
                {error && rows.length === 0 ? (
                  <AttachmentRow
                    name={fileName}
                    status="error"
                    errorText={error}
                    onRemove={resetSelection}
                  />
                ) : (
                  <AttachmentRow
                    name={fileName}
                    meta={fileSize != null ? `${formatNumber(rows.length)}件・${formatTagCsvBytes(fileSize)}` : `${formatNumber(rows.length)}件`}
                    onRemove={resetSelection}
                  />
                )}
              </div>
            ) : null}
          </div>
          {/* ファイル由来の誤りは上の行に出ているので、ここでは重ねて出さない。 */}
          {error && !(fileName && rows.length === 0) ? <Notice tone="danger" marker="dot" heading="失敗：CSVの取り込みを進められませんでした" role="alert">
            {error}
          </Notice> : null}
          <DialogActions padding="none">
            <Button type="button" onClick={close}>キャンセル</Button>
            <Button type="button" variant="primary" disabled={rows.length === 0} disabledReason={rows.length === 0 ? 'CSVファイルを選ぶと確認できます。' : undefined} onClick={() => void confirmRows()}>取り込む内容を確認</Button>
          </DialogActions>
        </> : null}

        {phase === 'preview' || phase === 'saving' ? <>
          <header className={styles.header}>
            <h2 id="tag-csv-title" className={styles.title}>取り込む内容の確認</h2>
            {/*
              設計 `sfTEW` は見出しの下に**どのファイルの何行か**を出す。
              確認画面を開いたまま別のCSVを選び直せるので、いま見ている数が
              どのファイルのものか分からないと確かめようがない。
            */}
            <p className={styles.description}>
              {preview ? `${fileName || '選んだCSV'} ／ ${formatNumber(preview.summary.total)}行を読み込みました。` : null}
              登録するとどうなるかを、行ごとに確かめてください。
            </p>
          </header>
          <div className={styles.body}>
          {preview ? <>
            <KpiBand density="compact" border="dividers">
              <KpiCard title="読み込んだ行" value={preview.summary.total} unit="件" detail="ファイルの行数" />
              <KpiCard title="新しく作る" value={preview.summary.ready} unit="件" detail="そのまま登録されます" />
              <KpiCard title="飛ばす" value={preview.summary.skipped} unit="件" detail="同じ名前のタグがあります" />
              <KpiCard title="エラー" value={preview.summary.invalid} unit="件" detail="直すまで登録されません" />
            </KpiBand>
            <div className={styles.filters}>
              <SegmentedControl<PreviewFilter>
                aria-label="取り込む行の絞り込み"
                value={filter}
                onChange={(next) => { setFilter(next); setShownRows(PREVIEW_ROW_STEP) }}
                options={([
                  ['all', 'すべて', preview.summary.total],
                  ['ready', '新規', preview.summary.ready],
                  ['skipped', '飛ばす', preview.summary.skipped],
                  ['invalid', 'エラー', preview.summary.invalid],
                ] as Array<[PreviewFilter, string, number]>).map(([value, label, count]) => ({ value, label, count }))}
              />
            </div>
            <div className={styles.tableFrame}>
              <table className={styles.table}>
                <colgroup><col style={{ width: '7%' }} /><col style={{ width: '26%' }} /><col style={{ width: '21%' }} /><col style={{ width: '12%' }} /><col /></colgroup>
                <thead><TableHeadRow><Th>行</Th><Th>タグ名</Th><Th>フォルダ</Th><Th>扱い</Th><Th>理由</Th></TableHeadRow></thead>
                <tbody>{visiblePreviewRows.slice(0, shownRows).map((row) => <tr key={`${row.line}-${row.name}`}>
                  <td>{row.line}</td>
                  <td className={styles.truncate} title={row.name}>{row.name || '（空欄）'}</td>
                  <td className={styles.truncate} title={row.folderName}>{row.folderName || '未分類'}</td>
                  <td><span className={`${styles.badge} ${styles[row.status]}`}>{STATUS_LABEL[row.status]}</span></td>
                  <td>{row.message ?? '登録できます'}</td>
                </tr>)}</tbody>
              </table>
              {visiblePreviewRows.length > shownRows ? (
                <div className={styles.moreRows}>
                  <Button type="button" variant="text" onClick={() => setShownRows((n) => n + PREVIEW_ROW_STEP)}>
                    {`もっと見る（残り${visiblePreviewRows.length - shownRows}行）`}
                  </Button>
                </div>
              ) : null}
            </div>
            {/*
              設計 `sfTEW` の注意帯。**押す前に、押したらどうなるかを言う。**
              とくに「同じ名前のタグは上書きしない」は、CSVでフォルダを
              直そうとして見送られたときに、どこへ行けばよいか分からなくなる。
            */}
              <Notice tone="warn" marker="dot" heading={<>要確認：{preview.summary.invalid > 0
                ? `エラーの${preview.summary.invalid}行は登録されません`
                : '登録できる行だけを登録します'}</>}>
                <p className={styles.warnBody}>
                  通る{preview.summary.ready}行はそのまま登録します。
                  エラーの行はCSVを直してから、もう一度取り込んでください。同じ名前のタグは上書きしません。
                </p>
              </Notice>
          </> : null}
          </div>
          {error ? <Notice tone="danger" marker="dot" heading="失敗：CSVの取り込みを進められませんでした" role="alert">
            {error}
          </Notice> : null}
          <DialogActions padding="none">
            <Button type="button" disabled={busy} onClick={resetSelection}>キャンセル</Button>
            <Button type="button" variant="primary" disabled={busy || !preview || preview.summary.ready === 0} disabledReason={!preview || preview.summary.ready === 0 ? '登録できる行がありません。CSVを直して選び直してください。' : undefined} onClick={() => void saveRows()} busy={busy} busyLabel="登録中…">
              {`${preview?.summary.ready ?? 0}件を登録する`}
            </Button>
          </DialogActions>
        </> : null}

        {phase === 'success' && result ? <>
          <div className={styles.body}>
            <Notice tone="success" marker="dot">
              <h2 id="tag-csv-title" className={styles.resultTitle}>{result.summary.created}件を登録しました</h2>
            </Notice>
            <div className={styles.breakdown}>
              <strong>フォルダの内訳</strong>
              <p>{Object.entries(result.rows.filter((row) => row.status === 'created').reduce<Record<string, number>>((counts, row) => {
                const key = row.folderName || '未分類'
                counts[key] = (counts[key] ?? 0) + 1
                return counts
              }, {})).map(([name, count]) => `${name} ${formatNumber(count)}件`).join('・')}</p>
              {result.summary.skipped > 0 ? <p>同じ名前だった{formatNumber(result.summary.skipped)}件は、上書きせずに飛ばしました。</p> : null}
            </div>
          </div>
          <DialogActions padding="none"><Button type="button" variant="primary" onClick={close}>一覧へ戻る</Button></DialogActions>
        </> : null}

        {phase === 'partial' && result ? <>
          <div className={styles.body}>
            <Notice tone="warn" marker="dot">
              <h2 id="tag-csv-title" className={styles.resultTitle}>
                要確認：{result.summary.created > 0
                  ? `${result.summary.created}件を登録し、${result.summary.invalid + result.summary.failed}件は入りませんでした`
                  : 'タグを登録できませんでした'}
              </h2>
            </Notice>
            <p className={styles.partialDescription}>入らなかった行だけを下に出しています。直して取り込み直せば、この{result.summary.invalid + result.summary.failed}件だけが登録されます。すでに登録した{result.summary.created}件は二重になりません（同じ名前は飛ばすため）。</p>
            <div className={styles.tableFrame}>
              <table className={styles.table}>
                <colgroup><col style={{ width: '9%' }} /><col style={{ width: '32%' }} /><col /></colgroup>
                <thead><TableHeadRow><Th>行</Th><Th>タグ名</Th><Th>入らなかった理由</Th></TableHeadRow></thead>
                <tbody>{result.rows.filter((row) => row.status === 'invalid' || row.status === 'failed').slice(0, 5).map((row) => <tr key={`${row.line}-${row.name}`}>
                  <td>{row.line}</td><td className={styles.truncate} title={row.name}>{row.name || '（空欄）'}</td>
                  <td>{row.message}</td>
                </tr>)}</tbody>
              </table>
            </div>
          </div>
          <DialogActions padding="none">
            <Button className={styles.exportButton} type="button" onClick={() => downloadCsv(failedTagRowsCsv(result.rows), `タグ一括登録-要修正-${todayInJapan()}.csv`)}>
              <Download aria-hidden="true" size={16} /> 入らなかった{result.summary.invalid + result.summary.failed}行をCSVで出す
            </Button>
            <Button type="button" variant="primary" onClick={close}>一覧へ戻る</Button>
          </DialogActions>
        </> : null}
      </section>
    </div>
  )

  return createPortal(content, document.body)
}
