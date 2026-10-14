import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/hanken-grotesk';
import '@fontsource-variable/jetbrains-mono';
import { App } from './App.tsx';
import { ErrorBoundary } from './components/ui.tsx';
import './styles.css';
import './styles-features.css';

// Um erro de renderização mostra a tela "Algo deu errado" (com Recarregar) em vez de uma janela vazia.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
