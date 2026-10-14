import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, ChevronRight, CornerDownLeft, FileDiff, FileEdit, FolderOpen, FilePlus, FileText, Globe, ListChecks, MessageSquare, RefreshCw,
  Search, ShieldQuestion, Square, SquareTerminal, TerminalSquare, Users, Wrench,
} from 'lucide-react';
import { EFFORT_LABEL, PERMISSION_LABEL, type Activity, type AgentSession as Session, type SessionSettings } from '../../shared/types.ts';
import { api, type SettingsInput } from '../api.ts';
import { setting, useAccountConfig } from '../claudeConfig.ts';
import { terminalLabel, useIntegrations } from '../integrations.ts';
import { toast, useStore, useWorkspace, useWorkspaceRepos } from '../store.ts';
import { ago, duration, isUnder, money, relativeTo } from '../util.ts';
import { ChangesView } from './ChangesView.tsx';
import { AccountAvatar, OrbitMark, SessionBadge } from './icons.tsx';
import { OpenMenu } from './OpenMenu.tsx';
import { EffortPicker, ModelPicker, PermissionPicker, modelLabel } from './SessionSettings.tsx';
import { AutoTextarea, Kbd, Markdown, RepoChip } from './ui.tsx';

const TOOL_ICON: Record<string, typeof Wrench> = {
  Read: FileText, Write: FilePlus, Edit: FileEdit, MultiEdit: FileEdit, NotebookEdit: FileEdit,
  Bash: TerminalSquare, PowerShell: TerminalSquare, Glob: Search, Grep: Search, WebFetch: Globe, WebSearch: Globe,
  Task: Users, Agent: Users, TodoWrite: ListChecks,
};

export function useActivities(sessionId: string | undefined): Activity[] | undefined {
  const activities = useStore((s) => (sessionId ? s.activities[sessionId] : undefined));
  useEffect(() => {
    if (!sessionId) return;
    // Começa a acompanhar a sessão já, para não perder eventos que chegam antes do snapshot.
    const s = useStore.getState();
    if (!s.activities[sessionId]) s.setActivities(sessionId, []);
    api.activities(sessionId).then((list) => useStore.getState().mergeActivities(sessionId, list)).catch(() => undefined);
  }, [sessionId]);
  return activities;
}

