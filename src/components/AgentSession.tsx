import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, ChevronRight, CircleCheck, CornerDownLeft, FileDiff, FileEdit, FolderOpen, FilePlus, FileText, GitBranch, Globe, ListChecks,
  MessageSquare, RefreshCw, Search, ShieldQuestion, Square, SquareTerminal, TerminalSquare, Users, Wrench,
} from 'lucide-react';
import { blockedActions, blockedValue, refusedReason, ruleKind, type RefusedReason, type RuleKind } from '../../shared/permissions.ts';
import {
  EFFORT_LABEL, MAX_IMAGES, PERMISSION_HELP, PERMISSION_LABEL, type Activity, type AgentSession as Session, type PermissionDenial, type Repo,
  type SessionSettings, type Worktree,
} from '../../shared/types.ts';
import { api, type SettingsInput } from '../api.ts';
import { setting, useAccountConfig } from '../claudeConfig.ts';
import type { PendingImage } from '../images.ts';
import { terminalLabel, useIntegrations } from '../integrations.ts';
import { toast, useStore, useWorkspace, useWorkspaceRepos } from '../store.ts';
import { ago, duration, isUnder, modKey } from '../util.ts';
import { sessionFolderLabel, sessionRepos, worktreeBranch } from '../worktree.ts';
import { Cost, usesSubscription } from './AccountsView.tsx';
import { ChangesView } from './ChangesView.tsx';
import { AccountAvatar, OrbitMark, SessionBadge } from './icons.tsx';
import { AttachButton, DropHint, ImageTray, SentImages, useImageAttachments } from './Images.tsx';
import { ConfirmDialog } from './modals.tsx';
import { OpenMenu } from './OpenMenu.tsx';
import { EffortPicker, ModelPicker, PermissionPicker, modelLabel } from './SessionSettings.tsx';
import { AutoTextarea, Kbd, Markdown, RepoChip } from './ui.tsx';

const TOOL_ICON: Record<string, typeof Wrench> = {
  Read: FileText, Write: FilePlus, Edit: FileEdit, MultiEdit: FileEdit, NotebookEdit: FileEdit,
  Bash: TerminalSquare, PowerShell: TerminalSquare, Glob: Search, Grep: Search, WebFetch: Globe, WebSearch: Globe,
  Task: Users, Agent: Users, TodoWrite: ListChecks,
};

type RepoMap = Map<string, Repo>;

/** Rascunho da resposta por sessão: fechar o painel ou trocar de sessão não apaga o que você escreveu. */
const composerDrafts = new Map<string, string>();
/** As imagens anexadas e ainda não enviadas, por sessão, como o rascunho do texto. */
const composerImages = new Map<string, PendingImage[]>();
/** A caixa de resposta aberta em cada sessão, avisada quando o rascunho dela volta de fora (ver restoreDraft). */
const draftListeners = new Map<string, Set<() => void>>();

/**
 * Um envio que falhou depois que a caixa de resposta fechou (ou que outra sessão foi aberta): o texto e as
 * imagens voltam para o rascunho da sessão, sem passar por cima do que já foi escrito de novo, e a caixa
 * aberta nela agora mostra na hora. Sem isso, eles ficariam escondidos e apareceriam numa abertura seguinte.
 */
function restoreDraft(sessionId: string, text: string, images: PendingImage[]): void {
  if (!composerDrafts.get(sessionId)?.trim()) composerDrafts.set(sessionId, text);
  const current = composerImages.get(sessionId) ?? [];
  const merged = [...images, ...current.filter((image) => !images.some((old) => old.id === image.id))].slice(0, MAX_IMAGES);
  if (merged.length) composerImages.set(sessionId, merged);
  draftListeners.get(sessionId)?.forEach((listener) => listener());
}

/** Troca as atividades de uma sessão que continua na tela (o painel pode ter fechado durante a busca). */
function replaceActivities(sessionId: string, list: Activity[]): void {
  const s = useStore.getState();
  if (s.activities[sessionId]) s.setActivities(sessionId, list);
}

/** Atividades da sessão, com o estado da primeira carga (e "Tentar de novo" se ela falhar). */
export function useActivities(sessionId: string): { activities: Activity[] | undefined; load: 'loading' | 'ready' | 'error'; retry: () => void } {
  const activities = useStore((s) => s.activities[sessionId]);
  const [load, setLoad] = useState<'loading' | 'ready' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    // Começa a acompanhar a sessão já, para não perder eventos que chegam antes do snapshot.
    const s = useStore.getState();
    if (!s.activities[sessionId]) s.setActivities(sessionId, []);
    setLoad('loading');
    api.activities(sessionId, true)
      .then((list) => {
        useStore.getState().mergeActivities(sessionId, list);
        if (alive) setLoad('ready');
      })
      .catch(() => alive && setLoad('error'));
    return () => {
      alive = false;
    };
  }, [sessionId, attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { activities, load, retry };
}

/**
 * Cabeçalho + feed + caixa de resposta de uma sessão de agente (o "agent session" do Linear).
 * Memoizado: eventos de outras sessões não redesenham este feed.
 */
