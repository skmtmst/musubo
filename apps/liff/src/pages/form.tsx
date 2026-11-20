import { jstDate as japanDate } from '@line-crm/shared';
import { useCustomerWords, useCustomerStyle } from '../components/customer-style-scope.js';
import { LiffApiError, liffErrorMessage } from '../lib/api-error.js';
import { useRequestGeneration } from '../lib/use-request-generation.js';
import SeatBookingBlock from '../components/seat-booking-block.js';
import { restaurantBookingApi } from '../lib/api.js';
import FormReception, { choiceReceptionLabel } from '../components/form-reception.js';
import { TextInput, RadioChoiceInput, CheckboxChoiceInput, PaymentMethodChoices, PaymentPolicyConsent, FieldLabel, FieldCount } from '../components/forms/controls.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import liff from '../lib/liff-runtime.js';
import { PREFECTURES, collectInputs, formFileKinds, isOtherFreeText, formChoiceIsSelected, nextSectionIndex, normalizeBookingValue, normalizeFormTheme, normalizeRatingValue, validateAnswer, type FormAvailability, type FormBlock, type FormBookingValue, type FormInputBlock, type FormLayout } from '@line-crm/shared';
import { submitButtonText } from '../lib/form-button-text.js';
import { api, type MenuItem, type PublicForm, type RoutedTarget, type StaffItem } from '../lib/api.js';
import Stepper from '../components/ui/Stepper.js';
import { NoRoutedSlots, RoutedBanner, RoutedConfirm } from '../components/routed-booking.js';
import { addDays, formatWeekday, slotStartsAtIso, formatJstEventAt, jstToday, utcToJstHm, utcToJstMd } from '../lib/datetime.js';
import { conflictMessage, decideFormSubmitStep, FORM_SUBMIT_INCOMPLETE_MESSAGE } from '../lib/form-submit-flow.js';
import { logFailure } from '../lib/user-message.js';
import { useWideViewport } from '../lib/use-wide-viewport.js';
import LoadErrorView from '../components/load-error-view.js';
import LoadingView from '../components/loading-view.js';
import Button from '../components/ui/button/index.js';
import LiffHeader from '../components/ui/liff-header.js';
import BottomBar from '../components/ui/bottom-bar.js';
import PrivacyNote from '../components/ui/privacy-note.js';
import StatusView from '../components/ui/status-view.js';
import Icon from '../components/ui/icon.js';
import FieldError from '../components/ui/field-error.js';
import MeetingModeChoices from '../components/meeting-mode-choices.js';
import { DateYmdField, BookingControls, FormChoiceRow, FormFileControl, FormSelectControl, FormTextControl, RatingStars } from '../components/forms/controls';
import { type AddressDraft, AddressFields } from "../components/form-address-fields.js"
/**
 * 回答フォーム（友だちが実際に入力する画面）。
 *
 * 管理画面で組んだ layout を、そのまま入力欄に起こす。ページ（セクション）
 * が2枚以上あるときは1枚ずつ出し、選択肢に行き先が付いていればそこへ飛ぶ。
 *
 * 検証は入力のたびではなく「次へ / 送信」を押したときに出す。打っている
 * 最中に赤が出ると、まだ入力し終えていないだけなのに間違いだと言われている
 * ように見える。
 *
 * ここでの検証は親切のためで、正しさの最終判断はサーバがする。画面を
 * 通り抜けられても、保存側で同じ検証にかかる。
 */

type Answers = Record<string, unknown>;

/** 予約欄の追加情報。既存の回答の日時・担当と同じ単位で保持する。 */
function formMeetingMode(value: unknown): 'online' | 'in_person' | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const mode = (value as Record<string, unknown>).meetingMode;
  return mode === 'online' || mode === 'in_person' ? mode : null;
}

/** 選択肢を選んだ状態から、はじめの値を作る。 */
function initialAnswers(layout: FormLayout, availability?: FormAvailability): Answers {
  const answers: Answers = {};
  for (const block of collectInputs(layout)) {
    const limited = availability?.choices[block.name] ?? {};
    const defaultValue = block.defaultValue;
    if (defaultValue && !(block.choices ?? []).some(c => limited[c.id]?.full && formChoiceIsSelected(block, c, [defaultValue]))) {
      answers[block.name] = defaultValue;
      continue;
    }
    const preselected = (block.choices ?? []).filter((c) => c.defaultSelected && !limited[c.id]?.full);
    if (preselected.length === 0) continue;
    answers[block.name] =
      block.type === 'checkbox' ? preselected.map((c) => c.label) : preselected[0].label;
  }
  return answers;
}

/**
 * 送信ボタンの文字。管理画面で決めた名前があればそれを使い、
 * 決めていないとき (空・旧い既定の「送信」) は設計どおり「送信する」。
 */
function submitLabelText(label: string | undefined): string {
  if (label && label !== '送信') return label;
  return '送信する';
}

/** 「その他」の選択肢ラベル。無ければ空。 */
function otherLabel(block: FormInputBlock): string {
  return (block.choices ?? []).find((choice) => choice.isOther)?.label ?? '';
}

