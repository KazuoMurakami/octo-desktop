import type {
  AccountConfig, Activity, AgentSession, AppState, AvailablePlugin, ClaudeAccount, ClaudeItem, ClaudeItemKind, Integrations, Issue, Preferences,
  Repo, RepoChanges, ServerEvent, SessionSettings, UpdateInfo, Workspace,
} from '../shared/types.ts';
import { toast, useStore } from './store.ts';

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${url}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = (data as { error?: string }).error ?? `Erro ${response.status}`;
    toast(message, 'error');
    throw new Error(message);
  }
  return data as T;
}

const post = <T,>(url: string, body: unknown = {}) => request<T>('POST', url, body);
const patch = <T,>(url: string, body: unknown) => request<T>('PATCH', url, body);
const put = <T,>(url: string, body: unknown) => request<T>('PUT', url, body);
const query = (params: Record<string, string | undefined>) => {
  const search = new URLSearchParams(Object.entries(params).filter((entry): entry is [string, string] => Boolean(entry[1])));
  return search.size ? `?${search}` : '';
};

export interface ContextInfo {
  file: string;
  exists: boolean;
  managed: boolean;
  preview: string;
}

export interface FolderInspection {
  path: string;
  name: string;
  repos: string[];
}

/** Para a API, '' em model/effort significa "padrão da conta" (sem flag). */
export type SettingsInput = Omit<SessionSettings, 'model' | 'effort'> & { model: string; effort: string };

export function settingsInput(settings: SessionSettings): SettingsInput {
  return { ...settings, model: settings.model ?? '', effort: settings.effort ?? '' };
}

export interface DelegateInput extends SettingsInput {
  accountId: string;
  instructions: string;
  mode: 'headless' | 'terminal';
}

export const api = {
  state: () => request<AppState>('GET', '/state'),

  pickFolder: () => post<{ path: string | null }>('/fs/pick-folder'),
  inspectFolder: (path: string, scanDepth: number) => post<FolderInspection>('/fs/inspect', { path, scanDepth }),

  createWorkspace: (body: { rootPath: string; name: string; key: string; scanDepth: number }) => post<Workspace>('/workspaces', body),
  updateWorkspace: (id: string, body: Partial<Workspace>) => patch<Workspace>(`/workspaces/${id}`, body),
  deleteWorkspace: (id: string) => request('DELETE', `/workspaces/${id}`),
  scan: (id: string) => post<Repo[]>(`/workspaces/${id}/scan`),
  context: (id: string, dir?: string) =>
    request<ContextInfo>('GET', `/workspaces/${id}/context${dir ? `?dir=${encodeURIComponent(dir)}` : ''}`),
  writeContext: (id: string, dir?: string) => post<{ file: string }>(`/workspaces/${id}/context`, { dir }),
  openTerminal: (id: string, body: { accountId?: string; dir?: string }) => post<AgentSession>(`/workspaces/${id}/terminal`, body),
  reveal: (id: string, dir?: string) => post(`/workspaces/${id}/reveal`, { dir }),

  createAccount: (body: { name: string; configDir: string; inherit: boolean }) => post<ClaudeAccount>('/accounts', body),
  updateAccount: (id: string, body: Partial<ClaudeAccount>) => patch<ClaudeAccount>(`/accounts/${id}`, body),
  deleteAccount: (id: string) => request('DELETE', `/accounts/${id}`),
  refreshAccount: (id: string) => post(`/accounts/${id}/status`),
  login: (id: string) => post(`/accounts/${id}/login`),

  accountConfig: (id: string, cwd?: string, fresh = false) => request<AccountConfig>('GET', `/accounts/${id}/config${query({ cwd, fresh: fresh ? '1' : undefined })}`),
  saveSettingsRaw: (id: string, raw: string) => put(`/accounts/${id}/settings`, { raw }),
  patchSettings: (id: string, body: { model?: string; effortLevel?: string; alwaysThinkingEnabled?: boolean | null }) => patch(`/accounts/${id}/settings`, body),
  readItem: (id: string, path: string, cwd?: string) => request<{ item: ClaudeItem; content: string }>('GET', `/accounts/${id}/item${query({ path, cwd })}`),
  createItem: (id: string, kind: ClaudeItemKind, name: string, content: string) => post<{ path: string }>(`/accounts/${id}/items`, { kind, name, content }),
  saveItem: (id: string, path: string, content: string, cwd?: string) => put(`/accounts/${id}/item`, { path, content, cwd }),
  deleteItem: (id: string, path: string, cwd?: string) => request<{ trash: string }>('DELETE', `/accounts/${id}/item${query({ path, cwd })}`),
  copyItem: (id: string, path: string, targetAccountId: string, cwd?: string) => post(`/accounts/${id}/item/copy`, { path, targetAccountId, cwd }),
  addMcp: (id: string, name: string, config: string) => post(`/accounts/${id}/mcp`, { name, config }),
  removeMcp: (id: string, name: string) => request('DELETE', `/accounts/${id}/mcp/${encodeURIComponent(name)}`),
  availablePlugins: (id: string) => request<AvailablePlugin[]>('GET', `/accounts/${id}/plugins/available`),
  pluginAction: (id: string, action: 'install' | 'uninstall' | 'enable' | 'disable', plugin: string) => post(`/accounts/${id}/plugins`, { action, id: plugin }),
  revealConfig: (id: string) => post(`/accounts/${id}/reveal`),

  integrations: () => request<Integrations>('GET', '/integrations'),
  update: () => request<UpdateInfo | null>('GET', '/update'),
  setPreferences: (body: Partial<Preferences>) => patch<Integrations>('/preferences', body),
  openEditor: (workspaceId: string, body: { dir?: string; repoIds?: string[]; editor?: string }) => post<{ editor: string }>(`/workspaces/${workspaceId}/open-editor`, body),
  openShell: (workspaceId: string, dir?: string) => post(`/workspaces/${workspaceId}/shell`, { dir }),
  folderChanges: (workspaceId: string, dir?: string) => request<RepoChanges[]>('GET', `/workspaces/${workspaceId}/changes${query({ dir })}`),
  openSessionEditor: (sessionId: string, editor?: string) => post<{ editor: string }>(`/sessions/${sessionId}/open-editor`, { editor }),
  openSessionShell: (sessionId: string) => post(`/sessions/${sessionId}/shell`),
  sessionChanges: (sessionId: string) => request<RepoChanges[]>('GET', `/sessions/${sessionId}/changes`),

  createIssue: (workspaceId: string, body: Partial<Issue>) => post<Issue>(`/workspaces/${workspaceId}/issues`, body),
  updateIssue: (id: string, body: Partial<Issue>) => patch<Issue>(`/issues/${id}`, body),
  deleteIssue: (id: string) => request('DELETE', `/issues/${id}`),
  delegate: (id: string, body: DelegateInput) => post<AgentSession>(`/issues/${id}/delegate`, body),

  activities: (sessionId: string) => request<Activity[]>('GET', `/sessions/${sessionId}/activities`),
  message: (sessionId: string, text: string, allowedTools: string[] = [], changes: Partial<SettingsInput> = {}) =>
    post<AgentSession>(`/sessions/${sessionId}/message`, { text, allowedTools, ...changes }),
  stop: (sessionId: string) => post(`/sessions/${sessionId}/stop`),
  dismissDenials: (sessionId: string) => post(`/sessions/${sessionId}/dismiss-denials`),
  resumeInTerminal: (sessionId: string) => post<AgentSession>(`/sessions/${sessionId}/terminal`),
  sync: (sessionId: string) => post<{ count: number }>(`/sessions/${sessionId}/sync`),
};

