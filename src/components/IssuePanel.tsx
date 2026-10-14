import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Bot, ChevronDown, FolderOpen, SquareTerminal, Trash2, X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { PRIORITY_LABEL, STATUSES, STATUS_LABEL, type Issue, type Priority } from '../../shared/types.ts';
import { api } from '../api.ts';
import { useStore, useWorkspace, useWorkspaceRepos } from '../store.ts';
import { ago, commonFolder, hue, relativeTo } from '../util.ts';
import { AgentSessionView } from './AgentSession.tsx';
import { OpenMenu } from './OpenMenu.tsx';
import { AccountAvatar, OrbitMark, PriorityIcon, SessionBadge, StatusIcon } from './icons.tsx';
import { AutoTextarea, Markdown, Menu, RepoChip } from './ui.tsx';

/** Painel lateral: issue aberta ou uma sessão avulsa (sem issue). */
export function Drawer() {
  const { openIssueId, openSessionId, set } = useStore(
    useShallow((s) => ({ openIssueId: s.openIssueId, openSessionId: s.openSessionId, set: s.set })),
  );
  const issue = useStore((s) => s.issues.find((i) => i.id === openIssueId));
  const session = useStore((s) => s.sessions.find((x) => x.id === openSessionId));
  if (!issue && !session) return null;
  const close = () => set({ openIssueId: null, openSessionId: null });

  return (
    <div className="drawer-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="drawer">
        {issue ? (
          <IssueDetail issue={issue} onClose={close} />
        ) : (
          session && (
            <>
              <header className="drawer-head">
                <span className="crumb"><Bot size={14} /> {session.title}</span>
                <button className="icon-btn" onClick={close}><X size={16} /></button>
              </header>
              <div className="drawer-session"><AgentSessionView key={session.id} session={session} /></div>
            </>
          )
        )}
      </div>
    </div>
  );
}