/** Cabeçalho + feed + caixa de resposta de uma sessão de agente (o "agent session" do Linear). */
export function AgentSessionView({ session }: { session: Session }) {
  const workspace = useWorkspace();
  const repos = useWorkspaceRepos();
  const account = useStore((s) => s.accounts.find((a) => a.id === session.accountId));
  const status = useStore((s) => s.accountStatus[session.accountId]);
  const activities = useActivities(session.id);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [syncing, setSyncing] = useState(false);
  const [tab, setTab] = useState<'activity' | 'changes'>('activity');
  const integrations = useIntegrations();
  const fetchChanges = useCallback(() => api.sessionChanges(session.id), [session.id]);

  const live = session.state === 'active' || session.state === 'pending';
  const repoMap = useMemo(() => new Map(repos.map((r) => [r.id, r])), [repos]);
  const inScope = repos.filter((r) => isUnder(session.cwd, r.absPath));

  // Sessões no terminal: puxa o andamento do transcript ao abrir.
  useEffect(() => {
    if (session.state === 'terminal') void api.sync(session.id).then(() => api.activities(session.id)).then((list) => useStore.getState().setActivities(session.id, list));
  }, [session.id, session.state]);

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [activities?.length]);

  const sync = async () => {
    setSyncing(true);
    try {
      const { count } = await api.sync(session.id);
      useStore.getState().setActivities(session.id, await api.activities(session.id));
      if (!count) toast('Ainda não há conversa registrada no terminal para esta sessão.');
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="agent">
      <div className="agent-head">
        <AccountAvatar account={account} status={status} size={22} />
        <div className="agent-head-text">
          <div className="agent-head-row">
            <strong>{account?.name ?? 'Conta removida'}</strong>
            <SessionBadge state={session.state} />
            <span className="dim">{PERMISSION_LABEL[session.permissionMode]}</span>
          </div>
          <div className="agent-head-row dim">
            <span className="mono with-icon" title={session.cwd}><FolderOpen size={12} /> {workspace ? relativeTo(workspace.rootPath, session.cwd) : session.cwd}</span>
            <span className="mono" title={session.model ? `Escolhido: ${session.model}` : 'Padrão da conta'}>{session.activeModel ?? modelLabel(session.model)}</span>
            {session.effort && <span>effort {EFFORT_LABEL[session.effort].toLowerCase()}</span>}
            {session.agent && <span className="mono">@{session.agent}</span>}
            <span>{money(session.costUsd)}</span>
            <span>{duration(session.durationMs)}</span>
            <span>{ago(session.startedAt)}</span>
          </div>
        </div>
        <div className="agent-actions">
          {live && (
            <button className="ghost-btn is-danger" onClick={() => api.stop(session.id)}><Square size={13} /> Parar</button>
          )}
          {!live && (
            <button
              className="ghost-btn"
              onClick={() => api.resumeInTerminal(session.id).then(() => toast(`Conversa aberta no ${terminalLabel(integrations)}.`, 'success'))}
              title="Abre esta mesma conversa no seu terminal (claude --resume), com a mesma conta e as mesmas opções"
            >
              <SquareTerminal size={13} /> Continuar no {terminalLabel(integrations)}
            </button>
          )}
          {workspace && <OpenMenu target={{ kind: 'session', sessionId: session.id, workspaceId: workspace.id, dir: session.cwd }} className="ghost-btn" />}
          {session.state === 'terminal' && (
            <button className="ghost-btn" onClick={sync} disabled={syncing} title="Traz o andamento da sessão do terminal para cá">
              <RefreshCw size={13} className={syncing ? 'spin' : ''} /> Sincronizar
            </button>
          )}
        </div>
      </div>

      {/* Os repositórios ao alcance da sessão acendem conforme o Claude os toca. */}
      <div className="repo-rail">
        <span className="rail-label"><OrbitMark size={13} active={live} /> contexto</span>
        {inScope.map((repo) => <RepoChip key={repo.id} repo={repo} lit={session.touchedRepoIds.includes(repo.id)} />)}
        {!inScope.length && <span className="dim">nenhum repositório nesta pasta</span>}
        <div className="segmented agent-tabs">
          <button className={tab === 'activity' ? 'is-on' : ''} onClick={() => setTab('activity')}><MessageSquare size={13} /> Atividade</button>
          <button className={tab === 'changes' ? 'is-on' : ''} onClick={() => setTab('changes')}><FileDiff size={13} /> Mudanças</button>
        </div>
      </div>

      {tab === 'changes' && workspace && (
        <div className="feed">
          <ChangesView
            fetcher={fetchChanges}
            target={{ kind: 'session', sessionId: session.id, workspaceId: workspace.id, dir: session.cwd }}
            emptyText="Nenhuma mudança desde o último commit nos repositórios desta sessão."
          />
        </div>
      )}

      <div
        hidden={tab === 'changes'}
        className="feed"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {!activities && <div className="feed-loading">Carregando atividade…</div>}
        {activities && <Feed activities={activities} repoMap={repoMap} />}
        {live && (
          <div className="feed-working"><OrbitMark size={14} active /> {account?.name ?? 'Claude'} está trabalhando…</div>
        )}
        {session.state === 'error' && session.lastError && !activities?.some((a) => a.type === 'error') && (
          <div className="feed-error"><AlertTriangle size={14} /> {session.lastError}</div>
        )}
      </div>

      {session.pendingDenials.length > 0 && !live && <Denials session={session} />}
      {!live && <Composer session={session} />}
    </div>
  );
}

