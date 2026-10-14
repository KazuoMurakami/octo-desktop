import { useMemo } from 'react';
import { FolderOpen, Inbox, SquareTerminal } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { openClaudeIn } from '../integrations.ts';
import { useStore, useWorkspace, useWorkspaceRepos } from '../store.ts';
import { ago, money } from '../util.ts';
import { Cost, usesSubscription } from './AccountsView.tsx';
import { AccountAvatar, OrbitMark, SessionBadge } from './icons.tsx';
import { folderLabel } from './OpenMenu.tsx';
import { RepoChip } from './ui.tsx';

/** Visão geral do trabalho dos agentes — equivalente às páginas de agente do Linear. */
export function SessionsView() {
  const workspace = useWorkspace();
  const repos = useWorkspaceRepos();
  const { sessions, issues, accounts, accountStatus, set } = useStore(
    useShallow((s) => ({ sessions: s.sessions, issues: s.issues, accounts: s.accounts, accountStatus: s.accountStatus, set: s.set })),
  );

  const list = useMemo(
    () => sessions.filter((s) => s.workspaceId === workspace?.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [sessions, workspace?.id],
  );
  const total = list.reduce((sum, s) => sum + s.costUsd, 0);
  const live = list.filter((s) => s.state === 'active' || s.state === 'pending').length;
  // Com assinatura (Pro/Max), o valor em US$ é só uma estimativa: o uso entra no plano.
  const allSubscription = list.length > 0 && list.every((s) => usesSubscription(accountStatus[s.accountId]));

  const openRoot = () => {
    if (workspace) void openClaudeIn(workspace.id);
  };

  return (
    <section className="view">
      <header className="view-head">
        <h1>Sessões do agente</h1>
        <div className="view-stats">
          <span><OrbitMark size={12} active={live > 0} /> {live} {live === 1 ? 'ativa' : 'ativas'}</span>
          <span>{list.length} no total</span>
          {total > 0 && (
            <span
              title={allSubscription
                ? 'Calculado pelo Claude Code em preço de API. Com assinatura, você não paga por sessão: o uso conta no limite do plano.'
                : 'Calculado pelo Claude Code em preço de API. Só vira cobrança para contas que usam chave de API.'}
            >
              {allSubscription ? `≈ ${money(total)} estimado (pago pela assinatura)` : `${money(total)} em custo estimado`}
            </span>
          )}
        </div>
      </header>

      {!list.length ? (
        <div className="empty">
          <OrbitMark size={40} />
          <h2>Nenhuma sessão ainda</h2>
          <p>Delegue uma issue ou abra o Claude na raiz do workspace. Toda sessão aparece aqui, com a pasta, a conta e os repositórios que tocou.</p>
          <div className="empty-actions">
            <button className="primary-btn" onClick={openRoot}><SquareTerminal size={14} /> Abrir Claude na raiz</button>
            <button className="ghost-btn" onClick={() => set({ view: 'issues' })}><Inbox size={14} /> Ir para Issues</button>
          </div>
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
                // Com issue, abre a issue já nesta sessão (e não na mais recente).
                onClick={() => set(issue ? { openIssueId: issue.id, openSessionId: session.id } : { openSessionId: session.id })}
              >
                <AccountAvatar account={account} size={22} />
                <div className="session-main">
                  <div className="session-title">
                    {issue && <span className="ident">{issue.identifier}</span>}
                    <span>{issue?.title ?? session.title}</span>
                  </div>
                  <div className="session-sub">
                    <span className="mono with-icon"><FolderOpen size={12} /> {workspace ? folderLabel(workspace, session.cwd) : session.cwd}</span>
                    <span>{session.mode === 'terminal' ? 'terminal' : 'segundo plano'}</span>
                    {touched.slice(0, 4).map((r) => <RepoChip key={r.id} repo={r} lit />)}
                  </div>
                </div>
                <SessionBadge state={session.state} />
                <span className="session-cost"><Cost usd={session.costUsd} subscription={usesSubscription(accountStatus[session.accountId])} /></span>
                <span className="dim session-date">{ago(session.updatedAt)}</span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
