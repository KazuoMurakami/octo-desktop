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
  | { kind: 'changes'; dir: string; title: string };

export interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'error' | 'success';
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
  toasts: Toast[];

  hydrate(state: AppState): void;
  apply(event: ServerEvent): void;
  setActivities(sessionId: string, activities: Activity[]): void;
  mergeActivities(sessionId: string, activities: Activity[]): void;
  selectWorkspace(id: string | null): void;
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
  toasts: [],

  hydrate(state) {
    const current = get().workspaceId;
    const workspaceId = state.workspaces.some((w) => w.id === current) ? current : (state.workspaces[0]?.id ?? null);
    set({ ...state, loaded: true, workspaceId });
  },

  apply(event) {
    const s = get();
    switch (event.type) {
      case 'workspace':
        set({ workspaces: upsert(s.workspaces, event.workspace), workspaceId: s.workspaceId ?? event.workspace.id });
        break;
      case 'workspace.deleted': {
        const workspaces = s.workspaces.filter((w) => w.id !== event.id);
        set({
          workspaces,
          workspaceId: s.workspaceId === event.id ? (workspaces[0]?.id ?? null) : s.workspaceId,
          repos: s.repos.filter((r) => r.workspaceId !== event.id),
          issues: s.issues.filter((i) => i.workspaceId !== event.id),
          sessions: s.sessions.filter((x) => x.workspaceId !== event.id),
        });
        break;
      }
      case 'repos':
        set({ repos: s.repos.filter((r) => r.workspaceId !== event.workspaceId).concat(event.repos) });
        break;
      case 'account':
        set({ accounts: upsert(s.accounts, event.account) });
        break;
      case 'account.deleted':
        set({ accounts: s.accounts.filter((a) => a.id !== event.id) });
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
        set({ activities: { ...s.activities, [event.activity.sessionId]: upsert(list, event.activity) } });
        break;
      }
    }
  },

  setActivities(sessionId, activities) {
    set({ activities: { ...get().activities, [sessionId]: activities } });
  },

  /** Junta um snapshot do servidor com eventos que chegaram por SSE enquanto ele carregava. */
  mergeActivities(sessionId, fetched) {
    const byId = new Map(fetched.map((a) => [a.id, a]));
    for (const live of get().activities[sessionId] ?? []) byId.set(live.id, live);
    const merged = [...byId.values()].sort((a, b) => a.ts.localeCompare(b.ts));
    set({ activities: { ...get().activities, [sessionId]: merged } });
  },

  selectWorkspace(id) {
    remember('workspace', id);
    set({ workspaceId: id, repoFilter: null, openIssueId: null, openSessionId: null });
  },

  set(partial) {
    if (partial.view) remember('view', partial.view);
    if (partial.layout) remember('layout', partial.layout);
    set(partial);
  },
}));

let toastId = 0;
export function toast(text: string, tone: Toast['tone'] = 'info'): void {
  const id = ++toastId;
  useStore.setState((s) => ({ toasts: [...s.toasts, { id, text, tone }] }));
  setTimeout(() => useStore.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), tone === 'error' ? 6000 : 3500);
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

export function defaultAccountId(): string | undefined {
  const s = useStore.getState();
  const workspace = s.workspaces.find((w) => w.id === s.workspaceId);
  return workspace?.defaultAccountId ?? s.accounts[0]?.id;
}
