'use client'

import { jstDateOffset } from '@/lib/jst-datetime'

/*
 * 「お客さまに見える形」のスマホ（・・・ の右）。
 * 外枠 330×690・黒い島・LINE の上の帯・メニューの帯。中は回答画面の形。
 * 選んでいるページを出す。押せない見本（role="img" ではなく読める文で出す）。
 * 予約を入れる欄の日にち・時刻は形を見せるための見本で、実際の空きではない。
 */
import { Check } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import LiffPhoneFrame from '@/components/shared/liff-phone-frame'
import { resolveCustomerFormTheme, DEFAULT_CUSTOMER_LOOK, type CustomerLook, PREFECTURES, normalizeRatingValue, FORM_OPTIONS_DEFAULT, type FormBlock, type FormInputBlock, type FormLayout } from '@line-crm/shared'
import { DateYmdField, AddressControls, BookingControls, FormChoiceRow, FormFileControl, FormSelectControl, FormTextControl, RatingStars } from '../../../../liff/src/components/forms/controls'
import styles from './edit.module.css'
import { SaveErrorField } from '@/components/shared/save-form-errors'

const WEEKDAY = '日月火水木金土'
const SAMPLE_TIMES = ['10:00', '11:00', '13:00', '14:00', '15:00', '16:00']

type Props = {
  layout: FormLayout
  accountLook?: CustomerLook | null
  pageIndex: number
  accountName: string
  bookingMenus: { id: string; name: string; durationMinutes: number }[]
  /** 上の小さい見出し。置き場に題があるとき（リサーチの「届き方」）は null。 */
  caption?: string | null
  /** フォームの名前。ページの題を決めていない時に使う。 */
  formName?: string
  /** 呼び出し元で決めた上の帯の題（リサーチなど）。 */
  title?: string
  /** 次へ・送るを画面の下に固定する（中身が長いリサーチ。絵 「下の帯（固定）」）。 */
  fixedNext?: boolean
  /** 進み具合の線と「1 / 1 ページ」を題の上（いちばん頭）に出す（絵 「進み具合」）。 */
  progressHead?: boolean
  /** 編集中のブロック。スマホの中をそこまで送って見せる（下の方の問いを押しても見える。絵 ）。 */
  focusBlockId?: string | null
  /** 「答え終わったあと」のタブで渡す。質問の画面ではなくお礼の画面を出す。 */
  thanks?: { text: string; url: string | null } | null
}

