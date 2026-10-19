import { useMemo, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { Columns3, List, Plus, Search, SquareTerminal, X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { STATUSES, STATUS_LABEL, type AgentSession, type Issue, type IssueStatus } from '../../shared/types.ts';
import { updateIssueNow } from '../actions.ts';
import { openClaudeIn } from '../integrations.ts';
import { useStore, useWorkspaceRepos } from '../store.ts';
import { ago } from '../util.ts';
import { openContextMenu } from './ContextMenu.tsx';
import { AccountAvatar, OrbitMark, PriorityIcon, StatusIcon } from './icons.tsx';
import { issueMenu } from './menus.tsx';
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
  const hasIssues = issues.some((i) => i.workspaceId === workspaceId);
  const nothingShown = hasIssues && !filtered.some((i) => statuses.includes(i.status));

  return (
    <section className="view">
      <header className="view-head">
        <h1>Issues</h1>
        {filterRepo && (
          <button className="filter-chip" onClick={() => set({ repoFilter: null })} title="Tirar o filtro de repositório">
            <RepoChip repo={filterRepo} />
            <X size={12} />
          </button>
        )}
        <div className="view-tools">
          <label className="search">
            <Search size={14} />
            <input placeholder="Filtrar issues" aria-label="Filtrar issues" value={search} onChange={(e) => set({ search: e.target.value })} />
          </label>
          <div className="segmented">
            <button className={layout === 'board' ? 'is-on' : ''} onClick={() => set({ layout: 'board' })} title="Quadro" aria-label="Quadro"><Columns3 size={14} /></button>
            <button className={layout === 'list' ? 'is-on' : ''} onClick={() => set({ layout: 'list' })} title="Lista" aria-label="Lista"><List size={14} /></button>
          </div>
          <button className="ghost-btn" onClick={() => setShowCanceled((v) => !v)}>{showCanceled ? 'Ocultar canceladas' : 'Mostrar canceladas'}</button>
          <button className="primary-btn" onClick={() => set({ modal: { kind: 'new-issue', repoIds: repoFilter ? [repoFilter] : [] } })}>
            <Plus size={14} /> Nova issue <Kbd>C</Kbd>
          </button>
        </div>
      </header>

      {!hasIssues ? (
        <EmptyIssues />
      ) : nothingShown ? (
        <NoMatches
          search={search.trim()}
          filtered={Boolean(search.trim() || repoFilter)}
          canceled={showCanceled ? 0 : filtered.filter((i) => i.status === 'canceled').length}
          onClear={() => set({ search: '', repoFilter: null })}
          onShowCanceled={() => setShowCanceled(true)}
        />
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

/** Enter ou Espaço abrem a issue focada (cards e linhas também funcionam pelo teclado). */
function openOnKey(e: KeyboardEvent<HTMLElement>, open: () => void): void {
  if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
  e.preventDefault();
  open();
}

/** Botão direito (ou Shift+F10) num card ou numa linha: as ações da issue. */
function issueContextMenu(e: MouseEvent<HTMLElement>, issue: Issue): void {
  openContextMenu(e, () => issueMenu(issue), { label: `Ações de ${issue.identifier}` });
}

function Column({ status, issues, ...ctx }: { status: IssueStatus; issues: Issue[] } & Ctx) {
  const [over, setOver] = useState(false);
  const set = useStore((s) => s.set);

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    // Atualização otimista: o servidor confirma via SSE (e, se recusar, o card volta para a coluna de antes).
    updateIssueNow(e.dataTransfer.getData('text/issue'), { status });
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
        <button className="icon-btn" onClick={() => set({ modal: { kind: 'new-issue', status } })} title="Nova issue nesta coluna" aria-label={`Nova issue em ${STATUS_LABEL[status]}`}><Plus size={14} /></button>
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
  const open = () => set({ openIssueId: issue.id });

  return (
    <div
      // O id acompanha a issue: mudando de coluna pelo menu do botão direito, o foco vai junto para o card novo.
      id={`issue-${issue.id}`}
      className={`card${live ? ' is-live' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={`${issue.identifier}: ${issue.title}`}
      draggable
      onDragStart={(e) => e.dataTransfer.setData('text/issue', issue.id)}
      onClick={open}
      onKeyDown={(e) => openOnKey(e, open)}
      onContextMenu={(e) => issueContextMenu(e, issue)}
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
    </div>
  );
}

function Row({ issue, repos, accounts, latestSession }: { issue: Issue } & Ctx) {
  const set = useStore((s) => s.set);
  const delegate = accounts.find((a) => a.id === issue.delegateAccountId);
  const open = () => set({ openIssueId: issue.id });
  return (
    <div
      id={`issue-${issue.id}`}
      className="row"
      role="button"
      tabIndex={0}
      aria-label={`${issue.identifier}: ${issue.title}`}
      onClick={open}
      onKeyDown={(e) => openOnKey(e, open)}
      onContextMenu={(e) => issueContextMenu(e, issue)}
    >
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

/**
 * Há issues, mas a busca, o filtro de repositório ou o "ocultar canceladas" esconderam todas.
 * `canceled`: quantas correspondem ao filtro, mas estão ocultas por serem canceladas.
 */
function NoMatches({ search, filtered, canceled, onClear, onShowCanceled }: {
  search: string;
  filtered: boolean;
  canceled: number;
  onClear: () => void;
  onShowCanceled: () => void;
}) {
  const one = canceled === 1;
  return (
    <div className="empty">
      <Search size={28} className="dim" />
      {filtered && canceled > 0 ? (
        <>
          <h2>
            {search
              ? one ? `A única issue que corresponde a “${search}” está cancelada` : `As ${canceled} issues que correspondem a “${search}” estão canceladas`
              : one ? 'A única issue deste repositório está cancelada' : `As ${canceled} issues deste repositório estão canceladas`}
          </h2>
          <p>As canceladas ficam ocultas no quadro.</p>
          <div className="empty-actions">
            <button className="primary-btn" onClick={onShowCanceled}>Mostrar canceladas</button>
            <button className="ghost-btn" onClick={onClear}>Limpar filtros</button>
          </div>
        </>
      ) : filtered ? (
        <>
          <h2>{search ? `Nenhuma issue corresponde a “${search}”` : 'Nenhuma issue neste repositório'}</h2>
          <p>A busca procura no título e no identificador (ex.: OCT-12). Limpe os filtros para ver todas as issues deste workspace.</p>
          <button className="primary-btn" onClick={onClear}>Limpar filtros</button>
        </>
      ) : (
        <>
          <h2>Todas as issues deste workspace estão canceladas</h2>
          <p>As canceladas ficam ocultas no quadro.</p>
          <button className="primary-btn" onClick={onShowCanceled}>Mostrar canceladas</button>
        </>
      )}
    </div>
  );
}

function EmptyIssues() {
  const { workspaceId, set } = useStore(useShallow((s) => ({ workspaceId: s.workspaceId, set: s.set })));
  const openRoot = () => {
    if (workspaceId) void openClaudeIn(workspaceId);
  };
  return (
    <div className="empty">
      <OrbitMark size={40} />
      <h2>Nenhuma issue ainda</h2>
      <p>
        Crie uma issue, marque os repositórios envolvidos e delegue para uma conta do Claude.
        Ele roda na pasta que agrupa esses repos, com o contexto de todos de uma vez.
      </p>
      <div className="empty-actions">
        <button className="primary-btn" onClick={() => set({ modal: { kind: 'new-issue' } })}><Plus size={14} /> Criar primeira issue</button>
        <button className="ghost-btn" onClick={openRoot} title="Abre um terminal na raiz do workspace já rodando o Claude, sem criar issue">
          <SquareTerminal size={14} /> Abrir Claude na raiz
        </button>
      </div>
    </div>
  );
}