/** 「その他」を選んだときに出す自由記入欄。 */
function OtherTextInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <TextInput
      type="text"
      value={value}
      placeholder="具体的に入力してください"
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export default function Form({ readOnlyDocument = false }: {readOnlyDocument?:boolean} = {}) {
  const words = useCustomerWords();
  const style = useCustomerStyle();
  const route = useParams<{ id: string }>();
  const [search] = useSearchParams();
  const id = route.id ?? search.get('id') ?? undefined;
  /**
   * P（試し回答）：管理画面の試しURLに付く合言葉。あるときは下書きを試す。
   * 試しの回答は集計に入らず、回答後の動作も動かない。
   */
  const testToken = readOnlyDocument ? null : search.get('test_token');

  // 414 幅の板（）は板 ID だけを替える。中身は同じ。
  const wide = useWideViewport();
  const [form, setForm] = useState<PublicForm | null>(null);
  const [answers, setAnswers] = useState<Answers>({});
  const [sectionIndex, setSectionIndex] = useState(0);
  /** 通ってきたページ。「前へ」で分岐を逆にたどるために覚える */
  const [trail, setTrail] = useState<number[]>([]);
  const request = useRequestGeneration(JSON.stringify([id, testToken, sectionIndex,readOnlyDocument]));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(false);
  const [confirming, setConfirming] = useState(false);
  /**
   * 欄ごとの直し方。★管理画面 (4-a) は欄のすぐ下に出す。
   * 画面下の `error` はサーバの失敗 (送信・画像) だけに使い、検証とは分ける。
   */
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  /** 送信中のファイル欄。二重に押させないため欄ごとに持つ */
  const filePreviewUrls = useRef(new Set<string>());
  useEffect(() => () => { filePreviewUrls.current.forEach(url => URL.revokeObjectURL(url)); }, []);
  const [uploading, setUploading] = useState<Record<string, boolean>>({});
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setForm(null);
      setError(null);
      setDone(false);setConfirming(false);setSectionIndex(0);setTrail([]);
      try {
        const data = await api.getForm(id, testToken ?? undefined);
        if (cancelled) return;
        const defaults = initialAnswers(data.layout, data.availability);
        setForm(data);
        setAnswers(defaults);
        // タブの題は上の帯（LiffHeader）が pageTitle・フォーム名から付ける。

        // 前回の回答を出す設定のときだけ、サーバが中身を返す。
        // 試しでは前の試しを書き戻さない（本物の回答も出さない）。
        if (!readOnlyDocument && !testToken && data.layout.options?.restorePrevious) {
          try {
            const latest = await api.getMyLatestFormAnswer(id);
            if (!cancelled && latest?.answers) {
              setAnswers((prev) => {
                const next = { ...prev, ...latest.answers };
                // 添付は回答ごとに選び直す。
                collectInputs(data.layout).filter(block => block.type === 'file').forEach(block => { delete next[block.name]; });
                for (const block of collectInputs(data.layout)) {
                  const full = (block.choices ?? []).filter(c => data.availability?.choices[block.name]?.[c.id]?.full);
                  const unavailable = (value: string) => full.some(c => formChoiceIsSelected(block, c, [value]));
                  if (Array.isArray(next[block.name])) next[block.name] = (next[block.name] as string[]).filter(v => !unavailable(v));
                  else if (unavailable(String(next[block.name] ?? ''))) next[block.name] = '';
                }
                return next;
              });
            }
          } catch {
            // 前回の回答は無くても入力はできる
          }
        }
      } catch (err) {
        if (!cancelled) {
          logFailure('form-load', err);
          setError(
            (err as { status?: number }).status === 404
              ? 'このフォームは見つかりませんでした'
              : 'フォームを開けませんでした',
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, reloadKey, testToken,readOnlyDocument]);

  const layout = form?.layout;
  const section = layout?.sections[sectionIndex];

  /**
   * 答えで予約の行き先を分けるフォーム（B6）：予約の欄があるページに来たら、答えから行き先を決めてもらう。
   * 行き先はサーバーが決める（お客さまは書き換えられない）。決められなければ「どれにも当たらない」行き先へ。
   */
  const routingBlock = layout?.sections.flatMap((s) => s.blocks).find((b): b is FormInputBlock => b.kind === 'input' && b.type === 'booking' && b.booking?.routing?.enabled === true);
  const routingOn = !readOnlyDocument && Boolean(routingBlock);
  /** 予約を作るときに添える署名（行き先は答えで決まり、お客さまは書き換えられない）。 */
  const routingToken = useRef<string | null>(null);
  const pageHasBooking = Boolean(section?.blocks.some((b) => b.kind === 'input' && b.type === 'booking'));
  const routedPage = routingOn && pageHasBooking;
  const bookingName = section?.blocks.find((b) => b.kind === 'input' && b.type === 'booking');
  const routedPicked = bookingName && bookingName.kind === 'input' ? normalizeBookingValue(answers[bookingName.name])?.startsAt ?? null : null;
  const [routed, setRouted] = useState<RoutedState | undefined>(undefined);
  const [routedRetry, setRoutedRetry] = useState(0);
  const [routedEmpty, setRoutedEmpty] = useState(false);
  /** 日時を選んだあとの「確認」の段（手順の帯の 3 つ目）。ここで初めて送る。 */
  const [routedConfirm, setRoutedConfirm] = useState(false);
  /** 予約の欄が必須で日時がまだのあいだは進めない（空きが無いときは問い合わせへ）。 */
  const routedNeedsPick = Boolean(bookingName && bookingName.kind === 'input' && bookingName.required) && !routedPicked && !routedEmpty;
  const answersKey = JSON.stringify(answers);
  useEffect(() => {
    if (!routingOn || !pageHasBooking || !id) { setRouted(undefined); return; }
    let alive = true;
    setRouted({ status: 'loading' });
    api.resolveFormRouting(id, JSON.parse(answersKey) as Record<string, unknown>, routingBlock?.id)
      .then(async (r) => {
        /* 口は行き先の ID だけを返す。見せる名前・時間・料金・担当の名前は、メニューと担当の口で読み足す。 */
        const [menus, staff] = await Promise.all([api.menus().catch(() => ({ menus: [] as MenuItem[] })), r.target.staffId ? api.staffOf(r.target.menuId).catch(() => ({ staff: [] as StaffItem[] })) : Promise.resolve({ staff: [] as StaffItem[] })]);
        const menu = menus.menus.find((m) => m.id === r.target.menuId);
        if (!alive) return;
        routingToken.current = r.routingToken;
        setRouted({ status: 'ready', target: {
          menuId: r.target.menuId, menuName: menu?.name ?? 'ご案内のメニュー', durationMinutes: menu?.duration_minutes ?? 0, price: menu?.base_price ?? 0,
          staffId: r.target.staffId ?? null, staffName: staff.staff.find((s) => s.id === r.target.staffId)?.display_name ?? null, meetingMode: r.target.meetingMode ?? null } });
      })
      .catch((e) => { logFailure('form-routing-resolve', e); if (alive) setRouted({ status: 'error', retry: () => setRoutedRetry((n) => n + 1) }); });
    return () => { alive = false; };
  }, [routingOn, pageHasBooking, id, answersKey, routedRetry, routingBlock?.id]);

  /** いま出ているページの入力欄。検証はここだけを見る。 */
  const visibleInputs = useMemo(() => {
    if (!layout || !section) return [];
    return [...layout.header, ...section.blocks].filter(
      (b): b is Extract<FormBlock, { kind: 'input' }> => b.kind === 'input' && !b.hidden,
    );
  }, [layout, section]);

  const isLast = useMemo(() => {
    if (!layout) return true;
    return nextSectionIndex(layout, sectionIndex, answers) >= layout.sections.length;
  }, [layout, sectionIndex, answers]);

  /** 欄を直したら、その欄の直し方を消す (直したのに残らないため)。 */
  const clearFieldError = (name: string) =>
    setFieldErrors((prev) => {
      if (!(name in prev)) return prev;
      const next = { ...prev };
      delete next[name];
      return next;
    });

  const setValue = (name: string, value: unknown) => {
    setAnswers((prev) => ({ ...prev, [name]: value }));
    clearFieldError(name);
  };

  const toggleCheckbox = (name: string, label: string) => {
    setAnswers((prev) => {
      const current = Array.isArray(prev[name]) ? (prev[name] as string[]) : [];
      return {
        ...prev,
        [name]: current.includes(label)
          ? current.filter((v) => v !== label)
          : [...current, label],
      };
    });
    clearFieldError(name);
  };

  /**
   * ファイルを預けて、回答には添付のIDを入れる。
   *
   * 中身をそのまま回答データに入れない。回答は D1 に JSON で入るので、
   * 画像を base64 で持たせると1件で数MBになり、一覧を開くだけで重くなる。
   */
  const uploadFile = async (name: string, file: File, side: 'single' | 'front' | 'back' = 'single') => {
    if (!id) return;
    setError(null);
    setUploading((prev) => ({ ...prev, [name]: true }));
    try {
      if (!layout) return;
      const block = collectInputs(layout).find(b => b.name === name);
      if (!block) return;
      if (formFileKinds(block).includes('identity')) { setError('本人確認書類は受け付けていません。店舗にお問い合わせください。'); return; }
      const res = await api.uploadFormFile(id, file, testToken ?? undefined, block.id, side);
      if (res.data.file) {
        const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined;
        if (previewUrl) filePreviewUrls.current.add(previewUrl);
        const entry = { ...res.data.file, previewUrl };
        setAnswers(previous => ({ ...previous, [name]: [...(Array.isArray(previous[name]) ? previous[name] as import('@line-crm/shared').FormFileAnswer[] : []), entry] }));
      } else if (res.data.url) setValue(name, res.data.url);
      else throw new Error('document_upload_response_missing');
      clearFieldError(name);
    } catch (err) {
      logFailure('form-upload', err);
      setError(err instanceof LiffApiError && err.status >= 400 && err.status < 500 && err.status !== 429
        ? err.message
        : 'ファイルを送れませんでした。時間をおいて、もう一度ファイルを選んでください。');
    } finally {
      setUploading((prev) => ({ ...prev, [name]: false }));
    }
  };

  /**
   * このページだけを見る。次のページの必須は、そこへ着くまで問わない。
   * 直し方は欄ごとに返し、呼び出し側が欄の下へ出す。
   */
  const validateVisible = (): { errors: Record<string, string>; first: string | null } => {
    const errors: Record<string, string> = {};
    for (const block of visibleInputs) {
      if (block.name in errors) continue;
      const value = answers[block.name];
      const unavailable = block.type === 'file' && formFileKinds(block).includes('identity');
      const hasFile = Array.isArray(value) ? value.length > 0 : !!value;
      const message = unavailable && (block.required || hasFile)
        ? '本人確認書類は受け付けていません。店舗にお問い合わせください。'
        : validateAnswer(block, value);
      if (message) errors[block.name] = message;
      const picked = block.type === 'booking' ? normalizeBookingValue(answers[block.name]) : null;
      if (style === 'consult' && picked && picked.kind !== 'seats' && !formMeetingMode(answers[block.name])) {
        errors[block.name] = '会い方を選んでから日時を選び直してください。';
      }
    }
    return { errors, first: Object.values(errors)[0] ?? null };
  };

  const goNext = () => {
    const { errors, first } = validateVisible();
    setFieldErrors(errors);
    if (first) return;
    setError(null);
    if (!layout) return;
    const to = nextSectionIndex(layout, sectionIndex, answers);
    if (to >= layout.sections.length) return;
    setTrail((prev) => [...prev, sectionIndex]);
    setSectionIndex(to);
    window.scrollTo({ top: 0 });
  };

  const goBack = () => {
    request.invalidate();
    setSending(false);
    setError(null);
    setTrail((prev) => {
      const next = [...prev];
      const to = next.pop();
      if (to !== undefined) setSectionIndex(to);
      return next;
    });
    window.scrollTo({ top: 0 });
  };

  // 論理送信単位の安定した冪等キー。この画面を開いている間は同じ値を
  // 使い続け、連打・通信再送を同じ回答としてまとめる
  // (イベント予約の確認画面と同じ流儀)。送り直しも同じキーで行い、
  // 新しいキーへの付け替えは利用者の明示の送り直し操作のときだけ行う。
  const [idemKey, setIdemKey] = useState<string>(() => crypto.randomUUID());
  // 内容違い・期限切れの使い回し。自動では送り直さず、利用者の操作を待つ。
  const [conflict, setConflict] = useState<
    null | { code: 'idempotency_content_mismatch' | 'idempotency_expired' }
  >(null);
  /**
   * 回答は保存できたが予約の確保に失敗したときの文言。空でなければ
   * 終わり画面に直し方と送り直しを出す（回答自体は保存済みと伝える）。
   */
  const [bookingError, setBookingError] = useState<string | null>(null);
  const [courseRefresh, setCourseRefresh] = useState(0);
  const [bookingRetrying, setBookingRetrying] = useState(false);
  /** 確保できた予約 (終わりの画面の一文「次回のご予約（10月14日 13:00）は…」に使う)。 */
  const [booked, setBooked] = useState<Array<{ startsAt: string; status: string }>>([]);
  const [formPayment,setFormPayment]=useState<{blockId:string;submissionKey:string;paymentMethod?:'online'|'onsite';total:number;amount:number;remaining:number;cancellation:string;policyVersion:number}|null>(null);
  const [formPaymentAccepted,setFormPaymentAccepted]=useState(false);
  const [formPaymentChoice,setFormPaymentChoice]=useState<'online'|'onsite'|undefined>();
  const [formPaymentChoiceRequired,setFormPaymentChoiceRequired]=useState(false);
  const paymentRequest=search.get('payment_request'),paymentStore=search.get('storeId'),paymentResult=search.get('payment_result');
  useEffect(()=>{
    if(!paymentRequest || !paymentStore || !paymentResult)return;
    let active=true;
    restaurantBookingApi.mine(paymentStore).then(result=>{
      if(!active)return;
      const row=result.data.find(item=>item.paymentRequestId===paymentRequest);
      setDone(true);
      if(row?.status==='confirmed') {setBooked([{startsAt:row.startsAt,status:row.status}]);setBookingError(null);}
      else {setBooked([]);setBookingError(row?.paymentStatus==='refunded'?'予約を確定できなかったため、お支払いは返金されました。':paymentResult==='cancelled'?'お支払いは完了していません。':'お支払いと予約の状態を確認しています。しばらくしてから読み直してください。');}
    }).catch(()=>{if(active){setDone(true);setBookingError('お支払いの状態を読み込めませんでした。');}});
    return()=>{active=false};
  },[paymentRequest,paymentStore,paymentResult]);

  const submitErrorText = (err: unknown): string => {
    const status = (err as { status?: number }).status;
    const body = (err as { body?: { error?: string; code?: string } }).body;
    if (status === 429 || body?.code === 'idempotent_in_progress') {
      return '送信を処理中です。少し待って送り直してください。';
    }
    // サーバが断った理由（期限切れ・1人1回・定員）はそのまま出す
    return liffErrorMessage(body, '送信できませんでした。時間をおいて試してください。');
  };

  /**
   * 「予約を入れる」欄の枠を確保する。予約は「未承認」で入り、店が承認する。
   * 枠の再確認と重なり防止は予約の受け口が担い、埋まっていれば断る。
   * 試し回答では予約を入れない。失敗の文言を返し、空なら全件確保できた。
   */
  const ensureBookings = async (key: string, generation: number): Promise<string | null> => {
    if (testToken || !layout) return null;
    const targets = collectInputs(layout)
      .map((block) => ({ block, picked: normalizeBookingValue(answers[block.name]) }))
      .filter((t) => t.block.type === 'booking' && t.picked !== null);
    const made: Array<{ startsAt: string; status: string }> = [];
    setBooked([]);
    for (const { block, picked } of targets) {
      if (!request.isCurrent(generation)) return null;
      const slot = picked!;
      const meetingMode = formMeetingMode(answers[block.name])
        ?? (routingBlock?.id === block.id && routed?.status === 'ready' ? routed.target.meetingMode : null);
      if (style === 'consult' && slot.kind !== 'seats' && !meetingMode) return '会い方を確かめてから日時を選び直してください。回答は保存されています。';
      try {
        const res = slot.kind === 'seats'
          ? (await restaurantBookingApi.formBooking({formId:id!,blockId:block.id,submissionKey:key,preview:true,...(formPaymentChoice?{paymentMethod:formPaymentChoice}:{})})).data
          : await api.createRequest(
          { menu_id: slot.menuId, staff_id: slot.staffId, starts_at: slot.startsAt, ...(meetingMode ? { meeting_mode: meetingMode } : {}), ...(routingToken.current && routingBlock?.id === block.id ? { routingToken: routingToken.current } : {}) },
          `${key}:booking:${block.id}`,
        );
        if (!request.isCurrent(generation)) return null;
        if('payment' in res && res.payment && 'required' in res.payment && res.payment.required) {
          setFormPaymentAccepted(false);setFormPayment({blockId:block.id,submissionKey:key,paymentMethod:formPaymentChoice,total:res.payment.quote.total,amount:res.payment.quote.amount,remaining:res.payment.quote.remaining,cancellation:res.payment.quote.cancellation.text,policyVersion:res.payment.quote.cancellation.version});
          return '回答を保存しました。予約を完了するにはお支払いが必要です。';
        }
        made.push({ startsAt: slot.startsAt, status: res?.status ?? 'requested' });
        setBooked([...made]);
      } catch (err) {
        logFailure('form-booking-request', err);
        const code = (err as { body?: { error?: string } }).body?.error;
        if(code==='payment_method_required'){setFormPaymentChoiceRequired(true);return 'お支払い方法を選んで、予約を取り直してください。';}
        if (code === 'slot_not_available') {
          return '選んだ枠が埋まりました。日時を選び直してください。';
        }
        return '予約の確保に失敗しました。回答は保存されています。';
      }
    }
    return null;
  };

  const retryBookings = async () => {
    const generation = request.begin();
    setBookingRetrying(true);
    try {
      const message = await ensureBookings(idemKey, generation);
      if (request.isCurrent(generation)) setBookingError(message);
    } finally {
      if (request.isCurrent(generation)) setBookingRetrying(false);
    }
  };

  const sendFlow = async (key: string, generation: number): Promise<void> => {
    // 送り直しの判定は lib/form-submit-flow.ts の判定表に従う。内容違い・
    // 期限切れの自動付け替えはここには書かない(書くと二重回答になる)。
    let current = key;
    for (let i = 0; i < 6; i += 1) {
      if (!request.isCurrent(generation)) return;
      const attempt = await api.submitForm(id!, {
        data: Object.fromEntries(Object.entries(answers).map(([name, value]) => [name, Array.isArray(value) ? value.map(v => v && typeof v === 'object' && 'fileId' in v ? { fileId: v.fileId } : v) : value])),
        trackedLinkId: search.get('ref') ?? undefined,
      }, current, testToken ?? undefined);
      if (!request.isCurrent(generation)) return;
      if (attempt.status === 409 && attempt.body?.code === 'restaurant_course_unavailable') {
        setIdemKey(crypto.randomUUID());
        setCourseRefresh(n => n + 1);
        setError('選んだメニューが見つかりません。メニューを選び直してください。');
        return;
      }
      const decision = decideFormSubmitStep(attempt);
      if (decision.action === 'done') {
        // 回答の保存後に予約を確保する。予約だけ失敗しても回答は残す。
        const bookingMessage = await ensureBookings(current, generation);
        if (!request.isCurrent(generation)) return;
        setBookingError(bookingMessage);
        const url = !bookingMessage ? layout!.options?.thanksUrl : undefined;
        if (url) {
          window.location.href = url;
          return;
        }
        setDone(true);
        window.scrollTo({ top: 0 });
        return;
      }
      if (decision.action === 'poll-same') {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      if (decision.action === 'adopt-key') {
        current = decision.key;
        setIdemKey(decision.key);
        continue;
      }
      if (decision.action === 'conflict') {
        setConflict({ code: decision.code });
        setError(conflictMessage(decision.code));
        return;
      }
      if (decision.action === 'busy') {
        setError('送信を処理中です。少し待って送り直してください。');
        return;
      }
      throw new Error(decision.message);
    }
    throw new Error(FORM_SUBMIT_INCOMPLETE_MESSAGE);
  };

  const submit = async (keyOverride?: string) => {
    if (!id || !layout) return;
    const { errors, first } = validateVisible();
    setFieldErrors(errors);
    if (first) return;
    if (layout.options?.confirmDialog?.enabled && !confirming && !keyOverride) {
      setConfirming(true);
      return;
    }

    if (sending) return;
    const generation = request.begin();
    setConfirming(false);
    setSending(true);
    setError(null);
    setConflict(null);
    setBookingError(null);
    try {
      await sendFlow(keyOverride ?? idemKey, generation);
    } catch (err) {
      if (!request.isCurrent(generation)) return;
      logFailure('form-submit', err);
      setError(submitErrorText(err));
    } finally {
      if (request.isCurrent(generation)) setSending(false);
    }
  };

  // 利用者の明示の送り直し操作のときだけ、新しいキーで送る。
  const resendWithFreshKey = async () => {
    const fresh = crypto.randomUUID();
    setIdemKey(fresh);
    setConflict(null);
    await submit(fresh);
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-canvas">
        <LiffHeader title="フォーム" />
        <div className="mx-auto w-full max-w-md p-4"><LoadingView /></div>
      </div>
    );
  }

  if (error && !form) {
    return <LoadErrorView message={error} onRetry={() => setReloadKey((k) => k + 1)} />;
  }

  if (!form || !layout) return null;

  const options = layout.options ?? {};
  const theme = normalizeFormTheme(options.theme);
  /**
   * デザイン設定でフォームの色を決めているときだけ true。
   * 決めていなければ ★V8  の白い地のままにし、既定の薄緑は付けない。
   */
  const hasCustomTheme = options.theme !== undefined && options.theme !== null;

  // P（試し回答）：試し合言葉があるときは、受付停止の下書きでも試せる。
  if ((!form.isActive && !testToken) || form.availability?.accepting === false) {
    return (
      <div className="min-h-screen bg-canvas">
        <LiffHeader title={options.pageTitle || form.name} />
        <div className="mx-auto max-w-md" style={{ backgroundColor: theme.sub }}>
          <StatusView icon="calendar" title={form.availability?.reason || 'このフォームは、いま回答を受け付けていません。'} />
          <Button variant="secondary" onClick={() => setReloadKey(n => n + 1)}>もう一度読み込む</Button>
        </div>
      </div>
    );
  }

  if (done) {
    // ★V8 ：お礼を題に、予約を入れたときはその日時と次の動きを本文に出す。
    const bookingNote = booked
      .map((b) => {
        const [m, d] = utcToJstMd(b.startsAt).split('/');
        const when = `${m}月${d}日 ${utcToJstHm(b.startsAt)}`;
        return b.status === 'confirmed'
          ? `次回のご予約（${when}）が決まりました。`
          : `次回のご予約（${when}）は${words.approvalPending}です。決まったらLINEでお知らせします。`;
      })
      .join('\n');
    return (
      <div className="min-h-screen bg-canvas" data-design-node="aNZKe">
        <LiffHeader title={options.pageTitle || form.name} />
        <div
          className="mx-auto max-w-md pb-[90px]"
          style={{ backgroundColor: hasCustomTheme ? theme.sub : undefined }}
        >
          {/* 上の帯と下の帯の間の真ん中に置く (送信しました)。 */}
          <div className="flex min-h-[calc(100dvh-var(--liff-header-h)-1px-90px)] flex-col items-center justify-center px-6">
            <StatusView
              icon="check"
              tone="success"
              large
              title={layout.options?.thanksText || 'ご回答ありがとうございました'}
              body={bookingNote || undefined}
            />
          </div>
          {testToken ? (
            <p className="px-6 pb-8 text-center text-xs text-ink-faint">
              試しの回答のため、集計には入りません。
            </p>
          ) : null}
          {formPayment && <div className="mx-6 mb-6"><p>{`料金 ${formPayment.total.toLocaleString('ja-JP')} 円・今お支払い ${formPayment.amount.toLocaleString('ja-JP')} 円・お店で ${formPayment.remaining.toLocaleString('ja-JP')} 円`}</p><p>{formPayment.cancellation}</p><PaymentPolicyConsent accepted={formPaymentAccepted} onChange={setFormPaymentAccepted} /><Button variant="primary" disabled={!formPaymentAccepted || bookingRetrying} onClick={()=>void (async()=>{if(!id || !formPayment || !formPaymentAccepted || bookingRetrying)return;setBookingRetrying(true);try{const result=await restaurantBookingApi.formBooking({formId:id,blockId:formPayment.blockId,submissionKey:formPayment.submissionKey,...(formPayment.paymentMethod?{paymentMethod:formPayment.paymentMethod}:{}),policyAccepted:true,policyVersion:formPayment.policyVersion,expectedAmount:formPayment.amount,expectedTotal:formPayment.total});if(result.data.payment?.status==='paid'){setBookingError('お支払いと予約の状態を確認しています。');setFormPayment(null);return;}const url=new URL(result.data.payment?.url??'');if(url.protocol!=='https:' || url.hostname!=='checkout.stripe.com' || url.username || url.password || url.port)throw new Error('invalid_checkout_url');liff.openWindow({url:url.toString(),external:true});}catch{setBookingError('お支払いの内容を確認できませんでした。もう一度お試しください。');setFormPayment(null);}finally{setBookingRetrying(false);}})()}>お支払いへ進む</Button></div>}
          {bookingError && !formPayment && (
            <div className="mx-6 mb-6 rounded-[10px] border border-liff-line-strong bg-canvas p-4">
              <p className="text-sm font-bold text-ink">{bookingError}</p>
              {formPaymentChoiceRequired && <PaymentMethodChoices name="form-payment" value={formPaymentChoice} onChange={setFormPaymentChoice} />}
              <div className="mt-3 flex gap-2">
                <Button variant="primary" className="flex-1"
                  type="button"
                  onClick={() => paymentRequest ? window.location.reload() : void retryBookings()}
                  disabled={bookingRetrying || (!paymentRequest && formPaymentChoiceRequired && !formPaymentChoice)}
                >
                  {bookingRetrying ? '確保中…' : paymentRequest ? 'お支払いを読み直す' : '予約を取り直す'}
                </Button>
                {!paymentRequest && <Button variant="secondary" className="flex-1"
                  type="button"
                  onClick={() => {
                    setBookingError(null);
                    setDone(false);
                    window.scrollTo({ top: 0 });
                  }}
                >
                  日時を選び直す
                </Button>}
              </div>
            </div>
          )}
        </div>
        <BottomBar>
          <Button variant="primary" onClick={() => liff.closeWindow()}>
            LINEに戻る
          </Button>
        </BottomBar>
      </div>
    );
  }

  const multi = layout.sections.length > 1;
  const radius = theme.cornerRadius === 'none' ? '0' : theme.cornerRadius === 'round' ? '1rem' : '0.5rem';

  const pageTitle = options.pageTitle || form.name;
  /**
   * ★V8 (・)：1ページ目はフォームの題と説明、2ページ目からは
   * そのページ (セクション) の名前を題にする。
   */
  const firstPage = sectionIndex === 0;
  const heading = firstPage || !section?.name ? pageTitle : section.name;
  /**
   * ページの先頭に並ぶ画像は、題の上の表紙として出す (★V8  の「画像」)。
   * 共通ヘッダは今までどおり題の下・ページの中身の前に出す。
   */
  const pageBlocks = readOnlyDocument ? layout.sections.flatMap(section=>section.blocks).filter(block=>block.kind!=='input') : section?.blocks ?? [];
  let coverCount = 0;
  while (coverCount < pageBlocks.length && pageBlocks[coverCount].kind === 'image') coverCount += 1;
  const covers = pageBlocks.slice(0, coverCount);
  const bodyBlocks = [...layout.header, ...pageBlocks.slice(coverCount)].filter(block=>!readOnlyDocument || block.kind!=='input');
  const blockView = (block: FormBlock, cover = false) => (
    <BlockView
      key={block.id}
      block={block}
      cover={cover}
      answers={answers}
      onChange={setValue}
      onToggle={toggleCheckbox}
      onUpload={uploadFile}
      uploading={!!uploading[block.kind === 'input' ? block.name : '']}
      error={block.kind === 'input' ? (fieldErrors[block.name] ?? null) : null}
      errorColor={theme.error}
      choiceAvailability={block.kind === 'input' ? form.availability?.choices[block.name] : undefined}
      routed={routed}
      onRoutedEmpty={setRoutedEmpty}
      courseRefresh={courseRefresh}
    />
  );

  return (
    <div className="min-h-screen bg-canvas" data-design-node={wide ? 'wPfqW' : 'B8rCt'}>
      <LiffHeader title={pageTitle} onBack={routedPage && routedConfirm ? () => setRoutedConfirm(false) : trail.length > 0 ? goBack : undefined} />
      <div
        className="mx-auto min-h-screen w-full max-w-md pb-28"
        style={{
          color: theme.text,
          backgroundColor: hasCustomTheme ? theme.sub : undefined,
          backgroundImage: theme.backgroundImageUrl ? `url(${theme.backgroundImageUrl})` : undefined,
          backgroundPosition: 'center',
          backgroundSize: 'cover',
          // 明朝を選んだときだけ書体を替える。ふつうは LIFF の書体 (Noto Sans JP) のまま。
          fontFamily: theme.fontFamily === 'serif' ? 'serif' : undefined,
        }}
      >
        {routedPage ? <Stepper steps={['質問', '日時', '確認']} current={routedConfirm ? 2 : 1} /> : null}
        {!readOnlyDocument && !routedPage && multi && options.sectionHeader !== 'none' && (
          <div className="px-4 pt-3">
            <div className="flex gap-1" aria-hidden="true">
              {layout.sections.map((s, i) => (
                <span
                  key={s.id}
                  className={`h-1 flex-1 rounded-xs ${i <= sectionIndex ? 'bg-liff-primary' : 'bg-liff-line'}`}
                />
              ))}
            </div>
            <p className="mt-1.5 text-[10px] text-liff-sub">
              {options.sectionHeader === 'name'
                ? layout.sections[sectionIndex]?.name
                : `${sectionIndex + 1} / ${layout.sections.length} ページ`}
            </p>
          </div>
        )}
        <div className="flex flex-col gap-3.5 p-4">
          {testToken ? (
            <p className="rounded-lg border border-hairline bg-canvas px-3 py-2 text-center text-xs text-ink-faint">
              試し回答中です。この回答は集計に入りません。
            </p>
          ) : null}
          {covers.map((block) => blockView(block, true))}
          {routedPage ? null : <h1 className="text-xl font-bold text-ink">{heading}</h1>}
          {firstPage && form.description && (
            <p className="text-xs leading-[18px] whitespace-pre-wrap text-liff-sub">
              {form.description}
            </p>
          )}

          {!readOnlyDocument && firstPage && <FormReception availability={form.availability} />}
          {routedPage && routedConfirm && routed?.status === 'ready' && routedPicked ? <RoutedConfirm target={routed.target} whenText={`${utcToJstMd(routedPicked)}（${formatWeekday(japanDate(new Date(routedPicked)))}）${utcToJstHm(routedPicked)}`} /> : null}
          <div className={routedPage && routedConfirm ? 'hidden' : 'contents'}>{bodyBlocks.map((block) => blockView(block))}</div>

          {error && (
            <p className="rounded-lg border border-hairline bg-canvas px-3 py-2 text-sm font-bold text-danger">
              {error}
            </p>
          )}

          {conflict && (
            <div>
              <Button variant="secondary" onClick={resendWithFreshKey} disabled={sending || Object.values(uploading).some(Boolean)}>
                {conflict.code === 'idempotency_expired' ? 'もう一度送る' : '別の回答として送り直す'}
              </Button>
            </div>
          )}

          {/* 送る最後のページだけ、個人情報の取り扱いの一行。 */}
          {!readOnlyDocument && isLast && <PrivacyNote />}
        </div>
      </div>

      {!readOnlyDocument && <BottomBar appearance="form">
        <Button variant="primary"
          type="button"
          onClick={() => {
            if (routedPage && routedEmpty) { liff.closeWindow(); return; }
            if (routedPage && routedNeedsPick) return;
            if (routedPage && routedPicked && !routedConfirm) { const { errors, first } = validateVisible(); setFieldErrors(errors); if (first) return; setRoutedConfirm(true); window.scrollTo({ top: 0 }); return; }
            if (isLast) void submit(); else goNext();
          }}
          disabled={sending || Object.values(uploading).some(Boolean) || (routedPage && routedNeedsPick)}
          style={{ backgroundColor: theme.main, color: submitButtonText(theme, hasCustomTheme), borderRadius: radius }}
        >
          {sending ? '送信中…' : routedPage && routedEmpty ? `${words.contact}に問い合わせる` : routedPage && routedNeedsPick ? '日時を選んでください' : routedPage && routedPicked && routedConfirm ? 'この内容で送る' : routedPage && routedPicked ? `${utcToJstMd(routedPicked)}（${formatWeekday(japanDate(new Date(routedPicked)))}）${utcToJstHm(routedPicked)} で進む` : isLast ? submitLabelText(options.submitLabel) : options.nextLabel || '次へ'}
        </Button>

      </BottomBar>}

      {confirming && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6">
          <div className="w-full max-w-xs rounded-xl bg-canvas p-5 text-center">
            <p className="text-sm text-ink">
              {options.confirmDialog?.text || '送信してよろしいですか？'}
            </p>
            <div className="mt-4 flex gap-2">
              <Button variant="secondary" className="flex-1"
                type="button"
                onClick={() => setConfirming(false)}
              >
                {options.confirmDialog?.cancelLabel || '閉じる'}
              </Button>
              <Button variant="primary" className="flex-1"
                type="button"
                onClick={() => submit()}
                style={{ backgroundColor: theme.main, color: submitButtonText(theme, hasCustomTheme), borderRadius: radius }}
              >
                {submitLabelText(options.confirmDialog?.okLabel)}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function toAddressDraft(value: unknown): AddressDraft {
  const empty: AddressDraft = { postalCode: '', prefecture: '', city: '', addressLine1: '', addressLine2: '' };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return empty;
  const v = value as Record<string, unknown>;
  const text = (key: string): string => (typeof v[key] === 'string' ? (v[key] as string) : '');
  return {
    postalCode: text('postalCode'),
    prefecture: text('prefecture'),
    city: text('city'),
    addressLine1: text('addressLine1'),
    addressLine2: text('addressLine2'),
  };
}

/**
 * 「予約を入れる」ブロック。メニューは店の指定、担当は指定か選ぶ、
 * 日にち→時刻の順に空き枠から選ぶ。選んだ枠は回答に入れ、送信後に
 * 予約の受け口で確保する（枠の再確認と重なり防止はそちらが担う）。
 */
export type RoutedState = { status: 'loading' } | { status: 'error'; retry: () => void } | { status: 'ready'; target: RoutedTarget };
export function BookingSlotPicker(props: {block:FormInputBlock;value:unknown;onChange:(next:FormBookingValue|'')=>void;/** 答えで行き先が決まるフォーム（B6）。 */ routed?:RoutedState;onRoutedEmpty?:(empty:boolean)=>void;courseRefresh?:number}) {
  return props.block.booking?.kind==='seats' ? <SeatBookingBlock {...props} /> : <PeopleBookingSlotPicker {...props} />;
}

function PeopleBookingSlotPicker({
  block,
  value,
  onChange,
  routed,
  onRoutedEmpty,
}: {
  block: FormInputBlock;
  value: unknown;
  onChange: (next: FormBookingValue | '') => void;
  routed?: RoutedState;
  onRoutedEmpty?: (empty: boolean) => void;
}) {
  const words = useCustomerWords();
  const style = useCustomerStyle();
  /* 答えで行き先が決まったら、フォームで決めたメニュー・担当より答えの行き先が先（担当は選ばせない）。 */
  const target = routed?.status === 'ready' ? routed.target : null;
  const menuId = target?.menuId ?? block.booking?.menuId ?? '';
  const fixedStaffId = target ? target.staffId : block.booking?.staffId ?? null;
  const daysAhead = Math.min(60, Math.max(1, block.booking?.daysAhead ?? 14));
  const picked = normalizeBookingValue(value);
  const today = jstToday();
  const lastDay = addDays(today, daysAhead - 1);

  const [menu, setMenu] = useState<MenuItem | null>(null);
  const [staffList, setStaffList] = useState<StaffItem[]>([]);
  const [staffId, setStaffId] = useState<string>(fixedStaffId ?? '');
  const [byDate, setByDate] = useState<Record<string, Array<{ start: string; open: boolean; startUtc?: string }>>>({});
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [draftMode, setChosenMode] = useState<'online' | 'in_person' | null>(null);
  const chosenMode = formMeetingMode(value) ?? draftMode;
  const modeSetting = target?.meetingMode ?? menu?.meeting_mode;
  const meetingMode = modeSetting === 'customer_choice' ? chosenMode
    : modeSetting === 'online' || modeSetting === 'in_person' ? modeSetting : null;
  const missingMode = (style === 'consult' || modeSetting === 'customer_choice') && !meetingMode;

  // メニューと担当を読む。担当の指定が無いときは選べるように出す。
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    Promise.all([
      api.menus(),
      fixedStaffId ? Promise.resolve(null) : api.staffOf(menuId).catch(() => null),
    ])
      .then(([menus, staff]) => {
        if (cancelled || !menuId) return;
        setMenu(menus.menus.find((m) => m.id === menuId) ?? null);
        const list = staff?.staff ?? [];
        setStaffList(list);
        if (!fixedStaffId) setStaffId((prev) => prev || list[0]?.id || '');
      })
      .catch((e) => {
        if (cancelled) return;
        logFailure('form-booking-menu', e);
        setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [menuId, fixedStaffId]);

  // 選べる期間の空きを28日ずつに割って読む（口の上限に収める）。
  useEffect(() => {
    const activeStaff = fixedStaffId ?? staffId;
    if (!menuId || !activeStaff) return;
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    const chunks: Array<[string, string]> = [];
    let head = today;
    while (head <= lastDay) {
      const tail = addDays(head, 27) <= lastDay ? addDays(head, 27) : lastDay;
      chunks.push([head, tail]);
      head = addDays(tail, 1);
    }
    Promise.all(chunks.map(([from, to]) => api.availability(menuId, activeStaff, from, to)))
      .then((results) => {
        if (cancelled) return;
        const merged: Record<string, Array<{ start: string; open: boolean; startUtc?: string }>> = {};
        for (const r of results) {
          for (const bucket of r.by_staff ?? []) {
            if (bucket.staff_id !== activeStaff) continue;
            for (const s of bucket.slots ?? []) {
              if (s.date < today || s.date > lastDay) continue;
              const open = !((s.remaining ?? 1) <= 0 || s.state === 'full' || s.state === 'closed');
              const list = (merged[s.date] ??= []);
              if (!list.some((t) => t.start === s.start)) {
                list.push({ start: s.start, open, ...(s.startUtc ? { startUtc: s.startUtc } : {}) });
              }
              else if (open) list.find((t) => t.start === s.start)!.open = true;
            }
          }
        }
        for (const d of Object.keys(merged)) {
          merged[d].sort((a, b) => (a.start < b.start ? -1 : 1));
        }
        setByDate(merged);
        setSelectedDate((prev) => {
          if (prev && merged[prev]?.some((t) => t.open)) return prev;
          return Object.keys(merged).sort().find((d) => merged[d].some((t) => t.open)) ?? null;
        });
      })
      .catch((e) => {
        if (cancelled) return;
        logFailure('form-booking-availability', e);
        setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [menuId, fixedStaffId, staffId, today, lastDay]);

  const emptyRouted = Boolean(target) && !loading && !failed && !Object.values(byDate).some((l) => l.some((t) => t.open));
  useEffect(() => { onRoutedEmpty?.(emptyRouted); }, [emptyRouted]); // eslint-disable-line react-hooks/exhaustive-deps
  if (routed?.status === 'loading') return <p className="text-sm text-ink-faint">ご案内を準備しています…</p>;
  if (routed?.status === 'error') {
    return (
      <LoadErrorView compact message="ご案内を準備できませんでした。回答は保存されています。" onRetry={routed.retry} />
    );
  }
  if (!menuId) {
    return <p className="text-sm text-ink-secondary">{`予約のメニューが決まっていません。${words.contact}に確認してください。`}</p>;
  }
  if (loading && Object.keys(byDate).length === 0) {
    return <p className="text-sm text-ink-faint">空き枠を読み込んでいます…</p>;
  }
  if (failed && Object.keys(byDate).length === 0) {
    return <p className="text-sm text-ink-secondary">空き枠を読めませんでした。時間をおいて開き直してください。</p>;
  }

  // ★V8 ：枠のある日はすべて並べ、空きの無い日は灰色で押せなくする。
  const dates = routed ? Array.from({ length: 7 }, (_, i) => addDays(today, i)) : Object.keys(byDate).sort();
  const hasOpen = (d: string) => Boolean(byDate[d]?.some((t) => t.open));
  const daySlots = (selectedDate && byDate[selectedDate]) || [];

  return (
    <div className={`flex flex-col ${target ? 'gap-4' : 'gap-2'}`} data-design-node="g9osGN">
      {menu && !target && (
        <p className="text-xs leading-[18px] text-liff-sub">
          {menu.name}・{menu.duration_minutes}分
        </p>
      )}
      {target ? <RoutedBanner target={target} /> : null}
      {modeSetting === 'customer_choice' ? <MeetingModeChoices name={`meeting-mode-${block.id}`} meetingMode={meetingMode} onChange={mode => {
        setChosenMode(mode);
        // 会い方を変えたときも、同じ日時の回答に結び付ける。
        if (picked) {
          const next = { ...picked, meetingMode: mode };
          onChange(next);
        }
      }} /> : style === 'consult' && !meetingMode ? <FieldError>会い方を読み込めませんでした。時間をおいて開き直してください。</FieldError>
        : meetingMode && !target && (style === 'consult' || meetingMode === 'online') ? <p className="text-xs text-liff-sub">会い方：{meetingMode === 'online' ? 'オンライン' : '対面'}</p> : null}
      {target && !emptyRouted ? <h2 className="pt-1 text-xl font-bold text-ink">日時を選んでください</h2> : null}
      {!target && !fixedStaffId && staffList.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {staffList.map((s) => (
            <Button variant="chip" selected={staffId === s.id}
              key={s.id}
              type="button"
              onClick={() => {
                // 担当を変えたら前の枠は捨てる（別の担当の枠で送らない）。
                if (picked && picked.staffId !== s.id) onChange('');
                setStaffId(s.id);
              }}
              aria-pressed={staffId === s.id}
            >
              {s.display_name}
            </Button>
          ))}
        </div>
      )}
      {emptyRouted ? null : <div className={target ? 'rounded-(--liff-radius-lg) border border-liff-line p-3.5' : undefined}><BookingControls
        days={dates.map((d) => ({ date: d, weekday: formatWeekday(d), day: Number(d.slice(8, 10)), open: hasOpen(d) }))}
        selectedDate={selectedDate ?? ''}
        onDate={setSelectedDate}
        times={selectedDate ? daySlots.map((t) => ({ start: t.start, open: t.open && !missingMode, selected: picked?.startsAt === slotStartsAtIso({ date: selectedDate, start: t.start, startUtc: t.startUtc }) })) : []}
        onTime={(start) => {
          const t = daySlots.find((slot) => slot.start === start);
          if (!t || !t.open || !selectedDate || missingMode) return;
          const startsAt = slotStartsAtIso({ date: selectedDate, start: t.start, startUtc: t.startUtc });
          const next = { menuId, staffId: fixedStaffId ?? staffId, startsAt, ...(meetingMode ? { meetingMode } : {}) };
          onChange(picked?.startsAt === startsAt ? '' : next);
        }}
      />{target ? <p className="mt-2 text-xs text-liff-sub">灰色の日は空きがありません</p> : null}</div>}
      {!dates.some(hasOpen) && (target
        ? <NoRoutedSlots target={target} days={daysAhead} />
        : <p className="text-sm text-ink-secondary">選べる期間に空きがありません。期間を変えてください。</p>)}
      {picked && (
        <p className="text-xs font-bold text-liff-primary">
          {formatJstEventAt(picked.startsAt)}〜 を選んでいます
        </p>
      )}
    </div>
  );
}

/**
 * ブロック1つを描く。
 * 直し方 (error) は欄のすぐ下に出す (★管理画面 4-a)。枠の色も直しの色にする。
 */
function BlockView({
  block,
  cover = false,
  answers,
  onChange,
  onToggle,
  onUpload,
  uploading,
  error,
  errorColor,
  choiceAvailability,
  routed,
  onRoutedEmpty,
  courseRefresh,
}: {
  courseRefresh?: number;
  routed?: RoutedState;
  onRoutedEmpty?: (empty: boolean) => void;
  block: FormBlock;
  /** ページの先頭の画像 (題の上の表紙)。★V8  は高さ 96・角丸 12 の帯。 */
  cover?: boolean;
  answers: Answers;
  onChange: (name: string, value: unknown) => void;
  onToggle: (name: string, label: string) => void;
  onUpload: (name: string, file: File, side?: 'single' | 'front' | 'back') => void;
  uploading: boolean;
  error: string | null;
  errorColor: string;
  choiceAvailability?: Record<string, { remaining: number; full: boolean }>;
}) {
  if (block.kind === 'heading') {
    const size = block.level === 1 ? 'text-xl' : block.level === 3 ? 'text-sm' : 'text-lg';
    return <h2 className={`font-bold text-ink ${size}`}>{block.text}</h2>;
  }

  if (block.kind === 'text') {
    return <p className="text-sm leading-relaxed whitespace-pre-wrap text-ink-secondary">{block.text}</p>;
  }

  if (block.kind === 'image') {
    if (!block.mediaUrl) return null;
    const image = (
      <img
        src={block.mediaUrl}
        alt={block.alt ?? ""}
        className={
          cover && block.size !== 'full'
            ? 'h-24 w-full rounded-xl object-cover'
            : block.size === 'full'
              ? 'w-full rounded-lg'
              : 'mx-auto max-w-[70%] rounded-lg'
        }
      />
    );
    return block.linkUrl ? (
      <a href={block.linkUrl} target="_blank" rel="noreferrer" aria-label={block.alt || "画像のリンクを開く"}>
        {image}
      </a>
    ) : (
      image
    );
  }

  if (block.kind === 'button') {
    return (
      <Button href={block.url} external variant={block.style === 'outline' ? 'secondary' : 'primary'}>
        {block.label}
      </Button>
    );
  }

  if (block.hidden) return null;

  const value = answers[block.name];
  const text = typeof value === 'string' ? value : '';
  const checked = Array.isArray(value) ? (value as string[]) : [];
  /** 直しがある欄は枠を直しの色にする (お店のテーマの error)。 */
  const invalidStyle = error ? { borderColor: errorColor } : undefined;
  // 欄名・説明・直しの文を入力と結ぶ（読み上げで欄名と直し方が分かるように）。
  // id はブロックの id から作る（並べ替えても同じ欄を指す）。
  const fieldId = `lf-${block.id}`;
  const labelId = `${fieldId}-label`;
  const descId = block.description ? `${fieldId}-desc` : undefined;
  const errorId = error ? `${fieldId}-error` : undefined;
  const describedBy = [descId, errorId].filter(Boolean).join(' ') || undefined;
  // 1つの入力で答える欄は label の htmlFor で結ぶ。選択肢・★・住所などは群れにして欄名で呼ぶ。
  const singleControl =
    block.type === 'text' ||
    block.type === 'textarea' ||
    block.type === 'prefecture' ||
    block.type === 'select' ||
    (block.type === 'date' && block.dateStyle !== 'ymd');
  const fieldProps = { id: fieldId, 'aria-describedby': describedBy, 'aria-required': !!block.required };

  return (
    <div className="flex flex-col gap-2">
      {/* ★V8 (B8rCt)：欄名と必須の札を1行に並べ、選択肢まで 8 空ける。 */}
      {routed && block.type === 'booking' ? null : <FieldLabel size="form" id={labelId} htmlFor={singleControl ? fieldId : undefined} required={block.required}>
        {block.label}
      </FieldLabel>}
      {block.description && (
        <p id={descId} className="-mt-1 text-xs text-ink-faint">{block.description}</p>
      )}

      <div
        {...(singleControl
          ? {}
          : { role: 'group', 'aria-labelledby': labelId, 'aria-describedby': describedBy })}
      >
        {(block.type === 'text' || block.type === 'textarea') && (
          <FormTextControl block={block} value={text} onChange={(next) => onChange(block.name, next)} style={invalidStyle} aria-invalid={!!error} {...fieldProps} />
        )}

        {block.type === 'date' &&
          (block.dateStyle === 'ymd' ? (
            <DateYmdField
              value={text}
              onChange={(next) => onChange(block.name, next)}
              placeholder={block.placeholder}
            />
          ) : (
            <FormTextControl block={block} value={text} onChange={(next) => onChange(block.name, next)} style={invalidStyle} aria-invalid={!!error} {...fieldProps} />
          ))}

        {block.type === 'prefecture' && (
          <FormSelectControl
            value={text}
            onChange={(e) => onChange(block.name, e.target.value)}
            style={invalidStyle}
            aria-invalid={!!error}
            {...fieldProps}
          >
            <option value="">都道府県を選択</option>
            {PREFECTURES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </FormSelectControl>
        )}

        {block.type === 'select' && (
          <div>
            <FormSelectControl
              // 「その他」を自由記入したときは、プルダウンにはその選択肢を出す
              value={isOtherFreeText(block, text) ? otherLabel(block) : text}
              onChange={(e) => onChange(block.name, e.target.value)}
              style={invalidStyle}
              aria-invalid={!!error}
              {...fieldProps}
            >
              <option value="">選択してください</option>
              {(block.choices ?? []).map((choice) => (
                <option key={choice.id} value={choice.label} disabled={choiceAvailability?.[choice.id]?.full}>
                  {choice.label}{choiceReceptionLabel(choiceAvailability?.[choice.id])}
                </option>
              ))}
            </FormSelectControl>
            {isOtherFreeText(block, text) && (
              <OtherTextInput
                value={text}
                onChange={(next) => onChange(block.name, next)}
              />
            )}
          </div>
        )}

        {block.type === 'radio' && (
          <div className={block.inline ? 'flex flex-wrap gap-2' : 'space-y-2'}>
            {(block.choices ?? []).map((choice) => {
              // 「その他」は、ラベルそのものだけでなく自由記入の値でも選中扱い
              const isFree = choice.isOther ? isOtherFreeText(block, text) : false;
              const checkedRadio = choice.isOther
                ? text === choice.label || isFree
                : text === choice.label;
              return (
                <div key={choice.id}>
                  <FormChoiceRow selected={checkedRadio}>
                    <RadioChoiceInput
                      name={block.name}
                      checked={checkedRadio}
                      disabled={choiceAvailability?.[choice.id]?.full}
                      onChange={() => onChange(block.name, choice.label)}
                    />
                    {choice.label}{choiceReceptionLabel(choiceAvailability?.[choice.id])}
                  </FormChoiceRow>
                  {choice.isOther && checkedRadio && (
                    <OtherTextInput
                      value={isFree ? text : ''}
                      onChange={(next) => onChange(block.name, next)}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}

        {block.type === 'checkbox' && (
          <div className={block.inline ? 'flex flex-wrap gap-2' : 'space-y-2'}>
            {(block.choices ?? []).map((choice) => {
              const freeTexts = checked.filter((v) => isOtherFreeText(block, v));
              const isChecked = choice.isOther
                ? checked.includes(choice.label) || freeTexts.length > 0
                : checked.includes(choice.label);
              return (
                <div key={choice.id}>
                  <FormChoiceRow selected={isChecked}>
                    <CheckboxChoiceInput
                      checked={isChecked}
                      disabled={choiceAvailability?.[choice.id]?.full}
                      onChange={() => {
                        if (!choice.isOther) {
                          onToggle(block.name, choice.label);
                          return;
                        }
                        // 「その他」を外すときは、自由記入の値も一緒に外す
                        onChange(
                          block.name,
                          isChecked
                            ? checked.filter(
                                (v) => v !== choice.label && !isOtherFreeText(block, v),
                              )
                            : [...checked, choice.label],
                        );
                      }}
                    />
                    {choice.label}{choiceReceptionLabel(choiceAvailability?.[choice.id])}
                  </FormChoiceRow>
                  {choice.isOther && isChecked && (
                    <OtherTextInput
                      value={freeTexts[0] ?? ''}
                      onChange={(next) =>
                        onChange(
                          block.name,
                          next === ''
                            ? [
                                ...checked.filter(
                                  (v) => v !== choice.label && !isOtherFreeText(block, v),
                                ),
                                choice.label,
                              ]
                            : [
                                ...checked.filter(
                                  (v) => v !== choice.label && !isOtherFreeText(block, v),
                                ),
                                next,
                              ],
                        )
                      }
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/*
          F-11：5段階評価は★で答える。初期値は「3」などの文字でも来るため
          数に直してから塗る（直せない文字は未選択として出す）。
        */}
        {block.type === 'rating' && (
          <RatingStars
            name={block.name}
            current={normalizeRatingValue(value)}
            onChange={onChange}
          />
        )}

        {/* 住所は郵便番号から自動補完。手入力も残す。 */}
        {block.type === 'address' && (
          <AddressFields
            name={block.name}
            draft={toAddressDraft(value)}
            onChange={onChange}
            placeholder={block.placeholder}
          />
        )}

        {block.type === 'file' && (
          <div>
            <FormFileControl label={block.label} kind={block.fileKind} kinds={block.fileKinds} bothSides={block.fileBothSides} maxCount={block.fileMaxCount}
              files={Array.isArray(value) ? value as import('@line-crm/shared').FormFileAnswer[] : []}
              uploading={uploading} onUpload={(file, side) => onUpload(block.name, file, side)}
              onRemove={fileId => { const next = (Array.isArray(value) ? value : []).filter(v => v.fileId !== fileId); const removed = (Array.isArray(value) ? value : []).find(v => v.fileId === fileId); if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl); onChange(block.name, next); }} />
            {!formFileKinds(block).includes('identity') && !Array.isArray(value) && text && (
              <div className="mt-2">
                <img src={text} alt="送った画像" className="max-h-40 rounded-lg" />
                <Button variant="text" className="mt-1"
                  type="button"
                  onClick={() => onChange(block.name, '')}
                >
                  選び直す
                </Button>
              </div>
            )}
          </div>
        )}

        {block.type === 'booking' && (
          <BookingSlotPicker
            block={block}
            value={value}
            routed={routed}
            onRoutedEmpty={onRoutedEmpty}
            courseRefresh={courseRefresh}
            onChange={(next) => onChange(block.name, next)}
          />
        )}

        {/* 文字数。上限を決めているときだけ出す */}
        {(block.type === 'text' || block.type === 'textarea') &&
          block.limit?.max &&
          !block.limit.hideCounter && (
            <FieldCount value={text} max={block.limit.max} />
          )}
      </div>

      {error && (
        <p id={errorId} className="mt-1 flex items-center gap-1 text-xs font-bold" style={{ color: errorColor }}>
          <Icon name="info" className="h-3.5 w-3.5 shrink-0" />
          {error}
        </p>
      )}
    </div>
  );
}
