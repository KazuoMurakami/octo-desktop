import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type {
  Activity, AgentSession, ClaudeAccount, Issue, PermissionDenial, Repo, SessionSettings, Workspace,
} from '../shared/types.ts';
import { claudeEnv, requireClaude } from './claude.ts';
import { broadcast } from './events.ts';
import { addHistory, commitIssue, commitSession, now, workspaceRepos } from './model.ts';
import { appendActivity, db, readActivities, writeActivities } from './store.ts';
import { openClaudeTerminal } from './terminal.ts';

interface Run {
  child: ChildProcess;
  stopped: boolean;
  gotResult: boolean;
  stderr: string;
  lastMessage: Activity | null;
}

const runs = new Map<string, Run>();

export function isRunning(sessionId: string): boolean {
  return runs.has(sessionId);
}

// ---------------------------------------------------------------- prompts

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Pasta onde a sessão roda: a menor pasta que contém todos os repositórios da issue.
 * Ex.: loja-api + loja-web → loja/ (igual a abrir essa pasta e rodar `claude`).
 */
export function sessionCwd(workspace: Workspace, repoIds: string[]): string {
  const focus = workspaceRepos(workspace.id).filter((r) => repoIds.includes(r.id));
  if (!focus.length) return workspace.rootPath;
  let common = focus[0].absPath.split(path.sep);
  for (const repo of focus.slice(1)) {
    const parts = repo.absPath.split(path.sep);
    let i = 0;
    while (i < common.length && i < parts.length && samePath(common[i], parts[i])) i++;
    common = common.slice(0, i);
  }
  const joined = common.join(path.sep) || workspace.rootPath;
  return isInside(workspace.rootPath, joined) ? joined : workspace.rootPath;
}

function relFrom(cwd: string, target: string): string {
  const relative = path.relative(cwd, target).split(path.sep).join('/');
  return relative ? `./${relative}` : './';
}

/** Contexto anexado ao system prompt: é o que dá ao Claude a visão de todos os repos de uma vez. */
export function workspaceSystemPrompt(workspace: Workspace, cwd: string): string {
  const repos = workspaceRepos(workspace.id);
  const inside = repos.filter((r) => isInside(cwd, r.absPath));
  const outside = repos.filter((r) => !isInside(cwd, r.absPath));
  const describe = (repo: Repo) => {
    const bits = [repo.stack.slice(0, 4).join(', '), repo.branch && `branch ${repo.branch}`].filter(Boolean).join(' · ');
    return `- ${repo.name}: ${relFrom(cwd, repo.absPath)}${bits ? ` (${bits})` : ''}`;
  };
  const atRoot = samePath(cwd, workspace.rootPath);
  return [
    'Você foi iniciado pelo Octo, um gerenciador local de issues.',
    atRoot
      ? `O diretório atual é a RAIZ do workspace "${workspace.name}", uma pasta com ${repos.length} repositórios git independentes (não é um monorepo):`
      : `O diretório atual (${relFrom(workspace.rootPath, cwd)} dentro do workspace "${workspace.name}", raiz ${workspace.rootPath}) contém ${inside.length} repositório(s) git independente(s):`,
    ...inside.map(describe),
    ...(outside.length ? ['', `Outros repositórios do workspace, fora da pasta atual: ${outside.map((r) => r.name).join(', ')}.`] : []),
    '',
    'Regras do workspace:',
    '- Cada repositório tem seu próprio git: rode comandos git dentro dele (ex.: git -C <repo> status). Nunca rode git init numa pasta que agrupa repositórios.',
    '- Instale dependências e rode scripts dentro da pasta do repositório correspondente.',
    '- Antes de mudar um repositório, leia o CLAUDE.md ou AGENTS.md dele, se existir.',
    '- Não faça commit, push ou operações destrutivas a menos que a issue peça explicitamente.',
    '- Ao terminar, responda com um resumo curto: o que mudou em cada repositório e os próximos passos.',
    '- Responda em português do Brasil.',
    workspace.guidance.trim() ? `\nDiretrizes do workspace definidas pelo usuário:\n${workspace.guidance.trim()}` : '',
  ].join('\n');
}