/** Troca o ?token=… do endereço por um cookie e o tira da barra de endereço. */
export async function authenticate(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const token = params.get('token');
  if (!token) return;
  await fetch(`/api/auth?token=${encodeURIComponent(token)}`).catch(() => undefined);
  params.delete('token');
  history.replaceState(null, '', `${location.pathname}${params.size ? `?${params}` : ''}${location.hash}`);
}

/** Carrega o estado inicial e mantém tudo sincronizado via Server-Sent Events. */
export function connect(): () => void {
  let source: EventSource | null = null;
  let closed = false;

  const open = async () => {
    // Sem o cookie de acesso, o EventSource só falharia em silêncio: avisa a interface.
    const probe = await fetch('/api/state', { method: 'HEAD' }).catch(() => null);
    if (closed) return;
    if (probe?.status === 401) {
      useStore.setState({ unauthorized: true });
      return;
    }
    source = new EventSource('/api/events');
    source.onopen = () => {
      // A cada (re)conexão recarregamos o estado inteiro para não perder eventos.
      api.state().then((state) => useStore.getState().hydrate(state)).catch(() => undefined);
      for (const sessionId of Object.keys(useStore.getState().activities)) {
        api.activities(sessionId).then((list) => useStore.getState().mergeActivities(sessionId, list)).catch(() => undefined);
      }
      useStore.setState({ connected: true });
    };
    source.onmessage = (message) => useStore.getState().apply(JSON.parse(message.data) as ServerEvent);
    source.onerror = () => {
      useStore.setState({ connected: false });
      if (source?.readyState === EventSource.CLOSED && !closed) setTimeout(() => void open(), 2000);
    };
  };
  void open();
  return () => {
    closed = true;
    source?.close();
  };
}
