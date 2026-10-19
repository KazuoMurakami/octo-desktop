import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { AlertTriangle, Check, LogIn, Menu as MenuIcon, RefreshCw, Search, X } from 'lucide-react';
import { blockedActions } from '../shared/permissions.ts';
import type { AccountStatus, AgentSession, ClaudeAccount } from '../shared/types.ts';
import { api, authenticate, connect } from './api.ts';
import { AccountsView } from './components/AccountsView.tsx';
import { ClaudeConfigView } from './components/ClaudeConfigView.tsx';
import { CommandPalette, ShortcutsHelp } from './components/CommandPalette.tsx';
import octoLogo from './assets/octo-logo.png';
import octoMark from './assets/octo-mark.png';
import { Drawer } from './components/IssuePanel.tsx';
import { IssuesView } from './components/IssuesView.tsx';
import { Modals, WorkspaceConnect } from './components/modals.tsx';
import { ReposView } from './components/ReposView.tsx';
import { SessionsView } from './components/SessionsView.tsx';
import { Sidebar } from './components/Sidebar.tsx';
import { CrashScreen, ErrorBoundary, Kbd, Toasts, escapeTopLayer, hasLayer, useEscapeLayer } from './components/ui.tsx';
import { toast, useStore, useWorkspace, type Toast } from './store.ts';
import { isTyping, leaveTextField, modKey } from './util.ts';

export function App() {
  const loaded = useStore((s) => s.loaded);
  const connected = useStore((s) => s.connected);
  const hasWorkspace = useStore((s) => s.workspaces.length > 0);
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

  useGlobalKeys();
  useSessionAlerts();
  useWindowTitle();
  useMenuCommands();

  let content;
  if (unauthorized) {
    content = (
      <div className="splash">
        <img className="brand-mark" src={octoMark} alt="" />
        <span>Acesso não autorizado.</span>
        <span className="dim">Abra o Octo pelo app desktop, ou pelo link com token mostrado no terminal ao rodar <code>npm start</code>.</span>
      </div>
    );
  } else if (!loaded) {
    content = (
      <div className="splash">
        <img className="brand-mark is-loading" src={octoMark} alt="" />
        <span>{connected ? 'Carregando…' : 'Conectando ao servidor do Octo…'}</span>
      </div>
    );
  } else if (!hasWorkspace) {
    content = (
      <div className="onboarding">
        <div className="onboarding-card">
          <img className="onboarding-logo" src={octoLogo} alt="Octo" />
          <h1>Uma pasta, todos os repositórios, um Claude.</h1>
          <p>
            Conecte a pasta onde ficam seus projetos. O Octo encontra os repositórios git dentro dela, organiza o trabalho
            em issues e delega cada uma para uma conta do Claude, que roda na pasta certa com o contexto de todos os repos
            envolvidos.
          </p>
          <DataNotice boxed />
          <ClaudeMissing />
          <SetupChecklist />
          <WorkspaceConnect />
        </div>
        <Modals />
      </div>
    );
  } else {
    content = <Workbench />;
  }

  return (
    <>
      {content}
      <Toasts />
    </>
  );
}

/** O app com um workspace: navegação, a tela escolhida, o painel da issue e o que abre por cima. */
function Workbench() {
  const connected = useStore((s) => s.connected);
  const view = useStore((s) => s.view);
  const navWanted = useStore((s) => s.navOpen);
  const drawerKey = useStore((s) => s.openIssueId ?? s.openSessionId);
  const narrow = useMediaQuery('(max-width: 900px)');
  const navOpen = navWanted && narrow;
  const drawerOpen = drawerKey !== null;
  const toggleRef = useRef<HTMLButtonElement>(null);

  useNavigationDrawer(navOpen, narrow, toggleRef);

  return (
    <div className={`app${navOpen ? ' is-nav-open' : ''}`}>
      <Sidebar inert={drawerOpen} drawer={navOpen} />
      <main className="main" inert={drawerOpen || navOpen}>
        <MobileBar toggleRef={toggleRef} />
        {!connected && <div className="offline">Sem conexão com o servidor. Tentando reconectar…</div>}
        {connected && <ClaudeHealth />}
        {connected && <DataNotice />}
        {connected && <LoginBanner />}
        {view === 'issues' && <IssuesView />}
        {view === 'sessions' && <SessionsView />}
        {view === 'repos' && <ReposView />}
        {view === 'accounts' && <AccountsView />}
        {view === 'claude' && <ClaudeConfigView />}
      </main>
      {navOpen && <div className="nav-backdrop" onMouseDown={() => useStore.getState().set({ navOpen: false })} />}
      <ErrorBoundary resetKey={drawerKey} fallback={(error) => <DrawerCrash error={error} />}>
        <Drawer />
      </ErrorBoundary>
      <Modals />
      <CommandPalette />
      <ShortcutsHelp />
    </div>
  );
}

