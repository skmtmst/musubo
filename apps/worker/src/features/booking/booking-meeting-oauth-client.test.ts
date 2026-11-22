import {expect,it,vi} from 'vitest';
import {exchangeMeetingAuthorization,meetingAuthorizationUrl,newMeetingVerifier,type MeetingOAuthConfig} from './booking-meeting-oauth-client.js';
const signal=new AbortController().signal;
it.each(['google_meet','zoom','teams','outlook'] as const)('%s は状態と PKCE を使い、鍵と本人を模擬で交換する',async provider=>{
 const config:MeetingOAuthConfig={provider,clientId:'fixture-client',clientSecret:'fixture-secret',redirectUri:'https://example.test/callback'};
 const verifier=newMeetingVerifier(),url=new URL(await meetingAuthorizationUrl(config,'fixture-state',verifier));
 expect(url.searchParams.get('state')).toBe('fixture-state');expect(url.searchParams.get('code_challenge_method')).toBe('S256');expect(url.searchParams.get('code_challenge')).not.toBe(verifier);
 const scopes=provider==='google_meet'?'https://www.googleapis.com/auth/calendar.events':provider==='zoom'?'user:read:user meeting:write:meeting meeting:read:meeting meeting:read:list_meetings meeting:delete:meeting':provider==='teams'?'User.Read OnlineMeetings.ReadWrite':'User.Read Calendars.ReadWrite';
 const request=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({access_token:'access',refresh_token:'refresh',expires_in:3600,scope:scopes}))).mockResolvedValueOnce(new Response(JSON.stringify(provider==='google_meet'?{sub:'person'}:{id:'person'})));
 expect(await exchangeMeetingAuthorization(config,{code:'fixture-code',verifier,signal},request as unknown as typeof fetch)).toMatchObject({accessToken:'access',refreshToken:'refresh',externalAccountId:'person',expiresAt:expect.any(String)});
 expect(request).toHaveBeenCalledTimes(2);
});
it('更新用の鍵がなければ接続を成功させない',async()=>{
 const config:MeetingOAuthConfig={provider:'zoom',clientId:'id',clientSecret:'secret',redirectUri:'https://example.test/callback'};
 const request=vi.fn(async()=>new Response(JSON.stringify({access_token:'access'}))) as unknown as typeof fetch;
 await expect(exchangeMeetingAuthorization(config,{code:'code',verifier:'verifier',signal},request)).rejects.toThrow('oauth_exchange_failed');expect(request).toHaveBeenCalledOnce();
});

