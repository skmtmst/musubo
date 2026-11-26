'use client'

import { Check, Upload } from 'lucide-react'
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ComponentType } from 'react'
import Button from '@/components/shared/button'
import Dialog, { type DialogProps } from '@/components/shared/dialog'
import ImageMultiUpload from '@/components/shared/image-multi-upload'
import ImageMultiSelect from '@/components/shared/image-multi-select'
import SegmentedControl from '@/components/shared/segmented'
import ListState from '@/components/shared/list-state'
import RadioCard, { RadioCardGroup } from '@/components/shared/radio-card'
import SearchField from '@/components/shared/search-field'
import { api } from '@/lib/api'
import {
  BANNER_MAX_REFERENCE_IMAGES,
  BANNER_REFERENCE_MODES,
  BANNER_REFERENCE_MODE_LABEL,
  imageMatchesQuery,
  type BannerImage,
  type BannerPreset,
  type BannerProject,
  type BannerReference,
  type BannerReferenceMode,
} from '@/lib/hq-banners'
import { formatNumber } from '@/lib/format'

type Scope = 'all' | 'favorite' | 'project'

/**
 * 参照画像をライブラリから選ぶ。承認済み ★BG-C `cOgWE`（旧 ★V8 ）。
 *
 * 最大 3 枚まで選べる。タイルを押すと選ばれ、下の「選んだ画像の使い方」で
 * 1 枚ずつ使い方（土台にする／素材を一部使う／雰囲気を参考にする）を決める。
 * 手元のファイルは下の「ファイルを選ぶ」から（親がプロジェクトへ取り込んで参照にする）。
 */
