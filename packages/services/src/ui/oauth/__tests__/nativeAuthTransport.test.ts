import type { OxyServices } from '@oxy.so/core';
import { startNativeOAuthSignIn, type NativeOAuthSignInContext } from '../nativeAuthTransport';
import { openAuthorizeUrlNative } from '../../components/oauthNavigation';
import { prepareAuthorizeRequest } from '../oauthHandshake';
jest.mock('../../components/oauthNavigation', () => ({ openAuthorizeUrlNative: jest.fn() }));
jest.mock('../oauthHandshake', () => ({ prepareAuthorizeRequest: jest.fn(async () => ({ authorizeUrl: 'https://auth.oxy.so/authorize', handshake: { state: 'expected', codeVerifier: 'verifier' } })) }));
const open = openAuthorizeUrlNative as jest.Mock;
const prepare = prepareAuthorizeRequest as jest.Mock;
const uri = 'externalapp://oauth/callback?tenant=fixed';
function fixture() {
  const exchange = jest.fn(async () => ({ sessionId: 'isolated', accessToken: 'bearer', user: { id: 'user' } }));
  const getPublic = jest.fn(async () => ({ id: 'app', name: 'External', type: 'third_party', isOfficial: false, isInternal: false, scopes: [] }));
  const context: NativeOAuthSignInContext = { platform: 'native', oxyServices: { apps: { getPublic }, auth: { oauth: { exchangeCode: exchange } } } as unknown as OxyServices, clientId: 'oxy_dk_registered', identityBound: false, commitSession: jest.fn(async () => undefined) };
  return { context, exchange, getPublic };
}
beforeEach(() => { jest.clearAllMocks(); open.mockResolvedValue({ redirectUrl: `${uri}&code=legitimate&state=expected` }); });
it('uses the common exchange and commits a fixed-query callback without device credentials', async () => {
  const { context, exchange, getPublic } = fixture();
  expect(await startNativeOAuthSignIn(context, { redirectUri: uri })).toEqual({ status: 'signed-in' });
  expect(getPublic).toHaveBeenCalledWith('oxy_dk_registered', { cache: false });
  expect(open).toHaveBeenCalledWith('https://auth.oxy.so/authorize', uri, { allowExternalFallback: false });
  expect(exchange).toHaveBeenCalledWith({ code: 'legitimate', clientId: 'oxy_dk_registered', redirectUri: uri, codeVerifier: 'verifier' });
  expect(context.commitSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'isolated', userId: 'user', deviceId: undefined, deviceSecret: undefined }));
});
it.each([
 `${uri}&code=x&state=expected&code=y`, `${uri}&code=x&state=expected&state=expected`,
 `${uri}&error=access_denied&state=wrong`, `${uri}&error=access_denied&state=expected`,
 `${uri}&code=x&state=wrong`, `${uri}&tenant=other&code=x&state=expected`, 'externalapp://oauth/callback?tenant=other&code=x&state=expected',
 `${uri}/extra?code=x&state=expected`, `${uri}&code=x&state=expected#fragment`,
])('rejects %s before exchange/commit', async (redirectUrl) => {
 const { context, exchange } = fixture(); open.mockResolvedValue({ redirectUrl });
 expect((await startNativeOAuthSignIn(context, { redirectUri: uri })).status).toBe('failed');
 expect(exchange).not.toHaveBeenCalled(); expect(context.commitSession).not.toHaveBeenCalled();
});
it('cancellation commits nothing', async () => {
 const { context, exchange } = fixture(); open.mockResolvedValue({ redirectUrl: null });
 expect(await startNativeOAuthSignIn(context, { redirectUri: uri })).toEqual({ status: 'cancelled' });
 expect(exchange).not.toHaveBeenCalled(); expect(context.commitSession).not.toHaveBeenCalled();
});
it.each(['platform','client','identity','official','registry-error'])('direct method rejects %s before opening', async (mode) => {
 const { context, exchange, getPublic } = fixture();
 if(mode==='platform') context.platform='unsupported';
 if(mode==='client') context.clientId=null;
 if(mode==='identity') context.identityBound=true;
 if(mode==='official') getPublic.mockResolvedValue({ id:'official', name:'Official', type:'first_party', isOfficial:true, isInternal:false, scopes:[] });
 if(mode==='registry-error') getPublic.mockRejectedValue(new Error('unavailable'));
 expect((await startNativeOAuthSignIn(context,{redirectUri:uri})).status).not.toBe('signed-in');
 expect(open).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled(); expect(exchange).not.toHaveBeenCalled();
});
it('rejects reentry without replacing the first handshake', async () => {
 const { context }=fixture(); let cancel!: (result:{redirectUrl:null})=>void;
 open.mockImplementation(()=>new Promise(resolve=>{cancel=resolve;}));
 const first=startNativeOAuthSignIn(context,{redirectUri:uri});
 for(let i=0;i<8;i++) await Promise.resolve();
 expect(await startNativeOAuthSignIn(context,{redirectUri:uri})).toEqual({status:'failed',reason:'already-in-progress'});
 cancel({redirectUrl:null}); await first;
});
