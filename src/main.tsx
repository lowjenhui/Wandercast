import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

// The app was renamed from TripValue; drop its old browser caches (the server keeps the data).
try {
  Object.keys(localStorage)
    .filter((k) => k.startsWith('tripvalue.'))
    .forEach((k) => localStorage.removeItem(k));
} catch {
  /* storage unavailable */
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
