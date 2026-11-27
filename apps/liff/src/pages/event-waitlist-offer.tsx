import { useCustomerWords } from '../components/customer-style-scope.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import liff from '@line/liff';
import { api, type EventWaitlistOfferDetail } from '../lib/api.js';
import { formatHoldLeft, formatJstEventAt } from '../lib/datetime.js';
import { logFailure } from '../lib/user-message.js';
import Button from '../components/ui/button/index.js';
import BottomBar from '../components/ui/bottom-bar.js';
import Icon from '../components/ui/icon.js';
import LiffHeader from '../components/ui/liff-header.js';
import LiffLookScope from '../components/liff-look-scope.js';
import StatusView from '../components/ui/status-view.js';
import LoadingView from '../components/loading-view.js';
import LoadErrorView from '../components/load-error-view.js';

/** 繰上げ案内の token だけを外した query（ほかの値は残す）。 */
export function searchWithoutOfferToken(search: string): string {
  const params = new URLSearchParams(search);
  params.delete('eventWaitlistToken');
  const rest = params.toString();
  return rest ? `?${rest}` : '';
}

type State = 'loading' | 'loadError' | 'ready' | 'submitting' | 'confirmed' | 'expired' | 'unavailable' | 'error' | 'uncertain';

/**
 * キャンセル待ちの繰上げ承諾。LINE の案内から token で開く。
 * 状態の分け方 (成功・期限切れ・利用不能・失敗) はそのまま。
 * 失敗のときは行き止まりにせず、もう一度試せるボタンを出す。
 * 見た目だけ ★管理画面 (主ボタン1つ・札の代わりに印＋文)。
 */
export default function EventWaitlistOffer({ token }: { token: string }) {
  return <EventWaitlistOfferCard key={token} token={token} />;
}

