'use client'

/*
 * 1通目の下見（設計 `管理画面 5 kk8dz 1通目設定` の右側）。
 *
 * 設計は1枚。トーク画面と同じ並びで、**いつ届くか**を帯で出し、その下に
 * **何が届くか**を吹き出しで出す。2枚に割ると、時刻と中身を別々に見ることになり、
 * 「この文面がこの時刻に届く」という1つの絵にならない。
 *
 * 「1日後 10:00」のような書き方は、設定としては正しいが、読む側は毎回
 * 頭の中で今日の日付に足し算することになる。ここで足しておく。
 */

import { Clock } from 'lucide-react'
import LinePreview from '@/components/shared/line-preview'
import { fillPreviewSample } from '@/components/shared/preview-sample'
import StickerPreview from '@/components/shared/sticker-preview'
import Notice from '@/components/shared/notice'
import styles from './step-preview.module.css'
import type { DeliveryMode } from '@line-crm/shared'
import type { ScenarioQuestion } from './question-editor'
import type { StepMessageKind } from './message-type-tabs'
import type { MessageKindState } from './message-kind-fields'

export interface StepPreviewProps {
  accountName?: string
  deliveryMode: DeliveryMode
  offsetDays: number
  /** absolute_time のときの配信時刻 "HH:MM"。 */
  deliveryTime: string
  /** elapsed / relative のときの「〜時間後」。 */
  offsetHours: number
  /** elapsed / relative の「〜分後」（時間に入りきらない分）。省略は 0。 */
  offsetMinutes?: number
  kind: StepMessageKind
  /** テンプレートを選んでいるときは、その名前。 */
  templateName?: string | null
  body: string
  imageUrl?: string | null
  question: ScenarioQuestion | null
  /** 位置情報・動画・音声・スタンプの入力。 */
  kindState?: MessageKindState
  /** 誰に送るか。札に出す。 */
  audienceLabel: string
  /**
   * R213: いま触っている通の番号。新規1通目のときは 1（省略時も 1）。
   * 2通目以降の編集で 1通目と案内すると、前後の流れを取り違える。
   */
  stepOrder?: number
  /**
   * R236: 送ったあとどうするか。右の設定サマリーの「配信後」に出す。
   * 省略時は次へ進む（送ったあとの既定）。一時停止の編集欄がある画面は
   * その値を渡す。渡さないと、一時停止中も「次へ進む」のまま残る。
   */
  afterSend?: 'continue' | 'pause'
}

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土']

/** 配信時刻の形（worker の validateStepSchedule と同じ）。空や崩れた値は受けない。 */
export const DELIVERY_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

/** 時刻指定なのに時刻が入っているか。消したままは「未設定」として扱う。 */
export function isDeliveryTimeSet(deliveryTime: string): boolean {
  return DELIVERY_TIME_RE.test(deliveryTime.trim())
}

/** 日本時間で見た「いま」。端末が海外時刻でも、配信はJSTで動く。 */
function nowJst(): Date {
  const now = new Date()
  return new Date(now.getTime() + (now.getTimezoneOffset() + 9 * 60) * 60_000)
}

function formatJst(date: Date): string {
  const m = date.getMonth() + 1
  const d = date.getDate()
  const w = WEEKDAYS[date.getDay()]
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  return `${m}月${d}日(${w}) ${hh}:${mm}`
}

/**
 * 届く日時を出す。配信方式ごとに数え方が違う。
 *
 *   時刻で指定 … 購読開始の日から N日後の、決めた時刻
 *   経過時間   … 購読開始から N日と M時間後
 *
 * 時刻で指定した日時が過去なら、実際の配信と同じく現在時刻にする。
 */
export function computeDeliveryAt(
  start: Date,
  mode: DeliveryMode,
  offsetDays: number,
  deliveryTime: string,
  offsetHours: number,
  offsetMinutes = 0,
): Date {
  const at = new Date(start.getTime())
  if (mode === 'absolute_time') {
    /*
     * R235: 時刻を消したまま（''）来ると、分の取り出しが undefined になり
     * setHours が Invalid Date を作って「NaN月NaN日」が出ていた。形が違う
     * 値は 0時0分に倒さず、呼び側が未設定表示にする（下の timeMissing）。
     * ここでは壊れた日時を作らないことだけを守る。
     */
    const parts = deliveryTime.split(':').map((n) => Number(n))
    const h = Number.isFinite(parts[0]) ? (parts[0] as number) : 0
    const m = Number.isFinite(parts[1]) ? (parts[1] as number) : 0
    at.setDate(at.getDate() + offsetDays)
    at.setHours(h, m, 0, 0)
    if (at.getTime() < start.getTime()) return new Date(start.getTime())
    return at
  }
  at.setDate(at.getDate() + offsetDays)
  at.setHours(at.getHours() + offsetHours)
  at.setMinutes(at.getMinutes() + offsetMinutes)
  return at
}

