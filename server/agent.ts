import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import {
  EFFORT_LABEL, PERMISSION_LABEL,
  type Activity, type AgentSession, type ClaudeAccount, type Issue, type PermissionDenial, type PermissionMode, type Repo, type SessionSettings,
  type Workspace, type Worktree,
} from '../shared/types.ts';
import { bashParts, blockedActions } from '../shared/permissions.ts';
import { dirtyEntries } from './changes.ts';
import { claudeEnv, requireClaude, type ClaudeCommand } from './claude.ts';
import { broadcast } from './events.ts';
import { imageBlocks, saveImages, saveTranscriptImages, type ParsedImage } from './images.ts';
import { HttpError, addHistory, commitIssue, commitSession, now, requireFolder, workspaceRepos } from './model.ts';
import { describeRepos } from './scanner.ts';
import { appendActivity, db, denialInput, readActivities, save, writeActivities, writeBaseline } from './store.ts';
import { cutPoint, describeSpawnError, fitsCommandLine, shrinkToFit } from './system.ts';
import { openClaudeTerminal } from './terminal.ts';
import { sessionRepos, worktreeCwd } from './worktrees.ts';

interface Run {
  child: ChildProcess;
  stopped: boolean;
  gotResult: boolean;
  stderr: string;
  lastMessage: Activity | null;
  /** SIGKILL agendado depois do Parar (macOS/Linux), caso o processo não saia sozinho. */
  killTimer: NodeJS.Timeout | null;
  /** Resolve quando o processo termina de vez (depois do resultado, ele ainda roda os hooks do fim e grava o transcript). */
  closed: Promise<void>;
  markClosed: () => void;
}

const runs = new Map<string, Run>();

/** Sessões cujo terminal está abrindo (resumeInTerminal esperando a janela). */
const opening = new Set<string>();

export function isRunning(sessionId: string): boolean {
  return runs.has(sessionId);
}

/** Ainda trabalhando: uma execução que já entregou o resultado só está saindo. */
function working(sessionId: string): boolean {
  const run = runs.get(sessionId);
  return Boolean(run && !run.gotResult);
}

export { working as isWorking };

/** Quanto esperar o Claude sair depois de já ter respondido (hooks do fim da sessão, gravação do transcript). */
const EXIT_GRACE = 20_000;

/**
 * Uma execução que já respondeu, mas cujo processo ainda está saindo: espera ele terminar (até
 * EXIT_GRACE), em vez de recusar quem responde logo depois da resposta aparecer. Com o Claude ainda
 * trabalhando (ou sem execução), volta na hora.
 */