// ---------------------------------------------------------------- teclado

/**
 * Atalhos globais. O Esc vai por camadas, uma de cada vez: paleta › menu › modal › gaveta de
 * navegação › painel da issue. Num campo com texto, o primeiro Esc só tira o foco do campo.
 */
function useGlobalKeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const s = useStore.getState();
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        // A paleta só existe com um workspace: carregando ou no onboarding, a tecla segue com o comportamento normal.
        if (!s.loaded || !s.workspaces.length) return;
        // Sobre um modal ou menu, a paleta não abre: um comando dela trocaria o modal e o texto digitado se perderia.
        if (!s.paletteOpen && hasLayer('modal', 'menu')) return;
        e.preventDefault();
        s.set({ paletteOpen: !s.paletteOpen });
        return;
      }
      if (e.key === 'Escape') {
        if (escapeTopLayer(e)) return;
        if (leaveTextField(e.target)) return;
        if (s.openIssueId || s.openSessionId) {
          e.preventDefault();
          // Tira o foco antes: um campo do painel dispara o onBlur (e salva) enquanto ainda está na tela.
          if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
          s.set({ openIssueId: null, openSessionId: null });
        }
        return;
      }
      if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey || hasLayer() || !s.workspaces.length) return;
      if (e.key === '?') {
        e.preventDefault();
        s.set({ shortcutsOpen: true });
      } else if (e.key === 'c' && s.workspaceId) {
        e.preventDefault();
        s.set({ modal: { kind: 'new-issue' } });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

// ---------------------------------------------------------------- janela estreita

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, [query]);
  return matches;
}

/** A gaveta de navegação fecha ao escolher um destino (ou ao abrir algo por cima) e devolve o foco ao botão. */
function useNavigationDrawer(open: boolean, narrow: boolean, toggleRef: RefObject<HTMLButtonElement | null>): void {
  const view = useStore((s) => s.view);
  const repoFilter = useStore((s) => s.repoFilter);
  const workspaceId = useStore((s) => s.workspaceId);
  const covered = useStore((s) => Boolean(s.openIssueId || s.openSessionId || s.modal || s.paletteOpen || s.shortcutsOpen));
  const wasOpen = useRef(false);

  useEffect(() => {
    if (useStore.getState().navOpen) useStore.getState().set({ navOpen: false });
  }, [view, repoFilter, workspaceId, covered, narrow]);

  useEffect(() => {
    if (wasOpen.current && !open) {
      const active = document.activeElement;
      if (!active || active === document.body || active.closest('.sidebar')) toggleRef.current?.focus();
    }
    wasOpen.current = open;
  }, [open, toggleRef]);

  useEscapeLayer(open, () => useStore.getState().set({ navOpen: false }), 'nav');
}

/** Barra do topo das janelas estreitas (abaixo de 900px): abre a navegação e a busca. */
function MobileBar({ toggleRef }: { toggleRef: RefObject<HTMLButtonElement | null> }) {
  const workspace = useWorkspace();
  const navOpen = useStore((s) => s.navOpen);
  const waiting = useStore((s) => s.sessions.filter((x) => x.workspaceId === s.workspaceId && x.state === 'awaiting_input').length);
  const set = useStore((s) => s.set);
  return (
    <div className="mobile-bar">
      <button
        ref={toggleRef}
        type="button"
        className="icon-btn nav-toggle"
        aria-label={waiting ? `Abrir navegação (${waiting} aguardando você)` : 'Abrir navegação'}
        title="Navegação"
        aria-controls="octo-sidebar"
        aria-expanded={navOpen}
        onClick={() => set({ navOpen: true })}
      >
        <MenuIcon size={17} />
        {waiting > 0 && <em className="nav-badge">{waiting}</em>}
      </button>
      <span className="ws-mark is-small">{workspace?.key.slice(0, 2) ?? 'OC'}</span>
      <span className="mobile-title">{workspace?.name ?? 'Octo'}</span>
      <button type="button" className="side-search mobile-search" onClick={() => set({ paletteOpen: true })}>
        <Search size={14} />
        <span>Buscar</span>
        <Kbd>{modKey()} K</Kbd>
      </button>
    </div>
  );
}

