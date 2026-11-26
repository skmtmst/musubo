import { expect, test } from 'vitest';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { Miniflare } from 'miniflare';

test('実workerdでも外部へのHTTPを止め、登録済みの試験LINEだけ模擬成功にする', async () => {
  const require = createRequire(import.meta.url);
  const viteRequire = createRequire(require.resolve('vite'));
  const esbuild = viteRequire('esbuild') as { build(options: Record<string, unknown>): Promise<{ outputFiles: Array<{ text: string }> }> };
  const bundle = await esbuild.build({ stdin: { resolveDir: resolve(process.cwd(), 'src'), loader: 'ts', contents: `
    import { withQaOutboundBoundary, QA_STAGING_DATABASE } from './services/staging-qa-safety.ts';
    export default { async fetch(request, bindings) {
      const path = new URL(request.url).pathname;
      const env = {...bindings, DEPLOY_ENV:path==='/production'?'production':'staging', WORKER_NAME:'nen-line-stg',
        D1_DATABASE_ID:QA_STAGING_DATABASE,WORKER_PUBLIC_URL:'https://stg-api.musubo.jp',STAGING_QA_ENABLED:'true',STAGING_QA_OUTBOUND_DISABLED:'true'};
      return withQaOutboundBoundary(env, async()=>{
        try {
          if(path==='/simulate') return await fetch('https://api.line.me/v2/bot/message/push', {
            method:'POST',headers:{Authorization:'Bearer qa-mock:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222'},
            body:JSON.stringify({to:'U'+'a'.repeat(32),messages:[{type:'text',text:'QA synthetic'}]})});
          return await fetch('https://outside.example.invalid/notification',{method:'POST',body:'QA synthetic'});
        } catch { return new Response('blocked',{status:503}); }
      });
    }};
  ` }, bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', external: ['node:async_hooks'] });
  const mf = new Miniflare({ workers: [
    { name: 'qa', modules: true, script: bundle.outputFiles[0]!.text, compatibilityDate: '2024-12-01', compatibilityFlags: ['nodejs_compat'],
      d1Databases: { DB: 'q75-database' }, outboundService: 'network' },
    { name: 'network', modules: true, script: `let calls=0;export default {fetch(request){
      if(new URL(request.url).pathname==='/calls')return Response.json({calls});calls++;return new Response('real network transport');}}` },
  ] });
  try {
    const db = await mf.getD1Database('DB', 'qa');
    await db.prepare('CREATE TABLE platform_settings(key TEXT PRIMARY KEY,value TEXT)').run();
    await db.prepare('CREATE TABLE line_accounts(id TEXT,tenant_id TEXT,channel_access_token TEXT,is_active INTEGER)').run();
    await db.prepare('CREATE TABLE friends(id TEXT,line_user_id TEXT,line_account_id TEXT,is_following INTEGER,line_platform_user_id TEXT AS (line_user_id) VIRTUAL)').run();
    const id = '11111111-1111-4111-8111-111111111111';
    await db.prepare('INSERT INTO platform_settings VALUES (?,?)').bind(`staging-qa:run:${id}`, JSON.stringify({ id, tenantId: 'qa-tenant', accountId: 'qa-account', status: 'active', friendIds: ['qa-friend'] })).run();
    await db.prepare('INSERT INTO line_accounts VALUES (?,?,?,1)').bind('qa-account', 'qa-tenant', `qa-mock:${id}:22222222-2222-4222-8222-222222222222`).run();
    await db.prepare('INSERT INTO friends VALUES (?,?,?,1)').bind('qa-friend', `U${'a'.repeat(32)}`, 'qa-account').run();
    const caller = await mf.getWorker('qa'), network = await mf.getWorker('network');
    expect((await caller.fetch('https://qa/blocked')).status).toBe(503);
    const simulated = await caller.fetch('https://qa/simulate');
    expect(simulated.status).toBe(200);
    expect(simulated.headers.get('x-staging-qa-simulated')).toBe('true');
    expect(await (await network.fetch('https://network/calls')).json()).toEqual({ calls: 0 });
    expect(await (await caller.fetch('https://qa/production')).text()).toBe('real network transport');
    expect(await (await network.fetch('https://network/calls')).json()).toEqual({ calls: 1 });
  } finally { await mf.dispose(); }
}, 30_000);
