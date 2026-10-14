import { useMemo } from 'react';
import { FolderOpen } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useStore, useWorkspace, useWorkspaceRepos } from '../store.ts';
import { ago, money, relativeTo } from '../util.ts';
import { AccountAvatar, OrbitMark, SessionBadge } from './icons.tsx';
import { RepoChip } from './ui.tsx';

/** Visão geral do trabalho dos agentes — equivalente às páginas de agente do Linear. */
export function SessionsView() {
  const workspace = useWorkspace();
  const repos = useWorkspaceRepos();
  const { sessions, issues, accounts, set } = useStore(
    useShallow((s) => ({ sessions: s.sessions, issues: s.issues, accounts: s.accounts, set: s.set })),
  );

  const list = useMemo(
    () => sessions.filter((s) => s.workspaceId === workspace?.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [sessions, workspace?.id],
  );
  const total = list.reduce((sum, s) => sum + s.costUsd, 0);
  const live = list.filter((s) => s.state === 'active' || s.state === 'pending').length;

  return (
    <section className="view">
      <header className="view-head">
        <h1>Sessões do agente</h1>
        <div className="view-stats">
          <span><OrbitMark size={12} active={live > 0} /> {live} ativa(s)</span>
          <span>{list.length} no total</span>
          <span>{money(total)} gastos</span>
        </div>
      </header>

      {!list.length ? (
        <div className="empty">
          <OrbitMark size={40} />
          <h2>Nenhuma sessão ainda</h2>
          <p>Delegue uma issue ou use “Abrir Claude na raiz”. Toda sessão aparece aqui, com a pasta, a conta e os repositórios que tocou.</p>
        </div>
      ) : (
        <div className="sessions">
          {list.map((session) => {
            const issue = issues.find((i) => i.id === session.issueId);
            const account = accounts.find((a) => a.id === session.accountId);
            const touched = repos.filter((r) => session.touchedRepoIds.includes(r.id));
            return (
              <button
                key={session.id}
                className="session-row"
                onClick={() => set(issue ? { openIssueId: issue.id } : { openSessionId: session.id })}
              >
                <AccountAvatar account={account} size={22} />
                <div className="session-main">
                  <div className="session-title">
                    {issue && <span className="ident">{issue.identifier}</span>}
                    <span>{issue?.title ?? session.title}</span>
                  </div>
                  <div className="session-sub">
                    <span className="mono with-icon"><FolderOpen size={12} /> {workspace ? relativeTo(workspace.rootPath, session.cwd) : session.cwd}</span>
                    <span>{session.mode === 'terminal' ? 'terminal' : 'segundo plano'}</span>
                    {touched.slice(0, 4).map((r) => <RepoChip key={r.id} repo={r} lit />)}
                  </div>
                </div>
                <SessionBadge state={session.state} />
                <span className="session-cost">{money(session.costUsd)}</span>
                <span className="dim session-date">{ago(session.updatedAt)}</span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