export function issuePrompt(issue: Issue, repos: Repo[], cwd: string, extra: string): string {
  const focus = repos.filter((r) => issue.repoIds.includes(r.id));
  return [
    `# ${issue.identifier}: ${issue.title}`,
    '',
    issue.description.trim() || '_Sem descrição._',
    '',
    '## Repositórios em foco',
    focus.length
      ? focus.map((r) => `- ${r.name} → ${relFrom(cwd, r.absPath)}`).join('\n')
      : '- Nenhum marcado. Descubra pelo contexto quais repositórios do workspace são relevantes.',
    extra.trim() ? `\n## Instruções adicionais\n${extra.trim()}` : '',
  ].join('\n');
}

// ---------------------------------------------------------------- activities

function emit(session: AgentSession, activity: Omit<Activity, 'id' | 'sessionId' | 'ts'> & { id?: string }): Activity {
  const full: Activity = { id: activity.id ?? randomUUID(), sessionId: session.id, ts: now(), ...activity };
  appendActivity(full);
  broadcast({ type: 'activity', activity: full });
  return full;
}

/** Lê o histórico da sessão; reemissões com o mesmo id substituem a versão anterior. */
export function sessionActivities(sessionId: string): Activity[] {
  const byId = new Map<string, Activity>();
  for (const activity of readActivities(sessionId)) byId.set(activity.id, activity);
  return [...byId.values()];
}

function normalize(p: string): string {
  const s = path.resolve(p).replace(/\\/g, '/');
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

/** Mapeia caminhos/comandos de uma ferramenta para os repositórios tocados. */
function touchedRepos(session: AgentSession, input: Record<string, any>): string[] {
  const repos = workspaceRepos(session.workspaceId);
  const ids = new Set<string>();
  for (const key of ['file_path', 'path', 'notebook_path']) {
    const value = input[key];
    if (typeof value !== 'string' || !value) continue;
    const target = normalize(path.resolve(session.cwd, value));
    let best: Repo | null = null;
    for (const repo of repos) {
      const root = normalize(repo.absPath);
      if ((target === root || target.startsWith(`${root}/`)) && (!best || root.length > normalize(best.absPath).length)) best = repo;
    }
    if (best) ids.add(best.id);
  }
  if (typeof input.command === 'string') {
    // Comandos citam repos pelo caminho relativo à pasta da sessão (ex.: `cd loja-api`, `git -C ./loja-api`).
    const command = input.command.replace(/\\/g, '/');
    for (const repo of repos) {
      const rel = path.relative(session.cwd, repo.absPath).split(path.sep).join('/');
      if (!rel || rel.startsWith('..')) continue;
      const escaped = rel.replace(/[.*+?^${}()|[\]]/g, '\\$&');
      if (new RegExp(`(^|[\\s"'=]|\\./)${escaped}(?=$|[\\s"'/;&|])`, 'i').test(command)) ids.add(repo.id);
    }
  }
  return [...ids];
}

function rel(session: AgentSession, p: unknown): string {
  if (typeof p !== 'string') return '';
  const relative = path.relative(session.cwd, p);
  return (relative && !relative.startsWith('..') ? relative : p).replace(/\\/g, '/');
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function summarizeTool(session: AgentSession, name: string, input: Record<string, any>): { text: string; detail?: string } {
  switch (name) {
    case 'Read':
      return { text: `Leu ${rel(session, input.file_path)}` };
    case 'Write':
      return { text: `Criou ${rel(session, input.file_path)}` };
    case 'Edit':
    case 'MultiEdit':
      return { text: `Editou ${rel(session, input.file_path)}`, detail: typeof input.new_string === 'string' ? clip(input.new_string, 1200) : undefined };
    case 'NotebookEdit':
      return { text: `Editou notebook ${rel(session, input.notebook_path)}` };
    case 'Bash':
    case 'PowerShell':
      return { text: input.description ? String(input.description) : 'Rodou um comando', detail: clip(String(input.command ?? ''), 2000) };
    case 'Glob':
      return { text: `Buscou arquivos ${input.pattern}${input.path ? ` em ${rel(session, input.path)}` : ''}` };
    case 'Grep':
      return { text: `Procurou "${clip(String(input.pattern), 80)}"${input.path ? ` em ${rel(session, input.path)}` : ''}` };
    case 'WebFetch':
      return { text: `Abriu ${input.url}` };
    case 'WebSearch':
      return { text: `Pesquisou "${input.query}"` };
    case 'Task':
    case 'Agent':
      return { text: `Delegou a um subagente: ${input.description ?? input.subagent_type ?? ''}`, detail: clip(String(input.prompt ?? ''), 1500) };
    case 'TodoWrite':
      return {
        text: 'Atualizou o plano',
        detail: Array.isArray(input.todos)
          ? input.todos.map((t: any) => `${t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▸' : '○'} ${t.content}`).join('\n')
          : undefined,
      };
    default:
      return { text: name, detail: clip(JSON.stringify(input, null, 2), 1500) };
  }
}

function denialRule(tool: string, input: Record<string, any>): string {
  if ((tool === 'Bash' || tool === 'PowerShell') && typeof input.command === 'string') return `${tool}(${input.command})`;
  return tool;
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c?.type === 'text' ? c.text : `[${c?.type ?? 'conteúdo'}]`)).join('\n');
  return '';
}

