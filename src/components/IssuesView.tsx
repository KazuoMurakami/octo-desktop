import { useMemo, useState, type DragEvent } from 'react';
import { Columns3, List, Plus, Search, X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { STATUSES, STATUS_LABEL, type AgentSession, type Issue, type IssueStatus } from '../../shared/types.ts';
import { api } from '../api.ts';
import { useStore, useWorkspaceRepos } from '../store.ts';
import { ago } from '../util.ts';
import { AccountAvatar, OrbitMark, PriorityIcon, StatusIcon } from './icons.tsx';
import { Kbd, RepoChip } from './ui.tsx';

const BOARD_STATUSES: IssueStatus[] = ['backlog', 'todo', 'in_progress', 'in_review', 'done'];

export function IssuesView() {
  const repos = useWorkspaceRepos();
  const { workspaceId, issues, sessions, accounts, layout, repoFilter, search, set } = useStore(
    useShallow((s) => ({
      workspaceId: s.workspaceId, issues: s.issues, sessions: s.sessions, accounts: s.accounts,
      layout: s.layout, repoFilter: s.repoFilter, search: s.search, set: s.set,
    })),
  );
  const [showCanceled, setShowCanceled] = useState(false);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return issues
      .filter((i) => i.workspaceId === workspaceId)
      .filter((i) => !repoFilter || i.repoIds.includes(repoFilter))
      .filter((i) => !q || i.title.toLowerCase().includes(q) || i.identifier.toLowerCase().includes(q))
      .sort((a, b) => a.sortOrder - b.sortOrder);
  }, [issues, workspaceId, repoFilter, search]);

  // Sessão mais recente de cada issue, para mostrar o agente trabalhando no card.
  const latestSession = useMemo(() => {
    const map = new Map<string, AgentSession>();
    for (const s of sessions) {
      if (!s.issueId) continue;
      const current = map.get(s.issueId);
      if (!current || current.startedAt < s.startedAt) map.set(s.issueId, s);
    }
    return map;
  }, [sessions]);

  const filterRepo = repos.find((r) => r.id === repoFilter);
  const statuses = showCanceled ? [...BOARD_STATUSES, 'canceled' as const] : BOARD_STATUSES;
  const ctx = { repos, accounts, latestSession };

  return (
    <section className="view">
      <header className="view-head">
        <h1>Issues</h1>
        {filterRepo && (
          <button className="filter-chip" onClick={() => set({ repoFilter: null })}>
            <RepoChip repo={filterRepo} />
            <X size={12} />
          </button>
        )}
        <div className="view-tools">
          <label className="search">
            <Search size={14} />
            <input placeholder="Filtrar issues" value={search} onChange={(e) => set({ search: e.target.value })} />
          </label>
          <div className="segmented">
            <button className={layout === 'board' ? 'is-on' : ''} onClick={() => set({ layout: 'board' })} title="Quadro"><Columns3 size={14} /></button>
            <button className={layout === 'list' ? 'is-on' : ''} onClick={() => set({ layout: 'list' })} title="Lista"><List size={14} /></button>
          </div>
          <button className="ghost-btn" onClick={() => setShowCanceled((v) => !v)}>{showCanceled ? 'Ocultar canceladas' : 'Mostrar canceladas'}</button>
          <button className="primary-btn" onClick={() => set({ modal: { kind: 'new-issue', repoIds: repoFilter ? [repoFilter] : [] } })}>
            <Plus size={14} /> Nova issue <Kbd>C</Kbd>
          </button>
        </div>
      </header>

      {filtered.length === 0 && issues.every((i) => i.workspaceId !== workspaceId) ? (
        <EmptyIssues />
      ) : layout === 'board' ? (
        <div className="board">
          {statuses.map((status) => (
            <Column key={status} status={status} issues={filtered.filter((i) => i.status === status)} {...ctx} />
          ))}
        </div>
      ) : (
        <div className="list">
          {STATUSES.filter((s) => statuses.includes(s)).map((status) => {
            const group = filtered.filter((i) => i.status === status);
            if (!group.length) return null;
            return (
              <div key={status} className="list-group">
                <div className="list-group-head"><StatusIcon status={status} /> {STATUS_LABEL[status]} <span className="dim">{group.length}</span></div>
                {group.map((issue) => <Row key={issue.id} issue={issue} {...ctx} />)}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

type Ctx = {
  repos: ReturnType<typeof useWorkspaceRepos>;
  accounts: ReturnType<typeof useStore.getState>['accounts'];
  latestSession: Map<string, AgentSession>;
};

function Column({ status, issues, ...ctx }: { status: IssueStatus; issues: Issue[] } & Ctx) {
  const [over, setOver] = useState(false);
  const set = useStore((s) => s.set);

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const id = e.dataTransfer.getData('text/issue');
    const issue = useStore.getState().issues.find((i) => i.id === id);
    if (!issue || issue.status === status) return;
    // Atualização otimista: o servidor confirma via SSE.
    useStore.getState().apply({ type: 'issue', issue: { ...issue, status } });
    void api.updateIssue(id, { status });
  };

  return (
    <div
      className={`column${over ? ' is-over' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      <div className="column-head">
        <StatusIcon status={status} />
        <span>{STATUS_LABEL[status]}</span>
        <span className="dim">{issues.length}</span>
        <button className="icon-btn" onClick={() => set({ modal: { kind: 'new-issue', status } })} title="Nova issue nesta coluna"><Plus size={14} /></button>
      </div>
      <div className="column-body">
        {issues.map((issue) => <Card key={issue.id} issue={issue} {...ctx} />)}
      </div>
    </div>
  );
}

function AgentState({ session }: { session?: AgentSession }) {
  if (!session) return null;
  if (session.state === 'active' || session.state === 'pending') return <span className="card-agent is-live"><OrbitMark size={12} active /> trabalhando</span>;
  if (session.state === 'awaiting_input') return <span className="card-agent is-waiting">aguarda você</span>;
  if (session.state === 'error') return <span className="card-agent is-error">erro</span>;
  if (session.state === 'terminal') return <span className="card-agent">no terminal</span>;
  return null;
}

function Card({ issue, repos, accounts, latestSession }: { issue: Issue } & Ctx) {
  const set = useStore((s) => s.set);
  const session = latestSession.get(issue.id);
  const delegate = accounts.find((a) => a.id === issue.delegateAccountId);
  const issueRepos = repos.filter((r) => issue.repoIds.includes(r.id));
  const live = session?.state === 'active' || session?.state === 'pending';

  return (
    <article
      className={`card${live ? ' is-live' : ''}`}
      draggable
      onDragStart={(e) => e.dataTransfer.setData('text/issue', issue.id)}
      onClick={() => set({ openIssueId: issue.id })}
    >
      <div className="card-top">
        <span className="ident">{issue.identifier}</span>
        <AgentState session={session} />
        <AccountAvatar account={delegate} size={18} />
      </div>
      <div className="card-title">{issue.title}</div>
      <div className="card-meta">
        <PriorityIcon priority={issue.priority} />
        {issueRepos.slice(0, 2).map((repo) => <RepoChip key={repo.id} repo={repo} lit={session?.touchedRepoIds.includes(repo.id)} />)}
        {issueRepos.length > 2 && <span className="dim">+{issueRepos.length - 2}</span>}
      </div>
    </article>
  );
}

function Row({ issue, repos, accounts, latestSession }: { issue: Issue } & Ctx) {
  const set = useStore((s) => s.set);
  const delegate = accounts.find((a) => a.id === issue.delegateAccountId);
  return (
    <div className="row" onClick={() => set({ openIssueId: issue.id })}>
      <PriorityIcon priority={issue.priority} />
      <span className="ident">{issue.identifier}</span>
      <StatusIcon status={issue.status} />
      <span className="row-title">{issue.title}</span>
      <AgentState session={latestSession.get(issue.id)} />
      <span className="row-repos">
        {repos.filter((r) => issue.repoIds.includes(r.id)).slice(0, 3).map((repo) => <RepoChip key={repo.id} repo={repo} />)}
      </span>
      <AccountAvatar account={delegate} size={18} />
      <span className="row-date">{ago(issue.updatedAt)}</span>
    </div>
  );
}

function EmptyIssues() {
  const set = useStore((s) => s.set);
  return (
    <div className="empty">
      <OrbitMark size={40} />
      <h2>Nenhuma issue ainda</h2>
      <p>
        Crie uma issue, marque os repositórios envolvidos e delegue para uma conta do Claude.
        Ele roda na pasta que agrupa esses repos, com o contexto de todos de uma vez.
      </p>
      <button className="primary-btn" onClick={() => set({ modal: { kind: 'new-issue' } })}><Plus size={14} /> Criar primeira issue</button>
    </div>
  );
}
