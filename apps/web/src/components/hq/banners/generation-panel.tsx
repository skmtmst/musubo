'use client'

import Button from '@/components/shared/button'
import Card from '@/components/shared/card'
import Dialog from '@/components/shared/dialog'
import ColorWell from '@/components/shared/color-well'
import ImageMultiUpload from '@/components/shared/image-multi-upload'
import HelpTip from '@/components/shared/help-tip'
import Radio from '@/components/shared/radio'
import RadioCard,{ RadioCardGroup } from '@/components/shared/radio-card'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import SegmentedControl from '@/components/shared/segmented'
import Select from '@/components/shared/select'
import { TextArea,TextField } from '@/components/shared/text-field'
import {
BANNER_MAX_REFERENCE_IMAGES,
BANNER_REFERENCE_MODES,
BANNER_REFERENCE_MODE_DESCRIPTION,
BANNER_REFERENCE_MODE_LABEL,
COLOR_ROLES,
CUSTOM_PROMPT_MAX,
TEXT_LINE_LENGTH_MAX,
TEXT_LINE_MAX,
alignEmphasis,
presetCardLabel,
presetSizeLabel,
tileCaption,
type BannerColorRoleKey,
type BannerGenerationInput,
type BannerImage,
type BannerPreset,
type BannerReferenceMode,
type BannerUsage,
} from '@/lib/hq-banners'
import { Images,Layers,Plus,Scissors,Sparkles,Upload,X } from 'lucide-react'
import { useId,useRef,useState,type ReactNode } from 'react'
import styles from './generation-panel.module.css'
import { UsageBars } from './generation-usage'
import LimitState from './limit-state'


/**
 * 使い方の説明に添える印。★BG-B `R6MBHf` の子の icon そのまま（lucide・14px・`$ink-secondary`）。
 * `pBYPP`=layers（土台にする）／`L2e1G`=scissors（素材を一部使う）／`q0T2d`=sparkles（雰囲気を参考にする）。
 */
const BANNER_REFERENCE_MODE_ICON: Record<BannerReferenceMode, typeof Layers> = {
  edit: Layers,
  parts: Scissors,
  inspire: Sparkles,
}

/**
 * 右 390px の生成パネル。Pencil 35-2 `GcJHv`（2026-09-13 に参照画像欄を足して作り直し）。
 *
 * 運用者に見せるのは「作りたい内容・参照画像・用途・テキスト・色・人物・枚数」だけ。
 * 品質やクレジットの選択は置かない（2026-09-12 決定、`docs/hq-banner-generation.md`）。
 *
 * 2026-10-06（オーナー指示）：
 * - 「バナー／自由入力」の切替は使い分けが分かりにくいので置かない。入力は1種類だけ。
 * - 「切り抜きの位置」と点線の枠は機能外なので画面に出さない（中央で整形する）。
 * - 選択肢は小さい箱（`variant="compact"`）で細く並べる。印・丸は出さない。
 *
 * 単一選択（人物・枚数・色の見本）は radio で組む。見た目は label が持つ。
 */
