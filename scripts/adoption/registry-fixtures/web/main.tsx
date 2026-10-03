import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BloomProvider } from '@oxy.so/bloom/provider';
import { OxyProvider, OxySignInButton, useAuth, useOxy } from '@oxy.so/services';

function App() {
  const { openAccountDialog, requestOAuthConsent, oxyServices } = useOxy();
  const [observation, setObservation] = useState('');
  const { user, isAuthenticated, isLoading, signOut } = useAuth();
  if (isLoading) return <p>Loading</p>;
  return isAuthenticated ? <>
    <p>Signed in as {user?.username}</p>
    <button onClick={() => openAccountDialog()}>Choose account</button>
    <button onClick={() => void signOut()}>Sign out</button>
    <button onClick={() => {
      void requestOAuthConsent({ redirectUri: `${location.origin}/`, scopes: ['user:read'] })
        .then((result) => setObservation(`Consent: ${result.status}`))
        .catch(() => setObservation('Consent: failed'));
    }}>Grant user read</button>
    <button onClick={() => {
      void oxyServices.apps.getPublic(clientId).then((app) => oxyServices.apps.connected.revoke(app.id))
        .then(() => setObservation('Grant revoked'))
        .catch(() => setObservation('Revoke: failed'));
    }}>Revoke this app grant</button>
    <button onClick={() => {
      oxyServices.cache.clear();
      void oxyServices.users.me()
        .then((profile) => setObservation(`API subject: ${profile.id} (${profile.username})`))
        .catch(() => setObservation('API subject: denied'));
    }}>Read API subject</button>
    <p>{observation}</p>
  </> : <><p>Signed out</p><OxySignInButton
    {...(firstPartyFixture ? {} : { oauthRedirectUri: `${location.origin}/` })} /></>;
}
const clientId = import.meta.env.VITE_OXY_CLIENT_ID;
// Public fixture configuration only controls the optional OAuth callback prop;
// the SDK still resolves and validates the registered application's lane.
const firstPartyFixture = ['webFirst', 'webSecond'].includes(import.meta.env.VITE_FIXTURE_LANE);
if (!clientId) throw new Error('Registered fixture clientId required');
createRoot(document.getElementById('root')!).render(<BloomProvider>
  <OxyProvider baseURL="http://127.0.0.1:17960" clientId={clientId}
    authWebUrl="http://127.0.0.1:17961" authorizeBaseUrl="http://127.0.0.1:17961/authorize">
    <App />
  </OxyProvider>
</BloomProvider>);
