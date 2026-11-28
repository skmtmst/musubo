import { formatYen } from '@line-crm/shared';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import LiffLookScope from '../../components/liff-look-scope.js';
import LoadingView from '../../components/loading-view.js';
import BottomBar from '../../components/ui/bottom-bar.js';
import Button from '../../components/ui/button/index.js';
import Card from '../../components/ui/card.js';
import LiffHeader from '../../components/ui/liff-header.js';
import { PhotoButton } from '../../components/ui/photo-preview.js';
import SegmentedControl from '../../components/ui/segmented-control.js';
import StatusView from '../../components/ui/status-view.js';
import { restaurantBookingApi, type RestaurantMenuData, type RestaurantMenuItem, type RestaurantMenuScope } from '../../lib/api.js';
import { logFailure } from '../../lib/user-message.js';
import PhotoGallery from './photo-gallery.js';
import styles from './menu.module.css';

const choices = [
  { value: 'course', label: 'コース' },
  { value: 'a_la_carte', label: '単品' },
] as const;

type MenuLoad = { state: 'loading' | 'failed' } | { state: 'ready'; menu: RestaurantMenuData };

function menuPeriod(item: RestaurantMenuItem): string {
  if (item.kind !== 'course') return '';
  const periodLabels = { lunch: 'ランチ', dinner: 'ディナー' };
  const periods = item.servicePeriods.flatMap((period) => {
    if (period === 'lunch' || period === 'dinner') return [periodLabels[period]];
    return [];
  });
  const duration = item.durationMinutes ? `${item.durationMinutes}分` : '';
  return [duration, ...periods].filter(Boolean).join('・');
}

function MenuItem({
  item,
  onOpenPhoto,
}: { item: RestaurantMenuItem; onOpenPhoto: (item: RestaurantMenuItem) => void }) {
  const photo = item.photos[0];
  const course = item.kind === 'course';
  const period = menuPeriod(item);
  const price = formatYen(item.price).replace(/^¥(.+)$/, '$1円');
  const text = item.photos.length > 1 ? `写真を見る · ${item.photos.length}枚` : '写真を見る';
  return (
    <Card>
      <div className={`${styles.item} ${course ? styles.course : styles.dish} ${photo ? styles.cardWithPhoto : ''}`}>
        <h2 className={`break-words font-bold leading-6 ${course ? 'text-lg' : 'text-[15px]'} ${styles.name}`}>
          {item.name}
        </h2>
        <div className={styles.itemDetails}>
          {item.description && <p className={`mt-2 whitespace-pre-line break-words text-[13px] leading-5 text-liff-sub ${styles.description}`}>{item.description}</p>}
          <div className={`${styles.itemMeta} ${course ? styles.courseMeta : ''}`}>
            {period && <p className="text-[13px] leading-5 text-liff-sub">{period}</p>}
            <p className={styles.price}>
              <strong className={`liff-num text-ink ${course ? 'text-[22px]' : 'text-base'}`}>{price}</strong>
              {course && <span className={styles.perGuest}>1名</span>}
            </p>
          </div>
        </div>
        {photo && (
          <div className={styles.coverPlacement}>
            <PhotoButton kind="cover" src={photo.url} crop={photo} caption={text} label={`${item.name}の${text}`}
              onClick={(event) => {
                event.currentTarget.focus({ preventScroll: true });
                onOpenPhoto(item);
              }} />
          </div>
        )}
      </div>
    </Card>
  );
}

function MenuScreen({
  storeId, token, onBack,
}: { storeId?: string; token: string; onBack?: () => void }) {
  const [load, setLoad] = useState<MenuLoad>({ state: 'loading' });
  const [revision, setRevision] = useState(0);
  const [kind, setKind] = useState<RestaurantMenuItem['kind']>('course');
  const [selected, setSelected] = useState<RestaurantMenuItem | null>(null);
  const ready = load.state === 'ready' ? load.menu : null;

  useEffect(() => {
    let current = true;
    const scope: RestaurantMenuScope = storeId ? { storeId } : { token };
    void restaurantBookingApi.menu(scope).then((menu) => {
      if (!current) return;
      if (menu.items.length && !menu.items.some((item) => item.kind === 'course')) setKind('a_la_carte');
      setLoad({ state: 'ready', menu });
    }).catch((error) => {
      if (!current) return;
      logFailure('restaurant-menu', error);
      setLoad({ state: 'failed' });
    });
    return () => { current = false; };
  }, [storeId, token, revision]);

  const screenItems = ready?.items.filter((item) => item.kind === kind) ?? [];
  const bookingUrl = ready?.bookingUrl;
  return (
    <LiffLookScope className={styles.page}>
      <LiffHeader title="メニュー" storeName={ready?.storeName} onBack={onBack} backLabel="予約に戻る" />
      <main className={`mx-auto w-full max-w-md space-y-4 px-4 pt-4 ${styles.content}`}>
        {load.state === 'loading' && <LoadingView label="メニューを読み込んでいます" />}
        {load.state === 'failed' && (
          <StatusView icon="wifi-off" title="メニューを読み込めませんでした"
            body="通信状況を確認して、もう一度お試しください。"
            action={{ label: 'もう一度読み込む', onClick: () => {
              setLoad({ state: 'loading' });
              setRevision((previous) => previous + 1);
            } }} />
        )}
        {ready && (ready.items.length ? (
          <>
            <SegmentedControl label="メニューの種類" choices={choices} value={kind} onChange={setKind}>
              <div className="space-y-3.5">
                {screenItems.length ? screenItems.map((item) => (
                  <MenuItem key={item.id} item={item} onOpenPhoto={setSelected} />
                )) : <StatusView icon="utensils" title={kind === 'course' ? 'コースは準備中です' : '単品メニューは準備中です'} />}
              </div>
            </SegmentedControl>
          </>
        ) : <StatusView icon="utensils" title="メニューは準備中です" />)}
      </main>
      {bookingUrl && !onBack && (
        <BottomBar>
          <Button variant="primary" href={bookingUrl}>
            席を予約する
          </Button>
        </BottomBar>
      )}
      {selected && (
        <PhotoGallery
          item={selected}
          onClose={() => setSelected(null)}
          refreshPhoto={async (photoId) => {
            const next = await restaurantBookingApi.menu(storeId ? { storeId } : { token });
            return next.items.find((item) => item.id === selected.id)?.photos.find((photo) => photo.id === photoId)?.url ?? null;
          }}
        />
      )}
    </LiffLookScope>
  );
}

export default function RestaurantMenu({ storeId, onBack }: { storeId?: string; onBack?: () => void } = {}) {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  return <MenuScreen key={storeId ?? token} storeId={storeId} token={token} onBack={onBack} />;
}
