import { useEffect } from 'react';
import { api, authenticate, connect } from './api.ts';
import { AccountsView } from './components/AccountsView.tsx';
import { ClaudeConfigView } from './components/ClaudeConfigView.tsx';
import { CommandPalette } from './components/CommandPalette.tsx';
import octoLogo from './assets/octo-logo.png';
import octoMark from './assets/octo-mark.png';
import { Drawer } from './components/IssuePanel.tsx';
import { IssuesView } from './components/IssuesView.tsx';
import { Modals, WorkspaceConnect } from './components/modals.tsx';
import { ReposView } from './components/ReposView.tsx';
import { SessionsView } from './components/SessionsView.tsx';
import { Sidebar } from './components/Sidebar.tsx';
import { Toasts } from './components/ui.tsx';
import { useStore } from './store.ts';
import { isTyping } from './util.ts';

export function App() {
  const loaded = useStore((s) => s.loaded);
  const connected = useStore((s) => s.connected);
  const hasWorkspace = useStore((s) => s.workspaces.length > 0);
  const view = useStore((s) => s.view);

  const unauthorized = useStore((s) => s.unauthorized);

  useEffect(() => {
    let close: (() => void) | undefined;
    let cancelled = false;
    void authenticate().finally(() => {
      if (!cancelled) close = connect();
    });
    return () => {
      cancelled = true;
      close?.();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        s.set({ paletteOpen: !s.paletteOpen });
        return;
      }
      if (e.key === 'Escape') {
        if (s.paletteOpen) s.set({ paletteOpen: false });
        else if (!s.modal && (s.openIssueId || s.openSessionId)) s.set({ openIssueId: null, openSessionId: null });
        return;
      }
      if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey || s.modal || s.paletteOpen) return;
      if (e.key === 'c' && s.workspaceId) {
        e.preventDefault();
        s.set({ modal: { kind: 'new-issue' } });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (unauthorized) {
    return (
      <div className="splash">
        <img className="brand-mark" src={octoMark} alt="" />
        <span>Acesso não autorizado.</span>
        <span className="dim">Abra o Octo pelo app desktop, ou pelo link com token mostrado no terminal ao rodar <code>npm start</code>.</span>
      </div>
    );
  }

  if (!loaded) {
    return (
      <div className="splash">
        <img className="brand-mark is-loading" src={octoMark} alt="" />
        <span>{connected ? 'Carregando…' : 'Conectando ao servidor do Octo…'}</span>
      </div>
    );
  }

  if (!hasWorkspace) {
    return (
      <div className="onboarding">
        <div className="onboarding-card">
          <img className="onboarding-logo" src={octoLogo} alt="Octo" />
          <h1>Uma pasta, todos os repositórios, um Claude.</h1>
          <p>
            Conecte a pasta onde ficam seus projetos. O Octo encontra os repositórios git dentro dela, organiza o trabalho
            em issues e delega cada uma para uma conta do Claude, que roda na pasta certa com o contexto de todos os repos
            envolvidos.
          </p>
          <ClaudeMissing />
          <WorkspaceConnect />
        </div>
        <Modals />
        <Toasts />
      </div>
    );
  }

  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        {!connected && <div className="offline">Sem conexão com o servidor. Tentando reconectar…</div>}
        {connected && <ClaudeHealth />}
        {view === 'issues' && <IssuesView />}
        {view === 'sessions' && <SessionsView />}
        {view === 'repos' && <ReposView />}
        {view === 'accounts' && <AccountsView />}
        {view === 'claude' && <ClaudeConfigView />}
      </main>
      <Drawer />
      <Modals />
      <CommandPalette />
      <Toasts />
    </div>
  );
}

/** Pede o estado de novo ao servidor (que procura o Claude Code outra vez se algo mudou). */
function recheck(): void {
  void api.state().then((state) => useStore.getState().hydrate(state));
}

/**
 * O Octo depende do Claude Code instalado na máquina. Se ele não existe, ou se uma atualização
 * automática deixou o executável quebrado, explica o que aconteceu e como resolver.
 */
function ClaudeMissing({ compact = false }: { compact?: boolean }) {
  const meta = useStore((s) => s.meta);
  if (!meta || meta.claudeBin) return null;
  const notFound = !meta.claudeProblem || meta.claudeProblem.startsWith('Claude Code não encontrado');
  const install = meta.platform === 'win32' ? 'irm https://claude.ai/install.ps1 | iex' : 'curl -fsSL https://claude.ai/install.sh | bash';
  return (
    <div className={`claude-missing${compact ? ' is-compact' : ''}`}>
      <strong>{notFound ? 'Claude Code não encontrado' : 'O Claude Code não está funcionando'}</strong>
      {notFound ? (
        <>
          <span>
            O Octo usa o Claude Code instalado neste computador. Instale-o{meta.platform === 'win32' ? ' pelo PowerShell' : ''}, faça login com{' '}
            <code>claude</code> e clique em verificar:
          </span>
          <code className="claude-missing-cmd">{install}</code>
        </>
      ) : (
        <>
          <span>{meta.claudeProblem}</span>
          <code className="claude-missing-cmd">npm install -g @anthropic-ai/claude-code</code>
        </>
      )}
      <span className="claude-missing-actions">
        <button className="ghost-btn is-small" onClick={recheck}>Verificar de novo</button>
        <a href="https://docs.claude.com/en/docs/claude-code/setup" target="_blank" rel="noreferrer">Outras formas de instalar</a>
      </span>
    </div>
  );
}

/** Aviso no topo do app: o Claude Code sumiu ou quebrou, ou o `claude` do terminal está quebrado. */
function ClaudeHealth() {
  const meta = useStore((s) => s.meta);
  if (!meta) return null;
  if (!meta.claudeBin) return <div className="health-bar"><ClaudeMissing compact /></div>;
  if (!meta.claudeWarning) return null;
  return (
    <div className="offline is-warning">
      {meta.claudeWarning} <button className="link-btn" onClick={recheck}>Verificar de novo</button>
    </div>
  );
}
