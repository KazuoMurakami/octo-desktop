import type {
  AccountConfig, AccountStatus, Activity, AgentSession, AppState, AvailablePlugin, ClaudeAccount, ClaudeItem, ClaudeItemKind, Integrations, Issue,
  Preferences, Repo, RepoChanges, ServerEvent, SessionSettings, UpdateInfo, Workspace,
} from '../shared/types.ts';
import { toast, useStore } from './store.ts';

interface RequestOptions {
  /** Não mostra aviso de erro: quem chamou trata a falha na própria tela. */
  quiet?: boolean;
  signal?: AbortSignal;
}

const OFFLINE = 'Sem conexão com o Octo. Confira se ele continua aberto e tente de novo.';
let lastOfflineToast = 0;

/** Falha de rede vira um aviso só (e não um por clique); com o banner de reconexão na tela, nem isso. */
function offlineToast(): void {
  if (!useStore.getState().connected || Date.now() - lastOfflineToast < 5000) return;
  lastOfflineToast = Date.now();
  toast(OFFLINE, 'error');
}

async function request<T>(method: string, url: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${url}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: options.signal,
    });
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    if (!options.quiet) offlineToast();
    throw new Error(OFFLINE);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = (data as { error?: string }).error ?? `O Octo respondeu com erro ${response.status}.`;
    if (!options.quiet) toast(message, 'error');
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
  /** A busca parou no limite de pastas: a lista pode estar incompleta. */
  partial?: boolean;
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
  /** Sem aviso de erro: a prévia da pasta mostra o motivo, e a busca é cancelada quando o caminho muda. */
  inspectFolder: (path: string, scanDepth: number, signal?: AbortSignal) =>
    request<FolderInspection>('POST', '/fs/inspect', { path, scanDepth }, { quiet: true, signal }),

  createWorkspace: (body: { rootPath: string; name: string; key: string; scanDepth: number }) => post<Workspace>('/workspaces', body),
  updateWorkspace: (id: string, body: Partial<Workspace>) => patch<Workspace>(`/workspaces/${id}`, body),
  deleteWorkspace: (id: string) => request('DELETE', `/workspaces/${id}`),
  scan: (id: string) => post<Repo[]>(`/workspaces/${id}/scan`),
  context: (id: string, dir?: string, quiet = false) =>
    request<ContextInfo>('GET', `/workspaces/${id}/context${dir ? `?dir=${encodeURIComponent(dir)}` : ''}`, undefined, { quiet }),
  writeContext: (id: string, dir?: string) => post<{ file: string }>(`/workspaces/${id}/context`, { dir }),
  openTerminal: (id: string, body: { accountId?: string; dir?: string }) => post<AgentSession>(`/workspaces/${id}/terminal`, body),
  reveal: (id: string, dir?: string) => post(`/workspaces/${id}/reveal`, { dir }),

  createAccount: (body: { name: string; configDir: string; inherit: boolean }) => post<ClaudeAccount>('/accounts', body),
  updateAccount: (id: string, body: Partial<ClaudeAccount>) => patch<ClaudeAccount>(`/accounts/${id}`, body),
  deleteAccount: (id: string) => request('DELETE', `/accounts/${id}`),
  refreshAccount: (id: string, quiet = false) => request<AccountStatus>('POST', `/accounts/${id}/status`, {}, { quiet }),
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
  /** `quiet`: a tela de mudanças mostra a falha com "Tentar de novo" em vez de um aviso. */
  folderChanges: (workspaceId: string, dir?: string, quiet = false) =>
    request<RepoChanges[]>('GET', `/workspaces/${workspaceId}/changes${query({ dir })}`, undefined, { quiet }),
  openSessionEditor: (sessionId: string, editor?: string) => post<{ editor: string }>(`/sessions/${sessionId}/open-editor`, { editor }),
  openSessionShell: (sessionId: string) => post(`/sessions/${sessionId}/shell`),
  sessionChanges: (sessionId: string, quiet = false) => request<RepoChanges[]>('GET', `/sessions/${sessionId}/changes`, undefined, { quiet }),

  createIssue: (workspaceId: string, body: Partial<Issue>) => post<Issue>(`/workspaces/${workspaceId}/issues`, body),
  updateIssue: (id: string, body: Partial<Issue>) => patch<Issue>(`/issues/${id}`, body),
  deleteIssue: (id: string) => request('DELETE', `/issues/${id}`),
  delegate: (id: string, body: DelegateInput) => post<AgentSession>(`/issues/${id}/delegate`, body),

  /** `quiet`: o feed mostra a falha com "Tentar de novo" em vez de um aviso. */
  activities: (sessionId: string, quiet = false) => request<Activity[]>('GET', `/sessions/${sessionId}/activities`, undefined, { quiet }),
  message: (sessionId: string, text: string, allowedTools: string[] = [], changes: Partial<SettingsInput> = {}) =>
    post<AgentSession>(`/sessions/${sessionId}/message`, { text, allowedTools, ...changes }),
  stop: (sessionId: string) => post(`/sessions/${sessionId}/stop`),
  dismissDenials: (sessionId: string) => post(`/sessions/${sessionId}/dismiss-denials`),
  /** Sessão de terminal (ou aguardando você) encerrada pela interface: vira concluída. */
  finish: (sessionId: string) => post<{ ok: true }>(`/sessions/${sessionId}/finish`),
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
  /** Cada (re)conexão começa uma carga nova; tentativas de uma conexão anterior param sozinhas. */
  let generation = 0;

  // Se a carga falhar (servidor reiniciando, por exemplo), tenta de novo com intervalos crescentes,
  // em vez de deixar a tela presa em "Carregando…".
  const loadState = (gen: number, attempt = 0) => {
    request<AppState>('GET', '/state', undefined, { quiet: true })
      .then((state) => {
        if (!closed && gen === generation) useStore.getState().hydrate(state);
      })
      .catch(() => {
        if (closed || gen !== generation) return;
        setTimeout(() => loadState(gen, attempt + 1), Math.min(30_000, 1000 * 2 ** attempt));
      });
  };

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
      loadState(++generation);
      for (const sessionId of Object.keys(useStore.getState().activities)) {
        api.activities(sessionId, true).then((list) => useStore.getState().mergeActivities(sessionId, list)).catch(() => undefined);
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