/** Converte uma linha do stream-json do Claude Code em atividades. */
function handleEvent(session: AgentSession, run: Run | null, event: any): void {
  if (!db.sessions.includes(session)) return; // workspace/issue apagado durante a execução
  if (event.type === 'system' && event.subtype === 'init') {
    // O modelo escolhido (ex.: "opus" ou o padrão da conta) continua em session.model; aqui fica o que rodou de fato.
    session.activeModel = event.model ?? null;
    const effort = session.effort ? ` · effort ${session.effort}` : '';
    emit(session, { type: 'system', text: `Sessão iniciada · ${event.model ?? 'modelo padrão'}${effort} · ${event.permissionMode ?? session.permissionMode}` });
    commitSession(session);
    return;
  }

  if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
    const nested = Boolean(event.parent_tool_use_id);
    for (const block of event.message.content) {
      if (block.type === 'text' && block.text?.trim()) {
        const activity = emit(session, { type: 'message', text: block.text, detail: nested ? 'subagente' : undefined });
        if (run && !nested) run.lastMessage = activity;
      } else if (block.type === 'thinking' && block.thinking?.trim()) {
        emit(session, { type: 'thought', text: block.thinking });
      } else if (block.type === 'tool_use') {
        const input = (block.input ?? {}) as Record<string, any>;
        const summary = summarizeTool(session, block.name, input);
        const repoIds = touchedRepos(session, input);
        const fresh = repoIds.filter((id) => !session.touchedRepoIds.includes(id));
        if (fresh.length) {
          session.touchedRepoIds.push(...fresh);
          commitSession(session);
        }
        emit(session, { type: 'action', tool: block.name, toolUseId: block.id, text: summary.text, detail: summary.detail, repoIds });
      }
    }
    return;
  }

  if (event.type === 'user' && Array.isArray(event.message?.content)) {
    for (const block of event.message.content) {
      if (block.type !== 'tool_result') continue;
      emit(session, {
        type: 'result',
        toolUseId: block.tool_use_id,
        text: clip(resultText(block.content), 4000),
        isError: Boolean(block.is_error),
      });
    }
    return;
  }

  if (event.type === 'result') {
    if (run) run.gotResult = true;
    session.costUsd += Number(event.total_cost_usd ?? 0);
    session.durationMs += Number(event.duration_ms ?? 0);
    session.turns += Number(event.num_turns ?? 0);
    const denials: PermissionDenial[] = (event.permission_denials ?? []).map((d: any) => ({
      tool: d.tool_name,
      input: d.tool_input ?? {},
      rule: denialRule(d.tool_name, d.tool_input ?? {}),
    }));
    session.pendingDenials = denials;

    const failed = event.is_error || (event.subtype && event.subtype !== 'success');
    if (failed) {
      session.state = 'error';
      session.lastError = typeof event.result === 'string' && event.result ? event.result : `Execução terminou com "${event.subtype}".`;
      emit(session, { type: 'error', text: session.lastError ?? 'Erro' });
    } else {
      const text = typeof event.result === 'string' ? event.result : '';
      // O texto final repete a última mensagem: promovemos essa mensagem a "resposta".
      if (run?.lastMessage && run.lastMessage.text.trim() === text.trim()) {
        emit(session, { ...run.lastMessage, type: 'response' });
      } else if (text.trim()) {
        emit(session, { type: 'response', text });
      }
      session.state = denials.length ? 'awaiting_input' : 'complete';
      session.lastError = null;
    }
    session.endedAt = now();
    commitSession(session);
    onSessionSettled(session);
  }
}

