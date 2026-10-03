import { createRoot } from 'react-dom/client';
import { BloomProvider } from '@oxy.so/bloom/provider';
import { OxyProvider, OxySignInButton, useAuth, useOxy } from '@oxy.so/services';

function App() {
  const { openAccountDialog } = useOxy();
  const { user, isAuthenticated, isLoading, signOut } = useAuth();
  if (isLoading) return <p>Loading</p>;
  return isAuthenticated ? <>
    <p>Signed in as {user?.username}</p>
    <button onClick={() => openAccountDialog()}>Choose account</button>
    <button onClick={() => void signOut()}>Sign out</button>
  </> : <><p>Signed out</p><OxySignInButton oauthRedirectUri={`${location.origin}/`} /></>;
}
const clientId = import.meta.env.VITE_OXY_CLIENT_ID;
if (!clientId) throw new Error('Registered fixture clientId required');
createRoot(document.getElementById('root')!).render(<BloomProvider>
  <OxyProvider baseURL="http://127.0.0.1:17960" clientId={clientId}
    authWebUrl="http://127.0.0.1:17961" authorizeBaseUrl="http://127.0.0.1:17961/authorize">
    <App />
  </OxyProvider>
</BloomProvider>);