export function FormPhone({ accountLook, layout, pageIndex, accountName, bookingMenus, caption = 'お客さまに見える形', formName, title, fixedNext = false, progressHead = false, focusBlockId = null, thanks = null }: Props) {
  const formRef = useRef<HTMLDivElement>(null)
  const sections = layout.sections
  const section = sections[pageIndex] ?? sections[0]
  const options = { ...FORM_OPTIONS_DEFAULT, ...layout.options }
  const phoneTitle = title ?? (options.pageTitle || formName || '回答フォーム')
  const blocks = [...(pageIndex === 0 ? layout.header : []), ...(section?.blocks ?? [])]
  const last = pageIndex >= sections.length - 1
  const bar = (
    <span className={styles.phoneProgress} aria-hidden="true">
      {sections.map((s, i) => <span key={s.id} data-done={i <= pageIndex || undefined} />)}
    </span>
  )
  const progress = progressHead ? (
    <span className={styles.phoneProgressHead}>
      {bar}
      <span className={styles.phonePageNo}>{`${pageIndex + 1} / ${sections.length} ページ`}</span>
    </span>
  ) : bar
  // 1ページ目は表紙（画像・題・説明）のあとに進み具合、ほかのページは頭に出す。
  const firstInput = blocks.findIndex((b) => b.kind === 'input')
  const progressAt = !progressHead && pageIndex === 0 && firstInput > 0 ? firstInput : 0
  // 色を決めたフォームは、その主の色で見せる（決めていなければ LINE の緑）。
  const theme = resolveCustomerFormTheme(layout.options,accountLook ?? DEFAULT_CUSTOMER_LOOK)
  const main = theme.main
  // 押したブロックがスマホの見えている所の外なら、そのブロックが上に来るまで中だけを送る（ページ全体は動かさない）。
  useEffect(() => {
    const box = formRef.current
    if (!box) return
    const target = focusBlockId ? box.querySelector<HTMLElement>(`[data-phone-block="${CSS.escape(focusBlockId)}"]`) : null
    if (!target) return
    const top = target.offsetTop - box.offsetTop
    const bottom = top + target.offsetHeight
    if (top < box.scrollTop || bottom > box.scrollTop + box.clientHeight) box.scrollTop = Math.max(0, top - 8)
  }, [focusBlockId, pageIndex, blocks.length])
  const nextLabel = last
    ? (options.submitLabel || '送信する')
    : `${options.nextLabel || '次へ'}（${pageIndex + 1} / ${sections.length}）`

  return (
    <LiffPhoneFrame title={phoneTitle} accountName={accountName} caption={caption ?? undefined} label="お客さまに見える形" accent={main} footer={!thanks && fixedNext ? <div className={styles.phoneFoot} style={{ backgroundColor: theme.sub }}><span className={styles.phoneNext}>{nextLabel}</span></div> : undefined}>
          <div ref={formRef} className={styles.phoneForm} style={{backgroundColor:theme.sub,color:theme.text,fontFamily:theme.fontFamily==='serif'?'serif':'sans-serif'}}>
            {thanks ? (
              <div className={styles.thanksBox}>
                <span className={styles.thanksMark} aria-hidden="true"><Check size={40} strokeWidth={3} color="var(--color-success)" /></span>
                <p className={styles.thanksText}>{thanks.url ? '送信後、次のURLを開きます' : (thanks.text || 'ご回答ありがとうございました')}</p>
                {thanks.url ? <p className={styles.thanksSub}>{thanks.url}</p> : null}
              </div>
            ) : (<>
              {blocks.length === 0 ? <p className={styles.phoneEmpty}>このページにはまだブロックがありません</p> : null}
              {blocks.map((block, index) => (
                <PhoneBlockWithProgress key={block.id} block={block} showProgress={index === progressAt} progress={progress} bookingMenus={bookingMenus} />
              ))}
              {blocks.length === 0 ? progress : null}
              {fixedNext ? null : <><span className={styles.phoneSpacer} />
              <span className={styles.phoneNext}>{nextLabel}</span></>}
            </>)}
          </div>
    </LiffPhoneFrame>
  )
}

function PhoneBlockWithProgress({ block, showProgress, progress, bookingMenus }: { block: FormBlock; showProgress: boolean; progress: ReactNode; bookingMenus: Props['bookingMenus'] }) {
  if (block.kind === 'input' && block.hidden) return showProgress ? <>{progress}</> : null
  return (
    <>
      {showProgress ? progress : null}
      <div data-phone-block={block.id} className={styles.phoneBlockSlot}><PhoneBlock block={block} bookingMenus={bookingMenus} /></div>
    </>
  )
}

function PhoneBlock({ block, bookingMenus }: { block: FormBlock; bookingMenus: Props['bookingMenus'] }) {
  switch (block.kind) {
    case 'image':
      return <PhoneImage url={block.mediaUrl} alt={block.alt} />
    case 'heading':
      return <p className={styles.phoneHeading} data-level={block.level ?? 2}>{block.text}</p>
    case 'text':
      return <p className={styles.phoneText}>{block.text}</p>
    case 'button':
      return <span className={styles.phoneButton}>{block.label}</span>
    default:
      return <PhoneQuestion block={block} bookingMenus={bookingMenus} />
  }
}

/** 読めない画像は壊れた印を出さず、地の色の箱にする。 */
function PhoneImage({ url, alt }: { url: string; alt?: string }) {
  const [failed, setFailed] = useState(false)
  if (!url || failed) return <span className={styles.phoneImage} role="img" aria-label={url ? '画像（読み込めません）' : '画像（未設定）'} />
  return <img width={280} height={70} className={styles.phoneImage} src={url} alt={alt ?? ""} onError={() => setFailed(true)} />
}