/** Automação de status no estilo Linear: delegar → Em andamento; agente terminou → Em revisão. */
function onSessionSettled(session: AgentSession): void {
  const issue = session.issueId ? db.issues.find((i) => i.id === session.issueId) : null;
  if (!issue) return;
  const account = db.accounts.find((a) => a.id === session.accountId);
  const actor = account?.name ?? 'Claude';
  if (session.state === 'complete') {
    if (issue.status === 'in_progress') {
      issue.status = 'in_review';
      addHistory(issue, 'status', actor, 'moveu para Em revisão ao concluir a sessão');
    } else {
      addHistory(issue, 'session', actor, 'concluiu a sessão');
    }
  } else if (session.state === 'awaiting_input') {
    addHistory(issue, 'session', actor, `aguarda permissão para ${session.pendingDenials.length} ação(ões)`);
  } else if (session.state === 'error') {
    addHistory(issue, 'session', actor, 'encerrou a sessão com erro');
  }
  commitIssue(issue);
}

// ---------------------------------------------------------------- execução headless

interface StartOptions {
  workspace: Workspace;
  issue: Issue | null;
  account: ClaudeAccount;
  settings: SessionSettings;
  extraInstructions: string;
  /** Pasta da sessão; por padrão, a menor pasta comum aos repositórios da issue. */
  cwd?: string;
}

function createSession(options: StartOptions, mode: AgentSession['mode']): AgentSession {
  const cwd = options.cwd ?? sessionCwd(options.workspace, options.issue?.repoIds ?? []);
  const title = options.issue ? `${options.issue.identifier} · ${options.issue.title}` : `Sessão em ${path.basename(cwd)}`;
  const session: AgentSession = {
    id: randomUUID(),
    workspaceId: options.workspace.id,
    issueId: options.issue?.id ?? null,
    accountId: options.account.id,
    claudeSessionId: randomUUID(),
    mode,
    state: mode === 'terminal' ? 'terminal' : 'pending',
    ...options.settings,
    title,
    cwd,
    startedAt: now(),
    updatedAt: now(),
    endedAt: null,
    costUsd: 0,
    durationMs: 0,
    turns: 0,
    touchedRepoIds: [],
    pendingDenials: [],
    lastError: null,
  };
  return session;
}

function markDelegated(issue: Issue, account: ClaudeAccount, how: string): void {
  if (issue.delegateAccountId !== account.id) {
    issue.delegateAccountId = account.id;
    addHistory(issue, 'delegate', 'Você', `delegou para ${account.name}`);
  }
  if (issue.status === 'backlog' || issue.status === 'todo') {
    issue.status = 'in_progress';
    addHistory(issue, 'status', account.name, 'moveu para Em andamento');
  }
  addHistory(issue, 'session', account.name, how);
  commitIssue(issue);
}

export function startHeadless(options: StartOptions): AgentSession {
  requireClaude(); // falha antes de registrar a sessão ou mexer no status da issue
  const session = createSession(options, 'headless');
  db.sessions.push(session);
  const repos = workspaceRepos(options.workspace.id);
  const prompt = options.issue ? issuePrompt(options.issue, repos, session.cwd, options.extraInstructions) : options.extraInstructions;
  if (options.issue) markDelegated(options.issue, options.account, 'iniciou uma sessão em segundo plano');

  const args = [
    '--session-id', session.claudeSessionId,
    '--name', session.title.slice(0, 80),
    '--append-system-prompt', workspaceSystemPrompt(options.workspace, session.cwd),
  ];
  run(session, options.account, prompt, args, []);
  return session;
}

/** Continua a conversa; `changes` troca modelo, effort etc. a partir desta mensagem (como o /model do CLI). */
export function sendMessage(session: AgentSession, text: string, allowedTools: string[], changes: Partial<SessionSettings> = {}): void {
  if (runs.has(session.id)) throw new Error('A sessão ainda está em execução.');
  const account = db.accounts.find((a) => a.id === session.accountId);
  if (!account) throw new Error('A conta desta sessão foi removida.');
  requireClaude();
  Object.assign(session, changes);
  if (session.mode === 'terminal') session.mode = 'headless';
  session.pendingDenials = [];
  run(session, account, text, ['--resume', session.claudeSessionId], allowedTools);
}