export default function GenerationPanel({
  presets,
  maxCount,
  value,
  onChange,
  disabled,
  referenceImages,
  onPickReference,
  onUploadReference,
  referenceBusy,
  usage,
  onReloadUsage,
  usageHeading,
  monthRemaining,
  v8Layout = false,
  accountSelector,
}: {
  accountSelector?: ReactNode
  presets: BannerPreset[]
  maxCount: number
  value: BannerGenerationInput
  onChange: (next: BannerGenerationInput) => void
  disabled?: boolean
  /** 選んでいる参照画像の実体（`value.references` の画像）。無ければ空。 */
  referenceImages: BannerImage[]
  /** 「ライブラリから選ぶ」。親が ★BG-C `cOgWE` のダイアログを開く。 */
  onPickReference: () => void
  /** 「ファイルを選ぶ」。親がプロジェクトへ取り込んでから参照にする。 */
  onUploadReference: (file: File) => void
  referenceBusy?: boolean
  /** 上限の帯（板 ）。上限のときだけ出す。 */
  usage?: BannerUsage | null
  onReloadUsage?: () => void
  /**
   * 利用量の棒の上に見出し「利用量」を置く（承認済み ★BG-B `qIp42` の `ta8eS` 1042,1843 37x17）。
   * 板がそう描いている V8 のプロジェクトの中だけが渡す。管理画面 の既定は変えない。
   */
  usageHeading?: boolean
  /** G-6：枚数のそばに残り枚数を置く。 */
  monthRemaining?: boolean
  /** 統括 V8 の板だけの並び。管理画面 の既定は変えない。 */
  v8Layout?: boolean
}) {
  const uid = useId()
  const fileRef = useRef<HTMLInputElement | null>(null)
  const set = <K extends keyof BannerGenerationInput>(key: K, next: BannerGenerationInput[K]) =>
    onChange({ ...value, [key]: next })

  /*
   * テキストの行と「強調」は必ず一緒に動かす（Pencil ★修正案 `g64HOD` 決まり1）。
   * 片方だけ足す・消すと、2行目の強調が3行目に付くような取り違えが起きる。
   */
  const setLines = (textLines: string[], emphasisLines: boolean[]) =>
    onChange({ ...value, textLines, emphasisLines: alignEmphasis(textLines, emphasisLines) })

  return (
    <Card
      variant="form"
      gap="normal"
      data-design-node="GcJHv"
      className="w-full shrink-0 self-start"
      style={{ maxWidth: 390 }}
      aria-label="画像を生成"
    >
      {/*
        見出しの行。`min-h-14` は 2026-10-06 のオーナー指示で外した「バナー／自由入力」の
        切替ボタン（板 `pj2tz`・`hPRmn`。板では見出しと同じ y156 の行にあった）を
        押せる大きさに保つための最小高さだった。切替が無い今は題だけの行なので外す。
        板Δ（`S0ay0i`画像を生成 → `RJIyX`出力サイズ）49 に対し、外すと 55 → 46 になる。
      */}
      <div className="flex flex-wrap items-center gap-2">
        <Sparkles aria-hidden="true" className="h-4.5 w-4.5 text-ink-faint" />
        <h2 className={v8Layout ? styles.v8HeadTitle : 'text-body font-bold text-ink'}>画像を生成</h2>
      </div>

      <div data-design-node="E8oZc" className="flex flex-col gap-4">
        {accountSelector}
        <Field v8Layout={v8Layout} label="作りたい内容" note={`任意・${CUSTOM_PROMPT_MAX}文字まで`} htmlFor={`${uid}-custom`}>
          <SaveErrorField names={["customPrompt", "value.customPrompt", "custom_prompt", "value.custom_prompt"]}>
            <TextArea id={`${uid}-custom`} rows={3} maxLength={CUSTOM_PROMPT_MAX} disabled={disabled}
              value={value.customPrompt} placeholder="例：桜と料理の写真を使った、春らしい案内"
              onChange={(event) => set('customPrompt', event.target.value)} />
          </SaveErrorField>
        </Field>

        {/*
          参照画像（承認済み ★BG-B `L1ax1Y`）。最大 3 枚で、1 枚ずつ使い方を決める。
          使い方の意味は下の説明（★BG-B `R6MBHf`）に出し、選ぶ前から読めるようにする。
        */}
        <Field v8Layout={v8Layout} label="参照画像" note={`任意・最大 ${BANNER_MAX_REFERENCE_IMAGES} 枚`}>
          <div data-design-node="L1ax1Y" className={v8Layout ? "flex flex-col gap-1.5" : "flex flex-col gap-2"}>
            {value.references.map((entry, index) => {
              const image = referenceImages.find((candidate) => candidate.id === entry.imageId) ?? null
              const name = image ? referenceTitle(image) : `${index + 1}枚目`
              return (
                <div
                  key={entry.imageId}
                  data-design-node="hGpey"
                  className="flex flex-wrap items-center gap-3 rounded-control border border-hairline bg-surface-pearl px-3 py-2.5"
                >
                  {/* 統括の画像は Worker から配信されるので next/image の最適化は使わない（image-tile と同じ） */}
                  {image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img width={48} height={48} src={image.media.url} alt="" className="h-12 w-12 shrink-0 rounded-mini bg-step-idle object-cover" />
                  ) : (
                    <span className="h-12 w-12 shrink-0 rounded-mini bg-step-idle" />
                  )}
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <p className="truncate text-label font-medium text-ink">{name}</p>
                    <p className="truncate text-micro text-ink-faint">{image ? tileCaption(image, presets) : `${index + 1}枚目`}</p>
                  </div>
                  <SaveErrorField names={[`references.${index}.mode`,"mode","entry.mode"]}><Select
                    aria-label={`${name}の使い方`}
                    className="w-44"
                    value={entry.mode}
                    disabled={disabled || referenceBusy}
                    onChange={(next) =>
                      set(
                        'references',
                        value.references.map((other) =>
                          other.imageId === entry.imageId ? { ...other, mode: next as BannerReferenceMode } : other,
                        ),
                      )
                    }
                    options={BANNER_REFERENCE_MODES.map((mode) => ({ value: mode, label: BANNER_REFERENCE_MODE_LABEL[mode] }))}
                  /></SaveErrorField>
                  <Button
                    disabled={disabled || referenceBusy}
                    aria-label={`${name}を外す`}
                    onClick={() => set('references', value.references.filter((other) => other.imageId !== entry.imageId))}
                  >
                    外す
                  </Button>
                </div>
              )
            })}

            {value.references.length < BANNER_MAX_REFERENCE_IMAGES ? (
              <>
                {v8Layout ? (
                  /* 絵 ：参照画像は落とす欄（題・ドラッグ＆ドロップ・制限）と、その中の「ライブラリから選ぶ」。 */
                  <ImageMultiUpload presentation="reference" disabled={disabled} busy={referenceBusy} onPickLibrary={onPickReference} onUpload={onUploadReference} />
                ) : <div className="grid grid-cols-2 gap-2">
                  <Button disabled={disabled || referenceBusy} onClick={onPickReference} className="w-full">
                    <Images aria-hidden="true" className="h-4 w-4" />
                    ライブラリから選択する
                  </Button>
                  <Button disabled={disabled || referenceBusy} onClick={() => fileRef.current?.click()} className="w-full" busy={referenceBusy} busyLabel="取り込んでいます…">
                    <Upload aria-hidden="true" className="h-4 w-4" />ファイルを選択する
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
                      if (file) onUploadReference(file)
                    }}
                  />
                </div>}
                {value.references.length === 0 ? (
                  <p className={v8Layout ? styles.v8SmallMuted : "text-micro text-ink-faint"}>
                    {`ライブラリの画像か、手元の画像（PNG・JPEG・WebP、10MB まで）を ${BANNER_MAX_REFERENCE_IMAGES} 枚まで選べます。`}
                  </p>
                ) : null}
              </>
            ) : (
              <p className={v8Layout ? styles.v8SmallMuted : "text-micro text-ink-faint"}>
                {`参照画像は ${BANNER_MAX_REFERENCE_IMAGES} 枚までです。入れ替えるときは、どれかを外してください。`}
              </p>
            )}

            {/*
              * 使い方の説明（★BG-B `R6MBHf`）。3 つの違いをここで読み切れるようにする。
              * 絵のとおり、行ごとに「印（14px）＋名前＋説明」を置き、名前と説明は**縦に**積む
              * （板では `UPIq5`「土台にする」と `Z55Iao`「構図と配色を…」が別の行。`：` でつないだ
              * 1行にはしない）。器は `$surface-pearl`・角丸10・内側12・行間8。
              * 角丸 10 は V7 で 12px の段に畳まれている（`globals.css` の `--radius-card` の但し書き）ので
              * `rounded-card` を使う。半端な段は新規で増やさない（#704）。
              */}
            <div data-design-node="R6MBHf" className="flex flex-col gap-2 rounded-card bg-surface-pearl p-3">
              <p className={v8Layout ? styles.v8Caption : "text-caption font-semibold text-ink"}>{`使い方は ${BANNER_REFERENCE_MODES.length} つから選べます`}</p>
              <ul className="flex flex-col gap-2">
                {BANNER_REFERENCE_MODES.map((mode) => {
                  const ModeIcon = BANNER_REFERENCE_MODE_ICON[mode]
                  return (
                    <li key={mode} className="flex items-center gap-2">
                      <ModeIcon aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-ink-secondary" />
                      <span className={styles.howToText}>
                        <span className={v8Layout ? styles.v8SmallTitle : "text-micro font-semibold text-ink"}>{BANNER_REFERENCE_MODE_LABEL[mode]}</span>
                        <span className={v8Layout ? styles.v8SmallMuted : "text-micro text-ink-faint"}>{BANNER_REFERENCE_MODE_DESCRIPTION[mode]}</span>
                      </span>
                    </li>
                  )
                })}
              </ul>
            </div>
          </div>
        </Field>

        <OutputSize
          name={`${uid}-preset`}
          presets={presets}
          value={value.presetKey}
          disabled={disabled}
          onSelect={(key) => set('presetKey', key)}
          v8Layout={v8Layout}
        />

        {/*
          * ★修正案 `g64HOD`（2026-10-06 承認）：行ごとに「強調」を入れ切りできる。
          * 入れた行だけを強調カラーで目立たせる。丸やタグの印は出さず、
          * 入っていることは地と枠と文字の色で示す。
          */}
        <Field v8Layout={v8Layout}
          label="画像に入れるテキスト"
          note={v8Layout ? `1行に1つ・${TEXT_LINE_LENGTH_MAX}文字まで` : `1行に1つ・${TEXT_LINE_LENGTH_MAX}文字まで／強調したい行は「強調」`}
          noteSpread={!v8Layout}
          footNote={v8Layout ? undefined : '「強調」を押した行は大きく・目立つ色で描きます（1〜2行まで推奨）'}
          help={undefined}
        >
          <div className={v8Layout ? 'flex flex-col gap-1.5' : 'flex flex-col gap-2 rounded-control border border-hairline p-3'}>
            {value.textLines.map((line, i) => (
              <div key={i} className={v8Layout ? styles.v8TextRow : "flex items-center gap-2"}>
                <span className={v8Layout ? styles.v8LineNumber : "w-3 text-micro font-semibold text-ink-faint"} aria-hidden="true">{i + 1}</span>
                <SaveErrorField names={["line","lines"]}><TextField
                  aria-label={`テキスト ${i + 1}行目`}
                  value={line}
                  maxLength={TEXT_LINE_LENGTH_MAX}
                  disabled={disabled}
                  placeholder={i === 0 ? '例: 2周年 春の感謝祭' : i === value.textLines.length - 1 ? '行動を促す文言（例: 今すぐチェック）' : ''}
                  onChange={(event) => {
                    const next = [...value.textLines]
                    next[i] = event.target.value
                    setLines(next, value.emphasisLines)
                  }}
                  className="min-w-0 flex-1"
                /></SaveErrorField>
                <EmphasisToggle
                  v8Layout={v8Layout}
                  index={i}
                  on={value.emphasisLines[i] === true}
                  disabled={disabled}
                  onToggle={() => {
                    const next = alignEmphasis(value.textLines, value.emphasisLines)
                    next[i] = !next[i]
                    set('emphasisLines', next)
                  }}
                />
                {value.textLines.length > 1 ? (
                  <button
                    type="button"
                    disabled={disabled}
                    aria-label={`${i + 1}行目を消す`}
                    onClick={() =>
                      setLines(
                        value.textLines.filter((_, j) => j !== i),
                        alignEmphasis(value.textLines, value.emphasisLines).filter((_, j) => j !== i),
                      )
                    }
                    className={v8Layout ? styles.v8LineRemove : "rounded-mini p-1 text-ink-faint hover:bg-canvas-sunken "}
                  >
                    <X aria-hidden="true" className="h-3.5 w-3.5" />
                  </button>
                ) : null}
              </div>
            ))}
            {value.textLines.length < TEXT_LINE_MAX ? (
              <button
                type="button"
                disabled={disabled}
                onClick={() =>
                  setLines([...value.textLines, ''], [...alignEmphasis(value.textLines, value.emphasisLines), false])
                }
                className={v8Layout ? styles.v8LineAdd : "inline-flex items-center gap-1 self-start text-caption font-semibold text-action hover:underline "}
              >
                <Plus aria-hidden="true" className="h-3.5 w-3.5" />
                行を足す
              </button>
            ) : null}
          </div>
        </Field>

        <ColorRoles value={value} onPick={(key, next) => set(key, next)} disabled={disabled} v8Layout={v8Layout} />

        <Field v8Layout={v8Layout}
          label="人物"
          note={v8Layout ? undefined : "写真に人を入れるかどうか"}
        >
          {/*
            * ★BG-B `z14gEG`：人物は素の2択（丸＋ラベル）を間隔 20 で左から並べる。
            * カード（枠つきの箱）ではありません。2026-10-06 オーナー指示
            *「人物のボタンも太くてスマートじゃない」どおり。
            */}
          <fieldset className="flex items-center gap-5" disabled={disabled}>
            <legend className="sr-only">人物</legend>
            <SaveErrorField names={["personOption","value.personOption"]}><Radio name={`${uid}-person`} value="without" size={v8Layout ? "medium" : "small"} checked={value.personOption === 'without'} onChange={() => set('personOption', 'without')}>
              入れない
            </Radio></SaveErrorField>
            <SaveErrorField names={["personOption","value.personOption"]}><Radio name={`${uid}-person`} value="with" size={v8Layout ? "medium" : "small"} checked={value.personOption === 'with'} onChange={() => set('personOption', 'with')}>
              入れる
            </Radio></SaveErrorField>
          </fieldset>
        </Field>

        {/*
          * ★BG-B `ELZIS`：枚数の注記は2つとも「つくる枚数」に付く。
          * 置き場所も絵のまま——`KCFAX`「一度に 4 枚まで」はラベル行
          * （4択の上）、`swcu2`「同じ条件で…」は4択の下。
          */}
        <Field v8Layout={v8Layout}
          label="つくる枚数"
          note={`一度に ${maxCount} 枚まで`}
          footNote={v8Layout ? undefined : "同じ条件で指定した枚数ぶん作ります（絵柄は毎回少しずつ変わります）"}
        >
          {/*
            * ★BG-B `SLgY5`：枚数は区切りスイッチ（灰色の器に4つのチップ）。
            * カードを4つ並べる形ではありません。器が role="group"
            * aria-label="枚数" を持つので、外側に fieldset+legend「枚数」を
            * 重ねない（group が2つになる）。操作停止は disabled で渡す。
            */}
          <SaveErrorField names={["count","value.count"]}><SegmentedControl
            aria-label="枚数"
            size="panel"
            equalWidth={v8Layout}
            disabled={disabled}
            options={Array.from({ length: maxCount }, (_, i) => ({
              value: String(i + 1),
              label: v8Layout ? `${i + 1}` : `${i + 1}枚`,
            }))}
            value={String(value.count)}
            onChange={(next) => set('count', Number(next))}
          /></SaveErrorField>
        </Field>

        {monthRemaining ? <p className="text-caption text-ink-secondary" aria-live="polite">{`今月の残り ${usage?.month.remaining ?? '—'}枚`}</p> : null}
        <UsageBars usage={usage ?? null} heading={v8Layout ? false : usageHeading} v8Layout={v8Layout} />

        <LimitState usage={usage ?? null} onReload={onReloadUsage} compact />

        {/*
          * 「1040 × 1040 で書き出します」（★BG-B `GcuH5`）はここに出さない。
          * 絵では下部追従バーの中ほど（左=残り枚数／中=サイズ／右=ボタン）。
          * 画面側（`app/hq/banners/project/page.tsx`・`v8/hq-banners/project.tsx`）の
          * 下の帯で `exportSizeText()` を出す。
          */}
      </div>
    </Card>
  )
}

