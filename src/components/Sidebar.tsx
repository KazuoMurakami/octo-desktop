import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import {
  Bot, ChevronDown, ChevronRight, FolderGit2, FolderPlus, Inbox, KeyRound, Search, Settings2, SlidersHorizontal, Sparkles, SquareTerminal, Unplug, X,
} from 'lucide-react';
import type { UpdateInfo, Workspace } from '../../shared/types.ts';
import { useShallow } from 'zustand/react/shallow';
import { api } from '../api.ts';
import { openClaudeIn } from '../integrations.ts';
import { defaultAccountId, useStore, useWorkspace, useWorkspaceRepos, type View } from '../store.ts';
import { hue, modKey, repoGroups, shortRepoName } from '../util.ts';
import { loginHint } from './AccountsView.tsx';
import { openContextMenu, type CloseReason } from './ContextMenu.tsx';
import { AccountAvatar, OrbitMark } from './icons.tsx';
import { groupMenu, repoMenu, workspaceMenu } from './menus.tsx';
import { Kbd, Menu } from './ui.tsx';

const NAV: { view: View; label: string; icon: typeof Inbox }[] = [
  { view: 'issues', label: 'Issues', icon: Inbox },
  { view: 'sessions', label: 'Sessões do agente', icon: Bot },
  { view: 'repos', label: 'Repositórios', icon: FolderGit2 },
  { view: 'accounts', label: 'Contas Claude', icon: KeyRound },
  { view: 'claude', label: 'Configuração do Claude', icon: SlidersHorizontal },
];

/**
 * Navegação lateral. Em janelas estreitas ela vira uma gaveta (`drawer` = gaveta aberta),
 * aberta pelo botão da barra do topo.
 */
