import { createRoot } from 'react-dom/client';
import { BloomProvider } from '@oxy.so/bloom/provider';
import { OxyProvider, OxySignInButton, useAuth } from '@oxy.so/services';
function App() {
  const { user, isAuthenticated, isLoading, signOut } = useAuth();
  if (isLoading) return <p>Loading</p>;
  return isAuthenticated ? (
    <>
      <p>Signed in as {user?.username}</p>
      <button onClick={() => void signOut()}>Sign out</button>
    </>
  ) : (
    <>
      <p>Signed out</p>
      <OxySignInButton oauthRedirectUri={`${location.origin}/`} />
    </>
  );
}
createRoot(document.getElementById('root')!).render(
  <BloomProvider>
    <OxyProvider baseURL="http://127.0.0.1:17855" clientId="oxy_dk_fixture_not_registered">
      <App />
    </OxyProvider>
  </BloomProvider>,
);