export async function settleRun(sessionId: string): Promise<void> {
  const run = runs.get(sessionId);
  if (!run?.gotResult) return;
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([run.closed, new Promise<void>((resolve) => (timer = setTimeout(resolve, EXIT_GRACE)))]);
  clearTimeout(timer);
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
export function workspaceSystemPrompt(workspace: Workspace, cwd: string, worktree: Worktree | null = null): string {
  return workspaceContext(workspace, cwd, worktree).text;
}

/** O contexto do workspace e o começo dele que um corte nunca tira. */
interface WorkspaceContext {
  text: string;
  /** Tamanho do começo com as regras do Octo (e as do worktree): o corte só tira o que vem depois, repositórios e diretrizes. */
  rules: number;
}

/**
 * O contexto do workspace (ver workspaceSystemPrompt). As regras do Octo vêm antes dos repositórios e das
 * diretrizes: se ele não couber na linha de comando, o corte começa pelo fim e nunca chega nelas (ver
 * planRun e fitTerminalArgs).
 */
function workspaceContext(workspace: Workspace, cwd: string, worktree: Worktree | null = null): WorkspaceContext {
  // Num worktree, os repositórios dele aparecem nos caminhos (e na branch) do worktree; os outros, na pasta original.
  const repos = sessionRepos({ workspaceId: workspace.id, worktree });
  const inside = repos.filter((r) => isInside(cwd, r.absPath));
  const outside = repos.filter((r) => !isInside(cwd, r.absPath));
  const describe = (repo: Repo) => {
    const bits = [repo.stack.slice(0, 4).join(', '), repo.branch && `branch ${repo.branch}`].filter(Boolean).join(' · ');
    return `- ${repo.name}: ${relFrom(cwd, repo.absPath)}${bits ? ` (${bits})` : ''}`;
  };
  const atRoot = samePath(cwd, worktree?.root ?? workspace.rootPath);
  const where = worktree
    ? atRoot
      ? `O diretório atual é a raiz do worktree da issue, que espelha o workspace "${workspace.name}" (pasta original: ${workspace.rootPath}). Ele contém ${inside.length} repositório(s) git independente(s) (não é um monorepo):`
      : `O diretório atual (${relFrom(worktree.root, cwd)} no worktree da issue, que espelha o workspace "${workspace.name}"; pasta original: ${workspace.rootPath}) contém ${inside.length} repositório(s) git independente(s):`
    : atRoot
      ? `O diretório atual é a RAIZ do workspace "${workspace.name}", uma pasta com ${repos.length} repositórios git independentes (não é um monorepo):`
      : `O diretório atual (${relFrom(workspace.rootPath, cwd)} dentro do workspace "${workspace.name}", raiz ${workspace.rootPath}) contém ${inside.length} repositório(s) git independente(s):`;
  const rules = [
    'Você foi iniciado pelo Octo, um gerenciador local de issues.',
    '',
    'Regras do workspace:',
    '- Cada repositório tem seu próprio git: rode comandos git dentro dele (ex.: git -C <repo> status). Nunca rode git init numa pasta que agrupa repositórios.',
    '- Instale dependências e rode scripts dentro da pasta do repositório correspondente.',
    '- Antes de mudar um repositório, leia o CLAUDE.md ou AGENTS.md dele, se existir.',
    '- Não faça commit, push ou operações destrutivas a menos que a issue peça explicitamente.',
    '- Ao terminar, responda com um resumo curto: o que mudou em cada repositório e os próximos passos.',
    '- Responda em português do Brasil.',
    ...(worktree ? ['', ...worktreeRules(workspace, worktree)] : []),
  ].join('\n');
  const text = [
    rules,
    '',
    where,
    ...inside.map(describe),
    ...(outside.length ? ['', `Outros repositórios do workspace, fora da pasta atual: ${outside.map((r) => r.name).join(', ')}.`] : []),
    workspace.guidance.trim() ? `\nDiretrizes do workspace definidas pelo usuário:\n${workspace.guidance.trim()}` : '',
  ].join('\n');
  return { text, rules: rules.length };
}

/** Regras de uma sessão num worktree: onde trabalhar e o que não veio da pasta original. */
function worktreeRules(workspace: Workspace, worktree: Worktree): string[] {
  const branches = [...new Set(worktree.repos.map((entry) => entry.branch))];
  const originals = workspaceRepos(workspace.id).filter((r) => worktree.repos.some((entry) => entry.repoId === r.id)).map((r) => r.absPath);
  return [
    'Regras do worktree:',
    `- Esta sessão roda num worktree git que o Octo criou para a issue, em ${worktree.root}: cada repositório aqui é uma cópia de trabalho à parte, ${branches.length === 1 ? `na branch ${branches[0]}` : `nas branches ${branches.join(', ')}`}, e a pasta original dele não é afetada.`,
    `- Trabalhe só dentro do worktree.${originals.length ? ` Nunca mexa nas pastas originais dos repositórios: ${originals.join(', ')}.` : ''}`,
    '- Não troque de branch (git checkout/switch) nem remova o worktree.',
    '- Arquivos fora do git (node_modules, .env, builds) não vêm junto: instale as dependências aqui antes de rodar scripts. Se faltar um .env necessário, avise o usuário (o .worktreeinclude de um repositório lista os arquivos ignorados que são copiados para worktrees novos).',
    '- CLAUDE.md, AGENTS.md, .mcp.json e .claude/ fora dos repositórios são cópias dos originais do workspace, só para contexto: mudanças neles não voltam para o workspace.',
  ];
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

/** Mapeia caminhos/comandos de uma ferramenta para os repositórios tocados (num worktree, pelos caminhos dele). */
function touchedRepos(session: AgentSession, input: Record<string, any>): string[] {
  const repos = sessionRepos(session);
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
  if (!relative) return '.'; // a própria pasta da sessão
  return (!relative.startsWith('..') && !path.isAbsolute(relative) ? relative : p).replace(/\\/g, '/');
}

/** " em pasta" das buscas; nada quando a busca é na própria pasta da sessão. */
function inDir(session: AgentSession, p: unknown): string {
  const where = rel(session, p);
  return where && where !== '.' ? ` em ${where}` : '';
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
      return { text: `Buscou arquivos ${input.pattern}${inDir(session, input.path)}` };
    case 'Grep':
      return { text: `Procurou "${clip(String(input.pattern), 80)}"${inDir(session, input.path)}` };
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

/**
 * Regras que liberam a ação bloqueada (vão no permissions.allow do --settings), as mais restritas que o Claude
 * Code entende. Um comando do Bash vira uma regra por parte, sem os wrappers, como o Claude Code o confere (ver
 * bashParts, em shared/permissions.ts); o que a divisão não modela fica numa regra só, com o comando inteiro, que
 * o painel mostra recusada. Sem como restringir, fica só o nome da ferramenta, que vale para todo uso dela: o
 * painel avisa (ver ruleKind), e o Bash e o PowerShell sozinhos o servidor nem aceita.
 */
function denialRules(tool: string, input: Record<string, any>): string[] {
  const command = typeof input.command === 'string' ? input.command : null;
  // O Monitor roda o comando pelo shell, com as regras do Bash: liberar o "Monitor" valeria para qualquer comando.
  if ((tool === 'Bash' || tool === 'Monitor') && command !== null) return (bashParts(command) ?? [command]).map((part) => `Bash(${part})`);
  // O comando do PowerShell fica inteiro: com mais de uma parte, o painel o mostra recusado (ver refusedReason).
  if (tool === 'PowerShell' && command !== null) return [`PowerShell(${command})`];
  if (tool === 'WebFetch') {
    const host = fetchHost(input.url);
    if (host) return [`WebFetch(domain:${host})`];
  }
  return [tool];
}

/**
 * O host de um endereço http(s), para a regra WebFetch(domain:host), que vale só para ele (nem os
 * subdomínios entram). Null quando não dá para restringir assim: um IPv6, um nome com "*" (que na regra
 * viraria curinga) ou com outros caracteres fora do comum.
 */
function fetchHost(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  // Como no Claude Code, maiúsculas e o ponto do fim não contam ("Exemplo.com." vale "exemplo.com").
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  return /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/.test(host) ? host : null;
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c?.type === 'text' ? c.text : `[${c?.type ?? 'conteúdo'}]`)).join('\n');
  return '';
}

/** Nome do modo de permissão como aparece na interface ("default" é o antigo nome de "Perguntar"). */
function permissionLabel(mode: unknown): string {
  if (mode === 'default') return PERMISSION_LABEL.manual;
  return PERMISSION_LABEL[mode as PermissionMode] ?? String(mode);
}

function usd(value: number): string {
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'USD' });
}