/**
 * 編集中の予定入力を、プレビューが受け取る「日・時間・分」へそろえる。
 *
 * 方式ごとに入力欄の持ち方が違う：
 *   relative … delayMinutes が合計の分（日・時間・分へ分解する）
 *   elapsed  … offsetDays ＋ offsetHours ＋ offsetMinutesRemainder
 *   absolute_time … offsetDays ＋ deliveryTime（時間・分は使わない）
 *
 * 呼び出し側で欄を個別に写すと「分だけ渡し忘れ」が起き、設定内容は
 * 「1分後」なのに配信の流れ・設定サマリーが「すぐに」のまま残る
 * （#616 SC-02b）。ここで1か所に決める。
 */
export function previewOffsets(
  mode: DeliveryMode,
  schedule: {
    delayMinutes: number
    offsetDays: number
    offsetHours: number
    offsetMinutesRemainder: number
  },
): { offsetDays: number; offsetHours: number; offsetMinutes: number } {
  if (mode === 'absolute_time') {
    return { offsetDays: Math.max(0, schedule.offsetDays), offsetHours: 0, offsetMinutes: 0 }
  }
  if (mode === 'relative') {
    const total = Number.isFinite(schedule.delayMinutes)
      ? Math.max(0, Math.floor(schedule.delayMinutes))
      : 0
    return {
      offsetDays: Math.floor(total / 1440),
      offsetHours: Math.floor((total % 1440) / 60),
      offsetMinutes: total % 60,
    }
  }
  return {
    offsetDays: Math.max(0, schedule.offsetDays),
    offsetHours: Math.max(0, schedule.offsetHours),
    offsetMinutes: Math.max(0, schedule.offsetMinutesRemainder),
  }
}

function scheduleWords(
  mode: DeliveryMode,
  offsetDays: number,
  deliveryTime: string,
  offsetHours: number,
  offsetMinutes = 0,
): string {
  if (mode === 'absolute_time') {
    // R235: 時刻が空のまま「当日の 」と出すと、設定が済んだように見える。未設定とはっきり言う。
    if (!isDeliveryTimeSet(deliveryTime)) return '時刻が未入力です'
    return offsetDays === 0 ? `当日の ${deliveryTime}` : `${offsetDays}日後の ${deliveryTime}`
  }
  const parts: string[] = []
  if (offsetDays > 0) parts.push(`${offsetDays}日`)
  if (offsetHours > 0) parts.push(`${offsetHours}時間`)
  if (offsetMinutes > 0) parts.push(`${offsetMinutes}分`)
  return parts.length === 0 ? 'すぐに' : `${parts.join('と')}後`
}

/** 実際の友だち情報を作らず、LINEプレビューだけ安全な例へ置き換える。 */
export function renderPreviewBody(body: string): string {
  return fillPreviewSample(body).text
}

