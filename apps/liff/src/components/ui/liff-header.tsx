import Button from './button/index.js';
import { useEffect, useState } from 'react';
import liff from '../../lib/liff-runtime.js';
import { api } from '../../lib/api.js';
import { logFailure } from '../../lib/user-message.js';
import Icon from './icon.js';
import { getLiffId } from '../../lib/liff-auth.js';

// 店名は画面ごとに読み直さない。最初に取れた値をモジュールに持つ。
const cachedShopNames = new Map<string, string>();
function accountKey() { try { return getLiffId(); } catch { return ''; } }

/**
 * ★V8 の上の帯。×・題・店名・… の1行 (高さ48)。全画面で同じ形。
 * 店名は /api/liff/config の accountName。読めないときは空のままにする
 * (帯の形は変えず、店名のところだけ空ける)。
 */
export function liffDocumentTitle(title: string): string {
  const name = title.trim();
  return name ? `${name} | musubo` : 'musubo';
}

/**
 * onBack を渡した段では、左の × は「この段を閉じる」（前の段へ戻る）にする（絵 kwC8E の × のまま）。
 * ページの中に戻るリンクは置かない。backLabel は読み上げの名前。
 */
export default function LiffHeader({ title, onBack, backLabel = '戻る', storeName }: { title: string; onBack?: () => void; backLabel?: string; storeName?: string }) {
  const key = accountKey();
  const [loadedName, setLoadedName] = useState<{ key: string; name: string } | null>(null);
  const shopName = storeName ?? (loadedName?.key === key ? loadedName.name : cachedShopNames.get(key) ?? null);

  // ブラウザ・LINE の上に出る題も、帯の題と同じ画面名にする（「<画面名> | musubo」）。
  useEffect(() => {
    document.title = liffDocumentTitle(title);
  }, [title]);

  useEffect(() => {
    if (storeName !== undefined || cachedShopNames.has(key)) return;
    let alive = true;
    api
      .liffConfig()
      .then((r) => {
        const name = r.data?.accountName ?? '';
        if (alive) { cachedShopNames.set(key, name); setLoadedName({ key, name }); }
      })
      .catch((e) => {
        logFailure('liff-config', e);
      });
    return () => { alive = false; };
  }, [key, storeName]);

  return (
    <header className="sticky top-0 z-10 border-b border-liff-line bg-canvas">
      <div className="mx-auto flex h-(--liff-header-h) w-full max-w-md items-center gap-2 px-3">
        {onBack ? (
          <Button variant="icon" type="button" aria-label={backLabel} onClick={onBack}>
            <Icon name="x" className="h-5 w-5" />
          </Button>
        ) : (
          <Button variant="icon"
            type="button"
            aria-label="閉じる"
            onClick={() => liff.closeWindow()}
          >
            <Icon name="x" className="h-5 w-5" />
          </Button>
        )}
        <div className="flex min-w-0 flex-1 flex-col items-center">
          <p className="max-w-full truncate text-[13px] font-bold text-ink">
            {title}
          </p>
          {shopName && (
            <p
              className="max-w-full truncate text-[10px] text-liff-sub"
              title={shopName}
            >
              {shopName}
            </p>
          )}
        </div>
        <span
          className="flex h-10 w-8 shrink-0 items-center justify-center text-ink"
          aria-hidden="true"
        >
          <Icon name="ellipsis" className="h-5 w-5" />
        </span>
      </div>
    </header>
  );
}
