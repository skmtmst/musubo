import { useCustomerWords } from '../components/customer-style-scope.js';
import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import liff from '@line/liff';
import { api, type EventWaitlistMine } from '../lib/api.js';
import { formatJstEventAt, utcToJstHm } from '../lib/datetime.js';
import { logFailure } from '../lib/user-message.js';
import LiffHeader from '../components/ui/liff-header.js';
import LiffLookScope from '../components/liff-look-scope.js';
import StatusView from '../components/ui/status-view.js';
import BottomBar from '../components/ui/bottom-bar.js';
import Button from '../components/ui/button/index.js';
import Icon from '../components/ui/icon.js';
import ConfirmDialog from '../components/ui/confirm-dialog.js';

/**
 * 2-c 申し込みが確定した・2-d キャンセル待ちに入った (V8)。
 * 承認制で承認待ちのときは 2-d と同じ待ちの印で出す (文言は承認待ちのまま)。
 * 上の帯と下の帯の間の真ん中に、丸・題・本文・申し込みの箱を置く。
 * 下の帯は「LINEに戻る」と「自分のイベントを見る」。
 * キャンセル待ちで、自分の待ち (GET /api/liff/events/me/waitlist) が見つかったときは、
 * 絵のとおり箱に「順番 N 番目」を足し、2つ目のボタンを「キャンセル待ちを取り消す」にする
 * (確認窓 → POST …/waitlist/:id/cancel → 自分のイベントへ)。見つからなければ今の形のまま。
 */
export default function EventDone() {
  const words = useCustomerWords();
  const { id } = useParams<{ id: string }>();
  const [search] = useSearchParams();
  const { search: locationSearch } = useLocation();
  const navigate = useNavigate();
  const status = search.get('status') ?? '';
  const startsAt = search.get('startsAt') ?? '';

  const isWaitlisted = status === 'waitlisted';
  const isPending = status === 'requested';
  const isConfirmed = status === 'confirmed';

  // 箱の「イベント」の行に出す名前。読めなければ行ごと出さない。
  const [eventName, setEventName] = useState<string | null>(null);
  useEffect(() => {
    if (!id) return;
    let alive = true;
    api
      .getEvent(id)
      .then((e) => {
        if (alive) setEventName(e.name);
      })
      .catch((e) => logFailure('event-done-name', e));
    return () => {
      alive = false;
    };
  }, [id]);

  // キャンセル待ちの自分の行 (順番・やめる)。読めなければ出さない。
  const waitSlot = search.get('waitSlot') ?? '';
  const [waitEntry, setWaitEntry] = useState<EventWaitlistMine | null>(null);
  const [askLeave, setAskLeave] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);
  useEffect(() => {
    if (!id || !isWaitlisted) return;
    let alive = true;
    api
      .myEventWaitlist()
      .then(({ items }) => {
        const mine = items.find(
          (w) =>
            w.event_id === id &&
            w.status === 'waiting' &&
            (waitSlot ? w.slot_id === waitSlot : startsAt !== '' && Date.parse(w.slot_starts_at) === Date.parse(startsAt)),
        );
        if (alive) setWaitEntry(mine ?? null);
      })
      .catch((e) => logFailure('event-done-waitlist', e));
    return () => {
      alive = false;
    };
  }, [id, isWaitlisted, waitSlot, startsAt]);

  async function leaveWaitlist() {
    if (!waitEntry) return;
    setLeaving(true);
    setLeaveError(null);
    try {
      await api.cancelMyEventWaitlist(waitEntry.id);
      goMine();
    } catch (e) {
      logFailure('event-done-leave-waitlist', e);
      setLeaveError('やめられませんでした。時間をおいてもう一度お試しください。');
    } finally {
      setLeaving(false);
    }
  }

  const title = isWaitlisted ? 'キャンセル待ちに入りました' : isPending ? '受付しました' : isConfirmed ? '申し込みが確定しました' : '申し込みの状態を確認してください';
  const body = isWaitlisted
    ? 'いまは満席です。空きが出たら、LINEでお知らせします。お知らせから24時間以内に「この席を取る」を押すと予約になります。'
    : isPending
      ? `${words.contact}の確認をお待ちください。確定すると LINE でお知らせします。`
      : !isConfirmed
        ? '自分のイベントから申し込みの状態を確認してください。'
      : startsAt
        ? `${formatJstEventAt(startsAt)}にお待ちしています。\n前日に LINE でお知らせします。`
        : '予約が確定しました。LINE で詳細をお送りしました。';

  function goMine() {
    navigate({ pathname: '/events/me', search: locationSearch });
  }

  return (
    <LiffLookScope className="min-h-screen bg-canvas" designNode="qVdiX">
      <LiffHeader title={words.event} />
      <div className="mx-auto w-full max-w-md pb-[142px]">
        <div className="flex min-h-[calc(100dvh-var(--liff-header-h)-1px-142px)] flex-col items-center justify-center px-6 py-4">
          <StatusView
            large
            icon={isWaitlisted || isPending ? 'hourglass' : 'calendar'}
            tone={isConfirmed ? 'success' : 'wait'}
            title={title}
            body={body}
          >
            {eventName && (
              <dl data-liff-card className="w-full divide-y divide-liff-divider rounded-(--liff-radius-lg) border border-liff-line px-3.5 py-1 text-left">
                {waitEntry?.queue_position != null && (
                  <div className="flex gap-2 py-2.5">
                    <dt className="w-18 shrink-0 text-xs text-liff-sub">順番</dt>
                    <dd className="min-w-0 flex-1 text-sm font-semibold text-ink">{`${waitEntry.queue_position} 番目`}</dd>
                  </div>
                )}
                <div className="flex gap-2 py-2.5">
                  <dt className="w-18 shrink-0 text-xs text-liff-sub">{words.event}</dt>
                  <dd className="min-w-0 flex-1 text-sm font-semibold text-ink">
                    {/* 1つの文にまとめる (板 qVdiX「秋のわんこ撮影会 11:00〜」)。 */}
                    {`${eventName}${startsAt ? ` ${utcToJstHm(startsAt)}〜` : ''}`}
                  </dd>
                </div>
              </dl>
            )}
          </StatusView>
        </div>
      </div>
      <BottomBar>
        <Button variant="primary" onClick={() => liff.closeWindow()}>
          LINEに戻る
        </Button>
        {waitEntry ? (
          <Button variant="secondary" onClick={() => setAskLeave(true)}>
            キャンセル待ちを取り消す
          </Button>
        ) : (
          <Button variant="secondary" onClick={goMine}>
            <Icon name="list" className="h-4 w-4" />
            {`${words.myEvents}を見る`}
          </Button>
        )}
      </BottomBar>
      <ConfirmDialog
        open={askLeave}
        title="キャンセル待ちをやめますか"
        description="取り消すと今の順番は戻りません。空きが出てもお知らせしません。"
        confirmLabel="取り消す"
        cancelLabel="待ち続ける"
        destructive
        busy={leaving}
        error={leaveError ?? undefined}
        onCancel={() => {
          setAskLeave(false);
          setLeaveError(null);
        }}
        onConfirm={() => void leaveWaitlist()}
      />
    </LiffLookScope>
  );
}
