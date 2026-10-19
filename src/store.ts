import { useMemo } from 'react';
import { create } from 'zustand';
import type {
  AccountStatus, Activity, AgentSession, AppMeta, AppState, ClaudeAccount, Issue, IssueStatus, Preferences, Repo, ServerEvent, Workspace,
} from '../shared/types.ts';

export type View = 'issues' | 'sessions' | 'repos' | 'accounts' | 'claude';

export type Modal =
  | { kind: 'new-issue'; status?: IssueStatus; repoIds?: string[] }
  | { kind: 'delegate'; issueId: string; mode: 'headless' | 'terminal' }
  | { kind: 'workspace' }
  | { kind: 'account' }
  | { kind: 'context'; dir?: string }
  | { kind: 'preferences' }
  | { kind: 'changes'; dir: string; title: string }
  /** Desconectar uma pasta (a aberta ou outra): ela sai do Octo, e nada é apagado do disco. */
  | { kind: 'disconnect'; workspaceId: string }
  | { kind: 'delete-issue'; issueId: string }
  /** Confirmação antes de abrir no terminal uma sessão que já foi aberta nele. */
  | { kind: 'resume-terminal'; sessionId: string };

/** Botão opcional de um aviso (ex.: "Ver" ou "Ativar avisos"). */
export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'error' | 'success';
  action?: ToastAction;
}

interface Store {
  loaded: boolean;
  connected: boolean;
  /** A API recusou o acesso: a página foi aberta sem o link com token. */
  unauthorized: boolean;
  workspaces: Workspace[];
  repos: Repo[];
  accounts: ClaudeAccount[];
  accountStatus: Record<string, AccountStatus>;
  issues: Issue[];
  sessions: AgentSession[];
  preferences: Preferences;
  meta: AppMeta | null;
  /** Atividades das sessões abertas no painel; saem da memória quando o painel fecha. */
  activities: Record<string, Activity[]>;

  workspaceId: string | null;
  view: View;
  layout: 'board' | 'list';
  repoFilter: string | null;
  search: string;
  openIssueId: string | null;
  openSessionId: string | null;
  /** Conta exibida em Configuração do Claude. */
  configAccountId: string | null;
  modal: Modal | null;
  paletteOpen: boolean;
  /** Janela estreita: a navegação vira uma gaveta aberta pela barra do topo. */
  navOpen: boolean;
  /** Lista de atalhos de teclado (tecla ?). */
  shortcutsOpen: boolean;
  toasts: Toast[];

  hydrate(state: AppState): void;
  apply(event: ServerEvent): void;
  setActivities(sessionId: string, activities: Activity[]): void;
  mergeActivities(sessionId: string, activities: Activity[]): void;
  selectWorkspace(id: string | null): void;
  forgetWorkspace(id: string): void;
  set(partial: Partial<Store>): void;
}

const saved = (key: string) => {
  try {
    return localStorage.getItem(`octo:${key}`);
  } catch {
    return null;
  }
};
const remember = (key: string, value: string | null) => {
  try {
    if (value === null) localStorage.removeItem(`octo:${key}`);
    else localStorage.setItem(`octo:${key}`, value);
  } catch {
    /* armazenamento indisponível */
  }
};

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const index = list.findIndex((x) => x.id === item.id);
  if (index === -1) return [...list, item];
  const next = list.slice();
  next[index] = item;
  return next;
}

/**
 * O snapshot do servidor substitui a lista; só fica a versão local de um item quando ela é
 * mais nova (um evento que chegou por SSE enquanto o snapshot estava a caminho).
 */
function newest<T extends { id: string; updatedAt: string }>(fresh: T[], local: T[]): T[] {
  const mine = new Map(local.map((x) => [x.id, x]));
  return fresh.map((x) => {
    const current = mine.get(x.id);
    return current && current.updatedAt > x.updatedAt ? current : x;
  });
}

/**
 * Ids das atividades que já estavam na tela quando a conexão com o servidor caiu. Na
 * ressincronização, vale a versão do servidor para elas (a última mensagem, por exemplo,
 * pode ter virado "resposta" durante a queda).
 */
const staleActivities = new Map<string, Set<string>>();