function DrawerCrash({ error }: { error: Error }) {
  const close = () => useStore.getState().set({ openIssueId: null, openSessionId: null });
  return (
    <div className="drawer-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="drawer is-crash">
        <CrashScreen error={error} compact onClose={close} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- avisos de sessão

/**
 * Avisa quando um agente em segundo plano termina, pede permissão ou para com erro: um aviso
 * na tela e, com a janela em segundo plano, uma notificação do sistema (se permitida).
 */
function useSessionAlerts(): void {
  useEffect(
    () =>
      useStore.subscribe((state, prev) => {
        if (!prev.loaded || state.sessions === prev.sessions) return;
        const before = new Map(prev.sessions.map((x) => [x.id, x]));
        for (const session of state.sessions) {
          if (session.mode !== 'headless') continue;
          const old = before.get(session.id);
          if (!old) offerNotifications();
          else if ((old.state === 'active' || old.state === 'pending') && old.state !== session.state) alertSession(session);
        }
      }),
    [],
  );
}

function alertSession(session: AgentSession): void {
  const s = useStore.getState();
  const issue = s.issues.find((i) => i.id === session.issueId);
  const name = issue?.identifier ?? session.title;
  let title: string;
  let body: string;
  let tone: Toast['tone'];
  if (session.state === 'awaiting_input') {
    // Ações, e não regras: um comando encadeado bloqueado vira uma regra por parte (ver blockedActions).
    const actions = blockedActions(session.pendingDenials);
    const one = actions.length === 1 ? actions[0] : null;
    const what = one ? (one.rules.length === 1 ? one.rules[0] : (one.value ?? one.rules.join(', '))) : '';
    title = `${name} aguarda você`;
    body = one
      ? `Precisa de permissão para ${what.length > 140 ? `${what.slice(0, 139)}…` : what}.`
      : actions.length
        ? `Precisa de permissão para ${actions.length} ações.`
        : 'Precisa de você para continuar.';
    tone = 'info';
  } else if (session.state === 'complete') {
    title = `${name}: o agente terminou`;
    body = issue?.title ?? 'Veja a resposta na sessão.';
    tone = 'success';
  } else if (session.state === 'error') {
    title = `${name} parou com erro`;
    body = session.lastError?.split('\n')[0]?.slice(0, 160) || 'Veja o erro na sessão.';
    tone = 'error';
  } else {
    return; // interrompida por você: nada a avisar
  }

  // Com a issue, o painel abre nela já mostrando esta sessão. Os avisos vêm de todos os workspaces, e o
  // painel usa as pastas, os repositórios e os padrões do workspace aberto: antes, abre o da sessão.
  const open = () => {
    const current = useStore.getState();
    if (session.workspaceId !== current.workspaceId) {
      if (!current.workspaces.some((w) => w.id === session.workspaceId)) return; // removido, e a sessão com ele
      // Um formulário aberto usa o workspace atual: trocar levaria o que foi digitado para o outro. Vale também
      // para os modais de uma tela, fora de s.modal (o editor de skills some ao mudar a conta padrão).
      if (current.modal || hasLayer('modal')) {
        toast('Feche a janela aberta para ver a sessão.');
        return;
      }
      current.selectWorkspace(session.workspaceId); // fecha o painel e limpa os filtros
    }
    useStore.getState().set({ openIssueId: issue?.id ?? null, openSessionId: session.id });
  };
  const focused = document.hasFocus();
  // Quem já está olhando a sessão não precisa de aviso.
  if (focused && (s.openSessionId === session.id || (issue && s.openIssueId === issue.id))) return;
  toast(session.state === 'awaiting_input' ? `${title}: ${body.charAt(0).toLowerCase()}${body.slice(1)}` : `${title}.`, tone, { label: 'Ver', run: open });
  if (!focused && 'Notification' in window && Notification.permission === 'granted') {
    try {
      const note = new Notification(title, { body, tag: session.id });
      note.onclick = () => {
        window.focus();
        open();
        note.close();
      };
    } catch {
      /* notificações indisponíveis neste ambiente */
    }
  }
}

/** Depois da primeira delegação, oferece (uma vez só) ativar as notificações do sistema. */
function offerNotifications(): void {
  if (!('Notification' in window) || Notification.permission !== 'default') return;
  try {
    if (localStorage.getItem('octo:notify-asked')) return;
    localStorage.setItem('octo:notify-asked', '1');
  } catch {
    return; // sem onde lembrar a resposta, melhor não perguntar a cada delegação
  }
  toast('Quer uma notificação do sistema quando um agente terminar ou precisar de você, mesmo com o Octo em segundo plano?', 'info', {
    label: 'Ativar',
    run: () => void Notification.requestPermission().then((result) => result === 'granted' && toast('Notificações ativadas.', 'success')),
  });
}

/** "(2) Octo" no título da janela (e na barra de tarefas) enquanto há sessões aguardando você. */
function useWindowTitle(): void {
  const waiting = useStore((s) => s.sessions.filter((x) => x.state === 'awaiting_input').length);
  useEffect(() => {
    document.title = waiting ? `(${waiting}) Octo` : 'Octo';
  }, [waiting]);
}

/**
 * Comandos do menu do app desktop (Octo › Preferências…). O processo principal dispara o evento
 * `octo:menu`, e o preventDefault avisa que a interface cuidou do pedido.
 */
function useMenuCommands(): void {
  useEffect(() => {
    const onMenu = (event: Event) => {
      const s = useStore.getState();
      if ((event as CustomEvent<string>).detail !== 'preferences' || !s.loaded) return;
      event.preventDefault();
      // Trocar um formulário aberto pelas preferências faria perder o que foi digitado nele.
      if (s.modal && s.modal.kind !== 'preferences') {
        toast('Feche a janela aberta para ver as preferências.');
        return;
      }
      s.set({ modal: { kind: 'preferences' }, paletteOpen: false });
    };
    window.addEventListener('octo:menu', onMenu);
    return () => window.removeEventListener('octo:menu', onMenu);
  }, []);
}

/** Aviso dispensado nesta abertura do app (não volta ao trocar de tela). */
let dismissedNotice: string | null = null;

/** O db.json estava danificado ao abrir: conta o que foi recuperado e onde ficou o arquivo danificado. */
function DataNotice({ boxed = false }: { boxed?: boolean }) {
  const notice = useStore((s) => s.meta?.dbNotice);
  const [, setDismissed] = useState<string | null>(null);
  if (!notice || notice === dismissedNotice) return null;
  const dismiss = () => {
    dismissedNotice = notice;
    setDismissed(notice);
  };
  return (
    <div className={boxed ? 'claude-missing' : 'offline is-warning'} role="alert">
      {boxed && <strong>Dados do Octo recuperados</strong>}
      <span>{notice}</span>{' '}
      <button type="button" className="link-btn" onClick={dismiss}>Entendi</button>
    </div>
  );
}

// ---------------------------------------------------------------- Claude Code e login

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
            O Octo usa o Claude Code instalado neste computador. Instale-o{meta.platform === 'win32' ? ' pelo PowerShell' : ' pelo terminal'}, faça login com{' '}
            <code>claude</code> e clique em verificar:
          </span>
          <code className="claude-missing-cmd">{install}</code>
          {meta.platform === 'win32' && (
            <span className="dim">Ele precisa estar instalado no próprio Windows: uma instalação só dentro do WSL não é encontrada.</span>
          )}
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

/** Conta padrão do workspace (ou a primeira, antes de haver workspace) e o login dela. */
function useDefaultAccount(): { account: ClaudeAccount | undefined; status: AccountStatus | undefined } {
  const account = useStore((s) => {
    const id = s.workspaces.find((w) => w.id === s.workspaceId)?.defaultAccountId ?? s.accounts[0]?.id;
    return s.accounts.find((a) => a.id === id);
  });
  const status = useStore((s) => (account ? s.accountStatus[account.id] : undefined));
  return { account, status };
}

/**
 * "Fazer login" abre um terminal com `claude auth login`. Ao voltar para o Octo depois disso,
 * a conta é verificada sozinha; "Verificar" confere na hora.
 */
function LoginActions({ account }: { account: ClaudeAccount }) {
  const [started, setStarted] = useState(false);
  const [checking, setChecking] = useState(false);

  const verify = useCallback(async (quiet: boolean) => {
    setChecking(true);
    try {
      const status = await api.refreshAccount(account.id, quiet);
      if (!quiet && !status.loggedIn) toast('A conta ainda não está conectada. Conclua o login no terminal e verifique de novo.');
    } catch {
      /* o erro já virou aviso em api.ts */
    } finally {
      setChecking(false);
    }
  }, [account.id]);

  useEffect(() => {
    if (!started) return;
    let last = 0;
    const onFocus = () => {
      if (Date.now() - last < 5000) return;
      last = Date.now();
      void verify(true);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [started, verify]);

  const login = () =>
    api.login(account.id).then(() => {
      setStarted(true);
      toast('Conclua o login no terminal que abriu. Quando voltar para o Octo, a conta é verificada sozinha.');
    });

  return (
    <span className="login-actions">
      <button type="button" className="primary-btn is-small" onClick={login}><LogIn size={13} /> Fazer login</button>
      <button type="button" className="ghost-btn is-small" onClick={() => void verify(false)} disabled={checking}>
        <RefreshCw size={13} className={checking ? 'spin' : ''} /> {started ? 'Já fiz login' : 'Verificar'}
      </button>
    </span>
  );
}

/** Primeiros passos no onboarding: Claude Code instalado e conta com login. */
function SetupChecklist() {
  const meta = useStore((s) => s.meta);
  const { account, status } = useDefaultAccount();
  if (!meta?.claudeBin || !account) return null; // sem o Claude Code, o ClaudeMissing já explica
  return (
    <ul className="setup-steps">
      <li className="is-done">
        <Check size={14} />
        <span>Claude Code {meta.claudeVersion ?? ''} instalado</span>
      </li>
      {status?.loggedIn ? (
        <li className="is-done">
          <Check size={14} />
          <span>Conta <strong>{account.name}</strong> conectada{status.email ? ` como ${status.email}` : ''}</span>
        </li>
      ) : !status ? (
        <li>
          <RefreshCw size={14} className="spin" />
          <span>Verificando o login da conta {account.name}…</span>
        </li>
      ) : status.error ? (
        <li className="is-warn">
          <AlertTriangle size={14} />
          <span>Não deu para verificar o login da conta {account.name}. <span className="dim">{status.error}</span></span>
          <LoginActions account={account} />
        </li>
      ) : (
        <li className="is-todo">
          <LogIn size={14} />
          <span>
            <strong>Falta fazer login.</strong> A conta {account.name} ainda não entrou no Claude Code. O login abre um terminal
            com <code>claude auth login</code>; depois é só voltar para cá.
          </span>
          <LoginActions account={account} />
        </li>
      )}
    </ul>
  );
}

/** Depois de conectar a pasta: a conta padrão ainda sem login (delegar em segundo plano falharia). */
function LoginBanner() {
  const { account, status } = useDefaultAccount();
  const claudeBin = useStore((s) => s.meta?.claudeBin);
  const [dismissed, setDismissed] = useState<string | null>(null);
  // Só com a certeza de "sem login": um erro na verificação (tempo esgotado etc.) não bloqueia nada.
  if (!claudeBin || !account || !status || status.loggedIn || status.error || dismissed === account.id) return null;
  return (
    <div className="login-bar" role="status">
      <LogIn size={14} />
      <span>
        A conta <strong>{account.name}</strong> ainda não fez login no Claude Code. Sem isso, delegar em segundo plano não funciona.
      </span>
      <LoginActions account={account} />
      <button type="button" className="icon-btn" aria-label="Dispensar aviso" title="Dispensar" onClick={() => setDismissed(account.id)}>
        <X size={13} />
      </button>
    </div>
  );
}
