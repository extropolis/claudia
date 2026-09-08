import { useState } from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { NotificationProvider } from './components/NotificationContainer';
import { AuthTokenGate } from './components/AuthTokenGate';
import { setupAudioUnlock } from './utils/browserCapabilities';
import { installAuthFetch, bootstrapAuth } from './config/auth-client';
import './styles/index.css';

// Set up AudioContext unlock on first user interaction (required for iOS/Android)
setupAudioUnlock();

/**
 * Gate the app on having an API token.
 *
 * Every /api route and every WebSocket upgrade requires one now, so mounting
 * App without a token produces an empty task list and a socket that never
 * opens — with nothing on screen explaining why. The gate says what is missing
 * and takes a pasted token; it is not a second way to *issue* one (the mobile
 * QR/link flow remains that).
 */
function Root({ authenticated }: { authenticated: boolean }) {
    const [ok, setOk] = useState(authenticated);
    if (!ok) return <AuthTokenGate onAuthenticated={() => setOk(true)} />;
    return (
        <NotificationProvider>
            <App />
        </NotificationProvider>
    );
}

// installAuthFetch wraps window.fetch once so the ~100 existing call sites stay
// untouched and the next one somebody writes is covered too. bootstrapAuth then
// fills in the token — from ?token= (Electron, the mobile QR link), from
// sessionStorage, or from the backend's loopback bootstrap, which is what makes
// "run start.sh, open a browser" keep working with no copy-paste.
//
// Awaited before render so the app never fires its first request unauthenticated.
installAuthFetch();

void bootstrapAuth().then((ok) => {
    if (!ok) {
        console.warn('[Auth] No API token for this page — showing the token gate. ' +
            'On this machine, `./start.sh` prints a URL that carries the token.');
    }
    ReactDOM.createRoot(document.getElementById('root')!).render(<Root authenticated={ok} />);
});
