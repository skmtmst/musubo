import { useEffect, useState } from 'react';
import { Navigate, useLocation, useParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import LoadingView from '../components/loading-view.js';
import LoadErrorView from '../components/load-error-view.js';
import LiffHeader, { liffDocumentTitle } from '../components/ui/liff-header.js';

export default function Research() {
  const { id = '' } = useParams<{ id: string }>();
  const location = useLocation();
  const [result, setResult] = useState<{ researchId: string; formId: string }>();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    document.title = liffDocumentTitle('リサーチ');
    setResult(undefined); setFailed(false);
    api.researchForm(id).then(result => {
      if (!active) return;
      if (typeof result?.formId !== 'string' || !result.formId.trim()) {
        setFailed(true);
        return;
      }
      setResult({ researchId: id, formId: result.formId });
    })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [id, attempt]);
  if (failed) return <LoadErrorView onRetry={() => setAttempt(value => value + 1)} />;
  if (!result || result.researchId !== id) return (
    <div className="min-h-screen bg-canvas">
      <LiffHeader title="リサーチ" />
      <div className="mx-auto w-full max-w-md p-4"><LoadingView /></div>
    </div>
  );
  return <Navigate to={{ pathname: `/forms/${encodeURIComponent(result.formId)}`, search: location.search }} replace />;
}
