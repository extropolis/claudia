import ReactDOM from 'react-dom/client';
import App from './App';
import { NotificationProvider } from './components/NotificationContainer';
import { setupAudioUnlock } from './utils/browserCapabilities';
import { installAuthFetch, bootstrapAuth } from './config/auth-client';
import './styles/index.css';

// Set up AudioContext unlock on first user interaction (required for iOS/Android)
setupAudioUnlock();

// Every /api route and every WebSocket upgrade requires a token now, so the
// credential has to exist before the app makes its first request. installAuthFetch
// wraps window.fetch once so all ~100 existing call sites stay untouched;
// bootstrapAuth then fills in the token — from ?token= (Electron, the mobile QR
// link), from sessionStorage, or from the backend's loopback bootstrap, which
// is what makes "run start.sh, open a browser" keep working with no copy-paste.
//
// Awaited before render: mounting first would fire the initial /api/tasks and
// the WebSocket connect with no credential and show an empty, broken UI while
// the bootstrap was still in flight. A failure is not fatal — the app renders
// and surfaces the token prompt.
installAuthFetch();

void bootstrapAuth()
    .then((ok) => {
        if (!ok) {
            console.warn('[Auth] No API token yet — the app will prompt for one. ' +
                'On this machine, `./start.sh` prints a URL that carries the token.');
        }
    })
    .finally(() => {
        ReactDOM.createRoot(document.getElementById('root')!).render(
            <NotificationProvider>
                <App />
            </NotificationProvider>
        );
    });
