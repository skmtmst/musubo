import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import LiffLookScope from '../components/liff-look-scope.js';
import LoadingView from '../components/loading-view.js';
import LiffHeader from '../components/ui/liff-header.js';
import BottomBar from '../components/ui/bottom-bar.js';
import Button from '../components/ui/button/index.js';
import Card from '../components/ui/card.js';
import {
  FileDownloadError,
  fetchFileBlob,
  issueFile,
  type FileFailureKind,
  type IssuedFile,
} from '../lib/file-download-api.js';
import { logFailure } from '../lib/user-message.js';
import DownloadFailure from '../components/download-failure.js';
import { closeOrBackToLine } from './not-found.js';

/** 失敗の言葉は docs/security/SIGNED-DOWNLOADS.md「失敗の文言と画面の状態」と同じ。 */
export const FILE_TEXT = {
  unavailable: 'このファイルは利用できません。お店へお問い合わせください',
  deleted: 'このファイルは削除されました',
  expired: 'リンクの期限が切れました',
  unconfigured: 'ただいま開けません。お店へお問い合わせください',
  login: 'LINEでログインして、もう一度お試しください',
  retry: '開けませんでした。時間をおいて、もう一度お試しください',
} as const;

const KIND_LABEL: Record<IssuedFile['kind'], string> = { image: '画像', video: '動画', file: '書類' };

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

type State =
  | { name: 'loading' }
  | { name: 'ready'; file: IssuedFile }
  | { name: 'fetching'; file: IssuedFile }
  | { name: 'opened'; file: IssuedFile; blobUrl: string }
  | { name: 'failed'; kind: FileFailureKind; waitSeconds?: number };

/**
 * ファイルを開く画面。本文のリンク (/liff/files/<UUID>) から LINE で本人確認して入る。
 * 開く操作は自動にせず［ファイルを開く］ボタンにする (LINE の中のブラウザで確実に開くため)。
 * 状態：読み込み中・開ける・開いた・期限切れ・開けない(別人/別店)・削除された・停止中・通信の失敗。
 * ファイル名と大きさは本人確認が済んだあとだけ出す。
 */