function IssueDetail({ issue, onClose }: { issue: Issue; onClose: () => void }) {
  const workspace = useWorkspace();
  const repos = useWorkspaceRepos();
  const { accounts, accountStatus, set } = useStore(useShallow((s) => ({ accounts: s.accounts, accountStatus: s.accountStatus, set: s.set })));
  const allSessions = useStore((s) => s.sessions);
  const sessions = useMemo(
    () => allSessions.filter((s) => s.issueId === issue.id).sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
    [allSessions, issue.id],
  );
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [title, setTitle] = useState(issue.title);
  const [description, setDescription] = useState(issue.description);
  const [editing, setEditing] = useState(!issue.description);

  useEffect(() => {
    setTitle(issue.title);
    setDescription(issue.description);
  }, [issue.id]);

  // Quando uma sessão nova começa, ela passa a ser a exibida.
  useEffect(() => setSessionId(sessions[0]?.id ?? null), [sessions[0]?.id]);

  const session = sessions.find((s) => s.id === sessionId) ?? sessions[0];
  const delegate = accounts.find((a) => a.id === issue.delegateAccountId);
  const issueRepos = repos.filter((r) => issue.repoIds.includes(r.id));
  const cwd = workspace ? commonFolder(workspace, issueRepos) : '';
  const update = (body: Partial<Issue>) => api.updateIssue(issue.id, body);

  const saveText = () => {
    if (title.trim() && title !== issue.title) void update({ title });
    if (description !== issue.description) void update({ description });
  };

  return (
    <>
      <header className="drawer-head">
        <span className="crumb">{workspace?.name} <span className="dim">›</span> <span className="ident">{issue.identifier}</span></span>
        <div className="drawer-head-actions">
          <button
            className="icon-btn is-danger"
            title="Excluir issue"
            onClick={() => {
              if (confirm(`Excluir ${issue.identifier}?`)) {
                void api.deleteIssue(issue.id);
                onClose();
              }
            }}
          >
            <Trash2 size={15} />
          </button>
          <button className="icon-btn" onClick={onClose} title="Fechar (Esc)"><X size={16} /></button>
        </div>
      </header>

      <div className="drawer-body">
        <div className="drawer-main">
          <input
            className="title-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={saveText}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
          {editing ? (
            <AutoTextarea
              className="desc-input"
              autoFocus={!issue.description}
              placeholder="Descreva o que precisa ser feito. Markdown funciona. Este texto vira o prompt do Claude."
              value={description}
              minRows={4}
              onChange={(e) => setDescription(e.target.value)}
              onBlur={() => {
                saveText();
                if (description.trim()) setEditing(false);
              }}
            />
          ) : (
            <div className="desc-view" onClick={() => setEditing(true)} title="Clique para editar">
              <Markdown>{description}</Markdown>
            </div>
          )}

          <section className="agent-section">
            <div className="section-head">
              <h3><OrbitMark size={14} active={session?.state === 'active'} /> Agente</h3>
              {sessions.length > 1 && (
                <Menu
                  trigger={<>{sessions.length} sessões <ChevronDown size={12} /></>}
                  className="ghost-btn"
                  width={300}
                  align="end"
                  items={sessions.map((s, index) => ({
                    key: s.id,
                    label: `Sessão ${sessions.length - index} · ${ago(s.startedAt)}`,
                    hint: <SessionBadge state={s.state} />,
                    selected: s.id === session?.id,
                    onSelect: () => setSessionId(s.id),
                  }))}
                />
              )}
            </div>
            {session ? (
              <AgentSessionView key={session.id} session={session} />
            ) : (
              <div className="agent-empty">
                <p>
                  Delegue esta issue: o Claude roda em{' '}
                  <code>{workspace ? relativeTo(workspace.rootPath, cwd) : '.'}</code>
                  {issueRepos.length > 1 ? ` com o contexto de ${issueRepos.length} repositórios` : ''} e relata o andamento aqui.
                </p>
                <div className="agent-empty-actions">
                  <button className="primary-btn" onClick={() => set({ modal: { kind: 'delegate', issueId: issue.id, mode: 'headless' } })}>
                    <Bot size={14} /> Delegar ao Claude
                  </button>
                  <button className="ghost-btn" onClick={() => set({ modal: { kind: 'delegate', issueId: issue.id, mode: 'terminal' } })}>
                    <SquareTerminal size={14} /> Abrir no terminal
                  </button>
                </div>
              </div>
            )}
          </section>
        </div>

        <aside className="drawer-side">
          <Prop label="Status">
            <Menu
              className="prop-btn"
              trigger={<><StatusIcon status={issue.status} /> {STATUS_LABEL[issue.status]}</>}
              items={STATUSES.map((s) => ({
                key: s, label: STATUS_LABEL[s], icon: <StatusIcon status={s} />, selected: s === issue.status, onSelect: () => update({ status: s }),
              }))}
            />
          </Prop>
          <Prop label="Prioridade">
            <Menu
              className="prop-btn"
              trigger={<><PriorityIcon priority={issue.priority} /> {PRIORITY_LABEL[issue.priority]}</>}
              items={([0, 1, 2, 3, 4] as Priority[]).map((p) => ({
                key: String(p), label: PRIORITY_LABEL[p], icon: <PriorityIcon priority={p} />, selected: p === issue.priority, onSelect: () => update({ priority: p }),
              }))}
            />
          </Prop>
          <Prop label="Delegado">
            <Menu
              className="prop-btn"
              trigger={<><AccountAvatar account={delegate} size={16} /> {delegate?.name ?? 'Ninguém'}</>}
              items={[
                { key: 'none', label: 'Ninguém', icon: <AccountAvatar size={16} />, selected: !delegate, onSelect: () => update({ delegateAccountId: null }) },
                ...accounts.map((a) => ({
                  key: a.id, label: a.name, hint: accountStatus[a.id]?.email ?? '', icon: <AccountAvatar account={a} size={16} />,
                  selected: a.id === delegate?.id, onSelect: () => update({ delegateAccountId: a.id }),
                })),
              ]}
            />
          </Prop>
          <Prop label="Repositórios">
            <Menu
              className="prop-btn is-wrap"
              multi
              filter
              width={300}
              trigger={issueRepos.length ? issueRepos.map((r) => <RepoChip key={r.id} repo={r} />) : <span className="dim">Adicionar…</span>}
              items={repos.map((r) => ({
                key: r.name,
                label: r.name,
                icon: <i className="dot" style={{ background: hue(r.name) }} />,
                selected: issue.repoIds.includes(r.id),
                onSelect: () => {
                  const current = useStore.getState().issues.find((i) => i.id === issue.id)?.repoIds ?? [];
                  void update({ repoIds: current.includes(r.id) ? current.filter((id) => id !== r.id) : [...current, r.id] });
                },
              }))}
            />
          </Prop>
          <Prop label="Pasta do agente">
            {workspace ? (
              <OpenMenu
                className="prop-btn mono"
                align="start"
                target={{ kind: 'folder', workspaceId: workspace.id, dir: cwd, repoIds: issueRepos.length ? issueRepos.map((r) => r.id) : undefined }}
                trigger={<><FolderOpen size={13} /> {relativeTo(workspace.rootPath, cwd)}</>}
              />
            ) : '—'}
          </Prop>

          {session && (
            <div className="side-actions">
              <button className="ghost-btn" onClick={() => set({ modal: { kind: 'delegate', issueId: issue.id, mode: 'headless' } })}><Bot size={13} /> Nova sessão</button>
              <button className="ghost-btn" onClick={() => set({ modal: { kind: 'delegate', issueId: issue.id, mode: 'terminal' } })}><SquareTerminal size={13} /> Terminal</button>
            </div>
          )}

          <div className="history">
            <div className="history-head">Atividade</div>
            {[...issue.history].reverse().slice(0, 30).map((h) => (
              <div key={h.id} className="history-row">
                <span><strong>{h.actor}</strong> {h.text}</span>
                <span className="dim">{ago(h.ts)}</span>
              </div>
            ))}
          </div>
        </aside>
      </div>
    </>
  );
}

function Prop({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="prop">
      <span className="prop-label">{label}</span>
      {children}
    </div>
  );
}
