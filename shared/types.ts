// Tipos compartilhados entre o servidor (Node) e a interface (React).

export const STATUSES = ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'canceled'] as const;
export type IssueStatus = (typeof STATUSES)[number];

export const STATUS_LABEL: Record<IssueStatus, string> = {
  backlog: 'Backlog',
  todo: 'A fazer',
  in_progress: 'Em andamento',
  in_review: 'Em revisão',
  done: 'Concluído',
  canceled: 'Cancelado',
};

/** Mesma escala do Linear: 0 = sem prioridade, 1 = urgente ... 4 = baixa. */
export type Priority = 0 | 1 | 2 | 3 | 4;

export const PRIORITY_LABEL: Record<Priority, string> = {
  0: 'Sem prioridade',
  1: 'Urgente',
  2: 'Alta',
  3: 'Média',
  4: 'Baixa',
};

/** Os mesmos modos do `claude --permission-mode`. */
export const PERMISSION_MODES = ['plan', 'manual', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export const PERMISSION_LABEL: Record<PermissionMode, string> = {
  plan: 'Planejar',
  manual: 'Perguntar',
  acceptEdits: 'Aceitar edições',
  auto: 'Automático',
  dontAsk: 'Não perguntar',
  bypassPermissions: 'Sem restrições',
};

export const PERMISSION_HELP: Record<PermissionMode, string> = {
  plan: 'Só lê e planeja. Bom para investigar e propor uma abordagem.',
  manual: 'Pede permissão para editar e rodar comandos. Em segundo plano, o pedido aparece na issue.',
  acceptEdits:
    'Edita arquivos sem perguntar. Comandos (npm, git…) pedem permissão: no terminal, na hora; em segundo plano, ficam bloqueados e aparecem na issue ao final, para você liberar com “Permitir e continuar”.',
  auto: 'O Claude decide sozinho o que é seguro executar.',
  dontAsk: 'Nunca pergunta: o que não estiver liberado nas configurações é negado.',
  bypassPermissions: 'Executa tudo sem perguntar. Use só em pastas descartáveis.',
};

/** Níveis do `claude --effort`: quanto o modelo pensa antes de agir. */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

export const EFFORT_LABEL: Record<Effort, string> = {
  low: 'Baixo',
  medium: 'Médio',
  high: 'Alto',
  xhigh: 'Muito alto',
  max: 'Máximo',
};

/** Apelidos aceitos por `--model`; sempre apontam para a versão mais recente de cada família. */
export const MODEL_ALIASES = [
  { id: 'fable', label: 'Fable', hint: 'o mais capaz' },
  { id: 'opus', label: 'Opus', hint: 'raciocínio profundo' },
  { id: 'sonnet', label: 'Sonnet', hint: 'equilíbrio' },
  { id: 'haiku', label: 'Haiku', hint: 'rápido e barato' },
] as const;

/** Como o Claude roda numa sessão: o equivalente às flags do CLI. */
export interface SessionSettings {
  permissionMode: PermissionMode;
  /** null = padrão da conta (settings.json). */
  model: string | null;
  effort: Effort | null;
  /** Subagente usado como agente principal (--agent). */
  agent: string | null;
  fallbackModel: string | null;
  /** Pastas fora da pasta da sessão que o Claude também pode acessar (--add-dir). */
  addDirs: string[];
  /** Limite de gasto por execução em segundo plano (--max-budget-usd). */
  maxBudgetUsd: number | null;
}

export interface Workspace {
  id: string;
  name: string;
  rootPath: string;
  /** Prefixo dos identificadores das issues, ex.: CUR → CUR-12 */
  key: string;
  scanDepth: number;
  issueCounter: number;
  /** Diretrizes do agente para o workspace inteiro (equivalente ao "agent guidance" do Linear). */
  guidance: string;
  defaultAccountId: string | null;
  defaultPermissionMode: PermissionMode;
  defaultModel: string | null;
  defaultEffort: Effort | null;
  createdAt: string;
  scannedAt: string | null;
}

export interface Repo {
  id: string;
  workspaceId: string;
  name: string;
  /** Caminho relativo à raiz do workspace ('.' quando a própria raiz é um repo). */
  relPath: string;
  absPath: string;
  branch: string | null;
  remoteUrl: string | null;
  lastCommitAt: string | null;
  lastCommitMessage: string | null;
  /** Arquivos alterados/não rastreados; null quando o git não respondeu a tempo. */
  dirty: number | null;
  ahead: number | null;
  behind: number | null;
  stack: string[];
  packageManager: string | null;
  scripts: string[];
  description: string | null;
  hasClaudeMd: boolean;
  hasAgentsMd: boolean;
}

export interface ClaudeAccount {
  id: string;
  name: string;
  /** null = conta padrão do Claude Code (~/.claude), sem CLAUDE_CONFIG_DIR. */
  configDir: string | null;
  color: string;
  createdAt: string;
}

export interface AccountStatus {
  accountId: string;
  loggedIn: boolean;
  email: string | null;
  orgName: string | null;
  subscriptionType: string | null;
  authMethod: string | null;
  configDirectory: string | null;
  error: string | null;
  checkedAt: string;
}

export type HistoryKind = 'created' | 'status' | 'priority' | 'delegate' | 'repos' | 'session';

export interface HistoryEntry {
  id: string;
  ts: string;
  kind: HistoryKind;
  actor: string;
  text: string;
}

export interface Issue {
  id: string;
  workspaceId: string;
  number: number;
  identifier: string;
  title: string;
  description: string;
  status: IssueStatus;
  priority: Priority;
  repoIds: string[];
  /** Conta do Claude a quem a issue foi delegada (o "Delegate" do Linear). */
  delegateAccountId: string | null;
  /**
   * Uma sessão concluiu enquanto outra desta issue ainda rodava: a issue vai para Em revisão
   * quando a última terminar, seja como for (concluída, com erro ou interrompida).
   */
  reviewPending: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  history: HistoryEntry[];
}

/** Estados de uma sessão de agente, inspirados no AgentSession do Linear. */
export type SessionState = 'pending' | 'active' | 'awaiting_input' | 'complete' | 'error' | 'stopped' | 'terminal';

export type SessionMode = 'headless' | 'terminal';

export interface PermissionDenial {
  tool: string;
  input: Record<string, unknown>;
  /** Regra sugerida para --allowedTools, ex.: Bash(npm test) */
  rule: string;
}

export interface AgentSession extends SessionSettings {
  id: string;
  workspaceId: string;
  issueId: string | null;
  accountId: string;
  /** ID da conversa no Claude Code (usado em --resume). */
  claudeSessionId: string;
  mode: SessionMode;
  state: SessionState;
  /** Modelo que o Claude Code informou ao iniciar a última execução. */
  activeModel?: string | null;
  title: string;
  cwd: string;
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
  costUsd: number;
  durationMs: number;
  turns: number;
  touchedRepoIds: string[];
  pendingDenials: PermissionDenial[];
  lastError: string | null;
  /**
   * Quando o Octo registrou o que já estava alterado (sem commit) nos repositórios, no início da
   * sessão. Com ele, a aba Mudanças marca `preexisting`. Ausente em sessões antigas.
   */
  baselineAt?: string | null;
}

export type ActivityType = 'prompt' | 'thought' | 'message' | 'action' | 'result' | 'system' | 'error' | 'response';

export interface Activity {
  id: string;
  sessionId: string;
  ts: string;
  type: ActivityType;
  /** Texto principal (markdown para message/response/prompt). */
  text: string;
  /** Para ações: nome da ferramenta e resumo legível. */
  tool?: string;
  toolUseId?: string;
  detail?: string;
  isError?: boolean;
  /** Repositórios afetados por esta ação. */
  repoIds?: string[];
}

export interface AppState {
  workspaces: Workspace[];
  repos: Repo[];
  accounts: ClaudeAccount[];
  accountStatus: Record<string, AccountStatus>;
  issues: Issue[];
  sessions: AgentSession[];
  preferences: Preferences;
  meta: AppMeta;
}

/** Preferências do app inteiro (não dependem do workspace). */
export interface Preferences {
  /** Onde o Claude interativo e o "terminal aqui" abrem (cmd, powershell, iterm…); null = o padrão do sistema. */
  terminal: string | null;
  /** Editor de "Abrir no editor" (vscode, cursor…); null = o primeiro instalado. */
  editor: string | null;
  /** Avisar quando houver versão nova (consulta as releases do GitHub). */
  checkUpdates: boolean;
}

export interface UpdateInfo {
  current: string;
  latest: string;
  /** Página da release no GitHub. */
  url: string;
  available: boolean;
}

/** Um terminal ou editor encontrado neste computador. */
export interface IntegrationOption {
  id: string;
  label: string;
  hint: string;
}

export interface Integrations {
  terminals: IntegrationOption[];
  editors: IntegrationOption[];
  /** Os ids efetivamente usados hoje (preferência ou o padrão disponível). */
  terminal: string | null;
  editor: string | null;
}

// ---------------------------------------------------------------- mudanças (git diff) de uma sessão ou pasta

export type FileChangeStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflict';

export interface FileChange {
  path: string;
  /** Caminho anterior, quando o arquivo foi renomeado. */
  oldPath: string | null;
  status: FileChangeStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  /** Diff unificado do arquivo ('' quando binário ou cortado por tamanho). */
  patch: string;
  /**
   * Só nas mudanças de uma sessão: true quando o arquivo já tinha alterações sem commit no
   * momento em que a sessão começou (e não mudou desde então); false quando a mudança é desta
   * sessão. Ausente quando não há registro do início (sessões antigas, mudanças de pasta).
   */
  preexisting?: boolean;
}

export interface RepoChanges {
  repoId: string;
  name: string;
  absPath: string;
  branch: string | null;
  files: FileChange[];
  /** O diff era grande demais e parte dos arquivos veio sem o conteúdo (ou ficou de fora). */
  truncated: boolean;
  /** Arquivos alterados que nem entraram na lista, por serem muitos (ex.: dependências fora do .gitignore). */
  omittedFiles?: number;
  error: string | null;
}

export interface AppMeta {
  /** Versão do Octo (package.json). */
  version: string;
  platform: string;
  home: string;
  suggestedRoot: string | null;
  claudeBin: string | null;
  claudeVersion: string | null;
  /** Por que o Claude Code não pode ser usado (não instalado, atualização quebrada…). */
  claudeProblem: string | null;
  /** O `claude` do terminal está quebrado, mas o Octo achou outro executável que funciona. */
  claudeWarning: string | null;
  dataDir: string;
  /** O db.json estava danificado ao abrir: o que o Octo fez (restaurou a cópia ou começou vazio). */
  dbNotice?: string | null;
}

export type ServerEvent =
  | { type: 'workspace'; workspace: Workspace }
  | { type: 'workspace.deleted'; id: string }
  | { type: 'repos'; workspaceId: string; repos: Repo[] }
  | { type: 'account'; account: ClaudeAccount }
  | { type: 'account.deleted'; id: string }
  | { type: 'account.status'; status: AccountStatus }
  | { type: 'issue'; issue: Issue }
  | { type: 'issue.deleted'; id: string }
  | { type: 'session'; session: AgentSession }
  | { type: 'activity'; activity: Activity }
  | { type: 'preferences'; preferences: Preferences };

// ---------------------------------------------------------------- configuração do Claude Code por conta

export type ClaudeItemKind = 'skill' | 'agent' | 'command';
/** user = pasta da conta; plugin = vem de um plugin instalado; project = .claude/ da pasta da sessão. */
export type ClaudeItemSource = 'user' | 'plugin' | 'project';

export interface ClaudeItem {
  kind: ClaudeItemKind;
  /** Nome como o Claude Code o chama: `revisar`, ou `plugin:revisar` para itens de plugin. */
  name: string;
  description: string;
  source: ClaudeItemSource;
  plugin: string | null;
  /** SKILL.md da skill ou o .md do agente/comando. */
  path: string;
  /** Pode ser chamado como /nome. */
  userInvocable: boolean;
  /** Só roda quando você chama (disable-model-invocation). */
  manualOnly: boolean;
  model: string | null;
}

export interface McpServerInfo {
  name: string;
  scope: 'user' | 'plugin';
  plugin: string | null;
  type: string;
  /** Comando (stdio) ou URL (http/sse); valores de env e headers nunca saem do servidor. */
  target: string;
}

export interface PluginInfo {
  id: string;
  version: string | null;
  enabled: boolean;
  scope: string;
  installPath: string | null;
  mcpServers: string[];
}

export interface AvailablePlugin {
  id: string;
  name: string;
  description: string;
  marketplace: string;
  installs: number | null;
}

export interface AccountConfig {
  accountId: string;
  configDir: string;
  settingsFile: string;
  /** Conteúdo bruto do settings.json ('' se não existir). */
  settingsRaw: string;
  settings: Record<string, unknown> | null;
  settingsError: string | null;
  items: ClaudeItem[];
  mcpServers: McpServerInfo[];
  plugins: PluginInfo[];
  pluginsError: string | null;
}