export const useStore = create<Store>((set, get) => ({
  loaded: false,
  connected: false,
  unauthorized: false,
  workspaces: [],
  repos: [],
  accounts: [],
  accountStatus: {},
  issues: [],
  sessions: [],
  preferences: { terminal: null, editor: null, checkUpdates: true },
  meta: null,
  activities: {},

  workspaceId: saved('workspace'),
  view: (saved('view') as View) ?? 'issues',
  layout: (saved('layout') as 'board' | 'list') ?? 'board',
  repoFilter: null,
  search: '',
  openIssueId: null,
  openSessionId: null,
  configAccountId: null,
  modal: null,
  paletteOpen: false,
  navOpen: false,
  shortcutsOpen: false,
  toasts: [],

  hydrate(state) {
    const s = get();
    const workspaceId = state.workspaces.some((w) => w.id === s.workspaceId) ? s.workspaceId : (state.workspaces[0]?.id ?? null);
    const sessions = newest(state.sessions, s.sessions);
    const issues = newest(state.issues, s.issues);
    const accountStatus = { ...state.accountStatus };
    for (const [id, local] of Object.entries(s.accountStatus)) {
      const fresh = accountStatus[id];
      if (state.accounts.some((a) => a.id === id) && (!fresh || local.checkedAt > fresh.checkedAt)) accountStatus[id] = local;
    }
    // Atividades de sessões que deixaram de existir saem da memória (e não são buscadas de novo).
    const alive = new Set(sessions.map((x) => x.id));
    const activities = Object.fromEntries(Object.entries(s.activities).filter(([id]) => alive.has(id)));
    for (const id of staleActivities.keys()) if (!alive.has(id)) staleActivities.delete(id);
    set({
      ...state,
      sessions,
      issues,
      accountStatus,
      activities,
      loaded: true,
      workspaceId,
      openIssueId: issues.some((i) => i.id === s.openIssueId) ? s.openIssueId : null,
      openSessionId: s.openSessionId && alive.has(s.openSessionId) ? s.openSessionId : null,
      repoFilter: state.repos.some((r) => r.id === s.repoFilter) ? s.repoFilter : null,
    });
  },

  apply(event) {
    const s = get();
    switch (event.type) {
      case 'workspace':
        set({ workspaces: upsert(s.workspaces, event.workspace), workspaceId: s.workspaceId ?? event.workspace.id });
        break;
      case 'workspace.deleted':
        s.forgetWorkspace(event.id);
        break;
      case 'repos':
        set({ repos: s.repos.filter((r) => r.workspaceId !== event.workspaceId).concat(event.repos) });
        break;
      case 'account':
        set({ accounts: upsert(s.accounts, event.account) });
        break;
      case 'account.deleted':
        // Os workspaces que tinham essa conta como padrão chegam à parte, com a conta que o servidor escolheu.
        set({
          accounts: s.accounts.filter((a) => a.id !== event.id),
          accountStatus: Object.fromEntries(Object.entries(s.accountStatus).filter(([id]) => id !== event.id)),
          configAccountId: s.configAccountId === event.id ? null : s.configAccountId,
        });
        break;
      case 'account.status':
        set({ accountStatus: { ...s.accountStatus, [event.status.accountId]: event.status } });
        break;
      case 'issue':
        set({ issues: upsert(s.issues, event.issue) });
        break;
      case 'issue.deleted':
        set({ issues: s.issues.filter((i) => i.id !== event.id), openIssueId: s.openIssueId === event.id ? null : s.openIssueId });
        break;
      case 'session':
        set({ sessions: upsert(s.sessions, event.session) });
        break;
      case 'preferences':
        set({ preferences: event.preferences });
        break;
      case 'activity': {
        const list = s.activities[event.activity.sessionId];
        if (!list) break; // só acompanhamos sessões já abertas na interface
        staleActivities.get(event.activity.sessionId)?.delete(event.activity.id);
        set({ activities: { ...s.activities, [event.activity.sessionId]: upsert(list, event.activity) } });
        break;
      }
    }
  },

  setActivities(sessionId, activities) {
    staleActivities.delete(sessionId);
    set({ activities: { ...get().activities, [sessionId]: activities } });
  },

  /**
   * Junta o que veio do servidor com o que chegou por SSE durante a busca (que é mais novo).
   * O que já estava na tela antes de uma queda da conexão não vale mais que o servidor.
   */
  mergeActivities(sessionId, fetched) {
    const current = get().activities[sessionId];
    if (!current) return; // o painel fechou enquanto a busca acontecia
    const stale = staleActivities.get(sessionId);
    staleActivities.delete(sessionId);
    const byId = new Map(fetched.map((a) => [a.id, a]));
    for (const live of current) if (!stale?.has(live.id)) byId.set(live.id, live);
    const merged = [...byId.values()].sort((a, b) => a.ts.localeCompare(b.ts));
    set({ activities: { ...get().activities, [sessionId]: merged } });
  },

  selectWorkspace(id) {
    remember('workspace', id);
    set({ workspaceId: id, repoFilter: null, search: '', openIssueId: null, openSessionId: null });
  },

  /**
   * Tira daqui uma pasta desconectada (por esta janela ou por outra) com tudo o que era dela. Se era a aberta,
   * abre a próxima como o selectWorkspace (lembrada no navegador e sem os filtros da anterior) ou, sem nenhuma,
   * volta à tela de conectar. A resposta da API e o evento do servidor chamam os dois: o segundo não faz nada.
   */
  forgetWorkspace(id) {
    const s = get();
    if (!s.workspaces.some((w) => w.id === id)) return;
    const workspaces = s.workspaces.filter((w) => w.id !== id);
    const sessions = s.sessions.filter((x) => x.workspaceId !== id);
    const issues = s.issues.filter((i) => i.workspaceId !== id);
    const alive = new Set(sessions.map((x) => x.id));
    for (const sessionId of staleActivities.keys()) if (!alive.has(sessionId)) staleActivities.delete(sessionId);
    const wasOpen = s.workspaceId === id;
    const workspaceId = wasOpen ? (workspaces[0]?.id ?? null) : s.workspaceId;
    if (wasOpen) remember('workspace', workspaceId);
    set({
      workspaces,
      workspaceId,
      repos: s.repos.filter((r) => r.workspaceId !== id),
      issues,
      sessions,
      activities: Object.fromEntries(Object.entries(s.activities).filter(([sessionId]) => alive.has(sessionId))),
      openIssueId: issues.some((i) => i.id === s.openIssueId) ? s.openIssueId : null,
      openSessionId: s.openSessionId && alive.has(s.openSessionId) ? s.openSessionId : null,
      ...(wasOpen && { repoFilter: null, search: '' }),
    });
  },

  set(partial) {
    if (partial.view) remember('view', partial.view);
    if (partial.layout) remember('layout', partial.layout);
    set(partial);
  },
}));

