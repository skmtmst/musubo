
import { useEffect, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import Button from './button/index.js';
import Icon from './icon.js';
import styles from './confirm-dialog.module.css';

/**
 * LIFF 共通の確認窓。管理画面の ConfirmDialog と同じ形
 * (題・影響・「閉じる」と危ない操作のボタン)。
 *
 * ブラウザの `confirm` は使わない。見た目が OS 任せで、
 * 何を取り消すのかを読ませられず、押し間違いを止められない。
 * 取り消せない操作 (`destructive`) は赤い実行ボタン＋警告の印にする。
 *
 * キーボードの動き:
 * - 開いている間の Escape は「閉じる」と同じ。処理中 (`busy`) は閉じない。
 * - 開いたら安全な方 (「閉じる」) へフォーカスを移し、Tab は窓の中を回る。
 *   閉じたら開く前の場所へ戻す。
 *
 * 折れ方:
 * - 題と本文は文節で折る (`word-break: auto-phrase`)。
 *   `overflow-wrap: anywhere` は言葉の途中で折るので使わない。
 */
export default function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = '実行する',
  cancelLabel = '閉じる',
  destructive = false,
  busy = false,
  confirmDisabled = false,
  error,
  children,
  designNode,
  onConfirm,
  onCancel,
  surface = 'dialog',
  footer,
  titleAside,
  appearance,
}: {
  open: boolean;
  surface?: 'dialog' | 'sheet';
  footer?: ReactNode;
  titleAside?: ReactNode;
  appearance?: 'photo' | 'photo-with-thumbnails';
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  confirmDisabled?: boolean;
  error?: string;
  children?: ReactNode;
  /** V8 の板の印。渡したときだけ枠に data-design-node を付ける。 */
  designNode?: string;
  /** 渡さないと実行ボタンそのものを出さない (条件を満たすまで押させない止め方)。 */
  onConfirm?: () => void;
  onCancel: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  // 開いている間の Escape は「閉じる」と同じ。処理中は閉じない。
  useEffect(() => {
    if (!open || busy) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, busy, onCancel]);

  // 開いたら安全な方 (「閉じる」) へ移し、閉じたら開く前へ戻す。
  useEffect(() => {
    if (!open) return;
    openerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (
    cancelRef.current ?? panelRef.current?.querySelector<HTMLElement>('button:not([disabled]), [href]') ?? panelRef.current)?.focus();
    return () => {
      const opener = openerRef.current;
      openerRef.current = null;
      if (opener && document.contains(opener)) opener.focus();
    };
  }, [open ]);

  // Tab が窓の外へ出ないように、行き止まりで折り返す。
  const trapTab = (event: ReactKeyboardEvent) => {
    if (event.key !== 'Tab') return;
    const panel = panelRef.current;
    if (!panel) return;
    const focusables = Array.from(
      panel.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    if (focusables.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (!focusables.some((focusable) => focusable === document.activeElement)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  if (!open) return null;
  const panelAppearance = appearance ? styles.photoPanel : 'p-5';
  const footerSpacing = appearance === 'photo-with-thumbnails' ? styles.galleryFooter
    : appearance === 'photo' ? styles.photoFooter : 'mt-4';
  return (
    <div
      className={surface === 'sheet' ? "fixed inset-0 z-50 flex items-end justify-center bg-ink/60" :"fixed inset-0 z-50 flex items-center justify-center bg-ink/60 p-6"}
      role="presentation"
      onMouseDown={(event) => {
        if (!busy && event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        data-design-node={designNode}
        role={destructive ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        aria-label={title}
        onKeyDown={trapTab}
        className={`w-full max-w-[480px] rounded-xl border border-hairline bg-canvas ${panelAppearance}`}
      >
        {surface === 'sheet' ? <div aria-hidden="true" className="mx-auto mb-4 h-1 w-10 rounded-full bg-hairline" /> : null}
        <div className="flex items-start gap-2">
          {destructive ? (
            <span className="shrink-0 text-danger" aria-hidden="true">
              <Icon name="alert-triangle" className="h-5 w-5" />
            </span>
          ) : null}
          <p className="min-w-0 flex-1 text-sm font-bold leading-6 text-ink [word-break:auto-phrase]">
            {title}
          </p>
          {titleAside}
        </div>
        {description !== undefined && (
          <p className="mt-2 text-sm leading-6 text-ink-secondary [word-break:auto-phrase]">
            {description}
          </p>
        )}
        {children}
        {error && (
          <p role="alert" className="mt-2 text-sm leading-6 text-danger">
            {error}
          </p>
        )}
        {footer ??
        <div className={`${footerSpacing} flex gap-2`}>
          <Button variant="secondary" ref={cancelRef} onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          {onConfirm ? (
            <Button variant={destructive ? 'danger' : 'primary'} onClick={onConfirm} disabled={busy || confirmDisabled}>
              {busy ? '処理中…' : confirmLabel}
            </Button>
          ) : null}
        </div>}
      </div>
    </div>
  );
}