/** 参照画像の見出し。ファイル名から拡張子を落とす（「春のキャンペーン-1」「chirashi」）。 */
function referenceTitle(image: BannerImage): string {
  return image.media.filename.replace(/\.[a-z0-9]+$/i, '') || '画像'
}

/*
 * 行ごとの「強調」（Pencil ★修正案 `g64HOD`・2026-10-06 承認、決まり 2〜4）。
 *
 * 高さ 26・左右の余白 9・角丸 999・文字 11/600。行番号と入力欄の右、同じ行に置く。
 * 入っていないとき＝地 canvas・枠 hairline・文字 ink-secondary。
 * 入っているとき＝地 accent-soft・枠 accent-deep 1.5・文字 accent-deep。
 * 丸やタグの印は出さない（押した状態は地と枠と文字の色だけで示す）。
 * 読み上げには `aria-pressed` で入り切りを伝え、名前は「1行目を強調」にする。
 *
 * 見た目は `generation-panel.module.css` にまとめる。承認した見え方は同じで、
 * 直書きの色と任意の大きさを画面側に残さないため（共通の約束 design-debt）。
 */
function EmphasisToggle({
  v8Layout = false,
  index,
  on,
  disabled,
  onToggle,
}: {
  v8Layout?: boolean
  index: number
  on: boolean
  disabled?: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={`${index + 1}行目を強調`}
      disabled={disabled}
      onClick={onToggle}
      className={`${styles.emphasis} ${v8Layout ? styles.v8Emphasis : ""} ${on ? styles.emphasisOn : styles.emphasisOff}`}
    >
      強調
    </button>
  )
}