useStore.subscribe((state, prev) => {
  // A conexão caiu: o que está na tela pode ter mudado no servidor sem chegar aqui.
  if (prev.connected && !state.connected) {
    for (const [sessionId, list] of Object.entries(state.activities)) {
      const ids = staleActivities.get(sessionId) ?? new Set<string>();
      for (const activity of list) ids.add(activity.id);
      staleActivities.set(sessionId, ids);
    }
  }
  // O painel fechou: as atividades saem da memória (reabrir busca de novo, e uma reconexão
  // não baixa outra vez o histórico de toda sessão já aberta).
  const wasOpen = Boolean(prev.openIssueId || prev.openSessionId);
  if (wasOpen && !state.openIssueId && !state.openSessionId && Object.keys(state.activities).length) {
    staleActivities.clear();
    useStore.setState({ activities: {} });
  }
});

// ---------------------------------------------------------------- avisos (toasts)

const TOAST_MS: Record<Toast['tone'], number> = { info: 4500, success: 3500, error: 8000 };
const MAX_TOASTS = 4;

interface ToastTimer {
  handle: ReturnType<typeof setTimeout> | null;
  remaining: number;
  started: number;
}
const timers = new Map<number, ToastTimer>();
/** Motivos para segurar os avisos na tela: mouse ou foco sobre eles, janela em segundo plano. */
const holds = new Set<string>();

function startTimer(id: number, timer: ToastTimer): void {
  timer.started = Date.now();
  timer.handle = setTimeout(() => dismissToast(id), timer.remaining);
}

let toastId = 0;
export function toast(text: string, tone: Toast['tone'] = 'info', action?: ToastAction): number {
  const id = ++toastId;
  const current = useStore.getState().toasts;
  for (const old of current.slice(0, Math.max(0, current.length - MAX_TOASTS + 1))) dismissToast(old.id);
  useStore.setState((s) => ({ toasts: [...s.toasts, { id, text, tone, action }] }));
  // Com um botão, o aviso fica mais tempo: dá para ler e decidir.
  const timer: ToastTimer = { handle: null, remaining: action ? 12_000 : TOAST_MS[tone], started: 0 };
  timers.set(id, timer);
  if (!holds.size) startTimer(id, timer);
  return id;
}

export function dismissToast(id: number): void {
  const timer = timers.get(id);
  if (timer?.handle) clearTimeout(timer.handle);
  timers.delete(id);
  useStore.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

/** Pausa (ou retoma) o sumiço automático dos avisos. */
export function holdToasts(reason: string, hold: boolean): void {
  const before = holds.size;
  if (hold) holds.add(reason);
  else holds.delete(reason);
  if (Boolean(before) === Boolean(holds.size)) return;
  for (const [id, timer] of timers) {
    if (holds.size && timer.handle) {
      clearTimeout(timer.handle);
      timer.handle = null;
      timer.remaining -= Date.now() - timer.started;
    } else if (!holds.size && !timer.handle) {
      timer.remaining = Math.max(timer.remaining, 1500);
      startTimer(id, timer);
    }
  }
}

// ---------------------------------------------------------------- seletores

export function useWorkspace(): Workspace | null {
  return useStore((s) => s.workspaces.find((w) => w.id === s.workspaceId) ?? null);
}

export function useWorkspaceRepos(): Repo[] {
  const workspaceId = useStore((s) => s.workspaceId);
  const repos = useStore((s) => s.repos);
  return useMemo(
    () => repos.filter((r) => r.workspaceId === workspaceId).sort((a, b) => a.name.localeCompare(b.name)),
    [repos, workspaceId],
  );
}

/** Conta padrão de um workspace (o aberto, se nenhum for dado) ou, sem uma, a primeira conta. */
export function defaultAccountId(workspaceId = useStore.getState().workspaceId): string | undefined {
  const s = useStore.getState();
  const workspace = s.workspaces.find((w) => w.id === workspaceId);
  return workspace?.defaultAccountId ?? s.accounts[0]?.id;
}