export const AgentSessionView = memo(function AgentSessionView({ session }: { session: Session }) {
  const workspace = useWorkspace();
  const repos = useWorkspaceRepos();
  const account = useStore((s) => s.accounts.find((a) => a.id === session.accountId));
  const status = useStore((s) => s.accountStatus[session.accountId]);
  // O worktree desta sessão saiu da issue (removido, ou trocado por um novo, com outra branch) ou a issue foi excluída,
  // o que remove o worktree antes (o servidor não exclui uma issue que ainda tem um): como no servidor, a conversa não
  // continua nele. Sem issue, a sessão foi aberta na pasta de um worktree, e vale a pasta.
  const worktreeLost = useStore((s): 'issue' | 'worktree' | null => {
    if (!session.worktree || !session.issueId) return null;
    const issue = s.issues.find((i) => i.id === session.issueId);
    if (!issue) return 'issue';
    // Uma remoção que parou no meio também conta: até ela terminar, nenhuma sessão roda nele.
    return issue.worktree?.createdAt !== session.worktree.createdAt || issue.worktree.removing ? 'worktree' : null;
  });
  const worktreeGone = worktreeLost !== null;
  const { activities, load, retry } = useActivities(session.id);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [syncing, setSyncing] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [askResume, setAskResume] = useState(false);
  const [tab, setTab] = useState<'activity' | 'changes'>('activity');
  const integrations = useIntegrations();
  const fetchChanges = useCallback(() => api.sessionChanges(session.id, true), [session.id]);

  const live = session.state === 'active' || session.state === 'pending';
  const inTerminal = session.state === 'terminal';
  // Já foi aberta no terminal (mesmo se marcada como concluída depois): aquela janela pode continuar aberta nesta conversa.
  const openedInTerminal = session.mode === 'terminal';
  const terminal = terminalLabel(integrations);
  // Num worktree, os repositórios dele ficam em outro caminho. A chave em texto não muda a cada evento da sessão
  // (o objeto muda): o feed não é redesenhado à toa.
  const worktreeKey = JSON.stringify(session.worktree ?? null);
  const sessionView = useMemo(() => sessionRepos(repos, JSON.parse(worktreeKey) as Worktree | null), [repos, worktreeKey]);
  const repoMap = useMemo(() => new Map(sessionView.map((r) => [r.id, r])), [sessionView]);
  const inScope = sessionView.filter((r) => isUnder(session.cwd, r.absPath));

  // Sessões no terminal: puxa o andamento do transcript ao abrir.
  useEffect(() => {
    if (session.state !== 'terminal') return;
    api.sync(session.id)
      .then(() => api.activities(session.id, true))
      .then((list) => replaceActivities(session.id, list))
      .catch(() => undefined);
  }, [session.id, session.state]);

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [activities?.length]);

  const reload = () => api.activities(session.id, true).then((list) => replaceActivities(session.id, list));

  const sync = async () => {
    setSyncing(true);
    try {
      const { count } = await api.sync(session.id);
      await reload();
      if (!count) toast('Ainda não há conversa registrada no terminal para esta sessão.');
    } catch {
      /* o aviso de erro já apareceu (api.ts) */
    } finally {
      setSyncing(false);
    }
  };

  // Enquanto o terminal abre, a caixa de resposta não envia: as duas coisas mexeriam na mesma conversa.
  const openInTerminal = async () => {
    setResuming(true);
    try {
      await api.resumeInTerminal(session.id);
      toast(`Conversa aberta no ${terminal}.`, 'success');
    } finally {
      setResuming(false);
    }
  };
  const resume = () => openInTerminal().catch(() => undefined); // o aviso de erro já apareceu

  // Terminou no terminal: traz o fim da conversa e tira a sessão de "No terminal".
  const finish = async () => {
    setFinishing(true);
    try {
      await api.sync(session.id).catch(() => undefined);
      await api.finish(session.id);
      await reload().catch(() => undefined);
      toast('Sessão marcada como concluída.', 'success');
    } catch {
      /* o aviso de erro já apareceu */
    } finally {
      setFinishing(false);
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
            {session.permissionMode === 'bypassPermissions' ? (
              <span className="tag is-danger" title={PERMISSION_HELP.bypassPermissions}>{PERMISSION_LABEL.bypassPermissions}</span>
            ) : (
              <span className="dim">{PERMISSION_LABEL[session.permissionMode]}</span>
            )}
          </div>
          <div className="agent-head-row dim">
            <span className="mono with-icon" title={session.cwd}>
              <FolderOpen size={12} /> {workspace ? sessionFolderLabel(workspace, session.cwd, session.worktree) : session.cwd}
            </span>
            {session.worktree && (
              <span
                className={`branch-chip${worktreeGone ? ' is-gone' : ''}`}
                title={worktreeGone
                  ? `O worktree desta sessão foi removido (${session.worktree.root}). A branch continua nos repositórios.`
                  : `Worktree em ${session.worktree.root}, a partir de ${[...new Set(session.worktree.repos.map((entry) => entry.base))].join(', ')}`}
              >
                <GitBranch size={11} /> <span>{worktreeBranch(session.worktree)}</span>
              </span>
            )}
            <span className="mono" title={session.model ? `Escolhido: ${session.model}` : 'Padrão da conta'}>{session.activeModel ?? modelLabel(session.model)}</span>
            {session.effort && <span>effort {(EFFORT_LABEL[session.effort] ?? session.effort).toLowerCase()}</span>}
            {session.agent && <span className="mono">@{session.agent}</span>}
            <Cost usd={session.costUsd} subscription={usesSubscription(status)} />
            <span>{duration(session.durationMs)}</span>
            <span>{ago(session.startedAt)}</span>
          </div>
        </div>
        <div className="agent-actions">
          {live && (
            <button className="ghost-btn is-danger" onClick={() => void api.stop(session.id).catch(() => undefined)}><Square size={13} /> Parar</button>
          )}
          {inTerminal && (
            <button
              className="ghost-btn"
              onClick={() => void finish()}
              disabled={finishing}
              title="Terminou no terminal? Marca a sessão como concluída. Se a issue estava Em andamento, ela vai para Em revisão."
            >
              <CircleCheck size={13} /> {finishing ? 'Concluindo…' : 'Marcar como concluída'}
            </button>
          )}
          {!live && (
            <button
              className="ghost-btn"
              disabled={resuming || !account || worktreeGone}
              onClick={() => (openedInTerminal ? setAskResume(true) : void resume())}
              title={!account
                ? 'A conta desta sessão foi removida do Octo.'
                : worktreeGone
                  ? 'O worktree desta sessão foi removido.'
                  : 'Abre esta mesma conversa no seu terminal (claude --resume), com a mesma conta e as mesmas opções'}
            >
              <SquareTerminal size={13} /> Continuar no {terminal}
            </button>
          )}
          {/* Worktree removido: não há o que abrir (no mesmo caminho pode estar um worktree novo, de outra branch). */}
          {workspace && !worktreeGone && <OpenMenu target={{ kind: 'session', sessionId: session.id, workspaceId: workspace.id, dir: session.cwd }} className="ghost-btn" />}
          {inTerminal && (
            <button className="ghost-btn" onClick={() => void sync()} disabled={syncing} title="Traz o andamento da sessão do terminal para cá">
              <RefreshCw size={13} className={syncing ? 'spin' : ''} /> Sincronizar
            </button>
          )}
        </div>
      </div>

      {/* Os repositórios ao alcance da sessão acendem conforme o Claude os toca. */}
      <div className="repo-rail">
        <span className="rail-label"><OrbitMark size={13} active={live} /> contexto</span>
        {/* Só os repositórios rolam: com muitos na pasta, as abas continuam à vista. */}
        <div className="repo-rail-chips">
          {inScope.map((repo) => <RepoChip key={repo.id} repo={repo} lit={session.touchedRepoIds.includes(repo.id)} />)}
          {!inScope.length && <span className="dim">nenhum repositório nesta pasta</span>}
        </div>
        <div className="segmented agent-tabs">
          <button className={tab === 'activity' ? 'is-on' : ''} onClick={() => setTab('activity')}><MessageSquare size={13} /> Atividade</button>
          <button className={tab === 'changes' ? 'is-on' : ''} onClick={() => setTab('changes')}><FileDiff size={13} /> Mudanças</button>
        </div>
      </div>

      {tab === 'changes' && workspace && (
        <div className="feed">
          {worktreeGone && session.worktree ? (
            <div className="changes-empty">
              O worktree desta sessão foi removido. O que tinha commit continua na branch {worktreeBranch(session.worktree)}, nos repositórios.
            </div>
          ) : (
            <ChangesView
              fetcher={fetchChanges}
              target={{ kind: 'session', sessionId: session.id, workspaceId: workspace.id, dir: session.cwd }}
              emptyText="Nenhuma mudança desde o último commit nos repositórios desta sessão."
              note={session.baselineAt
                ? 'Tudo que está sem commit nos repositórios desta sessão, comparado ao último commit. O que já estava alterado antes de ela começar fica separado, no fim de cada repositório.'
                : 'Tudo que está sem commit nos repositórios desta sessão, comparado ao último commit, inclusive o que já estava alterado antes de ela começar (esta sessão não tem o registro de como os arquivos estavam no início).'}
            />
          )}
        </div>
      )}

      <div
        hidden={tab === 'changes'}
        className={`feed${live ? ' is-live' : ''}`}
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {!activities?.length && load === 'loading' && <div className="feed-loading">Carregando atividade…</div>}
        {load === 'error' && (
          <div className="inline-error">
            Não foi possível carregar a atividade desta sessão. <button className="link-btn" onClick={retry}>Tentar de novo</button>
          </div>
        )}
        {activities && <Feed activities={activities} repoMap={repoMap} />}
        {live && (
          <div className="feed-working"><OrbitMark size={14} active /> {account?.name ?? 'Claude'} está trabalhando…</div>
        )}
        {session.state === 'error' && session.lastError && !activities?.some((a) => a.type === 'error') && (
          <div className="feed-error"><AlertTriangle size={14} /> {session.lastError}</div>
        )}
      </div>

      {/* Numa sessão que foi para o terminal, as permissões pendentes não valem mais por aqui. Sem a conta, ou com o terminal
          abrindo, só dá para concluir. */}
      {session.pendingDenials.length > 0 && !live && !inTerminal && (
        <Denials session={session} canContinue={Boolean(account) && !resuming && !worktreeGone} />
      )}
      {/* Conta ou worktree removidos: o servidor não continua a conversa. No lugar de uma caixa de resposta que não envia (e que
          buscaria a configuração de uma conta que não existe mais), fica o aviso. */}
      {!live && (account && !worktreeGone ? (
        <Composer session={session} resuming={resuming} />
      ) : (
        <div className="composer">
          <div className="composer-warning">
            <AlertTriangle size={13} />
            <span>
              {!account
                ? 'A conta desta sessão foi removida do Octo, então não dá para continuar esta conversa por aqui nem abri-la no terminal. Para seguir com o trabalho, comece uma nova sessão com outra conta.'
                : worktreeLost === 'issue'
                  ? 'A issue desta sessão foi excluída e o worktree dela saiu junto, então não dá para continuar esta conversa por aqui nem abri-la no terminal. Para seguir com o trabalho, comece uma nova sessão.'
                  : 'O worktree desta sessão foi removido, então não dá para continuar esta conversa por aqui nem abri-la no terminal. Para seguir com o trabalho, delegue a issue de novo, num worktree novo ou na pasta original dos repositórios.'}
            </span>
          </div>
        </div>
      ))}

      {askResume && (
        <ConfirmDialog
          title="Abrir outra janela do terminal?"
          tone="primary"
          confirmLabel="Abrir outra janela"
          busyLabel="Abrindo…"
          onConfirm={openInTerminal}
          onClose={() => setAskResume(false)}
        >
          <p>Esta sessão já foi aberta no terminal. Se aquela janela ainda estiver aberta, continue por lá.</p>
          <p>
            Duas janelas na mesma conversa gravam o mesmo histórico ao mesmo tempo e o embaralham. Abra outra só se a primeira já foi fechada.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
});

function Feed({ activities, repoMap }: { activities: Activity[]; repoMap: RepoMap }) {
  const results = useMemo(() => {
    const map = new Map<string, Activity>();
    for (const a of activities) if (a.type === 'result' && a.toolUseId) map.set(a.toolUseId, a);
    return map;
  }, [activities]);
  // Cada prompt começa uma execução: uma ação de antes do último que ficou sem resultado (a execução foi
  // interrompida) nunca vai recebê-lo.
  const lastPrompt = useMemo(() => activities.findLastIndex((a) => a.type === 'prompt'), [activities]);

  return (
    <>
      {activities.map((activity, index) => {
        // Resultados aparecem dentro da ação correspondente.
        if (activity.type === 'result') return null;
        const result = activity.toolUseId ? results.get(activity.toolUseId) : undefined;
        const stale = activity.type === 'action' && !result && index < lastPrompt;
        return <ActivityItem key={activity.id} activity={activity} result={result} repoMap={repoMap} stale={stale} />;
      })}
    </>
  );
}

/**
 * Um item do feed. Uma atividade gravada não muda (só é trocada inteira), então a comparação por
 * referência basta: a cada evento só o item novo renderiza, e o Markdown dos outros não é refeito.
 * `stale`: ação sem resultado de uma execução anterior (ver Feed), que só muda num prompt novo.
 */
const ActivityItem = memo(function ActivityItem({ activity, result, repoMap, stale = false }: { activity: Activity; result?: Activity; repoMap: RepoMap; stale?: boolean }) {
  switch (activity.type) {
    case 'prompt':
      return (
        <div className="act act-prompt">
          <div className="act-who">Você</div>
          {/* Uma mensagem só com imagens não tem texto. */}
          {activity.text.trim() && <Markdown>{activity.text}</Markdown>}
          {activity.images?.length ? <SentImages sessionId={activity.sessionId} names={activity.images} /> : null}
          {activity.detail && <div className="act-note">{activity.detail}</div>}
        </div>
      );
    case 'system':
      return <div className="act act-system">{activity.text}</div>;
    case 'thought':
      return <Collapsible className="act act-thought" summary="Raciocínio">{activity.text}</Collapsible>;
    case 'message':
      return (
        <div className={`act act-message${activity.detail === 'subagente' ? ' is-nested' : ''}`}>
          <Markdown>{activity.text}</Markdown>
        </div>
      );
    case 'response':
      return (
        <div className="act act-response">
          <div className="act-who"><OrbitMark size={12} /> Resposta</div>
          <Markdown>{activity.text}</Markdown>
        </div>
      );
    case 'error':
      return <div className="act act-error"><AlertTriangle size={14} /> <span>{activity.text}</span></div>;
    case 'action':
      return <Action activity={activity} result={result} repoMap={repoMap} stale={stale} />;
    default:
      return null;
  }
});

function Action({ activity, result, repoMap, stale }: { activity: Activity; result?: Activity; repoMap: RepoMap; stale: boolean }) {
  const [open, setOpen] = useState(false);
  const Icon = TOOL_ICON[activity.tool ?? ''] ?? Wrench;
  const expandable = Boolean(activity.detail || result?.text);
  return (
    <div className={`act act-action${result?.isError ? ' is-error' : ''}${open ? ' is-open' : ''}`}>
      <button className="act-action-row" onClick={() => expandable && setOpen((o) => !o)} disabled={!expandable} aria-expanded={expandable ? open : undefined}>
        <Icon size={13} className="act-tool-icon" />
        <span className="act-action-text">{activity.text}</span>
        {(activity.repoIds ?? []).map((id) => repoMap.get(id)).filter(Boolean).map((repo) => <RepoChip key={repo!.id} repo={repo!} lit />)}
        {!result && <span className={`act-pending${stale ? ' is-stale' : ''}`} />}
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
      <button className="act-collapse" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <ChevronRight size={12} style={{ transform: open ? 'rotate(90deg)' : undefined }} /> {summary}
      </button>
      {open && <div className="act-thought-body">{children}</div>}
    </div>
  );
}

/** O que está riscado: valeria para qualquer comando, para qualquer site, tem partes que o Octo não separa, ou uma mistura. */
type RefusedGroup = 'any' | 'domain' | 'compound' | 'mixed';

const REFUSED_GROUP: Record<RefusedReason, Exclude<RefusedGroup, 'mixed'>> = {
  empty: 'any',
  program: 'any',
  monitor: 'any',
  domain: 'domain',
  compound: 'compound',
};

/** Como seguir com o que não dá para liberar por aqui. */
const REFUSED_HOW: Record<RefusedGroup, string> = {
  any: 'Para seguir, continue no terminal, onde o Claude pergunta na hora, ou responda ao agente pedindo o comando exato.',
  domain: 'Para seguir, continue no terminal, onde o Claude pergunta na hora, ou responda ao agente pedindo o endereço exato.',
  compound: 'Para seguir, continue no terminal, onde o Claude Code pergunta parte por parte, ou peça ao agente para rodar as partes separadamente.',
  mixed: 'Para seguir, continue no terminal, onde o Claude pergunta na hora, ou responda ao agente.',
};

/** Por que o Octo não libera a regra (ver refusedReason). */
const REFUSED_WHY: Record<RefusedReason, string> = {
  empty: 'A regra está sem comando definido, então valeria para qualquer comando, e o Octo não a libera.',
  program: 'O * está no lugar do programa, então a regra valeria para qualquer comando, e o Octo não a libera.',
  monitor: 'O Monitor roda comandos pelo shell, então liberá-lo valeria para qualquer comando, e o Octo não libera.',
  domain: 'Só com curingas no lugar do domínio, a regra valeria para qualquer site e ainda abriria a rede dos comandos no sandbox para qualquer endereço, e o Octo não a libera.',
  compound: 'O Claude Code confere cada parte de um comando encadeado separadamente, e este tem partes que o Octo não consegue separar para liberar uma a uma (como $( ), crases, subshells, laços, here-docs, ou partes demais).',
};

/** O aviso ao lado de uma regra recusada (o porquê inteiro fica no title). */
const REFUSED_TEXT: Record<RefusedReason, string> = {
  empty: 'Valeria para qualquer comando: não dá para liberar por aqui.',
  program: 'Valeria para qualquer comando: não dá para liberar por aqui.',
  monitor: 'Valeria para qualquer comando: não dá para liberar por aqui.',
  domain: 'Valeria para qualquer site: não dá para liberar por aqui.',
  compound: 'Tem partes que o Octo não consegue liberar uma a uma.',
};

/** O aviso ao lado de uma regra que libera mais do que o bloqueado (ver ruleKind), com a explicação no title. */
function ruleWarning(kind: RuleKind, reason: RefusedReason | null, rule: string): { text: string; title: string } | null {
  switch (kind) {
    case 'refused': {
      const why = reason ?? 'empty';
      return { text: REFUSED_TEXT[why], title: `${REFUSED_WHY[why]} ${REFUSED_HOW[REFUSED_GROUP[why]]}` };
    }
    case 'wildcard':
      return /^(?:Bash|PowerShell)\(/i.test(rule)
        ? {
            text: 'O * é curinga: libera também outros comandos.',
            title: 'Nas regras de permissão do Claude Code, o * vale por qualquer texto, inclusive espaços: esta regra libera todo comando nesse formato, e não só o que foi bloqueado. Depois de um programa que roda outros (sh -c *, env *, sudo *), vale para qualquer comando.',
          }
        : {
            text: 'O * é curinga: vale também para mais do que foi bloqueado.',
            title: 'Nas regras de permissão do Claude Code, o * vale por qualquer texto: esta regra libera também outros endereços, arquivos ou chamadas nesse formato, e não só o que foi bloqueado.',
          };
    case 'whole-tool':
      return {
        text: 'Libera a ferramenta inteira nesta execução, não só o que foi bloqueado.',
        title: 'Só com o nome da ferramenta, a regra vale para todo uso dela até o agente terminar esta execução (qualquer endereço, arquivo ou chamada), e não só para o que foi bloqueado.',
      };
    default:
      return null;
  }
}

/**
 * O que foi bloqueado com cada regra, para mostrar embaixo dela: a regra de um WebFetch vale para o site
 * inteiro e a de um Write, para qualquer arquivo, mas só um endereço e um arquivo foram pedidos. Fica de
 * fora o que a própria regra já mostra (o comando de Bash(npm test)) e os comandos que viraram mais de uma
 * regra (`shown`), que já aparecem em cima das partes deles.
 */
function blockedBy(rule: string, denials: PermissionDenial[], shown: Set<string>): string[] {
  const tool = rule.split('(')[0];
  const texts = denials
    .filter((denial) => denial.rule === rule)
    .flatMap((denial) => {
      const value = blockedValue(denial.input ?? {});
      if (!value || rule === `${denial.tool}(${value})`) return [];
      // O comando de um Monitor vira uma regra de Bash: o nome diz de onde ele veio.
      const text = denial.tool === tool ? value : `${denial.tool}: ${value}`;
      return shown.has(text) ? [] : [text];
    });
  return [...new Set(texts)];
}

/** Uma linha curta (o texto inteiro fica no title). */
function oneLine(text: string, max = 200): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** Uma regra no painel, já classificada. */
interface DenialRule {
  rule: string;
  kind: RuleKind;
  reason: RefusedReason | null;
}

/** Uma linha do painel: a regra e o que foi bloqueado com ela (ver blockedBy). */
interface DenialLine {
  rule: DenialRule;
  blocked: string[];
}

/** Uma regra sozinha, ou as regras das partes de um comando bloqueado, juntas embaixo dele (command). */
interface DenialItem {
  key: string;
  command: string | null;
  lines: DenialLine[];
}

/**
 * As regras das ações bloqueadas como o painel as mostra. O agente costuma repetir o mesmo comando negado: cada
 * regra aparece uma vez só. As de um comando com mais de uma regra (as partes de um comando encadeado, ou ele com e
 * sem a variável de ambiente do começo; ver bashParts) ficam juntas embaixo dele, que aparece uma vez só: uma parte
 * que também foi bloqueada antes, sozinha ou em outro comando, aparece de novo ali, com a mesma caixa.
 */
function denialItems(denials: PermissionDenial[]): { rules: DenialRule[]; items: DenialItem[]; actions: number } {
  const rules = new Map<string, DenialRule>();
  for (const { rule } of denials) if (!rules.has(rule)) rules.set(rule, { rule, kind: ruleKind(rule), reason: refusedReason(rule) });
  const actions = blockedActions(denials);
  // O comando de cada ação com mais de uma regra, escrito como embaixo de uma regra (o de um Monitor vem com o nome dele).
  const commands = new Map(
    actions.flatMap((action) =>
      action.rules.length > 1 && action.value !== null
        ? [[action, action.rules[0].split('(')[0] === action.tool ? action.value : `${action.tool}: ${action.value}`] as const]
        : [],
    ),
  );
  const captions = new Set(commands.values());
  const shown = new Set<string>();
  const items: DenialItem[] = [];
  for (const action of actions) {
    const command = commands.get(action);
    if (command !== undefined) {
      const lines = action.rules.map((rule) => ({ rule: rules.get(rule)!, blocked: blockedBy(rule, denials, captions) }));
      items.push({ key: `comando:${action.tool}:${action.value}`, command, lines });
      for (const rule of action.rules) shown.add(rule);
      continue;
    }
    for (const rule of action.rules) {
      if (shown.has(rule)) continue;
      shown.add(rule);
      items.push({ key: `regra:${rule}`, command: null, lines: [{ rule: rules.get(rule)!, blocked: blockedBy(rule, denials, captions) }] });
    }
  }
  return { rules: [...rules.values()], items, actions: actions.length };
}

/** Embaixo de um comando que virou mais de uma regra. */
const PARTS_HELP = 'O Claude Code confere cada parte deste comando separadamente: libere todas para ele rodar.';
const PARTS_TITLE =
  'O Claude Code divide o comando nos separadores (&&, ||, ;, |, & e quebras de linha) e confere cada parte com as regras, sem os wrappers como timeout, nice, nohup e xargs. Uma variável de ambiente no começo (como NODE_ENV=test) às vezes sai também, então a mesma parte vem com e sem ela.';

/** Ainda há o que liberar por aqui, mas nada marcado. */
const NOTHING_CHOSEN = 'Marque o que quer liberar: o que vale para mais do que foi bloqueado vem desmarcado. Se o agente já resolveu de outro jeito, conclua.';

/** Nada dá para liberar por aqui: o porquê, com uma ação ou com várias. */
const NOTHING_ALLOWED: Record<RefusedGroup, [string, string]> = {
  any: ['Esta ação não dá para liberar por aqui: valeria para qualquer comando.', 'Nenhuma destas ações dá para liberar por aqui: valeriam para qualquer comando.'],
  domain: ['Esta ação não dá para liberar por aqui: valeria para qualquer site.', 'Nenhuma destas ações dá para liberar por aqui: valeriam para qualquer site.'],
  compound: [
    'Esta ação não dá para liberar por aqui: o comando tem partes que o Octo não consegue liberar uma a uma.',
    'Nenhuma destas ações dá para liberar por aqui: os comandos têm partes que o Octo não consegue liberar uma a uma.',
  ],
  mixed: ['Esta ação não dá para liberar por aqui: o motivo está ao lado de cada regra.', 'Nenhuma destas ações dá para liberar por aqui: o motivo está ao lado de cada regra.'],
};

/** No fim do texto de ajuda, quando também há o que liberar. */
const REFUSED_HINT: Record<RefusedGroup, string> = {
  any: ' O que está riscado não dá para liberar por aqui: continue no terminal ou peça ao agente o comando exato.',
  domain: ' O que está riscado não dá para liberar por aqui: continue no terminal ou peça ao agente o endereço exato.',
  compound: ' O que está riscado não dá para liberar por aqui: continue no terminal ou peça ao agente para rodar as partes separadamente.',
  mixed: ' O que está riscado não dá para liberar por aqui: continue no terminal ou responda ao agente.',
};

/** Uma regra no painel: a caixa, a regra com o aviso e, embaixo, o que foi bloqueado com ela. */
function DenialRow({ line, checked, disabled, onToggle }: { line: DenialLine; checked: boolean; disabled: boolean; onToggle: () => void }) {
  const { rule, kind, reason } = line.rule;
  const warning = ruleWarning(kind, reason, rule);
  return (
    <label className={`denial is-${kind}`}>
      <input type="checkbox" checked={checked} onChange={onToggle} disabled={disabled} />
      <span className="denial-body">
        <span className="denial-rule">
          <code>{rule}</code>
          {warning && (
            <span className="denial-warning" title={warning.title}>
              <AlertTriangle size={12} /> {warning.text}
            </span>
          )}
        </span>
        {line.blocked.slice(0, 3).map((text) => (
          <small key={text} className="denial-blocked" title={text.slice(0, 2000)}>{oneLine(text)}</small>
        ))}
        {line.blocked.length > 3 && <small className="denial-blocked">e mais {line.blocked.length - 3}</small>}
      </span>
    </label>
  );
}

/** Equivalente à "elicitation" do Linear: o agente parou porque precisa de permissão. */
function Denials({ session, canContinue }: { session: Session; canContinue: boolean }) {
  const { rules, items, actions } = useMemo(() => denialItems(session.pendingDenials), [session.pendingDenials]);
  const ids = useId();
  // Só vem marcado o que libera apenas o que foi bloqueado: o resto vale para mais, e só vai se você marcar.
  const [chosen, setChosen] = useState(() => new Set(rules.filter((row) => row.kind === 'scoped').map((row) => row.rule)));
  const [busy, setBusy] = useState(false);
  // O que o Octo não libera nunca vai (o servidor recusaria): nem tem caixa para marcar.
  const selected = rules.filter((row) => row.kind !== 'refused' && chosen.has(row.rule)).map((row) => row.rule);
  const selectable = rules.some((row) => row.kind !== 'refused');
  const groups = new Set(rules.flatMap((row) => (row.kind === 'refused' ? [REFUSED_GROUP[row.reason ?? 'empty']] : [])));
  const refused: RefusedGroup | null = !groups.size ? null : groups.size === 1 ? [...groups][0] : 'mixed';
  const hint = refused ? REFUSED_HINT[refused] : '';
  const toggle = (rule: string) =>
    setChosen((c) => {
      const next = new Set(c);
      if (next.has(rule)) next.delete(rule);
      else next.add(rule);
      return next;
    });
  // Um clique só: o segundo cairia em "a sessão ainda está em execução".
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
    } catch {
      /* o aviso de erro já apareceu */
    } finally {
      setBusy(false);
    }
  };
  const row = (line: DenialLine, key: string) => (
    <DenialRow
      key={key}
      line={line}
      checked={line.rule.kind !== 'refused' && chosen.has(line.rule.rule)}
      disabled={busy || line.rule.kind === 'refused'}
      onToggle={() => toggle(line.rule.rule)}
    />
  );
  return (
    <div className="denials">
      <div className="denials-head">
        <ShieldQuestion size={15} />
        {actions === 1 ? 'Uma ação foi bloqueada' : `${actions} ações foram bloqueadas`} pelo modo de permissão
      </div>
      <p className="denials-help">
        {!selectable
          ? `${NOTHING_ALLOWED[refused ?? 'any'][actions === 1 ? 0 : 1]} ${REFUSED_HOW[refused ?? 'any']} Se ele já resolveu de outro jeito, conclua.`
          : selected.length
            ? `Se o agente precisava disso para terminar, permita e ele continua de onde parou. Se ele já resolveu de outro jeito, conclua.${hint}`
            : `${NOTHING_CHOSEN}${hint}`}
      </p>
      {items.map((item, index) =>
        item.command === null ? (
          row(item.lines[0], item.key)
        ) : (
          // As partes de um comando ficam juntas, embaixo dele: o grupo leva o comando como nome e a explicação como descrição.
          <div key={item.key} className="denial-group" role="group" aria-labelledby={`${ids}-${index}`} aria-describedby={`${ids}-${index}-ajuda`}>
            <code id={`${ids}-${index}`} className="denial-group-command" title={item.command.slice(0, 2000)}>{oneLine(item.command)}</code>
            <small id={`${ids}-${index}-ajuda`} className="denial-group-help" title={PARTS_TITLE}>{PARTS_HELP}</small>
            {item.lines.map((line) => row(line, line.rule.rule))}
          </div>
        ),
      )}
      <div className="denials-actions">
        <button
          className="primary-btn"
          disabled={!selected.length || busy || !canContinue}
          title={selected.length ? undefined : selectable ? 'Marque as ações que quer liberar.' : 'O que foi bloqueado não dá para liberar por aqui.'}
          onClick={() => void run(() => api.message(session.id, 'Permissão concedida para as ações bloqueadas. Continue de onde parou.', selected))}
        >
          {busy ? 'Enviando…' : 'Permitir e continuar'}
        </button>
        <button className="ghost-btn" disabled={busy} onClick={() => void run(() => api.dismissDenials(session.id))} title="Marca a sessão como concluída sem liberar as ações">
          Concluir assim mesmo
        </button>
      </div>
    </div>
  );
}

/**
 * Resposta ao agente. Modelo, effort e permissões podem mudar a partir desta mensagem
 * (como /model e /effort no CLI), "/" lista as skills e comandos da conta, e imagens coladas,
 * arrastadas ou anexadas vão junto.
 */
function Composer({ session, resuming }: { session: Session; resuming: boolean }) {
  const [text, setTextState] = useState(() => composerDrafts.get(session.id) ?? '');
  const [changes, setChanges] = useState<Partial<SessionSettings>>({});
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [sending, setSending] = useState(false);
  const { config } = useAccountConfig(session.accountId, session.cwd);
  const slashList = useRef<HTMLDivElement>(null);
  const current = { ...session, ...changes };
  const listId = `slash-${session.id}`;
  const attachments = useImageAttachments({
    initial: composerImages.get(session.id),
    onChange: (images) => {
      if (images.length) composerImages.set(session.id, images);
      else composerImages.delete(session.id);
    },
  });

  const setText = (next: string) => {
    setTextState(next);
    if (next) composerDrafts.set(session.id, next);
    else composerDrafts.delete(session.id);
  };

  // Aberta: recebe o rascunho que um envio que falhou depois de a caixa fechar devolveu (restoreDraft).
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const listener = () => {
      setTextState(composerDrafts.get(session.id) ?? '');
      attachments.restore(composerImages.get(session.id) ?? []);
    };
    const listeners = draftListeners.get(session.id) ?? new Set<() => void>();
    listeners.add(listener);
    draftListeners.set(session.id, listeners);
    return () => {
      mounted.current = false;
      listeners.delete(listener);
      if (!listeners.size) draftListeners.delete(session.id);
    };
    // attachments.restore lê o estado por refs: a versão do primeiro render serve.
  }, [session.id]);

  const commands = useMemo(() => (config?.items ?? []).filter((item) => item.userInvocable), [config]);
  const typed = /^\/(\S*)$/.exec(text)?.[1].toLowerCase();
  const matches =
    typed === undefined || slashDismissed
      ? []
      : commands
          .filter((item) => item.name.toLowerCase().includes(typed))
          .sort((a, b) => Number(b.name.toLowerCase().startsWith(typed)) - Number(a.name.toLowerCase().startsWith(typed)) || a.name.localeCompare(b.name))
          .slice(0, 50);
  const active = matches.length ? slashIndex % matches.length : 0;

  // O item destacado fica sempre à vista na lista, que rola quando há muitas skills.
  useEffect(() => {
    slashList.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active, matches.length]);

  const deliver = async (message: string) => {
    const input: Partial<SettingsInput> = {};
    if ('model' in changes) input.model = changes.model ?? '';
    if ('effort' in changes) input.effort = changes.effort ?? '';
    if (changes.permissionMode) input.permissionMode = changes.permissionMode;
    setSending(true);
    setText(''); // limpa já; se o envio falhar, o texto e as imagens voltam
    const images = attachments.clear();
    try {
      await api.message(session.id, message, [], input, images.map(({ mediaType, data }) => ({ mediaType, data })));
      setChanges({});
    } catch {
      // A resposta pode ter esperado o Claude terminar de sair (até alguns segundos): se a caixa fechou nesse meio
      // tempo, o rascunho volta para a sessão, e não para esta caixa que já não está na tela.
      if (mounted.current) {
        setText(message);
        attachments.restore(images);
      } else {
        restoreDraft(session.id, message, images);
      }
    } finally {
      setSending(false);
    }
  };

  // Texto, imagens ou os dois. Uma imagem ainda sendo preparada segura o envio.
  const ready = Boolean(text.trim() || attachments.images.length) && !attachments.processing;

  const send = () => {
    if (ready && !sending && !resuming) void deliver(text.trim());
  };

  const pick = (name: string) => {
    setText(`/${name} `);
    setSlashIndex(0);
  };

  return (
    // Imagens arrastadas valem em qualquer ponto da caixa de resposta.
    <div className="composer" {...attachments.dropProps}>
      <DropHint show={attachments.dragging} />
      {/* Em segundo plano, a conversa segue numa cópia (--fork-session): o terminal não vê o que acontecer aqui.
          Vale também depois de "Marcar como concluída": a janela pode continuar aberta. */}
      {session.mode === 'terminal' && (
        <div className="composer-warning">
          <AlertTriangle size={13} />
          <span>
            Continuar por aqui abre uma cópia desta conversa em segundo plano. Se o Claude ainda estiver aberto no terminal, ele segue com a
            conversa original e não vê o que acontecer aqui.
          </span>
        </div>
      )}
      <div className="composer-bar">
        <ModelPicker value={current.model} onChange={(model) => setChanges((c) => ({ ...c, model }))} accountDefault={setting(config, 'model')} />
        <EffortPicker compact value={current.effort} onChange={(effort) => setChanges((c) => ({ ...c, effort }))} accountDefault={setting(config, 'effortLevel')} />
        <PermissionPicker value={current.permissionMode} onChange={(permissionMode) => setChanges((c) => ({ ...c, permissionMode }))} />
        <span className="composer-tip">
          {Object.keys(changes).length ? 'vale a partir desta mensagem' : <><Kbd>/</Kbd> skills e comandos · <Kbd>{modKey()} V</Kbd> imagem</>}
        </span>
      </div>
      <ImageTray images={attachments.images} processing={attachments.processing} onRemove={attachments.remove} />
      <div className="composer-input">
        {matches.length > 0 && (
          <div className="slash-menu" role="listbox" id={listId} aria-label="Skills e comandos" ref={slashList}>
            {matches.map((item, index) => (
              <button
                key={`${item.source}:${item.path}`}
                id={`${listId}-${index}`}
                type="button"
                role="option"
                aria-selected={index === active}
                tabIndex={-1}
                className={`slash-item${index === active ? ' is-active' : ''}`}
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
          maxRows={10}
          aria-label="Mensagem para o agente"
          aria-autocomplete="list"
          aria-controls={matches.length ? listId : undefined}
          aria-activedescendant={matches.length ? `${listId}-${active}` : undefined}
          placeholder={
            session.mode === 'terminal' ? 'Continuar esta sessão aqui, em segundo plano…' : 'Responder ao agente, pedir um ajuste, usar uma /skill ou colar uma imagem…'
          }
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setSlashDismissed(false);
            setSlashIndex(0);
          }}
          onPaste={attachments.onPaste}
          onKeyDown={(e) => {
            if (attachments.onKeyDown(e)) return; // Alt+V: cola a imagem copiada
            if (matches.length) {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                setSlashIndex((active + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length);
                return;
              }
              if (e.key === 'Tab' || (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.shiftKey)) {
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
              send();
            }
          }}
        />
        <AttachButton onFiles={attachments.add} className="ghost-btn composer-attach" />
        <button className="primary-btn" onClick={send} disabled={!ready || sending || resuming}>
          {sending ? 'Enviando…' : <>Enviar <Kbd>{modKey()} <CornerDownLeft size={10} /></Kbd></>}
        </button>
      </div>
    </div>
  );
}