it('求めた権限を外された場合は接続を成功させない',async()=>{
 const config:MeetingOAuthConfig={provider:'teams',clientId:'id',clientSecret:'secret',redirectUri:'https://example.test/callback'};
 const request=vi.fn(async()=>new Response(JSON.stringify({access_token:'access',refresh_token:'refresh',expires_in:3600,scope:'User.Read'}))) as unknown as typeof fetch;
 await expect(exchangeMeetingAuthorization(config,{code:'code',verifier:'verifier',signal},request)).rejects.toThrow('oauth_scope_missing');expect(request).toHaveBeenCalledOnce();
});
it('更新鍵の交換は一度だけ行い、Zoom の新しい更新鍵を受け取る',async()=>{
 const {refreshMeetingAuthorization}=await import('./booking-meeting-oauth-client.js');
 const config:MeetingOAuthConfig={provider:'zoom',clientId:'id',clientSecret:'secret',redirectUri:'https://example.test/callback'};
 const request=vi.fn(async()=>new Response(JSON.stringify({access_token:'access',refresh_token:'rotated',expires_in:3600}))) as unknown as typeof fetch;
 expect(await refreshMeetingAuthorization(config,{refreshToken:'original',signal},request)).toMatchObject({accessToken:'access',refreshToken:'rotated',expiresAt:expect.any(String)});expect(request).toHaveBeenCalledOnce();
});
it('Zoom の新しい更新鍵が無ければ成功扱いにしない',async()=>{
 const {refreshMeetingAuthorization}=await import('./booking-meeting-oauth-client.js');
 const config:MeetingOAuthConfig={provider:'zoom',clientId:'id',clientSecret:'secret',redirectUri:'https://example.test/callback'};
 const request=vi.fn(async()=>new Response(JSON.stringify({access_token:'access',expires_in:3600}))) as unknown as typeof fetch;
 await expect(refreshMeetingAuthorization(config,{refreshToken:'original',signal},request)).rejects.toThrow('oauth_refresh_failed');
});
it('Microsoft が Graph URL 付きの権限を返しても許可を確認できる',async()=>{
 const config:MeetingOAuthConfig={provider:'outlook',clientId:'id',clientSecret:'secret',redirectUri:'https://example.test/callback'};
 const request=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({access_token:'access',refresh_token:'refresh',expires_in:3600,scope:'https://graph.microsoft.com/User.Read https://graph.microsoft.com/Calendars.ReadWrite'}))).mockResolvedValueOnce(new Response(JSON.stringify({id:'person'})));
 await expect(exchangeMeetingAuthorization(config,{code:'code',verifier:'verifier',signal},request as unknown as typeof fetch)).resolves.toMatchObject({externalAccountId:'person'});
});
it('更新時の一時障害と無効な鍵と結果不明を区別する',async()=>{
 const {refreshMeetingAuthorization,MeetingRefreshError}=await import('./booking-meeting-oauth-client.js');
 const config:MeetingOAuthConfig={provider:'outlook',clientId:'id',clientSecret:'secret',redirectUri:'https://example.test/callback'};
 const call=async(provider:MeetingOAuthConfig['provider'],response:Response)=>{try{await refreshMeetingAuthorization({...config,provider},{refreshToken:'refresh',signal},vi.fn(async()=>response) as unknown as typeof fetch);return 'unexpected';}catch(e){return e instanceof MeetingRefreshError?e.kind:'unexpected';}};
 expect(await call('outlook',new Response('{}',{status:503}))).toBe('retryable');
 expect(await call('outlook',new Response('{"error":"invalid_grant"}',{status:400}))).toBe('revoked');
 expect(await call('zoom',new Response('{}',{status:503}))).toBe('unknown');
 expect(await call('zoom',new Response('{"error":"invalid_client"}',{status:401}))).toBe('configuration');
});
it.each(['google_meet','zoom'] as const)('%s の解除を安全な形式で送り失敗・通信不明を確認待ちにする',async provider=>{
 const {revokeMeetingAuthorization}=await import('./booking-meeting-oauth-client.js');
 const config:MeetingOAuthConfig={provider,clientId:'fixture-client',clientSecret:'fixture-secret',redirectUri:'https://example.test/callback'};
 const request=vi.fn().mockResolvedValueOnce(new Response('',{status:200})).mockResolvedValueOnce(new Response('',{status:503})).mockRejectedValueOnce(new Error('network'));
 expect(await revokeMeetingAuthorization(config,{token:'fixture-token',signal},request as unknown as typeof fetch)).toBe('done');
 const [url,options]=request.mock.calls[0] as [string,RequestInit];
 expect(url).toBe(provider==='zoom'?'https://zoom.us/oauth/revoke':'https://oauth2.googleapis.com/revoke');
 expect(new URLSearchParams(options.body as string).get('token')).toBe('fixture-token');
 if(provider==='zoom')expect((options.headers as Record<string,string>).Authorization).toBe(`Basic ${btoa('fixture-client:fixture-secret')}`);
 expect(await revokeMeetingAuthorization(config,{token:'fixture-token',signal},request as unknown as typeof fetch)).toBe('review');
 expect(await revokeMeetingAuthorization(config,{token:'fixture-token',signal},request as unknown as typeof fetch)).toBe('review');
});
