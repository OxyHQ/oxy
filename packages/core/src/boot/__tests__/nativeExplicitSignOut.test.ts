import type { OxyServices } from '../../OxyServices';
import type { SessionLoginResponse } from '../../models/session';
import { createNativeAuthStateStore, type AuthStateStore, type NativeKeyValueStorage } from '../../session/authStateStore';
import { refreshPersistedSession } from '../../session/refresh';
import { runSessionColdBoot } from '../sessionColdBoot';

type LogoutStore = AuthStateStore & {
  setAutomaticIdentitySignInSuppressed?: (suppressed: boolean) => Promise<boolean>;
};
function fixture() {
  const values = new Map<string, string>();
  const storage: NativeKeyValueStorage = {
    getItem: async key => values.get(key) ?? null,
    setItem: async (key, value) => { values.set(key, value); },
    removeItem: async key => { values.delete(key); },
  };
  const session = {sessionId:'new-key-session',user:{id:'commons-owner'},accessToken:'new-key-token',deviceId:'new-device',deviceSecret:'new-secret'} as SessionLoginResponse;
  const signInWithCommonsIdentity = jest.fn(async () => session);
  const oxy = {baseURL:'https://api.oxy.so',auth:{signInWithCommonsIdentity},session:{setAccessToken:jest.fn()},devices:{mintToken:jest.fn()},http:{getSessionEpoch:()=>0,hasSessionEnded:()=>false,runSingleFlightDeviceSecretMint:(operation:()=>Promise<unknown>)=>operation()}} as unknown as OxyServices;
  return {storage, values, oxy, signInWithCommonsIdentity};
}

describe('explicit native account logout survives a new process',()=>{
  it('does not challenge Commons after full signout and a recreated store',async()=>{
    const {storage,oxy,signInWithCommonsIdentity}=fixture();
    const original:LogoutStore=createNativeAuthStateStore(storage);
    await original.save({sessionId:'old',userId:'commons-owner',deviceId:'old-device',deviceSecret:'old-secret'});
    await original.setAutomaticIdentitySignInSuppressed?.(true);
    await original.clear();
    const restarted=createNativeAuthStateStore(storage);
    const outcome=await runSessionColdBoot({oxy,store:restarted,platform:{isWeb:false,isNative:true}});
    expect(outcome.kind).toBe('unauthenticated');
    expect(signInWithCommonsIdentity).not.toHaveBeenCalled();
  });
  it('also blocks the automatic refresh key lane after logout',async()=>{
    const {storage,oxy,signInWithCommonsIdentity}=fixture();
    const original:LogoutStore=createNativeAuthStateStore(storage);
    await original.setAutomaticIdentitySignInSuppressed?.(true);
    await original.clear();
    const token=await refreshPersistedSession({oxy,store:createNativeAuthStateStore(storage),allowCommonsIdentityFallback:true});
    expect(token).toBeNull();
    expect(signInWithCommonsIdentity).not.toHaveBeenCalled();
  });
  it('a pending save cannot restore a credential after the later clear',async()=>{
    const {storage}=fixture();
    let release!:()=>void;
    const barrier=new Promise<void>(resolve=>{release=resolve;});
    const backingSet=storage.setItem;
    storage.setItem=async(key,value)=>{await barrier;await backingSet(key,value);};
    const store=createNativeAuthStateStore(storage);
    const saving=store.save({sessionId:'old',userId:'old-user',deviceId:'old-device',deviceSecret:'old-secret'});
    const clearing=store.clear();
    release();
    await Promise.all([saving,clearing]);
    expect(await createNativeAuthStateStore(storage).load()).toBeNull();
  });
});
