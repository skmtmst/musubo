import { useCustomerWords } from './customer-style-scope.js';
import { bookingPriceText } from '../lib/booking-price.js';
import Button from './ui/button/index.js';
import { useEffect, useMemo, useState } from 'react';
import { api, type MenuItem } from '../lib/api.js';
import { logFailure } from '../lib/user-message.js';
import LoadErrorView from './load-error-view.js';
import LoadingView from './loading-view.js';
import MenuChoiceCard from './menu-choice-card.js';

const ALL_CATEGORY = 'すべて';

/**
 * 1-a メニューを選ぶ (★V8・)。札を押すと選ばれるだけで、進むのは下の操作の帯。
 * 種類の札 (すべて・トリミング…) で絞る。選んだ札は緑枠＋薄い緑の地＋緑のチェック。
 * (撮影: ボタン名にメニュー名をそのまま出す。qa-shots.mjs が名前で押す)
 */
export default function MenuList({
  selectedId,
  onSelect,
  onLoadState,
}: {
  selectedId: string | null;
  onSelect: (m: MenuItem) => void;
  /** 読み込み中・失敗・選ぶものが無い間は、下の帯を出さないための合図。 */
  onLoadState?: (ready: boolean) => void;
}) {
  const words = useCustomerWords();
  const [menus, setMenus] = useState<MenuItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [category, setCategory] = useState<string>(ALL_CATEGORY);

  useEffect(() => {
    setFailed(false);
    api
      .menus()
      .then((r) => setMenus(r.menus))
      .catch((e) => {
        logFailure('menus', e);
        setFailed(true);
      });
  }, [reloadKey]);

  useEffect(() => {
    onLoadState?.(menus !== null && !failed && menus.length > 0);
  }, [menus, failed, onLoadState]);

  const categories = useMemo(() => {
    const seen: string[] = [];
    for (const m of menus ?? []) {
      const c = m.category_label ?? 'その他';
      if (!seen.includes(c)) seen.push(c);
    }
    return seen;
  }, [menus]);

  if (failed) return <LoadErrorView onRetry={() => setReloadKey((k) => k + 1)} />;
  if (!menus) return <LoadingView />;

  const visible =
    category === ALL_CATEGORY
      ? menus
      : menus.filter((m) => (m.category_label ?? 'その他') === category);

  return (
    <div className="space-y-3.5">
      <h2 className="text-xl font-bold text-ink">{`${words.bookingContent}を選んでください`}</h2>
      {categories.length > 1 && (
        <div
          className="-mx-4 flex gap-1.5 overflow-x-auto px-4"
          role="group"
          aria-label="種類でしぼる"
        >
          {[ALL_CATEGORY, ...categories].map((c) => {
            const active = c === category;
            return (
              <Button variant="chip" selected={active}
                key={c}
                type="button"
                onClick={() => setCategory(c)}
                aria-pressed={active}
              >
                {c}
              </Button>
            );
          })}
        </div>
      )}
      <ul className="space-y-3.5">
        {visible.map((m) => {
          const selected = m.id === selectedId;
          return (
            <li key={m.id}>
              <MenuChoiceCard name={m.name} description={m.description} imageUrl={m.photo_url} selected={selected} onSelect={() => onSelect(m)} details={<>
                <span className="font-semibold text-ink">{m.duration_minutes}分</span>
                <span className="ml-2 font-bold text-liff-primary">{bookingPriceText(m.base_price, m.price_mode)}</span>
              </>} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
