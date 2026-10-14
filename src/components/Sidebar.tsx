import { useEffect, useMemo, useState } from 'react';
import { Bot, ChevronDown, ChevronRight, FolderGit2, FolderPlus, Inbox, KeyRound, Search, Settings2, SlidersHorizontal, Sparkles, SquareTerminal, X } from 'lucide-react';
import type { UpdateInfo } from '../../shared/types.ts';
import { useShallow } from 'zustand/react/shallow';
import { api } from '../api.ts';
import { defaultAccountId, useStore, useWorkspace, useWorkspaceRepos, type View } from '../store.ts';
import { hue, repoGroups, shortRepoName } from '../util.ts';
import { AccountAvatar, OrbitMark } from './icons.tsx';
import { Kbd, Menu } from './ui.tsx';

const NAV: { view: View; label: string; icon: typeof Inbox }[] = [
  { view: 'issues', label: 'Issues', icon: Inbox },
  { view: 'sessions', label: 'Sessões do agente', icon: Bot },
  { view: 'repos', label: 'Repositórios', icon: FolderGit2 },
  { view: 'accounts', label: 'Contas Claude', icon: KeyRound },
  { view: 'claude', label: 'Configuração do Claude', icon: SlidersHorizontal },
];

export function Sidebar() {
  const workspace = useWorkspace();
  const repos = useWorkspaceRepos();
  const { workspaces, accounts, accountStatus, issues, sessions, view, repoFilter, set, selectWorkspace } = useStore(
    useShallow((s) => ({
      workspaces: s.workspaces, accounts: s.accounts, accountStatus: s.accountStatus, issues: s.issues, sessions: s.sessions,
      view: s.view, repoFilter: s.repoFilter, set: s.set, selectWorkspace: s.selectWorkspace,
    })),
  );
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const groups = useMemo(() => (workspace ? repoGroups(workspace, repos) : []), [workspace, repos]);
  const loose = repos.filter((r) => !groups.some((g) => g.repos.includes(r)));
  const openCount = (repoId: string) =>
    issues.filter((i) => i.repoIds.includes(repoId) && i.status !== 'done' && i.status !== 'canceled').length;
  const running = sessions.filter((s) => s.workspaceId === workspace?.id && (s.state === 'active' || s.state === 'pending')).length;
  const waiting = sessions.filter((s) => s.workspaceId === workspace?.id && s.state === 'awaiting_input').length;
  const account = accounts.find((a) => a.id === defaultAccountId());

  const filterBy = (repoId: string) => set({ view: 'issues', repoFilter: repoFilter === repoId ? null : repoId });

  const repoRow = (repo: (typeof repos)[number], nested: boolean) => (
    <button
      key={repo.id}
      className={`side-repo${repoFilter === repo.id ? ' is-active' : ''}${nested ? ' is-nested' : ''}`}
      onClick={() => filterBy(repo.id)}
      title={repo.absPath}
    >
      <i style={{ background: hue(repo.name) }} />
      <span>{shortRepoName(repo)}</span>
      {openCount(repo.id) > 0 && <em>{openCount(repo.id)}</em>}
    </button>
  );

  return (
    <aside className="sidebar">
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
        items={[
          ...workspaces.map((w) => ({
            key: w.id,
            label: w.name,
            hint: w.key,
            icon: <span className="ws-mark is-small">{w.key.slice(0, 2)}</span>,
            selected: w.id === workspace?.id,
            onSelect: () => selectWorkspace(w.id),
          })),
          { key: 'new', label: 'Conectar outra pasta…', icon: <FolderPlus size={14} />, onSelect: () => set({ modal: { kind: 'workspace' } }) },
        ]}
      />

      <button className="side-search" onClick={() => set({ paletteOpen: true })}>
        <Search size={14} />
        <span>Buscar ou executar…</span>
        <Kbd>Ctrl K</Kbd>
      </button>

      <nav className="side-nav">
        {NAV.map(({ view: v, label, icon: Icon }) => (
          <button key={v} className={`side-link${view === v ? ' is-active' : ''}`} onClick={() => set({ view: v, ...(v !== 'issues' && { repoFilter: null }) })}>
            <Icon size={15} />
            <span>{label}</span>
            {v === 'sessions' && running > 0 && <em className="is-live"><OrbitMark size={11} active />{running}</em>}
            {v === 'sessions' && waiting > 0 && <em className="is-waiting">{waiting}</em>}
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
                  <button className="side-group-head" onClick={() => setCollapsed((c) => ({ ...c, [group.rel]: !isCollapsed }))}>
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
            onClick={() => api.openTerminal(workspace.id, { accountId: defaultAccountId() })}
          >
            <SquareTerminal size={15} />
            <span>
              <strong>Abrir Claude na raiz</strong>
              <small>{workspace.rootPath.split(/[\\/]/).at(-1)} · {repos.length} repos</small>
            </span>
          </button>
          <button className="launch-prefs" title="Preferências: terminal e editor" onClick={() => set({ modal: { kind: 'preferences' } })}>
            <Settings2 size={16} />
          </button>
          <Menu
            className="launch-account"
            align="end"
            width={260}
            trigger={<AccountAvatar account={account} status={account ? accountStatus[account.id] : undefined} size={22} />}
            items={accounts.map((a) => ({
              key: a.id,
              label: a.name,
              hint: accountStatus[a.id]?.email ?? 'sem login',
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
      <button className="icon-btn" title="Dispensar este aviso" onClick={dismiss}><X size={13} /></button>
    </div>
  );
}