export default function StepPreview({
  accountName,
  deliveryMode,
  offsetDays,
  deliveryTime,
  offsetHours,
  offsetMinutes = 0,
  kind,
  templateName,
  body,
  imageUrl,
  question,
  kindState,
  audienceLabel,
  stepOrder = 1,
  afterSend = 'continue',
}: StepPreviewProps) {
  const stepLabel = `${stepOrder}通目`
  const start = nowJst()
  /*
   * R235: 時刻を消したままは予定未設定として出し、日付計算へ渡さない。
   * 計算した日時を出すと、00:00 に倒れた値か NaN のどちらかが出て、
   * どちらも「設定が済んだ」か「壊れた」ように見える。
   */
  const timeMissing = deliveryMode === 'absolute_time' && !isDeliveryTimeSet(deliveryTime)
  const at = computeDeliveryAt(
    start,
    deliveryMode,
    offsetDays,
    timeMissing ? '00:00' : deliveryTime,
    offsetHours,
    offsetMinutes,
  )
  const immediate = !timeMissing && deliveryMode === 'absolute_time' && at.getTime() === start.getTime()
  const words = immediate ? 'すぐ' : scheduleWords(deliveryMode, offsetDays, deliveryTime, offsetHours, offsetMinutes)

  return (
    <aside
      aria-label={`${stepLabel}の下見`}
      className={`${styles.preview} border-hairline bg-canvas border p-4`}
    >
      {/* LINEの見た目の枠は共通部品 `LinePreview`（B-6）。届く日時は見える札のまま残す。 */}
      <div className="-mx-4 -mt-4 mb-4">
        <LinePreview
          accountName={accountName}
          caption={<span className="inline-flex items-center gap-1"><Clock aria-hidden size={16} strokeWidth={1.8} />{timeMissing ? `時刻を入れると届く日時が出ます（${stepLabel}）` : `${words}に届きます（${stepLabel}）`}</span>}
        >
          {templateName ? (
            <Bubble>
              <span className="text-ink-faint text-micro">テンプレート</span>
              <span className="text-ink mt-0.5 block text-label font-medium">{templateName}</span>
            </Bubble>
          ) : body.trim() ? (
            <Bubble>{renderPreviewBody(body)}</Bubble>
          ) : (
            <Placeholder>本文を書くと、ここに出ます</Placeholder>
          )}
        </LinePreview>
      </div>

      <h3 className="text-ink text-sm font-bold">配信の流れ</h3>
      <p className="text-ink-faint mt-0.5 text-micro leading-relaxed">
        いま購読が始まったとして計算しています（購読開始 {formatJst(start)}）。
        実際は、その人が購読を始めた時刻が起点です。
      </p>
      <p className="text-ink-secondary mt-1.5 text-micro leading-relaxed">
        送る相手：{audienceLabel}
      </p>

      {/* トーク画面に近い形。実物と同じ見た目にはしない（別物と分かるように）。 */}
      <div className="bg-canvas-sunken rounded-card mt-3 space-y-2 p-3">
        {/* 届く日時の帯（設計 h=26 r=full 11/600 アイコン13）。 */}
        <p className="flex justify-center">
          <span className={`${styles.band} bg-accent-soft text-accent-deep rounded-pill flex items-center gap-1 px-2.5 text-micro font-semibold`}>
            <Clock aria-hidden size={16} strokeWidth={1.8} />
            {timeMissing ? '時刻が未入力です' : `${words}・${formatJst(at)}`}
          </span>
        </p>

        {templateName ? (
          <Bubble>
            <span className="text-ink-faint text-micro">テンプレート</span>
            <span className="text-ink mt-0.5 block text-label font-medium">{templateName}</span>
          </Bubble>
        ) : kind === 'image' ? (
          imageUrl ? (
            // 中身が何かを見せるだけなので、次の最適化には載せない。
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={imageUrl}
              alt="送る画像"
              className="rounded-card max-h-48 w-auto max-w-full object-contain"
            />
          ) : (
            <Placeholder>画像を選ぶと、ここに出ます</Placeholder>
          )
        ) : kind === 'question' && question ? (
          <>
            {question.intro?.trim() ? <Bubble>{fillPreviewSample(question.intro).text}</Bubble> : null}
            <Bubble>
              <span className="text-ink block text-label font-medium">
                {fillPreviewSample(question.text.trim() || '（質問文がまだ空です）').text}
              </span>
              <span className="mt-2 block space-y-1.5">
                {question.choices.map((choice, i) => (
                  <span
                    key={i}
                    className={`rounded-control block px-3 py-2 text-center text-label font-medium ${
                      i === 0
                        ? 'bg-accent-deep text-on-accent'
                        : 'border-hairline text-ink-secondary border'
                    }`}
                  >
                    {fillPreviewSample(choice.label.trim() || `選択肢${i + 1}`).text}
                  </span>
                ))}
              </span>
            </Bubble>
          </>
        ) : kind === 'carousel' ? (
          templateName ? (
            <Bubble>
              <span className="text-ink-faint text-micro">カルーセル</span>
              <span className="text-ink mt-0.5 block text-label font-medium">{templateName}</span>
              <span className="text-ink-faint mt-1 block text-micro">
                実際の見た目は、カルーセルの編集画面で確かめられます。
              </span>
            </Bubble>
          ) : (
            <Placeholder>カルーセルを選ぶと、ここに出ます</Placeholder>
          )
        ) : kind === 'location' ? (
          kindState?.location.latitude && kindState.location.longitude ? (
            <Bubble>
              <span className="text-ink block text-label font-medium">
                {fillPreviewSample(kindState.location.title.trim() || '場所').text}
              </span>
              {kindState.location.address.trim() && (
                <span className="text-ink-secondary mt-0.5 block text-micro">
                  {fillPreviewSample(kindState.location.address).text}
                </span>
              )}
              {/* 地図そのものは出さない。ここで別の地図を出すと、
                  実際にLINEで開く地図と違うものを見せることになる。 */}
              <span className="bg-canvas-sunken text-ink-faint rounded-control mt-2 block px-3 py-4 text-center text-micro">
                地図（{kindState.location.latitude}, {kindState.location.longitude}）
              </span>
            </Bubble>
          ) : (
            <Placeholder>緯度と経度を入れると、ここに出ます</Placeholder>
          )
        ) : kind === 'sticker' ? (
          kindState?.sticker.stickerId ? (
            <Bubble>
              <StickerPreview stickerId={kindState.sticker.stickerId} size={80} />
            </Bubble>
          ) : (
            <Placeholder>スタンプを選ぶと、ここに出ます</Placeholder>
          )
        ) : kind === 'video' ? (
          kindState?.video.previewImageUrl ? (
            <Bubble>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={kindState.video.previewImageUrl}
                alt="動画のサムネイル"
                className="rounded-card max-h-40 w-auto max-w-full object-contain"
              />
              <span className="text-ink-faint mt-1 block text-micro">動画</span>
            </Bubble>
          ) : (
            <Placeholder>動画とサムネイルのURLを入れると、ここに出ます</Placeholder>
          )
        ) : kind === 'audio' ? (
          kindState?.audio.originalContentUrl ? (
            <Bubble>
              <span className="text-ink block text-label">音声</span>
              <span className="text-ink-faint mt-0.5 block text-micro">
                {kindState.audio.duration ? `${kindState.audio.duration} 秒` : '長さが未設定'}
              </span>
            </Bubble>
          ) : (
            <Placeholder>音声のURLを入れると、ここに出ます</Placeholder>
          )
        ) : body.trim() ? (
          <Bubble>{renderPreviewBody(body)}</Bubble>
        ) : (
          <Placeholder>本文を書くと、ここに出ます</Placeholder>
        )}
      </div>

      {immediate && (
        <Notice tone="warn" className="mt-2">
          設定した時刻を過ぎているため、すぐに送ります。
        </Notice>
      )}

      {/*
        差し込みの注意書き。
        実際の友だち情報は使わず、名前だけプレビュー用の例へ置き換える。
        本番送信では友だちごとの実値へ置き換わることを、その場に書く。
      */}
      {/\{\{[a-z_.+:0-9-]+\}\}/.test(body) && (
        <p className="text-ink-faint mt-2 text-micro leading-relaxed">
          名前はプレビュー用の「Kenta」に置き換えています。送るときは友だちごとの実際の値になります。
          そのほかの差し込みは書いたまま表示します。
        </p>
      )}

      {/*
        R213: 新規1通目の案内を使い回さない。2通目以降の編集中に
        「2通目からは、このあとの編集画面で足せます」と出すと、
        いま触っている通と順序を取り違える。
      */}
      <p className="text-ink-faint border-hairline mt-3 border-t pt-3 text-micro leading-relaxed">
        {stepOrder <= 1
          ? '2通目からは、このあとの編集画面で足せます。足すと、ここと同じ形で届く日時が並びます。'
          : `いま編集中の${stepLabel}の見本です。前後の通は、一覧の並びで確認できます。`}
      </p>

      <section className="border-hairline mt-3 border-t pt-3">
        <h3 className="text-ink text-sm font-bold">設定サマリー</h3>
        <dl className="mt-2 divide-y divide-hairline text-xs">
          <SummaryRow label="配信対象" value={audienceLabel} />
          <SummaryRow label="配信日時" value={timeMissing ? '時刻を入力してください' : `${words}・${formatJst(at)}`} />
          <SummaryRow
            label="送信数"
            value={templateName ? 'テンプレート 1通' : `${kind === 'text' ? 'テキスト' : 'メッセージ'} 1通`}
          />
          {/*
            R236: 送信後を「ここで一時停止する」にしても、ここだけ
            「次のステップへ進む」のまま残っていた。隣の設定内容の札
            （scenario-step-audience.ts の describeAfterSend）と同じ
            言い方にそろえる。部品から画面側の関数を読まないので、
            同じ2つの値をここで出す。
          */}
          <SummaryRow label="配信後" value={afterSend === 'pause' ? '送信後に一時停止' : '次へ進む'} />
        </dl>
      </section>
    </aside>
  )
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0">
      <dt className="text-ink-faint shrink-0">{label}</dt>
      <dd className="text-ink text-right font-semibold">{value}</dd>
    </div>
  )
}

/** 吹き出し。設計は左下だけ角を落とす（r=14,14,14,4）。 */
function Bubble({ children }: { children: React.ReactNode }) {
  return (
    <div className={`${styles.bubble} bg-canvas border-hairline text-ink max-w-full border px-3 py-2 text-label leading-relaxed font-medium whitespace-pre-wrap`}>
      {children}
    </div>
  )
}

function Placeholder({ children }: { children: React.ReactNode }) {
  return (
    <p className="border-hairline rounded-card text-ink-faint border border-dashed px-3 py-6 text-center text-micro">
      {children}
    </p>
  )
}
