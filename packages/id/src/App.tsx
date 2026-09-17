import { ContinueScreen } from './screens/ContinueScreen';
import { HomeScreen } from './screens/HomeScreen';
import { PrfCheckScreen } from './screens/PrfCheckScreen';

/** A handful of routes; a router library would be more code on the page that unseals roots. The host is internal (ADR 0024 D1): nothing here names it. */
export function App() {
  const { pathname, search } = window.location;
  const params = new URLSearchParams(search);

  let screen;
  if (pathname === '/continue') {
    const code = params.get('code');
    screen = code ? (
      <ContinueScreen code={code} />
    ) : (
      <section className="card">
        <h1>Can’t open this here</h1>
        <p>Open this page from the app that asked you to sign in.</p>
      </section>
    );
  } else if (pathname === '/move') {
    screen = <HomeScreen intent="move" />;
  } else if (pathname === '/prf-check') {
    screen = <PrfCheckScreen />;
  } else {
    screen = <HomeScreen />;
  }

  return (
    <main className="shell">
      <header className="brand">
        <img src="/favicon.svg" alt="" width={28} height={28} />
        <span>Oxy</span>
      </header>
      {screen}
    </main>
  );
}