function Feed({ activities, repoMap }: { activities: Activity[]; repoMap: Map<string, ReturnType<typeof useWorkspaceRepos>[number]> }) {
  const results = useMemo(() => {
    const map = new Map<string, Activity>();
    for (const a of activities) if (a.type === 'result' && a.toolUseId) map.set(a.toolUseId, a);
    return map;
  }, [activities]);

  return (
    <>
      {activities.map((activity) => {
        switch (activity.type) {
          case 'prompt':
            return (
              <div key={activity.id} className="act act-prompt">
                <div className="act-who">Você</div>
                <Markdown>{activity.text}</Markdown>
                {activity.detail && <div className="act-note">{activity.detail}</div>}
              </div>
            );
          case 'system':
            return <div key={activity.id} className="act act-system">{activity.text}</div>;
          case 'thought':
            return <Collapsible key={activity.id} className="act act-thought" summary="Raciocínio">{activity.text}</Collapsible>;
          case 'message':
            return (
              <div key={activity.id} className={`act act-message${activity.detail === 'subagente' ? ' is-nested' : ''}`}>
                <Markdown>{activity.text}</Markdown>
              </div>
            );
          case 'response':
            return (
              <div key={activity.id} className="act act-response">
                <div className="act-who"><OrbitMark size={12} /> Resposta</div>
                <Markdown>{activity.text}</Markdown>
              </div>
            );
          case 'error':
            return <div key={activity.id} className="act act-error"><AlertTriangle size={14} /> <span>{activity.text}</span></div>;
          case 'action':
            return <Action key={activity.id} activity={activity} result={activity.toolUseId ? results.get(activity.toolUseId) : undefined} repoMap={repoMap} />;
          default:
            return null; // resultados aparecem dentro da ação correspondente
        }
      })}
    </>
  );
}

function Action({ activity, result, repoMap }: { activity: Activity; result?: Activity; repoMap: Map<string, ReturnType<typeof useWorkspaceRepos>[number]> }) {
  const [open, setOpen] = useState(false);
  const Icon = TOOL_ICON[activity.tool ?? ''] ?? Wrench;
  const expandable = Boolean(activity.detail || result?.text);
  return (
    <div className={`act act-action${result?.isError ? ' is-error' : ''}${open ? ' is-open' : ''}`}>
      <button className="act-action-row" onClick={() => expandable && setOpen((o) => !o)} disabled={!expandable}>
        <Icon size={13} className="act-tool-icon" />
        <span className="act-action-text">{activity.text}</span>
        {(activity.repoIds ?? []).map((id) => repoMap.get(id)).filter(Boolean).map((repo) => <RepoChip key={repo!.id} repo={repo!} lit />)}
        {!result && <span className="act-pending" />}
        {expandable && <ChevronRight size={13} className="act-chevron" />}
      </button>
      {open && (
        <div className="act-detail">
          {activity.detail && <pre>{activity.detail}</pre>}
          {result?.text && <pre className="act-result">{result.text}</pre>}
        </div>
      )}
    </div>
  );
}

function Collapsible({ summary, children, className }: { summary: string; children: string; className: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={className}>
      <button className="act-collapse" onClick={() => setOpen((o) => !o)}>
        <ChevronRight size={12} style={{ transform: open ? 'rotate(90deg)' : undefined }} /> {summary}
      </button>
      {open && <div className="act-thought-body">{children}</div>}
    </div>
  );
}

/** Equivalente à "elicitation" do Linear: o agente parou porque precisa de permissão. */
function Denials({ session }: { session: Session }) {
  const [chosen, setChosen] = useState(() => new Set(session.pendingDenials.map((d) => d.rule)));
  const toggle = (rule: string) =>
    setChosen((c) => {
      const next = new Set(c);
      if (next.has(rule)) next.delete(rule);
      else next.add(rule);
      return next;
    });
  return (
    <div className="denials">
      <div className="denials-head">
        <ShieldQuestion size={15} />
        {session.pendingDenials.length === 1 ? 'Uma ação foi bloqueada' : `${session.pendingDenials.length} ações foram bloqueadas`} pelo modo de permissão
      </div>
      <p className="denials-help">Se o agente precisava disso para terminar, permita e ele continua de onde parou. Se ele já resolveu de outro jeito, conclua.</p>
      {session.pendingDenials.map((d) => (
        <label key={d.rule} className="denial">
          <input type="checkbox" checked={chosen.has(d.rule)} onChange={() => toggle(d.rule)} />
          <code>{d.rule}</code>
        </label>
      ))}
      <div className="denials-actions">
        <button
          className="primary-btn"
          disabled={!chosen.size}
          onClick={() => api.message(session.id, 'Permissão concedida para as ações bloqueadas. Continue de onde parou.', [...chosen])}
        >
          Permitir e continuar
        </button>
        <button className="ghost-btn" onClick={() => api.dismissDenials(session.id)} title="Marca a sessão como concluída sem liberar as ações">
          Concluir assim mesmo
        </button>
      </div>
    </div>
  );
}