/** As configurações da sessão como flags do `claude`. */
function settingsArgs(session: AgentSession, print: boolean): string[] {
  const args: string[] = [];
  // --add-dir aceita vários valores: vem primeiro e é seguido de outra opção, para não engolir o prompt.
  const dirs = (session.addDirs ?? []).filter((dir) => existsSync(dir));
  if (dirs.length) args.push('--add-dir', ...dirs);
  args.push('--permission-mode', session.permissionMode);
  if (session.model) args.push('--model', session.model);
  if (session.effort) args.push('--effort', session.effort);
  if (session.agent) args.push('--agent', session.agent);
  if (session.fallbackModel) args.push('--fallback-model', session.fallbackModel);
  if (print && session.maxBudgetUsd) args.push('--max-budget-usd', String(session.maxBudgetUsd));
  return args;
}

function run(session: AgentSession, account: ClaudeAccount, prompt: string, extraArgs: string[], allowedTools: string[]): void {
  const claude = requireClaude();
  const args = [
    ...claude.prefixArgs,
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    ...settingsArgs(session, true),
    ...extraArgs,
  ];
  if (allowedTools.length) args.push('--allowedTools', ...allowedTools);

  emit(session, { type: 'prompt', text: prompt, detail: allowedTools.length ? `Permitido: ${allowedTools.join(', ')}` : undefined });
  session.state = 'active';
  session.endedAt = null;
  session.lastError = null;
  commitSession(session);

  const child = spawn(claude.command, args, {
    cwd: session.cwd,
    env: claudeEnv(account),
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const state: Run = { child, stopped: false, gotResult: false, stderr: '', lastMessage: null };
  runs.set(session.id, state);

  // O prompt vai pelo stdin: sem limite de tamanho de linha de comando e sem problemas de escape.
  child.stdin?.end(prompt);

  createInterface({ input: child.stdout! }).on('line', (line) => {
    if (!line.trim()) return;
    try {
      handleEvent(session, state, JSON.parse(line));
    } catch {
      // Linhas que não são JSON (avisos) são ignoradas.
    }
  });
  child.stderr?.on('data', (chunk) => {
    state.stderr = (state.stderr + chunk.toString()).slice(-4000);
  });
  child.on('error', (error) => finish(session, state, null, error.message));
  child.on('close', (code) => finish(session, state, code, null));
}

function finish(session: AgentSession, state: Run, code: number | null, spawnError: string | null): void {
  if (runs.get(session.id) !== state) return;
  runs.delete(session.id);
  if (state.gotResult || !db.sessions.includes(session)) return;
  session.endedAt = now();
  if (state.stopped) {
    session.state = 'stopped';
    emit(session, { type: 'system', text: 'Sessão interrompida por você.' });
  } else {
    session.state = 'error';
    session.lastError = spawnError ?? (state.stderr.trim().split('\n').slice(-6).join('\n') || `Claude Code saiu com código ${code}.`);
    emit(session, { type: 'error', text: session.lastError });
  }
  commitSession(session);
  onSessionSettled(session);
}

/**
 * "Concluir assim mesmo": o agente terminou, mas alguma ação foi bloqueada no caminho e ele
 * resolveu sem ela. A sessão vira concluída (e a issue vai para revisão) sem liberar nada.
 */
export function dismissDenials(session: AgentSession): void {
  if (runs.has(session.id)) throw new Error('A sessão ainda está em execução.');
  if (session.state !== 'awaiting_input') return;
  session.pendingDenials = [];
  session.state = 'complete';
  emit(session, { type: 'system', text: 'Concluída sem liberar as ações bloqueadas.' });
  commitSession(session);
  onSessionSettled(session);
}

export function stopSession(session: AgentSession): void {
  const state = runs.get(session.id);
  if (!state) return;
  state.stopped = true;
  const pid = state.child.pid;
  if (process.platform === 'win32' && pid) {
    // Encerra também os processos filhos (ex.: um `npm run dev` iniciado pelo agente).
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
  } else {
    state.child.kill('SIGTERM');
  }
}

// ---------------------------------------------------------------- terminal interativo

export function startInTerminal(options: StartOptions): AgentSession {
  const session = createSession(options, 'terminal');
  const repos = workspaceRepos(options.workspace.id);
  const prompt = options.issue ? issuePrompt(options.issue, repos, session.cwd, options.extraInstructions) : options.extraInstructions;

  const args = [
    ...settingsArgs(session, false),
    '--session-id', session.claudeSessionId,
    '--name', session.title.slice(0, 80),
    '--append-system-prompt', workspaceSystemPrompt(options.workspace, session.cwd),
  ];
  // "--" encerra as opções: um prompt que começa com "-" (ex.: uma lista) continua sendo o prompt.
  if (prompt.trim()) args.push('--', prompt);

  openClaudeTerminal({
    cwd: session.cwd,
    account: options.account,
    args,
    title: `Octo · ${session.title}`,
    banner: `Octo · ${options.account.name} · ${session.cwd}`,
  });
  // Só registra depois que o terminal abriu de fato.
  db.sessions.push(session);
  if (options.issue) markDelegated(options.issue, options.account, 'abriu uma sessão no terminal');
  emit(session, { type: 'prompt', text: prompt || '_Sessão interativa aberta no terminal._' });
  emit(session, { type: 'system', text: 'Aberta no terminal. Use "Sincronizar" para trazer o andamento para cá.' });
  commitSession(session);
  return session;
}

export function resumeInTerminal(session: AgentSession): void {
  if (runs.has(session.id)) throw new Error('Pare a execução em segundo plano antes de abrir no terminal.');
  const account = db.accounts.find((a) => a.id === session.accountId) ?? null;
  openClaudeTerminal({
    cwd: session.cwd,
    account,
    args: ['--resume', session.claudeSessionId, ...settingsArgs(session, false)],
    title: `Octo · ${session.title}`,
    banner: `Octo · retomando ${session.title}`,
  });
  session.mode = 'terminal';
  session.state = 'terminal';
  emit(session, { type: 'system', text: 'Sessão retomada no terminal.' });
  commitSession(session);
}

/** Lê o transcript que o Claude Code grava em <config>/projects/<pasta>/<id>.jsonl. */
function findTranscript(session: AgentSession): string | null {
  const account = db.accounts.find((a) => a.id === session.accountId);
  const configDir = account?.configDir ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.claude');
  const projects = path.join(configDir, 'projects');
  if (!existsSync(projects)) return null;
  for (const dir of readdirSync(projects)) {
    const file = path.join(projects, dir, `${session.claudeSessionId}.jsonl`);
    if (existsSync(file)) return file;
  }
  return null;
}


/**
 * Reconstrói o feed a partir do transcript da sessão — permite trabalhar no terminal
 * (como você já faz) e ainda ver o andamento na issue.
 */
export function syncFromTranscript(session: AgentSession): number {
  const file = findTranscript(session);
  if (!file) return 0;
  const activities: Activity[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if ((entry.type === 'user' || entry.type === 'assistant') && !entry.isMeta) activities.push(...fromTranscriptEntry(session, entry));
  }
  if (!activities.length) return 0;
  const last = activities.at(-1)!;
  if (last.type === 'message') last.type = 'response';
  writeActivities(session.id, activities);
  commitSession(session);
  return activities.length;
}

function fromTranscriptEntry(session: AgentSession, entry: any): Activity[] {
  const base = { sessionId: session.id, ts: entry.timestamp ?? now() };
  const content = entry.message?.content;
  if (typeof content === 'string') {
    // Saídas de comandos locais (/model, /clear...) vêm como tags; não são prompts reais.
    if (entry.type !== 'user' || content.trimStart().startsWith('<')) return [];
    return [{ ...base, id: entry.uuid ?? randomUUID(), type: 'prompt', text: content }];
  }
  if (!Array.isArray(content)) return [];
  const out: Activity[] = [];
  content.forEach((block: any, index: number) => {
    const id = `${entry.uuid ?? randomUUID()}:${index}`;
    if (block.type === 'text' && block.text?.trim()) {
      if (entry.type === 'user' && block.text.trimStart().startsWith('<')) return;
      out.push({ ...base, id, type: entry.type === 'user' ? 'prompt' : 'message', text: block.text });
    } else if (block.type === 'thinking' && block.thinking?.trim()) {
      out.push({ ...base, id, type: 'thought', text: block.thinking });
    } else if (block.type === 'tool_use') {
      const input = block.input ?? {};
      const summary = summarizeTool(session, block.name, input);
      const repoIds = touchedRepos(session, input);
      for (const repoId of repoIds) if (!session.touchedRepoIds.includes(repoId)) session.touchedRepoIds.push(repoId);
      out.push({ ...base, id, type: 'action', tool: block.name, toolUseId: block.id, text: summary.text, detail: summary.detail, repoIds });
    } else if (block.type === 'tool_result') {
      out.push({ ...base, id, type: 'result', toolUseId: block.tool_use_id, text: clip(resultText(block.content), 4000), isError: Boolean(block.is_error) });
    }
  });
  return out;
}