export default function ReferencePickerDialog({
  open,
  projectId,
  presets,
  projects,
  selected,
  onClose,
  onPick,
  onLivePick,
  onUpload,
  frame: Frame = Dialog,
  hqLayout = false,
}: {
  open: boolean
  projectId: string
  presets: BannerPreset[]
  projects: BannerProject[]
  /** いま参照にしている画像と使い方（親の入力の値）。開いたときの初期選択になる。 */
  selected: BannerReference[]
  onClose: () => void
  /** 選び終わったとき。使い方つきの参照と、その画像の実体（親が手元に置く）を渡す。 */
  onPick: (references: BannerReference[], images: BannerImage[]) => void
  /**
   * 渡すと、押したその場で親の参照に入る（：［この画像を使う］の帯を持たない窓）。
   * 使い方は生成パネルの行で決める。下に手元の画像を落とす欄を置く。
   */
  onLivePick?: (references: BannerReference[], images: BannerImage[]) => void
  onUpload: (file: File) => void
  /** V8 の板が別の窓枠を描くときの差し替え。選択・検索・送信の動きは共有する。 */
  frame?: ComponentType<DialogProps>
  /** ：検索を次の行に置く4列の板。ほかの選択窓は変えない。 */
  hqLayout?: boolean
}) {

  /** 画像ごとのラジオ群を別の群として扱わせるための接頭辞。 */
  const uid = useId()
  const [images, setImages] = useState<BannerImage[] | null>(null)
  const [nextBefore, setNextBefore] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [scope, setScope] = useState<Scope>('all')
  const [query, setQuery] = useState('')
  /** 選んだ画像と使い方。並び順はプロンプトの「N枚目」と同じ。 */
  const [picks, setPicks] = useState<BannerReference[]>([])
  const fileRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setError('')
    void api.hqBanners.images
      .list({ limit: 60 })
      .then((res) => {
        if (cancelled) return
        if (!res.success) throw new Error(res.error)
        setImages(res.data)
        setNextBefore(res.nextBefore ?? null)
      })
      .catch(() => {
        if (!cancelled) setError('画像を読み込めませんでした。')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open])

  // 開くたび、親がいま参照にしている画像と使い方に戻す（取ってくる処理とは分ける）。
  useEffect(() => {
    if (open) setPicks(selected.slice(0, BANNER_MAX_REFERENCE_IMAGES).map((reference) => ({ ...reference })))
  }, [open, selected])

  const loadMore = async () => {
    if (!nextBefore || loading) return
    setLoading(true)
    try {
      const res = await api.hqBanners.images.list({ limit: 60, before: nextBefore })
      if (!res.success) throw new Error(res.error)
      setImages((prev) => [...(prev ?? []), ...res.data])
      setNextBefore(res.nextBefore ?? null)
    } catch {
      setError('続きを読み込めませんでした。')
    } finally {
      setLoading(false)
    }
  }

  /** R606: 検索0件の空状態から、検索語と絞り込みを外す。 */
  const clearSearchConditions = useCallback(() => {
    setQuery('')
    setScope('all')
  }, [])

  /**
   * 参照画像の名前と寸法（`cOgWE`）。名前はファイル名から拡張子を落とし、
   * 寸法は用途の指定寸法、無ければ画像自体の大きさを使う。
   */
  function referenceName(image: BannerImage): string {
    return image.media.filename.replace(/\.[a-z0-9]+$/i, '') || '画像'
  }

  function referenceSize(image: BannerImage, list: BannerPreset[]): string {
    const preset = image.generation ? list.find((p) => p.key === image.generation?.presetKey) : null
    const width = preset?.targetWidth ?? image.media.width
    const height = preset?.targetHeight ?? image.media.height
    return width && height ? `${width}×${height}` : '—'
  }

  const projectNames = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects])
  const visible = useMemo(() => {
    const list = images ?? []
    return list.filter((image) => {
      if (scope === 'favorite' && !image.isFavorite) return false
      if (scope === 'project' && image.projectId !== projectId) return false
      return imageMatchesQuery(image, query, projectNames.get(image.projectId) ?? '')
    })
  }, [images, scope, projectId, query, projectNames])

  /** 選んだ画像の実体。読み込んだ一覧から引く（並び順は選んだ順）。 */
  const pickedImages = useMemo(() => {
    const byId = new Map((images ?? []).map((image) => [image.id, image]))
    return picks
      .map((reference) => {
        const image = byId.get(reference.imageId)
        return image ? { reference, image } : null
      })
      .filter((entry): entry is { reference: BannerReference; image: BannerImage } => entry !== null)
  }, [images, picks])


  /** タイルを押したとき。選んでいれば外し、選んでいなければ 3 枚までで足す。 */
  const toggle = (image: BannerImage) => {
    const cur = picks
    const next = cur.some((reference) => reference.imageId === image.id)
      ? cur.filter((reference) => reference.imageId !== image.id)
      // 既定は「雰囲気を参考にする」。1 枚ずつ下の行（または生成パネル）で変えられる。
      : cur.length >= BANNER_MAX_REFERENCE_IMAGES ? cur : [...cur, { imageId: image.id, mode: 'inspire' as BannerReferenceMode }]
    setPicks(next)
    if (onLivePick && next !== cur) {
      const byId = new Map((images ?? []).map((candidate) => [candidate.id, candidate]))
      onLivePick(next, next.map((reference) => byId.get(reference.imageId)).filter((candidate): candidate is BannerImage => Boolean(candidate)))
    }
  }

  const setUsage = (imageId: string, mode: BannerReferenceMode) => {
    setPicks((cur) => cur.map((reference) => (reference.imageId === imageId ? { ...reference, mode } : reference)))
  }

  return (
    <Frame
      open={open}
      title="参照画像を選ぶ"
      description={
        onLivePick
          ? `ライブラリから最大 ${BANNER_MAX_REFERENCE_IMAGES} 枚選べます。押すとすぐ参照に入り、使い方は生成パネルで 1 枚ずつ決められます。`
          : `ライブラリから最大 ${BANNER_MAX_REFERENCE_IMAGES} 枚選べます。選んだ画像は、下で 1 枚ずつ使い方を決められます。`
      }
      onCancel={onClose}
      error={error || undefined}
      designNode="cOgWE"
      /*
       * 下の段。余白と区切り線（★V8 の窓 `q3DPdz` の下段と同じ 14/24）は
       * 共通の窓が自前の footer には付けないので、ここで持つ
       * （2026-10-06 オーナー指示「枠の隅までボタンがあり余白がない」）。
       */
      footer={onLivePick ? undefined :
        <div className={Frame === Dialog ? 'flex w-full flex-wrap items-center gap-2 border-t border-hairline px-6 py-3.5' : 'flex w-full flex-wrap items-center gap-2'}>
          <Button onClick={() => fileRef.current?.click()}>
            <Upload aria-hidden="true" className="h-4 w-4" />
            ファイルを選択する
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="sr-only"
            aria-label="参照画像のファイルを選ぶ"
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) onUpload(file)
            }}
          />
          <span className="flex-1" />
          <Button onClick={onClose}>キャンセル</Button>
          <Button
            variant="primary"
            disabled={picks.length === 0}
            disabledReason={picks.length === 0 ? '使う画像を選んでください。' : undefined}
            onClick={() => onPick(picks, pickedImages.map(({ image }) => image))}
          >
            <Check aria-hidden="true" className="h-4 w-4" />
            {picks.length === 0 ? 'この画像を使う' : `この ${formatNumber(picks.length)} 枚を使う`}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        {/* 絞り込み行（`cOgWE`）。チップが左、検索が右。 */}
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl
            aria-label="参照画像の範囲"
            value={scope}
            onChange={setScope}
            options={[
              { value: 'all', label: 'すべて' },
              { value: 'project', label: 'このプロジェクト' },
              { value: 'favorite', label: 'お気に入り' },
            ]}
          />
          <span className={hqLayout ? "w-full" : "flex-1"} />
          <div className="w-60 max-w-full">
            <SearchField value={query} onChange={setQuery} onClear={() => setQuery('')} placeholder="画像名・プロジェクト名で検索" aria-label="参照画像を検索" />
          </div>
        </div>

        {images === null ? (
          <ListState kind="loading" title="画像を読み込んでいます" />
        ) : visible.length === 0 ? (
          <>
            {/*
              R606: 全画像0件と検索一致0件を区別する。画像があるのに
              絞り込んで0件のときは未登録の説明を出さず、条件を外す口を付ける。
            */}
            {images.length === 0 ? (
              <ListState kind="empty" title="選べる画像がありません" description="生成した画像や取り込んだ画像がここに並びます。手元のファイルを選ぶこともできます。" />
            ) : (
              <ListState
                kind="empty"
                emptyPreset="filtered"
                action={<Button onClick={clearSearchConditions}>条件を外す</Button>}
              />
            )}
          </>
        ) : (
          <ImageMultiSelect
            designNode="exeSo" compact={hqLayout} max={BANNER_MAX_REFERENCE_IMAGES}
            items={visible.map(image => ({ id: image.id, url: image.media.url, name: referenceName(image), size: referenceSize(image, presets) }))}
            selectedIds={picks.map(reference => reference.imageId)}
            onToggle={id => { const image = visible.find(item => item.id === id); if (image) toggle(image) }}
          />
        )}

        {/* 選んだ画像の使い方（`JOi8G`）。1 枚ずつ決める。選んでいないときは出さない。 */}
        {/* UcBQ5：その場で選ぶ窓は、下に手元の画像を落とす欄。使い方は生成パネルの行で決める。 */}
        {onLivePick ? (
          <ImageMultiUpload presentation="library" onUpload={onUpload} />
        ) : null}

        {!onLivePick && pickedImages.length > 0 ? (
          <div data-design-node="JOi8G" className="flex flex-col gap-2 rounded-control bg-canvas-sunken p-3">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-label font-medium text-ink">選んだ画像の使い方</span>
              <span className="text-micro text-ink-faint">画像ごとに決めます・あとから生成パネルでも変えられます</span>
            </div>
            <ul className="flex flex-col gap-2">
              {pickedImages.map(({ reference, image }) => (
                <li key={reference.imageId} className="flex flex-wrap items-center gap-3">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img width={28} height={28} src={image.media.url} alt="" className="h-7 w-7 shrink-0 rounded-mini object-cover" loading="lazy" />
                  <span className="w-36 truncate text-caption font-semibold text-ink">{referenceName(image)}</span>
                  {/* 使い方は 3 択を行の中に並べて直接選ぶ（★BG-C `B3hdL4`「ルール3択」）。
                      素の radio は使わず、共通の RadioCard の行版で出す。
                      外す操作は承認デザインの行に描かれていないので置かない。
                      画像タイルを押し直す toggle() で選択解除できる（既存動作）。 */}
                  <RadioCardGroup
                    legend={`${referenceName(image)}の使い方`}
                    className="flex flex-wrap items-center gap-5"
                  >
                    {BANNER_REFERENCE_MODES.map((mode) => (
                      <RadioCard
                        key={mode}
                        variant="row"
                        name={`${uid}-usage-${reference.imageId}`}
                        value={mode}
                        checked={reference.mode === mode}
                        onChange={(next) => setUsage(reference.imageId, next as BannerReferenceMode)}
                        title={BANNER_REFERENCE_MODE_LABEL[mode]}
                      />
                    ))}
                  </RadioCardGroup>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {nextBefore ? (
          <div className="flex justify-center">
            <Button onClick={() => void loadMore()} disabled={loading} busy={loading} busyLabel="読み込んでいます…">続きを読み込む
            </Button>
          </div>
        ) : null}
      </div>
    </Frame>
  )
}