export function Sidebar({ inert = false, drawer = false }: { inert?: boolean; drawer?: boolean }) {
  const workspace = useWorkspace();
  const repos = useWorkspaceRepos();
  const { workspaces, accounts, accountStatus, issues, sessions, view, repoFilter, set, selectWorkspace } = useStore(
    useShallow((s) => ({
      workspaces: s.workspaces, accounts: s.accounts, accountStatus: s.accountStatus, issues: s.issues, sessions: s.sessions,
      view: s.view, repoFilter: s.repoFilter, set: s.set, selectWorkspace: s.selectWorkspace,
    })),
  );
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [launching, setLaunching] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  // A gaveta abriu: o foco entra nela.
  useEffect(() => {
    if (drawer) closeRef.current?.focus();
  }, [drawer]);

  const groups = useMemo(() => (workspace ? repoGroups(workspace, repos) : []), [workspace, repos]);
  const loose = repos.filter((r) => !groups.some((g) => g.repos.includes(r)));
  const openCount = (repoId: string) =>
    issues.filter((i) => i.repoIds.includes(repoId) && i.status !== 'done' && i.status !== 'canceled').length;
  const running = sessions.filter((s) => s.workspaceId === workspace?.id && (s.state === 'active' || s.state === 'pending')).length;
  const waiting = sessions.filter((s) => s.workspaceId === workspace?.id && s.state === 'awaiting_input').length;
  const account = accounts.find((a) => a.id === defaultAccountId());

  const filterBy = (repoId: string) => set({ view: 'issues', repoFilter: repoFilter === repoId ? null : repoId });

  const launch = () => {
    if (!workspace || launching) return;
    setLaunching(true);
    void openClaudeIn(workspace.id).finally(() => setTimeout(() => setLaunching(false), 2000));
  };

  /**
   * As ações de uma pasta. Aberto num item da lista do seletor, ele fecha junto quando uma ação é escolhida e no Tab,
   * como o próprio seletor: o foco volta para o botão dele, e o Tab segue dali (Esc fecha só o menu de cima).
   */
  const workspaceMenuOptions = (w: Workspace, anchor?: HTMLElement, closeSwitcher?: () => void) => ({
    label: `Ações da pasta ${w.name}`,
    anchor,
    // Desconectada por outra janela com o menu aberto, ele fecha: o botão do seletor continua na tela, já com outra pasta.
    alive: () => useStore.getState().workspaces.some((x) => x.id === w.id),
    onClose: (reason: CloseReason) => {
      if (reason === 'select' || reason === 'tab') closeSwitcher?.();
    },
  });

  const repoRow = (repo: (typeof repos)[number], nested: boolean) => (
    <button
      key={repo.id}
      className={`side-repo${repoFilter === repo.id ? ' is-active' : ''}${nested ? ' is-nested' : ''}`}
      onClick={() => filterBy(repo.id)}
      onContextMenu={(e) => openContextMenu(e, () => repoMenu(repo), { label: `Ações de ${shortRepoName(repo)}` })}
      title={repo.absPath}
      aria-pressed={repoFilter === repo.id}
    >
      <i style={{ background: hue(repo.name) }} />
      <span>{shortRepoName(repo)}</span>
      {openCount(repo.id) > 0 && <em>{openCount(repo.id)}</em>}
    </button>
  );

  return (
    <aside id="octo-sidebar" className="sidebar" inert={inert} aria-label="Navegação">
      <div className="side-top">
        <Menu
          className="ws-switcher"
          width={280}
          trigger={
            <>
              <span className="ws-mark">{workspace?.key.slice(0, 2) ?? 'OC'}</span>
              <span className="ws-name">{workspace?.name ?? 'Octo'}</span>
              <ChevronDown size={14} className="dim" />
            </>
          }
          onContextMenu={(e) => workspace && openContextMenu(e, () => workspaceMenu(workspace), workspaceMenuOptions(workspace))}
          items={[
            ...workspaces.map((w) => ({
              key: w.id,
              label: w.name,
              hint: w.key,
              icon: <span className="ws-mark is-small">{w.key.slice(0, 2)}</span>,
              selected: w.id === workspace?.id,
              onSelect: () => selectWorkspace(w.id),
              onContextMenu: (e: MouseEvent<HTMLElement>, anchor: HTMLElement, closeSwitcher: () => void) =>
                openContextMenu(e, () => workspaceMenu(w), workspaceMenuOptions(w, anchor, closeSwitcher)),
            })),
            { key: 'new', label: 'Conectar outra pasta…', icon: <FolderPlus size={14} />, onSelect: () => set({ modal: { kind: 'workspace' } }) },
            ...(workspace
              ? [{
                  key: 'disconnect',
                  label: 'Desconectar esta pasta…',
                  icon: <Unplug size={14} />,
                  danger: true,
                  onSelect: () => set({ modal: { kind: 'disconnect', workspaceId: workspace.id } }),
                }]
              : []),
          ]}
        />
        <button ref={closeRef} type="button" className="icon-btn side-close" aria-label="Fechar navegação" title="Fechar (Esc)" onClick={() => set({ navOpen: false })}>
          <X size={16} />
        </button>
      </div>

      <button className="side-search" onClick={() => set({ paletteOpen: true })}>
        <Search size={14} />
        <span>Buscar ou executar…</span>
        <Kbd>{modKey()} K</Kbd>
      </button>

      <nav className="side-nav">
        {NAV.map(({ view: v, label, icon: Icon }) => (
          <button
            key={v}
            className={`side-link${view === v ? ' is-active' : ''}`}
            aria-current={view === v ? 'page' : undefined}
            onClick={() => set({ view: v, ...(v !== 'issues' && { repoFilter: null }) })}
          >
            <Icon size={15} />
            <span>{label}</span>
            {v === 'sessions' && running > 0 && <em className="is-live" title={`${running} trabalhando`}><OrbitMark size={11} active />{running}</em>}
            {v === 'sessions' && waiting > 0 && <em className="is-waiting" title={`${waiting} aguardando você`}>{waiting}</em>}
          </button>
        ))}
      </nav>

      {workspace && (
        <div className="side-section">
          <div className="side-heading">
            <span>Pastas e repositórios</span>
            <span className="dim">{repos.length}</span>
          </div>
          <div className="side-tree">
            {groups.map((group) => {
              const isCollapsed = collapsed[group.rel] ?? group.repos.length > 4;
              return (
                <div key={group.rel} className="side-group">
                  <button
                    className="side-group-head"
                    aria-expanded={!isCollapsed}
                    onClick={() => setCollapsed((c) => ({ ...c, [group.rel]: !isCollapsed }))}
                    onContextMenu={(e) => openContextMenu(e, () => groupMenu(workspace.id, group), { label: `Ações da pasta ${group.rel}` })}
                  >
                    {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                    <span>{group.rel}</span>
                    <em className="dim">{group.repos.length}</em>
                  </button>
                  {!isCollapsed && group.repos.map((repo) => repoRow(repo, true))}
                </div>
              );
            })}
            {loose.map((repo) => repoRow(repo, false))}
          </div>
        </div>
      )}

      <UpdateBanner />

      {workspace && (
        <div className="side-foot">
          <button
            className="launch"
            title="Abre um terminal na raiz do workspace já rodando o Claude com o mapa de todos os repositórios"
            onClick={launch}
            disabled={launching}
            aria-busy={launching}
          >
            <SquareTerminal size={15} />
            <span>
              <strong>{launching ? 'Abrindo terminal…' : 'Abrir Claude na raiz'}</strong>
              <small>{workspace.rootPath.split(/[\\/]/).at(-1)} · {repos.length} repos</small>
            </span>
          </button>
          <button className="launch-prefs" title="Preferências: terminal e editor" aria-label="Preferências" onClick={() => set({ modal: { kind: 'preferences' } })}>
            <Settings2 size={16} />
          </button>
          <Menu
            className="launch-account"
            align="end"
            width={260}
            label={`Conta padrão do workspace: ${account?.name ?? 'nenhuma'}`}
            trigger={<AccountAvatar account={account} status={account ? accountStatus[account.id] : undefined} size={22} />}
            items={accounts.map((a) => ({
              key: a.id,
              label: a.name,
              hint: loginHint(accountStatus[a.id]),
              icon: <AccountAvatar account={a} size={16} />,
              selected: a.id === account?.id,
              onSelect: () => api.updateWorkspace(workspace.id, { defaultAccountId: a.id }),
            }))}
          />
        </div>
      )}
    </aside>
  );
}

/** "Octo X disponível": aparece quando há uma release mais nova no GitHub (pode ser desligado em Preferências). */
function UpdateBanner() {
  const enabled = useStore((s) => s.preferences.checkUpdates);
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem('octo:update-dismissed');
    } catch {
      return null;
    }
  });

  useEffect(() => {
    if (!enabled) return setInfo(null);
    let alive = true;
    const load = () => api.update().then((next) => alive && setInfo(next)).catch(() => undefined);
    void load();
    const timer = setInterval(load, 6 * 3600_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [enabled]);

  if (!info?.available || dismissed === info.latest) return null;
  const dismiss = () => {
    try {
      localStorage.setItem('octo:update-dismissed', info.latest);
    } catch {
      /* armazenamento indisponível: some só até recarregar */
    }
    setDismissed(info.latest);
  };
  return (
    <div className="update-banner">
      <Sparkles size={14} />
      <span>
        <strong>Octo {info.latest}</strong> disponível
        <small>você tem a {info.current}</small>
      </span>
      <a className="primary-btn is-small" href={info.url} target="_blank" rel="noreferrer">Baixar</a>
      <button className="icon-btn" title="Dispensar este aviso" aria-label="Dispensar este aviso" onClick={dismiss}><X size={13} /></button>
    </div>
  );
}
