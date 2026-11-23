/** LIFF と管理画面の見本で共有する入力の形。通信・送信は呼ぶ側が持つ。 */
import { useEffect, useState, useRef, forwardRef, type InputHTMLAttributes, type ReactNode, type LabelHTMLAttributes, type TextareaHTMLAttributes, type SelectHTMLAttributes, type Ref } from 'react'
import { PREFECTURES, type FormInputBlock, type FormFileAnswer } from '@line-crm/shared'
import Button from '../ui/button/index'
import Icon from '../ui/icon'
import styles from './controls.module.css'

/** 欄名と必要度の表示。札を読み上げ名へ混ぜず、欄との結び付きを保つ。 */
export function FieldMark({ required = false }: { required?: boolean }) {
  return <span aria-hidden="true" className={required ? styles.required : styles.optional}>{required ? '必須' : '任意'}</span>
}

export function FieldLabel({ required = false, children, size, ...props }: LabelHTMLAttributes<HTMLLabelElement> & { required?: boolean; size?: 'form' }) {
  return <div className={`${styles.label} ${size === 'form' ? styles.formLabel : ''}`}><label {...props}>{children}</label><FieldMark required={required} /></div>
}

export function FieldCount({ value, max, night = false }: { value: string; max: number; night?: boolean }) {
  return <p className={`${styles.count} ${night ? styles.nightCount : ''}`}>{value.length}/{max}文字</p>
}

function examplePlaceholder(value?: string) {
  return value?.replace(/^例\s*[:：]\s*/, '例：')
}

export function TextInput({ appearance = 'default', className = '', placeholder, ref, ...props }: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement>; appearance?: 'default' | 'night' | 'hidden' | 'pin' }) {
  const look = appearance === 'hidden' ? 'sr-only' : appearance === 'pin' ? styles.pin : appearance === 'night' ? styles.nightInput : styles.input
  return <input {...props} ref={ref} placeholder={examplePlaceholder(placeholder)} className={`${look} ${className}`} />
}

export function TextArea({ className = '', placeholder, appearance = 'default', ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & { appearance?: 'default' | 'booking' | 'event' }) {
  return <textarea {...props} placeholder={examplePlaceholder(placeholder)} className={`${styles.input} ${styles.textarea} ${appearance === 'booking' ? styles.bookingTextarea : appearance === 'event' ? styles.eventTextarea : ''} ${className}`} />
}

export function ChoiceInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={styles.choiceInput} />
}