function EventWaitlistOfferCard({ token }: { token: string }) {
  const words = useCustomerWords();
  const [state, setState] = useState<State>('loading');
  const navigate = useNavigate();
  // ?liffId=... を引き継ぐ (再読み込みで失わない)。
  const { search } = useLocation();

  // 現在の案内の詳細を読み終えるまで、承諾の操作は出さない。
  const [offer, setOffer] = useState<EventWaitlistOfferDetail | null>(null);
  const [remainingSeconds, setRemainingSeconds] = useState(0);
  const deadline = useRef<number | null>(null);
  const mounted = useRef(false);
  const generation = useRef(0);
  const loading = useRef(false);
  const phase = useRef<State>('loading');
  const detail = useRef<EventWaitlistOfferDetail | null>(null);
  const changeState = useCallback((next: State) => {
    phase.current = next;
    setState(next);
  }, []);
  const loadDetail = useCallback(async () => {
    if (!mounted.current || loading.current || (phase.current !== 'loading' && phase.current !== 'loadError')) return;
    loading.current = true;
    const mine = ++generation.current;
    detail.current = null;
    deadline.current = null;
    setOffer(null);
    changeState('loading');
    try {
      const res = await api.eventWaitlistOffer(token);
      if (!mounted.current || mine !== generation.current) return;
      if (!res?.data || typeof res.data.eventName !== 'string' ||
          typeof res.data.startsAt !== 'string' || !Number.isFinite(Date.parse(res.data.startsAt)) ||
          !Number.isInteger(res.data.partySize) || res.data.partySize < 1 ||
          !(res.data.venueName === null || typeof res.data.venueName === 'string')) {
        throw new Error('Offer detail is invalid');
      }
      const remaining = Number.isFinite(res.data.remainingSeconds) ? Math.max(0, res.data.remainingSeconds) : 0;
      deadline.current = Date.now() + remaining * 1000;
      setRemainingSeconds(remaining);
      detail.current = res.data;
      setOffer(res.data);
      changeState('ready');
    } catch (error) {
      if (!mounted.current || mine !== generation.current) return;
      logFailure('event-waitlist-offer-detail', error);
      changeState('loadError');
    } finally {
      if (mounted.current && mine === generation.current) loading.current = false;
    }
  }, [token, changeState]);
  useEffect(() => {
    mounted.current = true;
    void loadDetail();
    return () => {
      mounted.current = false;
      generation.current++;
      loading.current = false;
    };
  }, [loadDetail]);

  useEffect(() => {
    if (!offer || (state !== 'ready' && state !== 'submitting')) return;
    const update = () => {
      if (deadline.current === null) return;
      const left = Math.max(0, Math.ceil((deadline.current - Date.now()) / 1000));
      setRemainingSeconds(previous => Math.min(previous, left));
    };
    update();
    const timer = window.setInterval(update, 1000);
    window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, [offer, state]);

  const accept = async () => {
    if (!mounted.current || !detail.current || (phase.current !== 'ready' && phase.current !== 'error' && phase.current !== 'uncertain')) return;
    const mine = generation.current;
    changeState('submitting');
    try {
      const response = await api.acceptEventWaitlistOffer(token);
      if (!mounted.current || mine !== generation.current) return;
      if (response?.success !== true || response.data?.status !== 'confirmed' ||
          typeof response.data.bookingId !== 'string' || !response.data.bookingId.trim()) {
        changeState('uncertain');
        return;
      }
      changeState('confirmed');
    } catch (error) {
      if (!mounted.current || mine !== generation.current) return;
      logFailure('accept-event-waitlist-offer', error);
      const status = (error as { status?: number }).status;
      if (status === 410) changeState('expired');
      else if (status === 404 || status === 409) changeState('unavailable');
      else changeState('error');
    }
  };

  function goMine() {
    // 案内の token を外して移る。残すと App が案内の画面を優先し、
    // 自分のイベントへ移れない（?liffId などほかの値は引き継ぐ）。
    navigate({ pathname: '/events/me', search: searchWithoutOfferToken(search) });
  }

  return (
    <LiffLookScope className="min-h-screen bg-canvas" designNode="BjcuB">
      <LiffHeader title={words.event} />
      <main className="mx-auto flex min-h-[calc(100dvh-44px)] w-full max-w-md flex-col justify-center gap-4 px-6 pb-[142px]">
        {state === 'loading' ? (
          <LoadingView />
        ) : state === 'loadError' ? (
          <LoadErrorView compact onRetry={loadDetail} />
        ) : state === 'confirmed' ? (
          <div className="space-y-4">
            <StatusView
              icon="calendar"
              tone="success"
              title="予約が確定しました"
              body={`キャンセル待ちの席を予約しました。詳しい内容は${words.myEvents}で確認できます。`}
            />
            <Button variant="secondary" onClick={goMine}>
              <Icon name="list" className="h-4 w-4" />
              {`${words.myEvents}を見る`}
            </Button>
          </div>
        ) : state === 'expired' ? (
          <div className="space-y-4">
            <StatusView
              icon="hourglass"
              tone="wait"
              title="回答期限を過ぎています"
              body="席は次の方へ案内されました。"
            />
            <Button variant="secondary" onClick={goMine}>
              <Icon name="list" className="h-4 w-4" />
              {`${words.myEvents}を見る`}
            </Button>
          </div>
        ) : state === 'unavailable' ? (
          <div className="space-y-4">
            <StatusView
              icon="calendar"
              title="この案内は使えませんでした"
              body="この案内はすでに利用済みか、席を確保できませんでした。"
            />
            <Button variant="secondary" onClick={goMine}>
              <Icon name="list" className="h-4 w-4" />
              {`${words.myEvents}を見る`}
            </Button>
          </div>
        ) : state === 'error' || state === 'uncertain' ? (
          <div className="space-y-4">
            <StatusView
              icon="cloud-off"
              title={state === 'uncertain' ? '予約の状態を確認できませんでした' : '送信できませんでした'}
              body={state === 'uncertain' ? `${words.myEvents}でも予約の状態を確認できます。` : '通信に失敗しました。時間を置いて、もう一度お試しください。'}
            />
            <Button variant="secondary" onClick={accept}>
              <Icon name="rotate-cw" className="h-4 w-4" />
              もう一度試す
            </Button>
          </div>
        ) : (
          <>
            {/* ★V8 (BjcuB)：上の帯と下の帯の間の真ん中に、丸・題・本文・取っておく残り時間を置く。
                案内の中身を取得できたときだけ、対象と承諾の操作を表示する。 */}
            <div className="flex flex-col items-center justify-center [overflow-wrap:anywhere]">
              <StatusView
                large
                icon="party-popper"
                tone="success"
                title="空きが出ました"
                body={`${offer ? [offer.eventName.trim(), offer.venueName?.trim() ? `会場：${offer.venueName.trim()}` : '', `${formatJstEventAt(offer.startsAt)}〜 に ${offer.partySize} 席あります。`].filter(Boolean).join('\n') : ''}下のボタンを押すまで、予約にはなりません。`}
              >
                {offer && (remainingSeconds > 0 ? (
                  <p className="text-[13px] font-bold whitespace-nowrap text-liff-wait-ink">{`あと ${remainingSeconds < 60 ? `${remainingSeconds}秒` : formatHoldLeft(remainingSeconds)} 取っておきます`}</p>
                ) : <p className="text-[13px] font-bold text-liff-wait-ink">回答期限を確認してください。期限を過ぎた場合は予約できません。</p>)}
              </StatusView>
            </div>
            <BottomBar>
              <Button variant="primary" onClick={accept} disabled={state === 'submitting'}>
                {state === 'submitting' ? '予約を確定しています…' : 'この席を取る'}
              </Button>
              <Button variant="secondary" onClick={() => liff.closeWindow()} disabled={state === 'submitting'}>
                今回は見送る
              </Button>
            </BottomBar>
          </>
        )}
      </main>
    </LiffLookScope>
  );
}