/**
 * 脇のパネルの1項目（ラベル行＋中身）。
 *
 * ラベルの字は ★BG-B の板どおり **12px・600・`$ink`**（`text-caption font-semibold`）。
 * 共通部品の既定（`text-label` = 13px・500）より板が優先です
 * （`docs/v8-design-rules.md` §1 の2「画面ごとに、その板の絵のとおり」＞ §1 の4「共通部品」）。
 * 13px だと日本語ラベルが1文字あたり約1px太り、右の一言が板より5〜7px外へずれます。
 */
function Field({
  v8Layout = false,
  label,
  note,
  noteSpread,
  footNote,
  htmlFor,
  help,
  children,
}: {
  v8Layout?: boolean
  label: string
  /**
   * ラベルの**すぐ右**に添える一言。**入れる前に読んでおく**たぐい
   * （上限・単位・任意かどうか）。例: ★BG-B `KCFAX`「一度に 4 枚まで」。
   *
   * ★BG-B のラベル行は8本のうち7本が **gap 6 の左詰め**（`Z69t7`・`iENp8`・`PVn0V`・
   * `U4lxzo`・`AOkUL`・`b3r9d`・`VH9vI`。`justifyContent` の指定なし＝左詰め、`alignItems: center`）。
   * なので既定は左詰め。右端へ寄せるのは `noteSpread` のときだけ。
   */
  note?: string
  /**
   * ラベル行を両端に開く（ラベル左・一言右）。★BG-B で唯一そうなっている
   * `KqqEY`（項目 画像に入れるテキスト・gap 8・`space_between`）のための口。
   * ここだけ一言が226px・2行に折れて右端まで届くため、絵では両端に開いています。
   * 板では label と note の上辺がそろうので縦は `items-start`。
   */
  noteSpread?: boolean
  /**
   * 中身の**下**に置く一言。選んだあとの結果を説明するたぐい。
   * 例: ★BG-B `swcu2`「同じ条件で指定した枚数ぶん作ります…」。
   * 絵では4択の下にあるので、`note` と同じ行にまとめない。
   */
  footNote?: string
  htmlFor?: string
  help?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className={noteSpread ? 'flex items-start justify-between gap-2' : 'flex items-center gap-1.5'}>
        {htmlFor ? (
          <label htmlFor={htmlFor} className={v8Layout ? styles.v8Caption : "shrink-0 text-caption font-semibold text-ink"}>{label}</label>
        ) : (
          <span className={v8Layout ? styles.v8Caption : "shrink-0 text-caption font-semibold text-ink"}>{label}</span>
        )}
        {note ? <span className={v8Layout ? styles.v8SmallMuted : "min-w-0 text-micro text-ink-faint"}>{note}</span> : null}
        {help ? <HelpTip label={`${label}の補足`}>{help}</HelpTip> : null}
      </div>
      {children}
      {footNote ? <p className="text-nano text-ink-faint">{footNote}</p> : null}
    </div>
  )
}

