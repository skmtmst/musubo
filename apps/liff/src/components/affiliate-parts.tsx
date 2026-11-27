import { TextInput } from './forms/controls.js';
import { useEffect, useRef, useState, type RefObject } from 'react';
import Button from './ui/button/index.js';
import Icon from './ui/icon.js';


/**
 * Copy `text` with graceful degradation for LIFF WebViews:
 *   1. navigator.clipboard.writeText  — modern, needs secure context + permission
 *   2. document.execCommand('copy')   — legacy textarea-select fallback
 *   3. neither worked → caller shows the URL selected for manual copy
 * Returns true only when the browser confirms the copy succeeded.
 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to execCommand
  }

  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    ta.style.left = '-9999px';
    ta.setAttribute('readonly', '');
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    if (ok) return true;
  } catch {
    // fall through to manual-copy fallback
  }

  return false;
}


function CopyButton({
  url,
  urlRef,
  compact = false,
}: {
  url: string;
  urlRef: RefObject<HTMLInputElement | null>;
  /** 箱の中の1行  では小さな四角のボタンにする。 */
  compact?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [manualCopy, setManualCopy] = useState(false);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const currentUrl = useRef(url);
  const alive = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  currentUrl.current = url;
  useEffect(() => { setCopied(false); setManualCopy(false); if (timer.current) clearTimeout(timer.current); }, [url]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; if (timer.current) clearTimeout(timer.current); }; }, []);

  async function handleCopy() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    const ok = await copyText(url);
    pending.current = false;
    if (!alive.current) return;
    setBusy(false);
    if (currentUrl.current !== url) return;
    if (ok) {
      setManualCopy(false);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
      return;
    }
    setManualCopy(true);
    setTimeout(() => {
      const el = urlRef.current;
      if (el) {
        el.focus();
        el.select();
        el.setSelectionRange(0, el.value.length);
      }
    }, 0);
  }

  return (
    <>
      <Button variant={compact ? 'inline-action' : 'secondary'} className="w-auto shrink-0"
        type="button"
        onClick={handleCopy}
        disabled={busy}
      >
        {!compact && <Icon name="copy" className="h-3.5 w-3.5" />}
        {copied ? 'コピーしました' : 'コピーする'}
      </Button>
      {manualCopy && (
        <div className="w-full space-y-1">
          <p className="text-xs text-ink-secondary">
            自動コピーできませんでした。下のURLを選択してコピーしてください。
          </p>
          <TextInput
            ref={urlRef}
            type="text"
            aria-label="紹介のURL"
            readOnly
            value={url}
            onFocus={(e) => e.currentTarget.select()}
          />
        </div>
      )}
    </>
  );
}
export { copyText, CopyButton }
