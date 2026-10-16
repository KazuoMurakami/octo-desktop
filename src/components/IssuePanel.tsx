import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { AlertTriangle, Bot, ChevronDown, Ellipsis, FolderOpen, FolderX, GitBranch, SquareTerminal, Trash2, X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import {
  PRIORITY_LABEL, STATUSES, STATUS_LABEL, type AgentSession, type Issue, type Priority, type Worktree, type WorktreeStatus,
} from '../../shared/types.ts';
import { api } from '../api.ts';
import { toast, useStore, useWorkspace, useWorkspaceRepos } from '../store.ts';
import { ago, commonFolder, hue, relativeTo } from '../util.ts';
import { homePath, sessionFolderLabel, worktreeBranch, worktreeDir, worktreeName } from '../worktree.ts';
import { loginHint } from './AccountsView.tsx';
import { AgentSessionView } from './AgentSession.tsx';
import { ConfirmDialog } from './modals.tsx';
import { OpenMenu } from './OpenMenu.tsx';
import { AccountAvatar, OrbitMark, PriorityIcon, SessionBadge, StatusIcon } from './icons.tsx';
import { AutoTextarea, Markdown, Menu, RepoChip, trapTab } from './ui.tsx';

/** Painel lateral: issue aberta ou uma sessão avulsa (sem issue). */
export function Drawer() {
  const { openIssueId, openSessionId, set } = useStore(
    useShallow((s) => ({ openIssueId: s.openIssueId, openSessionId: s.openSessionId, set: s.set })),
  );
  const issue = useStore((s) => s.issues.find((i) => i.id === openIssueId));
  const session = useStore((s) => s.sessions.find((x) => x.id === openSessionId));
  if (!issue && !session) return null;
  const close = () => {
    // Tira o foco antes de fechar: o campo em edição dispara o onBlur (e salva) enquanto ainda está na tela.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    set({ openIssueId: null, openSessionId: null });
  };

  return (
    <DrawerShell label={issue ? `${issue.identifier} · ${issue.title}` : (session?.title ?? 'Sessão')} onClose={close}>
      {issue ? (
        // A key remonta o detalhe ao trocar de issue com o painel aberto (Ctrl+K): nada da anterior fica para trás.
        <IssueDetail key={issue.id} issue={issue} initialSessionId={openSessionId} onClose={close} />
      ) : (
        session && (
          <>
            <header className="drawer-head">
              <span className="crumb"><Bot size={14} /> {session.title}</span>
              <button className="icon-btn" onClick={close} title="Fechar (Esc)" aria-label="Fechar"><X size={16} /></button>
            </header>
            <div className="drawer-session"><AgentSessionView key={session.id} session={session} /></div>
          </>
        )
      )}
    </DrawerShell>
  );
}

/**
 * Moldura do painel com semântica de diálogo: recebe o foco ao abrir, prende o Tab dentro dele
 * e devolve o foco a quem o abriu ao fechar. O fundo (navegação e tela) fica inerte em App.tsx.
 */
function DrawerShell({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  // Lido antes do primeiro commit: o autoFocus de dentro do painel já teria mudado o foco.
  const [returnTo] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));

  useEffect(() => {
    const el = ref.current;
    if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
    return () => {
      // Só quando o painel saiu da tela de fato (no StrictMode o efeito também roda de novo sem desmontar)
      // e ninguém pegou o foco depois.
      const active = document.activeElement;
      if (el && !el.isConnected && (!active || active === document.body) && returnTo?.isConnected) returnTo.focus({ preventScroll: true });
    };
  }, [returnTo]);

  return (
    <div className="drawer-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        // Um Tab já usado lá dentro (ex.: escolher uma /skill no composer) não move o foco.
        onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => !e.defaultPrevented && trapTab(e)}
      >
        {children}
      </div>
    </div>
  );
}

/** O agente está trabalhando nesta sessão agora, em segundo plano. */
const isLive = (session: AgentSession) => session.state === 'active' || session.state === 'pending';

/**
 * Um agente roda agora neste worktree: a regra do servidor para não removê-lo. Vale qualquer sessão nele, inclusive
 * uma aberta na pasta do worktree sem a issue.
 */
function runsIn(sessions: AgentSession[], worktree: Worktree): boolean {
  return sessions.some((s) => isLive(s) && s.worktree && relativeTo(s.worktree.root, worktree.root) === '.');
}