function PhoneQuestion({ block, bookingMenus }: { block: FormInputBlock; bookingMenus: Props['bookingMenus'] }) {
  if (block.hidden) return null
  const text = block.defaultValue ?? ''
  const selectedChoices = (block.choices ?? []).filter((c) => c.defaultSelected).map((c) => c.label)
  return <div className={styles.phoneQ}>
    <span className={styles.phoneQTitle}>{block.label || '（質問の文）'}{block.required ? <span className={styles.phoneRequired}>必須</span> : null}</span>
    {block.description ? <p className={styles.phoneText}>{block.description}</p> : null}
    {/* inert は見た目を薄くせず、選択・添付・送信とキーボード操作を止める。 */}
    <div inert>
      {(block.type === 'text' || block.type === 'textarea' || block.type === 'date') ? (
        block.type === 'date' && block.dateStyle === 'ymd' ? <DateYmdField value={text} placeholder={block.placeholder} readOnly onChange={() => {}} /> :
          <FormTextControl block={block} value={text} readOnly onChange={() => {}} />
      ) : null}
      {block.type === 'select' || block.type === 'prefecture' ? <FormSelectControl aria-label={block.label} value={text || selectedChoices[0] || ''} onChange={() => {}}>
        <option value="">{block.type === 'prefecture' ? '都道府県を選択' : '選択してください'}</option>
        {(block.type === 'prefecture' ? PREFECTURES : (block.choices ?? []).map((c) => c.label)).map((label) => <option key={label} value={label}>{label}</option>)}
      </FormSelectControl> : null}
      {block.type === 'radio' || block.type === 'checkbox' ? <div className={styles.phoneChoices} data-inline={block.inline || undefined}>
        {(block.choices ?? []).map((choice) => {
          const selected = block.type === 'radio' && text ? text === choice.label : selectedChoices.includes(choice.label)
          return <FormChoiceRow key={choice.id} selected={selected}><SaveErrorField names={["selected"]}><input type={block.type} checked={selected} readOnly tabIndex={-1} /></SaveErrorField>{choice.label}</FormChoiceRow>
        })}
      </div> : null}
      {block.type === 'rating' ? <RatingStars name={block.name} current={normalizeRatingValue(text)} onChange={() => {}} /> : null}
      {block.type === 'file' ? <FormFileControl label={block.label} kind={block.fileKind} kinds={block.fileKinds} bothSides={block.fileBothSides} maxCount={block.fileMaxCount} /> : null}
      {block.type === 'address' ? <AddressControls draft={{ postalCode: '', prefecture: '', city: '', addressLine1: '', addressLine2: '' }} placeholder={block.placeholder} onChange={() => {}} /> : null}
      {block.type === 'booking' ? <BookingPreview block={block} bookingMenus={bookingMenus} /> : null}
    </div>
  </div>
}

function BookingPreview({ block, bookingMenus }: { block: FormInputBlock; bookingMenus: Props['bookingMenus'] }) {
  const menu = bookingMenus.find((m) => m.id === block.booking?.menuId)
  const days = Array.from({ length: 5 }, (_, i) => {
    const date = jstDateOffset(i + 1)
    const d = new Date(`${date}T00:00:00Z`)
    return { date, weekday: WEEKDAY[d.getUTCDay()], day: d.getUTCDate(), open: true }
  })
  return <><p className={styles.phoneText}>空き枠の見本（実際の空きではありません）</p><BookingControls preview menuLabel={menu ? `${menu.name}・${menu.durationMinutes}分` : 'メニューを選んでください'} days={days} selectedDate={days[2].date} onDate={() => {}} times={SAMPLE_TIMES.map((start, i) => ({ start, open: i !== 0 && i !== 4, selected: false }))} onTime={() => {}} /></>
}