export default function FileOpen() {
  const params = useParams();
  const [search] = useSearchParams();
  const id = params.id ?? search.get('id') ?? '';
  const [state, setState] = useState<State>({ name: 'loading' });
  const generation = useRef(0);
  const blobUrl = useRef<string | null>(null);
  const openingGeneration = useRef<number | null>(null);

  const load = useCallback(async () => {
    const mine = ++generation.current;
    if (blobUrl.current) { URL.revokeObjectURL(blobUrl.current); blobUrl.current = null; }
    setState({ name: 'loading' });
    try {
      const file = await issueFile(id);
      if (!file || typeof file.id !== 'string' || typeof file.url !== 'string' || typeof file.expiresAt !== 'string' || typeof file.filename !== 'string' || typeof file.mimeType !== 'string' || !Number.isSafeInteger(file.size) || file.size < 0 || !['image', 'video', 'file'].includes(file.kind)) throw new FileDownloadError('retry');
      if (mine === generation.current) setState({ name: 'ready', file });
    } catch (err) {
      logFailure('file-issue', err);
      if (mine !== generation.current) return;
      const e = err instanceof FileDownloadError ? err : new FileDownloadError('retry');
      setState({ name: 'failed', kind: e.kind, waitSeconds: e.retryAfterSeconds });
    }
  }, [id]);

  useEffect(() => {
    void load();
    return () => { generation.current++; };
  }, [load]);

  useEffect(() => () => { if (blobUrl.current) URL.revokeObjectURL(blobUrl.current); }, []);

  const open = useCallback(async (file: IssuedFile) => {
    const mine = generation.current;
    if (openingGeneration.current === mine) return;
    // 取得リンクは最長15分。過ぎていたら通信せず期限切れにする。
    if (!Number.isFinite(Date.parse(file.expiresAt)) || Date.parse(file.expiresAt) <= Date.now()) {
      setState({ name: 'failed', kind: 'expired' });
      return;
    }
    openingGeneration.current = mine;
    setState({ name: 'fetching', file });
    try {
      const blob = await fetchFileBlob(file);
      if (mine !== generation.current) return;
      const url = URL.createObjectURL(blob);
      blobUrl.current = url;
      setState({ name: 'opened', file, blobUrl: url });
      // 画像・動画は画面の中で見せる。書類 (PDF など) は端末の表示に渡す。
      if (file.kind === 'file') window.location.assign(url);
    } catch (err) {
      if (mine !== generation.current) return;
      logFailure('file-fetch', err);
      const e = err instanceof FileDownloadError ? err : new FileDownloadError('retry');
      setState({ name: 'failed', kind: e.kind, waitSeconds: e.retryAfterSeconds });
    } finally {
      if (openingGeneration.current === mine) openingGeneration.current = null;
    }
  }, []);

  return (
    <LiffLookScope className="min-h-screen bg-canvas">
      <LiffHeader title="ファイル" />
      <div className="mx-auto w-full max-w-md px-4 pt-3 pb-40">
        {state.name === 'loading' && <LoadingView label="本人確認をしています…" />}
        {(state.name === 'ready' || state.name === 'fetching' || state.name === 'opened') && (
          <FileCard state={state} />
        )}
        {state.name === 'failed' && <Failure state={state} onRetry={() => void load()} />}
      </div>
      {(state.name === 'ready' || state.name === 'fetching') && (
        <BottomBar>
          <Button variant="primary" disabled={state.name === 'fetching'} onClick={() => void open(state.file)}>
            {state.name === 'fetching' ? '開いています…' : 'ファイルを開く'}
          </Button>
        </BottomBar>
      )}
      {state.name === 'opened' && (
        <BottomBar>
          <Button variant="primary" onClick={() => closeOrBackToLine('close')}>閉じる</Button>
          {state.file.kind === 'file' && (
            <Button variant="secondary" onClick={() => window.location.assign(state.blobUrl)}>もう一度開く</Button>
          )}
        </BottomBar>
      )}
    </LiffLookScope>
  );
}

function FileCard({ state }: { state: Extract<State, { name: 'ready' | 'fetching' | 'opened' }> }) {
  const { file } = state;
  return (
    <div className="space-y-3.5" data-file-state={state.name}>
      <Card className="space-y-1 p-4">
        <p className="text-[15px] font-bold break-all text-ink" data-file-name>{file.filename}</p>
        <p className="text-[13px] text-liff-sub">
          {KIND_LABEL[file.kind]}・{formatFileSize(file.size)}
        </p>
      </Card>
      {state.name === 'opened' && file.kind === 'image' && (
        <Card className="overflow-hidden">
          <img src={state.blobUrl} alt={file.filename} className="block h-auto w-full" />
        </Card>
      )}
      {state.name === 'opened' && file.kind === 'video' && (
        <Card className="overflow-hidden">
          <video src={state.blobUrl} controls playsInline className="block h-auto w-full" />
        </Card>
      )}
      {state.name !== 'opened' && (
        <p className="text-[13px] text-pretty text-liff-sub">
          ボタンを押すと、ファイルを開きます。
        </p>
      )}
    </div>
  );
}

function Failure({ state, onRetry }: { state: Extract<State, { name: 'failed' }>; onRetry: () => void }) {
  return (
    <div data-file-state={state.kind}>
      <DownloadFailure
        kind={state.kind}
        waitSeconds={state.waitSeconds}
        onRetry={onRetry}
        copy={{
          unavailableTitle: 'ファイルを開けません',
          unavailableBody: FILE_TEXT.unavailable,
          deletedTitle: FILE_TEXT.deleted,
          expiredRetry: 'もう一度開く',
          expiredBody: 'もう一度開くと、新しいリンクを作ります。',
          unconfiguredBody: FILE_TEXT.unconfigured,
          loginBody: FILE_TEXT.login,
          retryBody: '時間をおいて、もう一度お試しください。',
        }}
      />
    </div>
  );
}