/** Por que a execução terminou com erro, em português e com o que fazer (em vez do código do CLI). */
function resultError(session: AgentSession, event: any): string {
  if (typeof event.result === 'string' && event.result.trim()) return event.result;
  const details = Array.isArray(event.errors) ? event.errors.filter((e: unknown) => typeof e === 'string' && e.trim()).join('\n') : '';
  switch (event.subtype) {
    case 'error_max_turns':
      return 'O Claude atingiu o limite de turnos desta execução. Responda para ele continuar de onde parou.';
    case 'error_max_budget_usd':
      return session.maxBudgetUsd
        ? `O Claude parou ao atingir o limite de gasto desta execução (${usd(session.maxBudgetUsd)}). Responda para ele continuar: cada resposta tem um novo limite de ${usd(session.maxBudgetUsd)}.`
        : 'O Claude parou ao atingir o limite de gasto desta execução. Responda para ele continuar.';
    case 'error_during_execution':
      return `O Claude Code falhou durante a execução.${details ? `\n${details}` : ' Responda para tentar de novo.'}`;
    case 'error_max_structured_output_retries':
      return 'O Claude não conseguiu montar a resposta no formato pedido.';
    default:
      return details || 'O Claude Code encerrou a execução com erro.';
  }
}

/** Converte uma linha do stream-json do Claude Code em atividades. */
function handleEvent(session: AgentSession, run: Run | null, event: any): void {
  if (!db.sessions.includes(session)) return; // workspace/issue apagado durante a execução
  if (event.type === 'system' && event.subtype === 'init') {
    // Num ramo novo da conversa (--fork-session) o Claude Code cria outro ID: as próximas mensagens seguem nele.
    if (typeof event.session_id === 'string' && event.session_id && event.session_id !== session.claudeSessionId) {
      session.claudeSessionId = event.session_id;
      // Só agora a sessão sai da conversa do terminal: se a execução caísse antes deste evento, a próxima resposta abriria um ramo novo de novo.
      if (session.mode === 'terminal') session.mode = 'headless';
    }
    // O modelo escolhido (ex.: "opus" ou o padrão da conta) continua em session.model; aqui fica o que rodou de fato.
    session.activeModel = event.model ?? null;
    const effort = session.effort ? ` · esforço ${EFFORT_LABEL[session.effort].toLowerCase()}` : '';
    emit(session, { type: 'system', text: `Sessão iniciada · ${event.model ?? 'modelo padrão'}${effort} · ${permissionLabel(event.permissionMode ?? session.permissionMode)}` });
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
    session.costUsd += Number(event.total_cost_usd ?? 0);
    session.durationMs += Number(event.duration_ms ?? 0);
    session.turns += Number(event.num_turns ?? 0);
    // Uma entrada por regra: as partes de um comando encadeado vêm com a mesma ação (ver denialRules e
    // blockedActions). As regras saem do tool_input inteiro; na sessão fica só o que se lê dele (ver denialInput).
    const denials: PermissionDenial[] = (Array.isArray(event.permission_denials) ? event.permission_denials : []).flatMap((d: any) => {
      if (typeof d?.tool_name !== 'string' || !d.tool_name) return [];
      const toolInput = d.tool_input && typeof d.tool_input === 'object' && !Array.isArray(d.tool_input) ? d.tool_input : {};
      const input = denialInput(toolInput);
      return denialRules(d.tool_name, toolInput).map((rule) => ({ tool: d.tool_name, input, rule }));
    });
    session.pendingDenials = denials;

    const failed = event.is_error || (event.subtype && event.subtype !== 'success');
    if (failed) {
      session.state = 'error';
      session.lastError = resultError(session, event);
      emit(session, { type: 'error', text: session.lastError });
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
    // Só agora: se algo acima falhar, o 'close' ainda encerra a sessão com erro em vez de deixá-la "trabalhando".
    if (run) run.gotResult = true;
  }
}

/** Automação de status no estilo Linear: delegar → Em andamento; agente terminou → Em revisão. */
function onSessionSettled(session: AgentSession): void {
  void refreshTouchedRepos(session).catch((error: unknown) => console.error('[octo] falha ao atualizar os repositórios da sessão', error));
  const issue = session.issueId ? db.issues.find((i) => i.id === session.issueId) : null;
  if (!issue) return;
  const account = db.accounts.find((a) => a.id === session.accountId);
  const actor = account?.name ?? 'Claude';
  // Outra sessão desta issue ainda trabalha em segundo plano: a revisão espera ela terminar.
  const othersRunning = db.sessions.some((s) => s !== session && s.issueId === issue.id && working(s.id));
  if (session.state === 'complete') {
    if (issue.status === 'in_progress' && !othersRunning) {
      issue.status = 'in_review';
      addHistory(issue, 'status', actor, 'moveu para Em revisão ao concluir a sessão');
    } else {
      addHistory(issue, 'session', actor, othersRunning ? 'concluiu a sessão (outra sessão desta issue ainda está rodando)' : 'concluiu a sessão');
    }
    issue.reviewPending = othersRunning && issue.status === 'in_progress';
  } else {
    if (session.state === 'awaiting_input') {
      // As regras das partes de um comando contam como uma ação só.
      const count = blockedActions(session.pendingDenials).length;
      addHistory(issue, 'session', actor, count === 1 ? 'aguarda permissão para 1 ação' : `aguarda permissão para ${count} ações`);
    } else if (session.state === 'error') {
      addHistory(issue, 'session', actor, 'encerrou a sessão com erro');
    }
    // Revisão adiada (outra sessão concluiu enquanto esta rodava): esta era a última, termine como terminar.
    if (issue.reviewPending && !othersRunning) {
      issue.reviewPending = false;
      if (issue.status === 'in_progress') {
        issue.status = 'in_review';
        addHistory(issue, 'status', actor, 'moveu para Em revisão (outra sessão desta issue já tinha concluído)');
      }
    }
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
  /** Imagens que vão junto do prompt (só em segundo plano). */
  images?: ParsedImage[];
  /** Worktree em que a sessão roda (ver prepareWorktree); sem ele, a pasta original dos repositórios. */
  worktree?: Worktree | null;
  /** Avisos que entram no feed quando a sessão começa (ex.: como o worktree foi preparado). */
  notes?: string[];
  /** ID da sessão, quando quem delega já gravou as imagens dela (ver savedImages). */
  sessionId?: string;
  /** As imagens já gravadas com sessionId (os nomes, na ordem): saveImages não roda de novo. */
  savedImages?: string[];
}

function createSession(options: StartOptions, mode: AgentSession['mode']): AgentSession {
  const repoIds = options.issue?.repoIds ?? [];
  const cwd = options.cwd ?? (options.worktree ? worktreeCwd(options.worktree, repoIds) : sessionCwd(options.workspace, repoIds));
  const title = options.issue ? `${options.issue.identifier} · ${options.issue.title}` : `Sessão em ${path.basename(cwd)}`;
  const session: AgentSession = {
    id: options.sessionId ?? randomUUID(),
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
  // Uma cópia: o que mudar depois no worktree da issue (um repositório a mais, a remoção) não reescreve esta sessão.
  if (options.worktree) session.worktree = { ...options.worktree, repos: options.worktree.repos.map((entry) => ({ ...entry })) };
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

function missingFolder(cwd: string): string {
  return `A pasta desta sessão não existe mais: ${cwd}. Ela pode ter sido movida, renomeada ou apagada; reescaneie o workspace.`;
}

/** Sessão que já existe: a pasta dela é fixa desde o início, então reescanear o workspace não resolve. */
function requireSessionFolder(session: AgentSession): void {
  const worktree = session.worktree;
  if (!worktree) {
    requireFolder(
      session.cwd,
      `A pasta desta sessão não existe mais: ${session.cwd}. Ela pode ter sido movida, renomeada ou apagada. Para continuar esta conversa, devolva a pasta a esse caminho; se não der, comece uma nova sessão.`,
    );
    return;
  }
  const issue = db.issues.find((i) => i.id === session.issueId);
  // Sem a issue (excluída, o que só acontece depois de o worktree dela sair), não há o que delegar de novo.
  const removed = session.issueId && !issue
    ? `A issue desta sessão foi excluída, e o worktree dela (${worktree.root}) saiu junto. Para continuar o trabalho, comece uma nova sessão.`
    : `O worktree desta sessão foi removido (${worktree.root}). Para continuar, delegue a issue de novo: num worktree novo ou na pasta original dos repositórios.`;
  // Removido e criado de novo no mesmo caminho, é outro worktree (com outra branch): a conversa não segue nele.
  if (issue?.worktree && samePath(issue.worktree.root, worktree.root) && (issue.worktree.createdAt !== worktree.createdAt || issue.worktree.removing)) {
    throw new HttpError(400, removed);
  }
  requireFolder(session.cwd, removed);
}

export function startHeadless(options: StartOptions): AgentSession {
  // Tudo que pode falhar vem antes de registrar a sessão ou mexer no status da issue.
  const claude = requireClaude();
  const session = createSession(options, 'headless');
  requireFolder(session.cwd, missingFolder(session.cwd));
  const prompt = options.issue ? issuePrompt(options.issue, sessionRepos(session), session.cwd, options.extraInstructions) : options.extraInstructions;
  const plan = planRun(
    claude,
    session,
    prompt,
    ['--session-id', session.claudeSessionId, '--name', session.title.slice(0, 80)],
    [],
    workspaceContext(options.workspace, session.cwd, session.worktree),
    options.images,
  );
  plan.images = options.savedImages ?? saveImages(session.id, options.images ?? []);

  db.sessions.push(session);
  if (options.issue) markDelegated(options.issue, options.account, 'iniciou uma sessão em segundo plano');
  // Os avisos (ex.: o worktree criado) ficam acima do prompt.
  for (const text of options.notes ?? []) emit(session, { type: 'system', text });
  void recordBaseline(session);
  launchRun(session, options.account, plan);
  return session;
}

/** Continua a conversa; `changes` troca modelo, effort etc. a partir desta mensagem (como o /model do CLI). */
export async function sendMessage(
  session: AgentSession,
  text: string,
  allowedTools: string[],
  changes: Partial<SessionSettings> = {},
  images: ParsedImage[] = [],
): Promise<void> {
  await settleRun(session.id);
  if (runs.has(session.id)) throw new HttpError(409, 'A sessão ainda está em execução.');
  if (opening.has(session.id)) throw new HttpError(409, 'A sessão está sendo aberta no terminal. Espere a janela abrir antes de responder por aqui.');
  const account = db.accounts.find((a) => a.id === session.accountId);
  if (!account) throw new HttpError(400, 'A conta desta sessão foi removida.');
  const claude = requireClaude();
  requireSessionFolder(session);
  // Aberta no terminal (mesmo se já marcada como concluída): a janela pode continuar aberta nesta
  // mesma conversa, e dois processos gravando o mesmo histórico o embaralham. Em segundo plano, a
  // conversa segue num ramo novo (--fork-session), com todo o histórico; o ID novo chega no evento de início.
  const fork = session.mode === 'terminal';
  // O contexto do workspace vai em toda resposta: o CLI segue com o system prompt gravado na conversa só até
  // ela ser compactada (em versões antigas, nem isso), e sem ele o agente perderia as regras e as diretrizes.
  const workspace = db.workspaces.find((w) => w.id === session.workspaceId);
  const context = workspace ? workspaceContext(workspace, session.cwd, session.worktree) : null;
  const resume = ['--resume', session.claudeSessionId, ...(fork ? ['--fork-session'] : [])];
  const plan = planRun(claude, { ...session, ...changes }, text, resume, allowedTools, context, images, true);
  // As imagens vão para o disco antes de mexer na sessão: se a gravação falhar, nada muda.
  plan.images = saveImages(session.id, images);

  Object.assign(session, changes);
  session.pendingDenials = [];
  if (fork) {
    emit(session, {
      type: 'system',
      text: 'Continuando em segundo plano numa cópia desta conversa. Se a janela do terminal ainda estiver aberta, ela segue com a conversa original.',
    });
  }
  launchRun(session, account, plan);
  // Logo abaixo do prompt (o Claude só responde depois): o contexto não foi inteiro nesta resposta.
  if (plan.contextCut === 'cut') {
    emit(session, {
      type: 'system',
      text: `O contexto do workspace (repositórios e diretrizes) passou do limite de tamanho da linha de comando do sistema e chegou cortado nesta resposta: o fim das diretrizes do workspace pode ter ficado de fora. Encurte as diretrizes${plan.allowedTools.length ? ', ou libere menos ações de uma vez' : ''}.`,
    });
  } else if (plan.contextCut === 'dropped') {
    emit(session, {
      type: 'system',
      text: 'O contexto do workspace (repositórios e diretrizes) não coube na linha de comando do sistema e ficou de fora desta resposta: o Claude segue só com o que já está na conversa.',
    });
  }
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

/** Uma execução em segundo plano já montada e validada, pronta para iniciar. */
interface RunPlan {
  command: string;
  args: string[];
  /** O que vai pelo stdin: o prompt (na primeira mensagem, com o contexto do workspace, se ele não coube na linha de comando). */
  input: string;
  /** O prompt como aparece no feed. */
  prompt: string;
  allowedTools: string[];
  /** Imagens que foram junto, para o feed: os nomes gravados por saveImages depois de planejar. */
  images: string[];
  /** Numa resposta, o contexto do workspace não coube inteiro na linha de comando: foi cortado pelo fim, ou ficou de fora. */
  contextCut: 'cut' | 'dropped' | null;
}

const RULES_TOO_LONG = 'As ações liberadas formam um comando longo demais para o sistema. Libere menos ações de uma vez, ou responda sem liberar.';

/**
 * Monta os argumentos e confere o limite da linha de comando do sistema (32.767 caracteres no
 * Windows) antes de qualquer mudança de estado. O contexto do workspace vai no system prompt; se
 * não couber (ex.: diretrizes muito longas), na primeira mensagem segue junto do prompt pelo stdin,
 * que não tem limite. Numa resposta (`resuming`) ele viraria parte da mensagem do usuário: em vez
 * disso, o fim dele é cortado, como no terminal, sem nunca chegar nas regras do Octo do começo.
 * Com imagens, o stdin leva uma mensagem em JSON (--input-format stream-json): as imagens e, por
 * último, o mesmo texto que iria sozinho.
 */
function planRun(
  claude: ClaudeCommand,
  session: AgentSession,
  prompt: string,
  extraArgs: string[],
  allowedTools: string[],
  context: WorkspaceContext | null,
  images: ParsedImage[] = [],
  resuming = false,
): RunPlan {
  const inputFormat = images.length ? ['--input-format', 'stream-json'] : [];
  const base = [...claude.prefixArgs, '-p', '--output-format', 'stream-json', '--verbose', ...inputFormat, ...settingsArgs(session, true), ...extraArgs];
  // As ações liberadas vão no --settings (o único da execução: um segundo substituiria este), uma regra
  // inteira por item. Nunca no --allowedTools: o CLI re-divide o valor por espaço e vírgula fora de
  // parênteses, e Bash(git log --format="%h (%an)" WebFetch -n 5) viraria um WebFetch sozinho.
  const tools = allowedTools.length ? ['--settings', JSON.stringify({ permissions: { allow: allowedTools } })] : [];
  const plan = { command: claude.command, prompt, allowedTools, images: [] };
  const stdin = (text: string) => (images.length ? userMessage(images, text) : text);
  if (context) {
    const withContext = (system: string) => [...base, '--append-system-prompt', system, ...tools];
    if (fitsCommandLine(claude.command, withContext(context.text))) return { ...plan, args: withContext(context.text), input: stdin(prompt), contextCut: null };
    if (resuming) {
      // Numa resposta, o que faltar de espaço sai do fim do contexto: as diretrizes, depois os repositórios. As
      // regras do Octo e as ações liberadas vão inteiras.
      const short = shrinkToFit(claude.command, withContext, context.text, CONTEXT_CUT, context.rules);
      if (short !== null) return { ...plan, args: withContext(short), input: stdin(prompt), contextCut: 'cut' };
      // Nem as regras do Octo cabem ao lado das ações liberadas: a execução que as libera não segue sem elas.
      if (allowedTools.length) throw new HttpError(400, RULES_TOO_LONG);
    }
  }
  const args = [...base, ...tools];
  if (!fitsCommandLine(claude.command, args)) throw new HttpError(400, RULES_TOO_LONG);
  // Numa resposta sem ações liberadas, um contexto que nem com as regras cabe (ex.: centenas de pastas adicionais)
  // fica de fora, sem impedir a conversa de seguir com o que já está nela.
  return {
    ...plan,
    args,
    input: stdin(context && !resuming ? `${context.text}\n\n---\n\n${prompt}` : prompt),
    contextCut: context && resuming ? 'dropped' : null,
  };
}

/** Mensagem do usuário no formato do --input-format stream-json: uma linha JSON, com o conteúdo em blocos. */
function userMessage(images: ParsedImage[], text: string): string {
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content: imageBlocks(images, text) }, parent_tool_use_id: null })}\n`;
}

/** Exceções aqui (num evento do processo) derrubariam o servidor: viram só um registro no console. */
function guarded(action: () => void): void {
  try {
    action();
  } catch (error) {
    console.error('[octo]', error);
  }
}

function launchRun(session: AgentSession, account: ClaudeAccount, plan: RunPlan): void {
  emit(session, {
    type: 'prompt',
    text: plan.prompt,
    detail: plan.allowedTools.length ? `Permitido: ${plan.allowedTools.join(', ')}` : undefined,
    images: plan.images.length ? plan.images : undefined,
  });
  session.state = 'active';
  session.endedAt = null;
  session.lastError = null;
  commitSession(session);

  let child: ChildProcess;
  try {
    child = spawn(plan.command, plan.args, {
      cwd: session.cwd,
      env: claudeEnv(account),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    // Algumas falhas (executável inválido, linha de comando longa demais) são lançadas aqui,
    // sem evento 'error' nem 'close': sem isto a sessão ficaria "trabalhando" sem processo.
    session.state = 'error';
    session.endedAt = now();
    session.lastError = describeSpawnError(error, 'Não foi possível iniciar o Claude Code');
    emit(session, { type: 'error', text: session.lastError });
    commitSession(session);
    onSessionSettled(session);
    return;
  }
  let markClosed = () => {};
  const closed = new Promise<void>((resolve) => (markClosed = resolve));
  const state: Run = { child, stopped: false, gotResult: false, stderr: '', lastMessage: null, killTimer: null, closed, markClosed };
  runs.set(session.id, state);

  // Se o Claude sair antes de ler tudo (ex.: uma opção que a versão instalada não conhece, ou o
  // Parar logo no início), a escrita falha com EPIPE/EOF. O desfecho já vem pelo 'close'.
  child.stdin?.on('error', () => {});
  // O prompt vai pelo stdin: sem limite de tamanho de linha de comando e sem problemas de escape.
  child.stdin?.end(plan.input);

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
  child.on('error', (error) => guarded(() => finish(session, state, null, describeSpawnError(error, 'Não foi possível iniciar o Claude Code'))));
  child.on('close', (code) => guarded(() => finish(session, state, code, null)));
}

function finish(session: AgentSession, state: Run, code: number | null, spawnError: string | null): void {
  state.markClosed();
  if (state.killTimer) clearTimeout(state.killTimer);
  if (runs.get(session.id) !== state) return;
  runs.delete(session.id);
  if (state.gotResult || !db.sessions.includes(session)) return;
  session.endedAt = now();
  if (state.stopped) {
    session.state = 'stopped';
    emit(session, { type: 'system', text: 'Sessão interrompida por você.' });
  } else {
    session.state = 'error';
    const stderr = state.stderr.trim().split('\n').slice(-6).join('\n');
    session.lastError =
      spawnError ??
      (stderr ? `O Claude Code parou com erro:\n${stderr}` : `O Claude Code foi encerrado antes de concluir (código de saída ${code ?? 'desconhecido'}).`);
    emit(session, { type: 'error', text: session.lastError });
  }
  commitSession(session);
  onSessionSettled(session);
}

/**
 * "Concluir assim mesmo": o agente terminou (ou parou com erro, ex.: no limite de gasto), mas
 * alguma ação foi bloqueada no caminho. A sessão vira concluída (e a issue vai para revisão) sem liberar nada.
 */
export function dismissDenials(session: AgentSession): void {
  if (runs.has(session.id)) throw new HttpError(409, 'A sessão ainda está em execução.');
  // O resultado com erro também traz as ações bloqueadas.
  if (!session.pendingDenials.length || (session.state !== 'awaiting_input' && session.state !== 'error')) {
    throw new HttpError(409, 'Esta sessão não tem ações bloqueadas para dispensar.');
  }
  session.pendingDenials = [];
  session.state = 'complete';
  session.endedAt = now();
  session.lastError = null;
  emit(session, { type: 'system', text: 'Concluída sem liberar as ações bloqueadas.' });
  commitSession(session);
  onSessionSettled(session);
}

/**
 * "Concluir": encerra uma sessão que o Octo não acompanha até o fim (aberta no terminal) ou que
 * aguarda permissão. A sessão vira concluída e a issue em andamento vai para revisão.
 */
export function finishSession(session: AgentSession): void {
  if (runs.has(session.id)) throw new HttpError(400, 'A sessão está rodando em segundo plano. Pare-a antes de concluir.');
  if (session.state === 'complete') return;
  const hadDenials = session.pendingDenials.length > 0;
  session.pendingDenials = [];
  session.state = 'complete';
  session.endedAt = now();
  session.lastError = null;
  emit(session, { type: 'system', text: hadDenials ? 'Concluída por você, sem liberar as ações bloqueadas.' : 'Sessão concluída por você.' });
  commitSession(session);
  onSessionSettled(session);
}

export function stopSession(session: AgentSession): void {
  const state = runs.get(session.id);
  if (!state) {
    // Sem processo (ex.: o início falhou ou o Octo reiniciou): a sessão não pode ficar "trabalhando".
    if (session.state === 'active' || session.state === 'pending') {
      session.state = 'stopped';
      session.endedAt = now();
      emit(session, { type: 'system', text: 'Sessão interrompida por você.' });
      commitSession(session);
    }
    return;
  }
  state.stopped = true;
  const pid = state.child.pid;
  if (process.platform === 'win32' && pid) {
    // Encerra também os processos filhos (ex.: um `npm run dev` iniciado pelo agente).
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
  } else {
    state.child.kill('SIGTERM');
    // Se o Claude não sair sozinho em alguns segundos, força (o Parar não pode ficar sem efeito).
    if (!state.killTimer) {
      state.killTimer = setTimeout(() => {
        if (runs.get(session.id) === state) state.child.kill('SIGKILL');
      }, 5000);
      state.killTimer.unref();
    }
  }
}

// ---------------------------------------------------------------- terminal interativo

const PROMPT_CUT = '\n\n[Octo: o restante da descrição foi cortado aqui por causa do limite de tamanho da linha de comando do sistema. Se precisar dele, peça ao usuário.]';
const CONTEXT_CUT = '\n\n[Octo: o restante do contexto do workspace foi cortado por causa do limite de tamanho da linha de comando do sistema.]';
/** No banner do terminal, quando o contexto foi cortado (ver fitTerminalArgs). */
const CONTEXT_CUT_BANNER = '\nAtenção: o contexto do workspace (repositórios e diretrizes) era longo demais para a linha de comando e foi cortado.';

/**
 * No terminal o prompt e o contexto vão na linha de comando do Claude (32.767 caracteres no
 * Windows, 128 KiB por argumento no Linux). Se passar, corta o fim da descrição (e, se ainda
 * faltar espaço, o do contexto, sem chegar nas regras do Octo) com um aviso, em vez de o Claude
 * nem abrir. Diz o que foi cortado.
 */
function fitTerminalArgs(claude: ClaudeCommand, options: string[], context: WorkspaceContext, prompt: string): { args: string[]; promptCut: boolean; contextCut: boolean } {
  // "--" encerra as opções: um prompt que começa com "-" (ex.: uma lista) continua sendo o prompt.
  const build = (system: string, text: string) => [...options, '--append-system-prompt', system, ...(text.trim() ? ['--', text] : [])];
  const full = (args: string[]) => [...claude.prefixArgs, ...args];
  if (fitsCommandLine(claude.command, full(build(context.text, prompt)))) return { args: build(context.text, prompt), promptCut: false, contextCut: false };
  // Primeiro o fim da descrição, mantendo pelo menos o começo dela.
  const keep = Math.min(prompt.length, 2000);
  const shortPrompt = shrinkToFit(claude.command, (text) => full(build(context.text, text)), prompt, PROMPT_CUT, keep);
  if (shortPrompt !== null) return { args: build(context.text, shortPrompt), promptCut: true, contextCut: false };
  // Descrição curta (ou já no mínimo): o que passa do limite é o contexto do workspace.
  const head = keep < prompt.length ? prompt.slice(0, cutPoint(prompt, keep)) + PROMPT_CUT : prompt;
  const shortContext = shrinkToFit(claude.command, (system) => full(build(system, head)), context.text, CONTEXT_CUT, context.rules);
  if (shortContext !== null) return { args: build(shortContext, head), promptCut: head !== prompt, contextCut: shortContext !== context.text };
  throw new HttpError(400, 'O comando para abrir o Claude ficou longo demais para o sistema. Encurte as diretrizes do workspace ou use “Delegar” em segundo plano.');
}

/** No terminal o prompt vai na linha de comando, que só leva texto: imagens só vão em segundo plano. */
export function refuseTerminalImages(images: ParsedImage[] = []): void {
  if (images.length) {
    throw new HttpError(400, 'As imagens só vão junto em segundo plano. No terminal, cole a imagem direto no Claude: Alt+V no Windows, Ctrl+V no macOS e no Linux.');
  }
}

export async function startInTerminal(options: StartOptions): Promise<AgentSession> {
  refuseTerminalImages(options.images);
  const claude = requireClaude();
  const session = createSession(options, 'terminal');
  requireFolder(session.cwd, missingFolder(session.cwd));
  const prompt = options.issue ? issuePrompt(options.issue, sessionRepos(session), session.cwd, options.extraInstructions) : options.extraInstructions;
  const { args, promptCut, contextCut } = fitTerminalArgs(
    claude,
    [...settingsArgs(session, false), '--session-id', session.claudeSessionId, '--name', session.title.slice(0, 80)],
    workspaceContext(options.workspace, session.cwd, session.worktree),
    prompt,
  );
  const warnings = [
    promptCut ? '\nAtenção: a descrição da issue era longa demais para a linha de comando e foi cortada.' : '',
    contextCut ? CONTEXT_CUT_BANNER : '',
  ].join('');

  await openClaudeTerminal({
    cwd: session.cwd,
    account: options.account,
    args,
    title: `Octo · ${session.title}`,
    banner: `Octo · ${options.account.name} · ${session.cwd}${warnings}`,
  });
  // Só registra depois que o terminal abriu de fato.
  db.sessions.push(session);
  if (options.issue) markDelegated(options.issue, options.account, 'abriu uma sessão no terminal');
  // Como em segundo plano: os avisos (ex.: o worktree criado) ficam acima do prompt.
  for (const text of options.notes ?? []) emit(session, { type: 'system', text });
  emit(session, { type: 'prompt', text: prompt || '_Sessão interativa aberta no terminal._' });
  if (promptCut) {
    emit(session, {
      type: 'system',
      text: 'A descrição passou do limite de tamanho da linha de comando do sistema e chegou cortada ao terminal. Para enviar o texto inteiro, use “Delegar” em segundo plano.',
    });
  }
  if (contextCut) {
    emit(session, {
      type: 'system',
      text: 'O contexto do workspace (repositórios e diretrizes) passou do limite de tamanho da linha de comando do sistema e chegou cortado ao terminal: o fim das diretrizes do workspace pode ter ficado de fora. Encurte as diretrizes, ou use “Delegar” em segundo plano, que envia tudo.',
    });
  }
  emit(session, { type: 'system', text: 'Aberta no terminal. Use "Sincronizar" para trazer o andamento para cá.' });
  commitSession(session);
  void recordBaseline(session);
  return session;
}

export async function resumeInTerminal(session: AgentSession): Promise<void> {
  await settleRun(session.id);
  if (runs.has(session.id)) throw new HttpError(409, 'Pare a execução em segundo plano antes de abrir no terminal.');
  if (opening.has(session.id)) throw new HttpError(409, 'A sessão já está sendo aberta no terminal.');
  const account = db.accounts.find((a) => a.id === session.accountId);
  if (!account) throw new HttpError(400, 'A conta desta sessão foi removida.');
  requireSessionFolder(session);
  // O contexto do workspace vai junto, como nas respostas (ver sendMessage). Sem prompt: se faltar
  // espaço na linha de comando, só o fim do contexto é cortado.
  const workspace = db.workspaces.find((w) => w.id === session.workspaceId);
  const options = ['--resume', session.claudeSessionId, ...settingsArgs(session, false)];
  const { args, contextCut } = workspace
    ? fitTerminalArgs(requireClaude(), options, workspaceContext(workspace, session.cwd, session.worktree), '')
    : { args: options, contextCut: false };
  // Enquanto a janela abre (no iTerm, até a permissão de Automação), uma resposta por aqui rodaria
  // em segundo plano na mesma conversa que o terminal vai retomar: sendMessage recusa.
  opening.add(session.id);
  try {
    await openClaudeTerminal({
      cwd: session.cwd,
      account,
      args,
      title: `Octo · ${session.title}`,
      banner: `Octo · retomando ${session.title}${contextCut ? CONTEXT_CUT_BANNER : ''}`,
    });
  } finally {
    opening.delete(session.id);
  }
  session.mode = 'terminal';
  session.state = 'terminal';
  // No terminal o Claude pergunta na hora: as ações bloqueadas em segundo plano não valem mais.
  session.pendingDenials = [];
  // Como no startInTerminal: o aviso do corte fica acima da linha que diz onde a sessão está.
  if (contextCut) {
    emit(session, {
      type: 'system',
      text: 'O contexto do workspace (repositórios e diretrizes) passou do limite de tamanho da linha de comando do sistema e chegou cortado ao terminal: o fim das diretrizes do workspace pode ter ficado de fora. Para ele ir inteiro, encurte as diretrizes.',
    });
  }
  emit(session, { type: 'system', text: 'Sessão retomada no terminal.' });
  commitSession(session);
}

// ---------------------------------------------------------------- depois da sessão

/** Repositórios cujo estado inicial importa para a aba Mudanças: os da issue primeiro, depois os da pasta. */
function baselineRepos(session: AgentSession): Repo[] {
  const issue = session.issueId ? db.issues.find((i) => i.id === session.issueId) : null;
  const inScope = sessionRepos(session).filter((r) => isInside(session.cwd, r.absPath));
  const focused = inScope.filter((r) => issue?.repoIds.includes(r.id));
  return [...new Set([...focused, ...inScope])].slice(0, 40);
}

/** Registra o que já estava alterado (sem commit) quando a sessão começou, para a aba Mudanças. */
async function recordBaseline(session: AgentSession): Promise<void> {
  try {
    const at = now();
    const repos = baselineRepos(session);
    const entries: Record<string, string[]> = {};
    for (let i = 0; i < repos.length; i += 4) {
      const batch = repos.slice(i, i + 4);
      const results = await Promise.all(batch.map((repo) => dirtyEntries(repo)));
      batch.forEach((repo, index) => {
        const result = results[index];
        if (result) entries[repo.id] = result;
      });
    }
    if (!db.sessions.includes(session)) return;
    writeBaseline(session.id, { at, repos: entries });
    session.baselineAt = at;
    commitSession(session);
  } catch (error) {
    console.error('[octo] não foi possível registrar o estado inicial dos repositórios', error);
  }
}

/**
 * Depois de uma sessão, lê de novo os repositórios que ela mexeu (branch, alterações, último
 * commit): a tela de Repositórios não fica mostrando "limpo" num repo que o agente acabou de editar.
 */
async function refreshTouchedRepos(session: AgentSession): Promise<void> {
  // Num worktree, quem mudou foi a cópia de trabalho dele: a pasta original dos repositórios continua igual.
  if (session.worktree) return;
  const workspace = db.workspaces.find((w) => w.id === session.workspaceId);
  if (!workspace) return;
  const issue = session.issueId ? db.issues.find((i) => i.id === session.issueId) : null;
  const ids = new Set([...session.touchedRepoIds, ...(issue?.repoIds ?? [])]);
  const repos = workspaceRepos(workspace.id);
  // Uma sessão no terminal só sabe o que mexeu depois de sincronizar: vale a pasta dela.
  const targets = ids.size
    ? repos.filter((r) => ids.has(r.id))
    : session.mode === 'terminal'
      ? repos.filter((r) => isInside(session.cwd, r.absPath)).slice(0, 40)
      : [];
  const dirs = targets.map((r) => r.absPath).filter((dir) => existsSync(dir));
  if (!dirs.length) return;
  const fresh = await describeRepos(workspace, dirs);
  if (!db.workspaces.includes(workspace)) return;
  const byId = new Map(fresh.map((repo) => [repo.id, repo]));
  db.repos = db.repos.map((repo) => byId.get(repo.id) ?? repo);
  save();
  broadcast({ type: 'repos', workspaceId: workspace.id, repos: workspaceRepos(workspace.id) });
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

/** Rótulo antes de cada imagem numa mensagem: "[Imagem #1]" nas do Octo, "[Image #1]" nas do Claude Code. */
const IMAGE_LABEL = /^\[(Imagem|Image) #\d+\]$/;

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
  // Na mensagem do usuário, os textos e as imagens coladas viram um prompt só, no lugar do primeiro deles.
  const prompt = { at: -1, id: '', texts: [] as string[], images: [] as unknown[] };
  content.forEach((block: any, index: number) => {
    const id = `${entry.uuid ?? randomUUID()}:${index}`;
    if (entry.type === 'user' && (block.type === 'text' || block.type === 'image')) {
      if (block.type === 'text') {
        const text = typeof block.text === 'string' ? block.text : '';
        if (!text.trim() || text.trimStart().startsWith('<') || IMAGE_LABEL.test(text.trim())) return;
        prompt.texts.push(text);
      } else {
        prompt.images.push(block);
      }
      if (prompt.at < 0) {
        prompt.at = out.length;
        prompt.id = id;
      }
    } else if (block.type === 'text' && block.text?.trim()) {
      out.push({ ...base, id, type: 'message', text: block.text });
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
  const images = saveTranscriptImages(session.id, prompt.images);
  if (prompt.texts.length || images.length) {
    out.splice(prompt.at, 0, { ...base, id: prompt.id, type: 'prompt', text: prompt.texts.join('\n\n'), images: images.length ? images : undefined });
  }
  return out;
}