/**
 * Resposta ao agente. Modelo, effort e permissões podem mudar a partir desta mensagem
 * (como /model e /effort no CLI), e "/" lista as skills e comandos da conta.
 */
function Composer({ session }: { session: Session }) {
  const [text, setText] = useState('');
  const [changes, setChanges] = useState<Partial<SessionSettings>>({});
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const { config } = useAccountConfig(session.accountId, session.cwd);
  const current = { ...session, ...changes };

  const commands = useMemo(() => (config?.items ?? []).filter((item) => item.userInvocable), [config]);
  const typed = /^\/(\S*)$/.exec(text)?.[1].toLowerCase();
  const matches =
    typed === undefined || slashDismissed
      ? []
      : commands
          .filter((item) => item.name.toLowerCase().includes(typed))
          .sort((a, b) => Number(b.name.toLowerCase().startsWith(typed)) - Number(a.name.toLowerCase().startsWith(typed)) || a.name.localeCompare(b.name))
          .slice(0, 8);

  const send = async () => {
    if (!text.trim()) return;
    const input: Partial<SettingsInput> = {};
    if ('model' in changes) input.model = changes.model ?? '';
    if ('effort' in changes) input.effort = changes.effort ?? '';
    if (changes.permissionMode) input.permissionMode = changes.permissionMode;
    await api.message(session.id, text.trim(), [], input);
    setText('');
    setChanges({});
  };

  const pick = (name: string) => {
    setText(`/${name} `);
    setSlashIndex(0);
  };

  return (
    <div className="composer">
      <div className="composer-bar">
        <ModelPicker value={current.model} onChange={(model) => setChanges((c) => ({ ...c, model }))} accountDefault={setting(config, 'model')} />
        <EffortPicker compact value={current.effort} onChange={(effort) => setChanges((c) => ({ ...c, effort }))} accountDefault={setting(config, 'effortLevel')} />
        <PermissionPicker value={current.permissionMode} onChange={(permissionMode) => setChanges((c) => ({ ...c, permissionMode }))} />
        <span className="composer-tip">{Object.keys(changes).length ? 'vale a partir desta mensagem' : <><Kbd>/</Kbd> skills e comandos</>}</span>
      </div>
      <div className="composer-input">
        {matches.length > 0 && (
          <div className="slash-menu" role="listbox">
            {matches.map((item, index) => (
              <button
                key={`${item.source}:${item.path}`}
                type="button"
                className={`slash-item${index === slashIndex % matches.length ? ' is-active' : ''}`}
                onMouseEnter={() => setSlashIndex(index)}
                onMouseDown={(e) => {
                  e.preventDefault(); // mantém o foco na caixa de texto
                  pick(item.name);
                }}
              >
                <span className="mono">/{item.name}</span>
                <span className="slash-desc">{item.description}</span>
                <span className="slash-kind">{item.kind === 'command' ? 'comando' : 'skill'}{item.source !== 'user' ? ` · ${item.source === 'plugin' ? 'plugin' : 'projeto'}` : ''}</span>
              </button>
            ))}
          </div>
        )}
        <AutoTextarea
          minRows={2}
          placeholder={session.state === 'terminal' ? 'Continuar esta sessão aqui, em segundo plano…' : 'Responder ao agente, pedir um ajuste ou usar uma /skill…'}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setSlashDismissed(false);
            setSlashIndex(0);
          }}
          onKeyDown={(e) => {
            if (matches.length) {
              const active = slashIndex % matches.length;
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                setSlashIndex((active + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length);
                return;
              }
              if (e.key === 'Tab' || (e.key === 'Enter' && !e.ctrlKey && !e.metaKey)) {
                e.preventDefault();
                pick(matches[active].name);
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setSlashDismissed(true);
                return;
              }
            }
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button className="primary-btn" onClick={send} disabled={!text.trim()}>
          Enviar <Kbd>Ctrl <CornerDownLeft size={10} /></Kbd>
        </button>
      </div>
    </div>
  );
}
