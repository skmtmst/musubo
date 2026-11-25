import { createClientLogger } from '@line-crm/shared';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, useLocation } from 'react-router-dom';
import { liffActionFromUrl } from '@line-crm/shared';
import App from './app.js';
import LiffLookScope from './components/liff-look-scope.js';
import CustomerStyleScope from './components/customer-style-scope.js';
import { initLiff } from './lib/liff-auth.js';
import './index.css';
const clientLogger = createClientLogger('liff');


/** 業種を必要としない既存のファイル・フォーム等は、業種未設定だけで止めない。 */
function CustomerContext() {
  const location = useLocation();
  const search = new URLSearchParams(location.search);
  const page = search.get('page');
  const action = liffActionFromUrl(`https://liff.line.me/entry/${location.search}`);
  const independentEntry = search.has('couponRef') || search.has('eventWaitlistToken')
    || (page === 'webinar' && search.has('slug')) || (page === 'research' && search.has('researchId'))
    || (page === 'restaurant' && search.has('token')) || page === 'restaurant-menu' || action?.kind === 'form' || action?.kind === 'visit_stamp';
  const required = /^\/(?:booking|events|mypage)(?:\/|$)/.test(location.pathname)
    || (location.pathname === '/' && !independentEntry);
  return <CustomerStyleScope required={required}><App /></CustomerStyleScope>;
}

(async () => {
  try {
    await initLiff();
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <BrowserRouter>
          <LiffLookScope><CustomerContext /></LiffLookScope>
        </BrowserRouter>
      </StrictMode>,
    );
  } catch (err) {
    clientLogger.error("src_main_failed");
    document.getElementById('root')!.innerHTML = `
      <div style="padding: 2rem; font-family: sans-serif; color: #4b5563; text-align: center;">
        <h1 style="font-size: 1rem; margin-bottom: 0.5rem;">開けませんでした</h1>
        <p style="font-size: 0.875rem;">時間をおいて、もう一度お試しください。</p>
      </div>
    `;
  }
})();