function IssueDetail({ issue, initialSessionId, onClose }: { issue: Issue; initialSessionId: string | null; onClose: () => void }) {
  const workspace = useWorkspace();
  const repos = useWorkspaceRepos();
  const { accounts, accountStatus, set } = useStore(useShallow((s) => ({ accounts: s.accounts, accountStatus: s.accountStatus, set: s.set })));
  const allSessions = useStore((s) => s.sessions);
  const sessions = useMemo(
    () => allSessions.filter((s) => s.issueId === issue.id).sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
    [allSessions, issue.id],
  );
  // Aberta por "Sessões do agente": mostra a sessão clicada, e não a mais recente.
  const [sessionId, setSessionId] = useState<string | null>(() =>
    initialSessionId && sessions.some((s) => s.id === initialSessionId) ? initialSessionId : null,
  );
  const [title, setTitle] = useState(issue.title);
  const [description, setDescription] = useState(issue.description);
  const [editing, setEditing] = useState(!issue.description);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [confirmDelete, setConfirmDelete] = useState(false);
  /** O worktree que você pediu para remover (pela data de criação): um novo, criado depois, não reabre o diálogo. */
  const [removingWorktree, setRemovingWorktree] = useState<string | null>(null);
  const home = useStore((s) => s.meta?.home);

  // Quando uma sessão nova começa depois que o painel abriu, ela passa a ser a exibida.
  const newest = sessions[0]?.id ?? null;
  const seenNewest = useRef(newest);
  useEffect(() => {
    if (newest === seenNewest.current) return;
    seenNewest.current = newest;
    setSessionId(newest);
  }, [newest]);

  // Pedido para mostrar uma sessão (lista de sessões, aviso "Ver"), também com o painel já aberto nesta
  // issue. Depois de lido, o pedido sai do store: não deve valer para a próxima issue aberta pelo Ctrl+K.
  useEffect(() => {
    if (!initialSessionId) return;
    if (sessions.some((s) => s.id === initialSessionId)) setSessionId(initialSessionId);
    useStore.getState().set({ openSessionId: null });
  }, [initialSessionId]);

  // ---- título e descrição: salvos durante a digitação (após uma pausa) e, por garantia, ao fechar o painel.
  const draft = useRef({ title: issue.title, description: issue.description });
  const saved = useRef({ title: issue.title, description: issue.description });
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const removed = useRef(false);

  const flush = useCallback(() => {
    clearTimeout(timer.current);
    if (removed.current) return;
    const body: Partial<Issue> = {};
    const nextTitle = draft.current.title.trim();
    if (nextTitle && nextTitle !== saved.current.title) body.title = nextTitle;
    if (draft.current.description !== saved.current.description) body.description = draft.current.description;
    if (body.title === undefined && body.description === undefined) return;
    // A issue pode ter sido excluída (aqui ou em outra janela) com o painel aberto.
    if (!useStore.getState().issues.some((i) => i.id === issue.id)) return;
    const previous = saved.current;
    saved.current = { title: body.title ?? previous.title, description: body.description ?? previous.description };
    setSaveState('saving');
    api.updateIssue(issue.id, body).then(
      () => setSaveState('saved'),
      () => {
        saved.current = previous; // a próxima pausa ou o fechamento tentam de novo
        setSaveState('idle');
      },
    );
  }, [issue.id]);

  const edit = (changes: Partial<typeof draft.current>) => {
    draft.current = { ...draft.current, ...changes };
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, 700);
  };

  // Fechar com Esc ou clicando fora desmonta o campo sem onBlur: grava o que faltar aqui.
  useEffect(() => () => flush(), [flush]);

  useEffect(() => {
    if (saveState !== 'saved') return;
    const hide = setTimeout(() => setSaveState('idle'), 2500);
    return () => clearTimeout(hide);
  }, [saveState]);

  const session = sessions.find((s) => s.id === sessionId) ?? sessions[0];
  const account = accounts.find((a) => a.id === issue.delegateAccountId);
  const workspaceAccount = accounts.find((a) => a.id === workspace?.defaultAccountId) ?? accounts[0];
  const issueRepos = repos.filter((r) => issue.repoIds.includes(r.id));
  // Com worktree, as sessões da issue rodam nele (salvo se você desmarcar ao delegar).
  const worktree = issue.worktree ?? null;
  const cwd = worktree ? worktreeDir(worktree, issue.repoIds) : workspace ? commonFolder(workspace, issueRepos) : '';
  const folder = workspace ? sessionFolderLabel(workspace, cwd, worktree) : '';
  const running = sessions.some(isLive);
  // Só o agente rodando no worktree segura a exclusão (o worktree sai antes da issue, e não sai em uso); um que foi
  // delegado na pasta original é interrompido junto com ela.
  const busyInWorktree = worktree ? runsIn(allSessions, worktree) : false;
  const update = (body: Partial<Issue>) => api.updateIssue(issue.id, body);

  const remove = async () => {
    removed.current = true;
    clearTimeout(timer.current);
    try {
      // O worktree sai junto (as branches ficam). Com alterações sem commit, o servidor recusa e avisa: aí ele sai
      // antes por Mais ações › Remover worktree, que mostra o que se perde.
      if (issue.worktree) await api.removeWorktree(issue.id, false);
      await api.deleteIssue(issue.id);
    } catch (error) {
      removed.current = false;
      throw error;
    }
    onClose();
  };

  return (
    <>
      <header className="drawer-head">
        <span className="crumb">
          {workspace?.name} <span className="dim">›</span> <span className="ident">{issue.identifier}</span>
          {saveState !== 'idle' && <span className="save-state" aria-live="polite">{saveState === 'saving' ? 'Salvando…' : 'Salvo'}</span>}
        </span>
        <div className="drawer-head-actions">
          {/* Longe do X: excluir passa por um menu e por uma confirmação. */}
          <Menu
            className="icon-btn"
            align="end"
            width={220}
            label="Mais ações"
            trigger={<Ellipsis size={16} />}
            items={[
              ...(worktree
                ? [{ key: 'worktree', label: 'Remover worktree…', icon: <FolderX size={14} />, onSelect: () => setRemovingWorktree(worktree.createdAt) }]
                : []),
              { key: 'delete', label: 'Excluir issue…', icon: <Trash2 size={14} />, danger: true, onSelect: () => setConfirmDelete(true) },
            ]}
          />
          <button className="icon-btn" onClick={onClose} title="Fechar (Esc)" aria-label="Fechar"><X size={16} /></button>
        </div>
      </header>

      <div className="drawer-body">
        <div className="drawer-main">
          <input
            className="title-input"
            aria-label="Título da issue"
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              edit({ title: e.target.value });
            }}
            onBlur={flush}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
          {editing ? (
            <AutoTextarea
              className="desc-input"
              autoFocus
              aria-label="Descrição"
              placeholder="Descreva o que precisa ser feito. Markdown funciona. Este texto vira o prompt do Claude."
              value={description}
              minRows={4}
              onFocus={(e) => {
                const end = e.currentTarget.value.length;
                e.currentTarget.setSelectionRange(end, end);
              }}
              onChange={(e) => {
                setDescription(e.target.value);
                edit({ description: e.target.value });
              }}
              onBlur={() => {
                flush();
                if (description.trim()) setEditing(false);
              }}
            />
          ) : (
            <div
              className="desc-view"
              tabIndex={0}
              title="Clique ou aperte Enter para editar"
              onClick={() => setEditing(true)}
              onKeyDown={(e) => {
                if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                  e.preventDefault();
                  setEditing(true);
                }
              }}
            >
              {description.trim() ? <Markdown>{description}</Markdown> : <span className="desc-placeholder">Adicionar descrição…</span>}
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
                  {worktree ? (
                    <>Delegue esta issue: o Claude roda no worktree <code>{folder}</code>, na branch <code>{worktreeBranch(worktree)}</code>,</>
                  ) : (
                    <>Delegue esta issue: o Claude roda em <code>{folder || '—'}</code></>
                  )}
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
          {/* Só escolhe a conta usada ao delegar; não inicia nada sozinho. */}
          <Prop label="Conta" hint="A conta do Claude usada quando você delega esta issue. Trocar aqui não inicia nada: para o Claude começar, use “Delegar ao Claude”.">
            <Menu
              className="prop-btn"
              width={280}
              trigger={<><AccountAvatar account={account} size={16} /> {account?.name ?? <span className="dim">Padrão do workspace</span>}</>}
              items={[
                {
                  key: 'none', label: 'Padrão do workspace', hint: workspaceAccount?.name ?? '', icon: <AccountAvatar size={16} />,
                  selected: !account, onSelect: () => update({ delegateAccountId: null }),
                },
                ...accounts.map((a) => ({
                  key: a.id, label: a.name, hint: loginHint(accountStatus[a.id]), icon: <AccountAvatar account={a} size={16} />,
                  selected: a.id === account?.id, onSelect: () => update({ delegateAccountId: a.id }),
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
                className={`prop-btn mono${worktree ? ' is-worktree' : ''}`}
                align="start"
                target={{ kind: 'folder', workspaceId: workspace.id, dir: cwd, repoIds: issueRepos.length ? issueRepos.map((r) => r.id) : undefined }}
                trigger={worktree ? (
                  <>
                    <GitBranch size={13} />
                    <span className="prop-worktree" title={`Worktree em ${worktree.root}`}>
                      <span>{folder}</span>
                      <span className="dim">{worktreeBranch(worktree)}</span>
                    </span>
                  </>
                ) : <><FolderOpen size={13} /> {folder}</>}
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

      {confirmDelete && (
        <ConfirmDialog
          title={`Excluir ${issue.identifier}?`}
          confirmLabel="Excluir issue"
          busyLabel="Excluindo…"
          // Com o agente rodando no worktree, ele não sai: pare o agente antes.
          disabled={busyInWorktree}
          onConfirm={remove}
          onClose={() => setConfirmDelete(false)}
        >
          <p>
            A issue “{issue.title}” sai do quadro, com a descrição e o histórico.
            {/* Travada, a exclusão não interrompe nada: quem para o agente é você. */}
            {running && !busyInWorktree && <> <strong>O agente que está trabalhando nela será interrompido.</strong></>}
          </p>
          <p>
            {sessions.length > 0 ? 'As sessões do agente continuam em Sessões do agente. ' : ''}
            Nada muda nos arquivos dos repositórios.
          </p>
          {worktree && (busyInWorktree ? (
            <div className="composer-warning">
              <AlertTriangle size={13} />
              <span>O agente está trabalhando no worktree desta issue. Pare-o antes de excluir: o worktree sai junto com a issue.</span>
            </div>
          ) : (
            <p>
              O worktree <span className="mono">{homePath(worktree.root, home)}</span> sai junto; a branch <span className="mono">{worktreeBranch(worktree)}</span>{' '}
              continua nos repositórios. Se ele tiver alterações sem commit (ou arquivos fora dos repositórios), a exclusão para e avisa:
              remova-o antes por Mais ações › Remover worktree, que mostra o que se perde. Feche os terminais e editores abertos nessa pasta.
            </p>
          ))}
        </ConfirmDialog>
      )}

      {worktree && removingWorktree === worktree.createdAt && (
        <RemoveWorktreeDialog issueId={issue.id} worktree={worktree} onClose={() => setRemovingWorktree(null)} />
      )}
    </>
  );
}

/**
 * Remover o worktree da issue. Antes, mostra o que há em cada repositório dele: alterações sem
 * commit (que se perdem) e commits na branch (que ficam nos repositórios).
 */
function RemoveWorktreeDialog({ issueId, worktree, onClose }: { issueId: string; worktree: Worktree; onClose: () => void }) {
  const home = useStore((s) => s.meta?.home);
  // Ao vivo: o agente pode terminar (ou começar) com o diálogo aberto.
  const busyNow = useStore((s) => runsIn(s.sessions, worktree));
  const [status, setStatus] = useState<WorktreeStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);

  // Confere de novo quando um agente começa ou termina no worktree: o que ele deixou sem commit muda a lista.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.worktreeStatus(issueId, true)
      .then((next) => {
        if (!alive) return;
        setStatus(next);
        setError(null);
      })
      .catch((e: Error) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [issueId, attempt, busyNow]);

  // A sessão já terminou, mas o processo do Claude ainda está saindo, e para o servidor ele continua rodando:
  // confere de novo em seguida, em vez de deixar a remoção travada.
  useEffect(() => {
    if (busyNow || !status?.busy) return;
    const timer = setTimeout(() => setAttempt((n) => n + 1), 1500);
    return () => clearTimeout(timer);
  }, [busyNow, status]);

  const busy = busyNow || Boolean(status?.busy);
  const name = worktreeName(worktree);
  const branch = worktreeBranch(worktree);
  // O que se perde: as alterações sem commit e, num repositório que o git não conseguiu conferir, o que houver nele.
  const dirty = status?.repos.filter((repo) => repo.dirty) ?? [];
  const unchecked = status?.repos.filter((repo) => repo.dirty === null) ?? [];
  // Arquivos que o agente deixou fora dos repositórios (um PLANO.md na raiz): o git não os vê, e eles se perdem também.
  const outside = status?.outside ?? [];
  const discards = dirty.length > 0 || unchecked.length > 0 || outside.length > 0;

  const remove = async () => {
    try {
      // O que se perde está listado aqui: confirmar é concordar em perder. Sem a lista (a consulta falhou), vai sem
      // forçar, e o servidor recusa se houver alterações sem commit ou um repositório que ele não conseguiu conferir.
      await api.removeWorktree(issueId, discards);
    } catch (e) {
      setAttempt((n) => n + 1); // algo mudou desde que o diálogo abriu (um arquivo alterado, uma sessão que começou)
      throw e;
    }
    toast(`Worktree ${name} removido. A branch ${branch} continua nos repositórios.`, 'success');
  };

  return (
    <ConfirmDialog
      title={`Remover o worktree ${name}?`}
      confirmLabel={discards ? 'Remover e descartar' : 'Remover worktree'}
      busyLabel="Removendo…"
      disabled={loading || busy}
      onConfirm={remove}
      onClose={onClose}
    >
      <p>
        Apaga a pasta <span className="mono">{homePath(worktree.root, home)}</span> e o worktree de cada repositório. A branch{' '}
        <span className="mono">{branch}</span> e os commits dela continuam nos repositórios.
      </p>
      {status && (
        <ul className="worktree-repos">
          {status.repos.map((repo) => (
            <li key={repo.repoId}>
              <i style={{ background: hue(repo.name) }} />
              <strong>{repo.name}</strong>
              <span className="mono dim with-icon"><GitBranch size={12} /> {repo.branch}</span>
              <span className="worktree-repo-state">
                {!repo.exists ? 'a pasta já não existe' : (
                  <>
                    {repo.dirty === null ? 'não deu para conferir' : repo.dirty ? (
                      <><em className="dirty">{repo.dirty}</em> {repo.dirty === 1 ? 'arquivo' : 'arquivos'} sem commit</>
                    ) : 'limpo'}
                    {repo.ahead !== null && ` · ${repo.ahead ? `${repo.ahead} ${repo.ahead === 1 ? 'commit' : 'commits'} na branch` : 'sem commits novos'}`}
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {/* Uma nova consulta que falhou também aparece: a lista de antes pode estar velha (ex.: ainda dizendo que o agente roda). */}
      {error ? (
        <div className="inline-error">
          Não foi possível conferir o worktree: {error}{' '}
          <button className="link-btn" onClick={() => setAttempt((n) => n + 1)} disabled={loading}>Tentar de novo</button>
        </div>
      ) : !status && <p className="dim">Conferindo os repositórios…</p>}
      {busy ? (
        <div className="composer-warning">
          <AlertTriangle size={13} />
          <span>Uma sessão está rodando neste worktree. Pare-a antes de remover.</span>
        </div>
      ) : (
        <>
          {dirty.length > 0 && <p><strong>As alterações sem commit serão perdidas.</strong> Se quiser guardá-las, faça um commit antes.</p>}
          {unchecked.length > 0 && (
            <p>
              <strong>Não deu para conferir {unchecked.map((repo) => repo.name).join(', ')}:</strong> se houver alterações sem commit ali,
              elas {dirty.length > 0 ? 'também ' : ''}serão perdidas. Confira a pasta antes, se precisar guardar algo.
            </p>
          )}
          {outside.length > 0 && (
            <p>
              <strong>Arquivos fora dos repositórios</strong>, que o git não guarda, {dirty.length || unchecked.length ? 'também ' : ''}serão perdidos:{' '}
              <span className="mono">{outside.slice(0, 6).join(', ')}{outside.length > 6 ? ' e mais' : ''}</span>.
            </p>
          )}
          <p>Feche os terminais e editores abertos nessa pasta: eles podem impedir a remoção.</p>
        </>
      )}
    </ConfirmDialog>
  );
}

function Prop({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="prop" title={hint}>
      <span className="prop-label">{label}</span>
      {children}
    </div>
  );
}
