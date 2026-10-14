import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Bot, ChevronDown, Ellipsis, FolderOpen, SquareTerminal, Trash2, X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { PRIORITY_LABEL, STATUSES, STATUS_LABEL, type Issue, type Priority } from '../../shared/types.ts';
import { api } from '../api.ts';
import { useStore, useWorkspace, useWorkspaceRepos } from '../store.ts';
import { ago, commonFolder, hue } from '../util.ts';
import { loginHint } from './AccountsView.tsx';
import { AgentSessionView } from './AgentSession.tsx';
import { ConfirmDialog } from './modals.tsx';
import { OpenMenu, folderLabel } from './OpenMenu.tsx';
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
  const cwd = workspace ? commonFolder(workspace, issueRepos) : '';
  const folder = workspace ? folderLabel(workspace, cwd) : '';
  const running = sessions.some((s) => s.state === 'active' || s.state === 'pending');
  const update = (body: Partial<Issue>) => api.updateIssue(issue.id, body);

  const remove = async () => {
    removed.current = true;
    clearTimeout(timer.current);
    try {
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
            items={[{ key: 'delete', label: 'Excluir issue…', icon: <Trash2 size={14} />, danger: true, onSelect: () => setConfirmDelete(true) }]}
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
                  Delegue esta issue: o Claude roda em <code>{folder || '—'}</code>
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
                className="prop-btn mono"
                align="start"
                target={{ kind: 'folder', workspaceId: workspace.id, dir: cwd, repoIds: issueRepos.length ? issueRepos.map((r) => r.id) : undefined }}
                trigger={<><FolderOpen size={13} /> {folder}</>}
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
          onConfirm={remove}
          onClose={() => setConfirmDelete(false)}
        >
          <p>
            A issue “{issue.title}” sai do quadro, com a descrição e o histórico.
            {running && <> <strong>O agente que está trabalhando nela será interrompido.</strong></>}
          </p>
          <p>
            {sessions.length > 0 ? 'As sessões do agente continuam em Sessões do agente. ' : ''}
            Nada muda nos arquivos dos repositórios.
          </p>
        </ConfirmDialog>
      )}
    </>
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
