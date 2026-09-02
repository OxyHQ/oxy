import ReactDOM from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import { BloomThemeProvider } from '@oxyhq/bloom/theme';
import { getRouter } from './router';
import './styles.css';

const router = getRouter();

// NOTE: Do NOT wrap the app in <React.StrictMode>. On web, react-native-web's
// Modal (used by Bloom's BottomSheet / bottom-placement Dialog, i.e. the
// account/sign-in sheet on narrow viewports) mounts its ModalPortal host during
// render and removes it in an effect cleanup; StrictMode's dev double-invoke
// never re-attaches it, so bottom sheets never paint. accounts (Expo) and auth
// render without StrictMode for the same reason.
ReactDOM.createRoot(document.getElementById('root')!).render(
  <BloomThemeProvider mode="system" colorPreset="oxy">
    <RouterProvider router={router} />
  </BloomThemeProvider>,
);