/** 現在の用途を短く示し、大きさの選択肢は窓で開く。 */
function OutputSize({
  name,
  presets,
  value,
  disabled,
  onSelect,
  v8Layout = false,
}: {
  name: string
  presets: BannerPreset[]
  value: string
  disabled?: boolean
  onSelect: (key: string) => void
  v8Layout?: boolean
}) {
  const [opened, setOpened] = useState(false)
  const selected = presets.find((preset) => preset.key === value)

  return (
    <div data-design-node="xy4EW" className="flex flex-col gap-2">
      <p className="truncate text-caption text-ink" title={selected ? `${presetCardLabel(selected)}・${presetSizeLabel(selected)}` : undefined}>
        {selected ? `${presetCardLabel(selected)}・${presetSizeLabel(selected)}` : '用途と大きさを選んでください'}
      </p>
      <div className="flex justify-center"><Button disabled={disabled} onClick={() => setOpened(true)}>大きさを変更する</Button></div>
      <Dialog footerAlign="center" open={opened} title="用途と大きさを選ぶ" onCancel={() => setOpened(false)} cancelLabel="閉じる">
        <SaveErrorField names={["key", "preset.key", "value"]}>
          <RadioCardGroup legend="出力サイズ" columns={2}>
            {presets.map((preset) => (
              <RadioCard key={preset.key} name={name} value={preset.key} checked={value === preset.key}
                disabled={disabled} onChange={(key) => { onSelect(key); setOpened(false) }} variant="compact"
                compactTypography={v8Layout ? 'banner' : 'default'} title={presetCardLabel(preset)} note={presetSizeLabel(preset)} />
            ))}
          </RadioCardGroup>
        </SaveErrorField>
      </Dialog>
    </div>
  )
}