type Mark = 'calendar' | 'clock' | 'chevron' | 'clip'
export function FieldIcon({ mark }: { mark: Mark }) {
  return <svg className={styles.icon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" data-field-icon={mark}>
    {mark === 'calendar' ? <><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M8 2v4m8-4v4M3 10h18" /></> : null}
    {mark === 'clock' ? <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></> : null}
    {mark === 'chevron' ? <path d="m6 9 6 6 6-6" /> : null}
    {mark === 'clip' ? <path d="m21 11-9 9a6 6 0 0 1-8.5-8.5l9-9a4 4 0 0 1 5.7 5.7l-9 9a2 2 0 0 1-2.8-2.8l8.3-8.3" /> : null}
  </svg>
}

export function FormTextControl({ block, value, onChange, ...props }: {
  block: FormInputBlock
  value: string
  onChange: (value: string) => void
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  const format = block.limit?.format
  const temporal = block.type === 'date' ? 'date' : format === 'time' ? 'time' : null
  const hint = block.placeholder || (temporal === 'date' ? '年/月/日' : temporal === 'time' ? '--:--' : '')
  const field = block.type === 'textarea' ? (
    <TextArea id={props.id} aria-describedby={props['aria-describedby']} aria-invalid={props['aria-invalid']} aria-required={props['aria-required']} style={props.style} readOnly={props.readOnly}
      rows={3} value={value} placeholder={block.placeholder || undefined} maxLength={block.limit?.max}
      onChange={(e) => onChange(e.target.value)} />
  ) : (
    <div className={styles.wrap}>
      <TextInput {...props} type={temporal ?? (format === 'email' ? 'email' : format === 'tel' ? 'tel' : 'text')}
        value={value} placeholder={block.placeholder || undefined} maxLength={block.limit?.max}
        onChange={(e) => onChange(e.target.value)} data-temporal={temporal || undefined} data-empty={temporal && !value || undefined} />
      {temporal && !value ? <span className={styles.temporalHint} aria-hidden="true">{hint}</span> : null}
      {temporal ? <span className={styles.endIcon}><FieldIcon mark={temporal === 'date' ? 'calendar' : 'clock'} /></span> : null}
    </div>
  )
  return <div className={styles.stack}>
    {field}
    {format === 'email' ? <p className={styles.note}>メールアドレスの形をチェックします</p> : null}
    {format === 'tel' ? <p className={styles.note}>電話番号の形をチェックします</p> : null}
  </div>
}

export function FormSelectControl({ children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <div className={styles.wrap}><select {...props} className={`${styles.input} ${styles.select}`}>{children}</select><span className={styles.endIcon}><FieldIcon mark="chevron" /></span></div>
}

export function FormChoiceRow({ children, selected }: { children: ReactNode; selected: boolean }) {
  return <label className={styles.choice} data-selected={selected || undefined}>{children}</label>
}

export function RatingStars({ name, current, onChange }: { name: string; current: number | null; onChange: (name: string, value: unknown) => void }) {
  return <div role="radiogroup" aria-label="5段階評価" className={styles.stars}>
    {[1, 2, 3, 4, 5].map((n) => <button key={n} type="button" role="radio" aria-checked={current === n} aria-label={`星${n}つ`} onClick={() => onChange(name, current === n ? '' : n)} className={styles.star} data-on={current != null && n <= current || undefined}>{current != null && n <= current ? '★' : '☆'}</button>)}
  </div>
}

// 写真の許可形式。PDF は質問の設定に応じて加える。
export const FORM_FILE_ACCEPT = 'image/jpeg,image/png,image/gif,image/webp,image/heic,image/heif'
export function FormFileControl({ label, uploading = false, onUpload, kind = 'image', kinds, bothSides = false, maxCount = 1, files = [], onRemove }: {
  label: string; uploading?: boolean; onUpload?: (file: File, side: 'single' | 'front' | 'back') => void;
  kind?: FormInputBlock['fileKind']; kinds?: FormInputBlock['fileKinds']; bothSides?: boolean; maxCount?: number;
  files?: (FormFileAnswer & { previewUrl?: string })[]; onRemove?: (fileId: string) => void;
}) {
  const allowedKinds = kinds ?? [kind];
  kind = allowedKinds.includes('identity') ? 'identity' : allowedKinds.includes('image') ? 'image' : 'pdf';
  const ref = useRef<HTMLInputElement>(null)
  const camera = useRef<HTMLInputElement>(null)
  const sideRef = useRef<'single' | 'front' | 'back'>('single')
  const [error, setError] = useState('')
  const [selectedSide, setSelectedSide] = useState<'front' | 'back'>('front')
  const [reselectOpen, setReselectOpen] = useState(false)
  const accept = [allowedKinds.some(k => k === 'image' || k === 'identity') ? FORM_FILE_ACCEPT : '', allowedKinds.includes('pdf') ? 'application/pdf' : ''].filter(Boolean).join(',')
  const choose = (file?: File) => {
    if (!file || allowedKinds.includes('identity')) return;
    if (file.size > 10 * 1024 * 1024 || !file.size) { setError('1ファイル10MBまでです'); return }
    if (!accept.split(',').includes(file.type)) { setError('受け取れる形式のファイルを選んでください'); return }
    setError(''); onUpload?.(file, sideRef.current)
  }
  const sides: ('single' | 'front' | 'back')[] = kind === 'identity' && bothSides ? ['front', 'back'] : ['single']
  const limit = sides.length === 2 ? 2 : Math.min(10, Math.max(1, maxCount))
  const atLimit = files.length >= limit
  useEffect(() => { if (!atLimit) setReselectOpen(false) }, [atLimit])
  const pick = (take: boolean) => {
    sideRef.current = sides.length === 2 ? files.some(f => f.side === selectedSide) ? (selectedSide === 'front' ? 'back' : 'front') : selectedSide : 'single';
    (take ? camera : ref).current?.click();
  }
  if (allowedKinds.includes('identity')) return <FieldError>本人確認書類は受け付けていません。店舗にお問い合わせください。</FieldError>
  return <div className={styles.fileControl}>
    <input ref={ref} type="file" aria-label={label} accept={accept} disabled={uploading} hidden onChange={e => { choose(e.target.files?.[0]); e.target.value = '' }} />
    <input ref={camera} type="file" aria-label={`${label}を撮る`} accept={FORM_FILE_ACCEPT} capture="environment" disabled={uploading} hidden onChange={e => { choose(e.target.files?.[0]); e.target.value = '' }} />
    <div className={styles.fileSlots} data-both-sides={sides.length === 2 || undefined}>
      {sides.map(side => {
        const entries = files.filter(file => (file.side ?? 'single') === side)
        const sideLabel = side === 'front' ? '表' : '裏'
        return <div key={side} className={styles.fileSide} role="group" aria-label={side === 'single' ? label : sideLabel}>
          {side !== 'single' && !entries.length ? <button type="button" className={styles.fileSlot} aria-label={`${sideLabel}（写真を入れる）`} aria-pressed={selectedSide === side} disabled={uploading} onClick={() => setSelectedSide(side)}><Icon name="image" className={styles.fileSlotIcon} /><span>{sideLabel}</span><span className={styles.note}>写真を入れる</span></button> : null}
          {entries.map(file => {
            const preview = file.previewUrl && file.mimeType?.startsWith('image/') ? <img className={styles.filePreview} src={file.previewUrl} alt="送った写真" /> : <span className={styles.fileName} title={file.filename}>{file.filename || '書類'}</span>
            return <div key={file.fileId} className={styles.fileItem}>
              {side !== 'single' ? <button type="button" className={styles.fileSelect} aria-label={`${sideLabel}を選ぶ`} aria-pressed={selectedSide === side} disabled={uploading} onClick={() => setSelectedSide(side)}>{preview}<span className={styles.fileSideLabel}>{sideLabel}</span></button> : <div className={styles.fileSelect}>{preview}</div>}
              <button type="button" className={styles.fileRemove} disabled={uploading} aria-label={`${file.filename || '書類'}を外す`} onClick={() => onRemove?.(file.fileId)}><Icon name="x" className={styles.fileRemoveIcon} /></button>
            </div>
          })}
        </div>
      })}
    </div>
    {files.length ? <div className={styles.fileNames}>{files.map(file => <span key={file.fileId} title={file.filename}>{file.filename || '書類'}{file.state === 'pending' ? '（検査中）' : ''}</span>)}</div> : null}
    {!atLimit ? <div className={styles.fileActions}>
      {kind !== 'pdf' ? <button type="button" className={styles.fileButton} disabled={uploading} onClick={() => pick(true)}><Icon name="camera" className={styles.icon} />写真を撮る</button> : null}
      {kind !== 'pdf' ? <button type="button" className={styles.fileButton} disabled={uploading} onClick={() => pick(false)}><Icon name="image" className={styles.icon} />写真を選ぶ</button> : null}
      <button type="button" className={styles.fileButton} disabled={uploading} onClick={() => pick(false)}><FieldIcon mark="clip" />ファイルを選ぶ</button>
    </div> : null}
    {atLimit && kind !== 'pdf' ? <div className={styles.fileReselect} data-open={reselectOpen || undefined}>
      <button type="button" className={styles.fileButton} disabled={uploading} aria-expanded={reselectOpen} onClick={() => setReselectOpen(!reselectOpen)}><Icon name="rotate-cw" className={styles.icon} />撮り直す・選び直す</button>
      {reselectOpen ? <div className={styles.fileActions}>
        {files.map(file => <button key={file.fileId} type="button" className={styles.fileButton} disabled={uploading} onClick={() => { if (file.side === 'front' || file.side === 'back') setSelectedSide(file.side); onRemove?.(file.fileId) }}>{file.side === 'front' ? '表' : file.side === 'back' ? '裏' : file.filename || '写真'}を外して選び直す</button>)}
      </div> : null}
    </div> : null}
    <p className={styles.note}>{kind === 'pdf' ? 'PDF・1ファイル10MBまで' : `JPG・PNG・GIF・WebP・HEIC・HEIF${allowedKinds.includes('pdf') ? '・PDF' : ''}・1ファイル10MBまで`}{`・${limit}枚まで`}</p>
    {uploading ? <p className={styles.note}>送っています…</p> : null}
    {error ? <p role="alert" className={styles.note}>{error}</p> : null}
  </div>
}

export type AddressDraft = { postalCode: string; prefecture: string; city: string; addressLine1: string; addressLine2: string }
export function AddressControls({ draft, placeholder, onChange, onLookup, looking = false, children }: {
  draft: AddressDraft; placeholder?: string; onChange: (draft: AddressDraft) => void; onLookup?: () => void; looking?: boolean; children?: ReactNode
}) {
  return <div className={styles.stack}>
    <div className={styles.stack}><span className={styles.note}>郵便番号</span>
    <div className={styles.postal}>
      <input type="text" inputMode="numeric" aria-label="郵便番号" value={draft.postalCode} onChange={(e) => onChange({ ...draft, postalCode: e.target.value })} className={styles.input} />
      <button type="button" className={styles.lookup} disabled={looking} onClick={onLookup}>{looking ? '調べています…' : '住所を探す'}</button>
    </div></div>
    {children}
    <FormSelectControl aria-label="都道府県" value={draft.prefecture} onChange={(e) => onChange({ ...draft, prefecture: e.target.value })}>
      <option value="">都道府県を選択</option>
      {/* 候補は入力部品の呼ぶ側からではなく共通の正本を使う。 */}
      {PREFECTURES.map((p) => <option key={p} value={p}>{p}</option>)}
    </FormSelectControl>
    {(['city', 'addressLine1', 'addressLine2'] as const).map((key, i) => <label key={key} className={styles.stack}><span className={styles.note}>{['市区町村', '番地', '建物名・部屋番号'][i]}{key === 'addressLine2' && <FieldMark />}</span><TextInput type="text" aria-label={['市区町村', '番地', '建物名'][i]} value={draft[key]} placeholder={key === 'addressLine1' ? placeholder || undefined : undefined} onChange={(e) => onChange({ ...draft, [key]: e.target.value })} /></label>)}
  </div>
}

export type BookingDay = { date: string; weekday: string; day: number; open: boolean }
export type BookingTime = { start: string; open: boolean; selected: boolean }
export function BookingControls({ menuLabel, days, selectedDate, times, onDate, onTime, children, preview = false }: {
  preview?: boolean; menuLabel?: string; days: BookingDay[]; selectedDate: string; times: BookingTime[]; onDate: (date: string) => void; onTime: (start: string) => void; children?: ReactNode
}) {
  return <div className={styles.stack}>
    {menuLabel ? <p className={styles.note}>{menuLabel}</p> : null}
    {children}
    <div className={styles.days} role="group" aria-label="日付" style={days.length === 7 ? { ['--day-cols' as string]: 7 } : undefined}>
      {days.map((d) => <button key={d.date} type="button" className={styles.day} aria-pressed={selectedDate === d.date} aria-label={`${Number(d.date.slice(5, 7))}月${d.day}日${d.open ? '' : ' 空きなし'}`} data-off={!d.open || undefined} disabled={!d.open && !preview} aria-disabled={!d.open || undefined} onClick={() => { if (d.open) onDate(d.date) }}><span className={styles.weekday}>{d.weekday}</span><span>{d.day}</span></button>)}
    </div>
    <div className={styles.times}>
      {times.map((t) => <button key={t.start} type="button" className={styles.time} aria-pressed={t.selected} disabled={!t.open && !preview} aria-disabled={!t.open || undefined} data-off={!t.open || undefined} onClick={() => { if (t.open) onTime(t.start) }}>{t.start}</button>)}
    </div>
  </div>
}

/** 'YYYY-MM-DD' を [年, 月, 日] に分ける。形でない値は空3つにする。 */
function splitYmd(value: string): [string, string, string] {
  const m = /^(\d{1,4})-(\d{1,2})-(\d{1,2})$/.exec(value);
  return m ? [m[1], m[2], m[3]] : ['', '', ''];
}

/**
 * 日付を「年・月・日」の3欄で入れる。
 *
 * 編集画面で「年月日を3つに分ける」を選んだ日付欄に使う。カレンダー式は
 * 選びにくい年代（生年月日など）があるための出し分け。
 * 3欄とも入るまでは形の合わない値を回答に入れ、送信時の検証で
 * 「日付を選んでください」へ流す（途中経過を正しい値と誤認しないため）。
 */
export function DateYmdField({
  value,
  onChange,
  placeholder,
  readOnly,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  readOnly?: boolean;
}) {
  const [parts, setParts] = useState<[string, string, string]>(() => splitYmd(value));
  // 自分が出した値が戻ってきたときは欄を上書きしない（途中の入力が消えるため）
  const lastEmitted = useRef<string | null>(null);

  useEffect(() => {
    if (value === lastEmitted.current) return;
    setParts(splitYmd(value));
  }, [value]);

  const update = (index: number, raw: string) => {
    const digits = raw.replace(/[^\d]/g, '').slice(0, index === 0 ? 4 : 2);
    const next = [...parts] as [string, string, string];
    next[index] = digits;
    setParts(next);
    const all = next.every((p) => p !== '');
    const emitted = all
      ? `${next[0].padStart(4, '0')}-${next[1].padStart(2, '0')}-${next[2].padStart(2, '0')}`
      : next.some((p) => p !== '')
        ? `${next[0] || '0000'}-${next[1] || '00'}-${next[2] || '00'}`
        : '';
    lastEmitted.current = emitted;
    onChange(emitted);
  };

  const partClass = styles.input;
  const specs: { placeholder: string; label: string; maxLength: number }[] = [
    { placeholder: '年', label: '年', maxLength: 4 },
    { placeholder: '月', label: '月', maxLength: 2 },
    { placeholder: '日', label: '日', maxLength: 2 },
  ];
  return (
    <div className={styles.ymd}>
      {specs.map((spec, i) => (
        <span key={spec.label} className={styles.ymdPart}>
          <input
            type="text"
            inputMode="numeric"
            value={parts[i]}
            maxLength={spec.maxLength}
            placeholder={i === 0 ? placeholder || spec.placeholder : spec.placeholder}
            readOnly={readOnly}
            aria-label={spec.label}
            onChange={(e) => update(i, e.target.value)}
            className={partClass}
          />
          <span className={styles.note}>{spec.label}</span>
        </span>
      ))}
    </div>
  );
}

/** LIFF の全画面が使う素の欄。識別子・電話・選択・添付の意味は変えない。 */
export const LiffInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & {appearance?:'night'|'concealed'|'pin'}>(function LiffInput({className, appearance, type='text',...props},ref) {
 const choice=type==='radio'||type==='checkbox'
 return <input {...props} ref={ref} type={type} className={[appearance==='concealed'?styles.concealedInput:appearance==='pin'?styles.pinInput:choice?styles.choiceInput:appearance==='night'?styles.nightInput:styles.input,className].filter(Boolean).join(' ')} />
})
export const LiffTextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function LiffTextArea({className,rows=3,...props},ref){return <textarea {...props} ref={ref} rows={rows} className={[styles.input,styles.textarea,className].filter(Boolean).join(' ')} />})
export function RequiredMark() { return <span aria-hidden="true" className={styles.required}>必須</span> }
export function OptionalMark() { return <span aria-hidden="true" className={styles.optional}>任意</span> }
export function LiffFieldLabel({label,children,required=false,optional=!required,as:Tag='label',className,...props}: LabelHTMLAttributes<HTMLLabelElement> & {label?:string;required?:boolean;optional?:boolean;as?:'label'|'span'}) {
 const text=label ?? children
 const shown=typeof text==='string'?text.replace(/\s*[（(](任意|必須)[）)]/g,'').replace(/\s*[*＊]$/,''):text
 return <span className={styles.labelRow}><Tag {...props} className={[styles.label,className].filter(Boolean).join(' ')}>{shown}</Tag>{required?<RequiredMark/>:optional?<OptionalMark/>:null}</span>
}

/** 日付のネイティブ選択は共通の入力部品だけが描く。 */
export function HiddenDateInput(props: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { ref?: Ref<HTMLInputElement> }) {
  return <TextInput {...props} appearance="hidden" type="date" />
}

/** 空き時刻の選択。読み上げと選択状態を共通ボタンへ渡す。 */
/** お客さまの人数選択。5名以上は人数を選び直せる。 */
export function RestaurantGuestChoices({label, value, onChange}: {label:string; value:number; onChange:(n:number)=>void}) {
  return <>
    <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={label}>
      {[1,2,3,4].map(n => <Button key={n} variant="chip" selected={value===n} role="radio" aria-checked={value===n} onClick={() => onChange(n)}>{n}名</Button>)}
      <Button variant="chip" selected={value>=5} role="radio" aria-checked={value>=5} onClick={() => onChange(5)}>5名以上</Button>
    </div>
    {value>=5 && <div><FieldLabel htmlFor="seat-more-guests" required>人数を選ぶ</FieldLabel><FormSelectControl id="seat-more-guests" aria-label="5名以上の人数" value={value} onChange={e => onChange(Number(e.target.value))}>{Array.from({length:Math.max(20,value)-4}, (_,i)=>i+5).map(n=><option key={n} value={n}>{n}名</option>)}</FormSelectControl></div>}
  </>
}

export function RestaurantTimeChoices({ options, value, onChange }: {
  options: { value: string; label: string; accessibleLabel: string; available: boolean }[];
  value: string | null;
  onChange: (value: string) => void;
}) {
  return <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="時刻">{options.map(option =>
    <Button variant="time" key={option.value} role="radio" aria-checked={option.value === value}
      aria-label={option.accessibleLabel} selected={option.value === value} disabled={!option.available}
      onClick={() => onChange(option.value)}><span className="flex flex-col"><span>{option.label}</span><span>{option.accessibleLabel.slice(option.label.length).trim()}</span></span></Button>
  )}</div>
}

/** LIFFの欄に結び付く失敗。再試行の操作は呼ぶ側に残す。 */
export function FieldError({ children, tone = 'danger' }: { children: ReactNode; tone?: 'danger' | 'inherit' }) {
  return <p role="alert" className={tone === 'danger' ? 'text-[13px] leading-5 text-danger' : undefined}>{children}</p>
}