/**
 * 色の4つの役割。Pencil ★BG-B `KkTNS`。
 *
 * ベース＝背景、メイン＝主役、サブ＝差し色、強調＝目立たせたい文字。
 * 色そのものは共通の「色を選ぶ」（★BG-2 `P8ZUj`）で選ぶ。
 */
export function ColorRoles({
  value,
  onPick,
  disabled,
  v8Layout = false,
}: {
  value: BannerGenerationInput
  onPick: (key: BannerColorRoleKey, next: string | null) => void
  disabled?: boolean
  v8Layout?: boolean
}) {
  // いま使っている色を「このデザインの色」として見せ、役割どうしで使い回せるようにする。
  const used = Array.from(new Set(COLOR_ROLES.map((role) => value[role.key]).filter((c): c is string => Boolean(c))))
  return (
    <div className={v8Layout ? "flex flex-col gap-1.5" : "flex flex-col gap-2"}>
      <div className="flex items-center gap-1.5">
        <span className={v8Layout ? styles.v8ColorTitle : "shrink-0 text-caption font-semibold text-ink"}>{v8Layout ? '色' : 'カラー'}</span>
        {v8Layout ? null : <span className="min-w-0 text-micro text-ink-faint">4つの役割で指定します</span>}
      </div>
      {/*
        4つの役割の並び。縦の間隔は板から逆算する。板の上下のピッチは
        （`VVBfu`メインカラー y1355 → `ZdLJ8`サブカラー y1420）65px。
        実画面の 1 区画は 題18 + 組の中の間隔6 + 色の枠36 = 60px なので、
        縦の間隔は 4px（`gap-y-1`）でピッチ 64 になり板と 1px 差に収まる。
        6px にすると板ちょうどだが、`size-scale-contract.test.tsx` の
        「4の倍数でない gap 段を増やさない」ラチェットに引っかかるので 4px を採る。
        横は板どおり 12px のままにする。
      */}
      <div className={v8Layout ? "grid grid-cols-2 gap-x-2 gap-y-2" : "grid grid-cols-2 gap-x-3 gap-y-1"}>
        {COLOR_ROLES.map((role) => (
          <div key={role.key} className={v8Layout ? "flex flex-col gap-1" : "flex flex-col gap-1.5"}>
            <span className={v8Layout ? styles.v8SmallMuted : "text-caption font-semibold text-ink"}>{v8Layout ? role.label.replace("カラー", "") : role.label}</span>
            <ColorWell
              block
              label={role.label}
              value={value[role.key] ?? null}
              fallback={role.sample}
              savedColors={used}
              disabled={disabled}
              onChange={(next) => onPick(role.key, next)}
            />
          </div>
        ))}
      </div>
      {/* 補足（Pencil `pQlYK`）。色の役割の意味を言葉で置いておく。 */}
      <div className="rounded-mini bg-canvas-sunken p-3">
        <p className={v8Layout ? styles.v8SmallTitle : "text-caption font-semibold text-ink"}>色の決め方</p>
        <p className={v8Layout ? styles.v8ColorNote : "mt-1 text-micro text-ink-secondary"}>{v8Layout ? 'ベースは背景、メインは見出しの文字、サブは飾り、強調は値段や締切など目立たせたい所に使います。' : '色をタップすると、好きな色を選べる画面が開きます。画面の中の色をそのまま拾うスポイトも使えます。ベースは背景、メインは主役、サブは差し色、強調は特に目立たせたい文字に使います。'}</p>
      </div>
    </div>
  )
}
