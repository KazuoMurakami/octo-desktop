import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import {
  EFFORTS, MAX_IMAGES_TOTAL_BASE64, PERMISSION_MODES, STATUSES, STATUS_LABEL,
  type AccountStatus, type AppState, type ClaudeAccount, type Effort, type Issue, type IssueStatus, type PermissionMode, type Priority,
  type Repo, type SessionSettings, type Workspace, type WorktreeBase,
} from '../shared/types.ts';
import {
  dismissDenials, finishSession, isInside, isRunning, isWorking, refuseTerminalImages, resumeInTerminal, sendMessage, sessionActivities, settleRun,
  startHeadless,
  startInTerminal, stopSession, syncFromTranscript,
} from './agent.ts';
import { checkAccountStatus, claude, requireClaude } from './claude.ts';
import {
  addMcpServer, availablePlugins, copyItem, createItem, deleteItem, patchSettings, pluginAction, readAccountConfig, readItem, removeMcpServer,
  saveItem, writeSettingsRaw,
} from './claudeConfig.ts';
import { changesFor, markPreexisting } from './changes.ts';
import { readContextStatus, renderContextBlock, writeContext } from './context.ts';
import { broadcast, subscribe } from './events.ts';
import { imageFile, parseImages, saveImages } from './images.ts';
import {
  HttpError, addHistory, commitIssue, getAccount, getIssue, getSession, getWorkspace, now, requireFolder, workspaceRepos,
} from './model.ts';
import { apiToken, releaseLock, sameToken, writeLock } from './instance.ts';
import { integrations, isKnownEditor, isKnownTerminal, openInEditor } from './integrations.ts';
import { findRepoDirs, scanWorkspace } from './scanner.ts';
import { checkUpdate } from './update.ts';
import { DATA_DIR, db, dbNotice, flush, readBaseline, save } from './store.ts';
import { copyTree, samePath } from './system.ts';
import { openClaudeTerminal, openShell, pickFolder, revealFolder } from './terminal.ts';
import {
  WORKTREES_DIR, discardNewWorktree, isPreparing, planWorktree, prepareWorktree, removeWorktree, reposAt, sessionRepos, worktreeAt, worktreeStatus,
} from './worktrees.ts';

// server/ no código-fonte, dist-electron/ no app empacotado: a raiz é sempre um nível acima.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
/** Versão do Octo, do package.json (fica junto do código também no app empacotado). */
export const APP_VERSION: string = (() => {
  try {
    return String(JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version ?? '0.0.0');
  } catch {
    return '0.0.0';
  }
})();
const ACCOUNT_COLORS = ['#d97757', '#6c8cff', '#3fb68b', '#e5b84b', '#c678dd', '#4fc1c9', '#ef6b73'];

export interface ServerOptions {
  /** Porta preferida. Com `anyPortIfBusy`, usa outra livre se ela estiver ocupada. */
  port: number;
  anyPortIfBusy?: boolean;
  /** Aceita a interface servida pelo Vite em localhost:5173 (só em desenvolvimento). */
  devOrigin?: boolean;
  /** Pasta sugerida no onboarding; null = nenhuma sugestão. */
  suggestedRoot?: string | null;
  /** Seletor de pasta nativo; o app desktop usa o diálogo do Electron. */
  pickFolder?: () => Promise<string | null>;
}

const TOKEN = apiToken();
/** Porta em que o servidor está escutando; dá nome ao cookie (cookies não separam portas). */
let listeningPort = 0;
let pick = pickFolder;
let suggestedRoot: string | null = path.dirname(ROOT);

const accountStatus: Record<string, AccountStatus> = {};

// ---------------------------------------------------------------- bootstrap

if (db.accounts.length === 0) {
  db.accounts.push({ id: randomUUID(), name: 'Principal', configDir: null, color: ACCOUNT_COLORS[0], createdAt: now() });
  save();
}

async function refreshStatus(account: ClaudeAccount): Promise<AccountStatus> {
  const status = await checkAccountStatus(account);
  accountStatus[account.id] = status;
  broadcast({ type: 'account.status', status });
  return status;
}

/** Em segundo plano: uma falha aqui não pode virar uma rejeição sem tratamento (que encerra o processo). */
function refreshStatusLater(account: ClaudeAccount): void {
  refreshStatus(account).catch((error: unknown) => console.error('[octo] falha ao verificar a conta', error));
}

for (const account of db.accounts) refreshStatusLater(account);

// ---------------------------------------------------------------- helpers

function deriveKey(name: string): string {
  const letters = name.normalize('NFD').replace(/[^A-Za-z]/g, '').toUpperCase();
  return (letters.slice(0, 3) || 'WS').padEnd(2, 'X');
}

function slug(text: string): string {
  return text.normalize('NFD').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'conta';
}

function asStatus(value: unknown): IssueStatus | undefined {
  return STATUSES.includes(value as IssueStatus) ? (value as IssueStatus) : undefined;
}

function asPriority(value: unknown): Priority | undefined {
  return [0, 1, 2, 3, 4].includes(value as number) ? (value as Priority) : undefined;
}

function asPermission(value: unknown): PermissionMode | undefined {
  return PERMISSION_MODES.includes(value as PermissionMode) ? (value as PermissionMode) : undefined;
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asEffort(value: unknown): Effort | null {
  return EFFORTS.includes(value as Effort) ? (value as Effort) : null;
}

/** De onde sai a branch do worktree pedido ao delegar; null (ou qualquer outro valor) = sem worktree. */
function asWorktreeBase(value: unknown): WorktreeBase | null {
  return value === 'default' || value === 'current' ? value : null;
}

/** Modelo ou agente que vai como argumento do `claude` ('' = padrão). Nunca começa com "-". */
function cliValue(value: unknown, what: string): string | null {
  const text = str(value).trim();
  if (!text) return null;
  if (!/^[\w][\w.:@/[\]-]*$/.test(text)) throw new HttpError(400, `${what} inválido: ${text}`);
  return text;
}

/** --fallback-model aceita vários modelos separados por vírgula, tentados em ordem. */
function fallbackModels(value: unknown): string | null {
  const models = str(value).split(',').map((model) => cliValue(model, 'Modelo reserva')).filter(Boolean);
  return models.length ? models.join(',') : null;
}

/**
 * Caminho digitado ou colado: aceita ~ (pasta do usuário), %VARIÁVEL% no Windows e as aspas do
 * "Copiar como caminho" do Explorer. Caminho relativo não é aceito: dependeria da pasta em que o
 * Octo foi aberto.
 */
function userPath(value: unknown): string {
  let text = str(value).trim();
  if (/^(["']).*\1$/.test(text) && text.length >= 2) text = text.slice(1, -1).trim();
  if (text === '~' || /^~[\\/]/.test(text)) text = path.join(homedir(), text.slice(1));
  if (process.platform === 'win32') text = text.replace(/%([^%\\/]+)%/g, (whole, name: string) => process.env[name] ?? whole);
  if (!text) throw new HttpError(400, 'Informe a pasta.');
  if (!path.isAbsolute(text)) {
    const example = process.platform === 'win32' ? 'C:\\Users\\voce\\projetos' : '~/projetos';
    throw new HttpError(400, `Use o caminho completo da pasta (ex.: ${example}).`);
  }
  return path.resolve(text);
}

function existingDirs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => str(item).trim()).filter(Boolean).map((dir) => {
    const resolved = userPath(dir);
    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) throw new HttpError(400, `Pasta não encontrada: ${dir}`);
    return resolved;
  });
}

/**
 * Regras de --allowedTools (ex.: "Bash(npm test)", "Edit", "mcp__servidor__ferramenta"). Nunca
 * começam com "-": um valor assim encerraria a lista e viraria uma opção do claude.
 */
function allowedRules(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const rules = value.filter((rule): rule is string => typeof rule === 'string').map((rule) => rule.trim()).filter(Boolean);
  if (rules.length > 50) throw new HttpError(400, 'Libere no máximo 50 ações de uma vez.');
  for (const rule of rules) {
    if (!/^[A-Za-z][\w.:-]*(\([\s\S]*\))?$/.test(rule)) throw new HttpError(400, `Regra de permissão inválida: ${rule.slice(0, 80)}`);
  }
  return rules;
}

function budget(value: unknown): number | null {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

/** Configurações de uma sessão nova; o que não vier usa os padrões do workspace. */
function sessionSettings(workspace: Workspace, body: Record<string, unknown>): SessionSettings {
  return {
    permissionMode: asPermission(body.permissionMode) ?? workspace.defaultPermissionMode,
    model: body.model === undefined ? workspace.defaultModel : cliValue(body.model, 'Modelo'),
    effort: body.effort === undefined ? workspace.defaultEffort : asEffort(body.effort),
    agent: cliValue(body.agent, 'Agente'),
    fallbackModel: fallbackModels(body.fallbackModel),
    addDirs: existingDirs(body.addDirs),
    maxBudgetUsd: budget(body.maxBudgetUsd),
  };
}

/** Só o que veio no corpo: trocar o modelo no meio da conversa não mexe no resto. */
function settingsChanges(body: Record<string, unknown>): Partial<SessionSettings> {
  const changes: Partial<SessionSettings> = {};
  if (body.model !== undefined) changes.model = cliValue(body.model, 'Modelo');
  if (body.effort !== undefined) changes.effort = asEffort(body.effort);
  const permission = asPermission(body.permissionMode);
  if (permission) changes.permissionMode = permission;
  return changes;
}

/** Pasta de projeto para listar skills/agentes em .claude/: precisa estar dentro de um workspace ou de um worktree do Octo. */
function projectDir(value: unknown): string | null {
  const dir = str(value).trim();
  if (!dir) return null;
  const resolved = path.resolve(dir);
  const known = db.workspaces.some((w) => isInside(w.rootPath, resolved)) || isInside(WORKTREES_DIR, resolved);
  return known && existsSync(resolved) ? resolved : null;
}

async function rescan(workspace: Workspace) {
  const repos = await scanWorkspace(workspace);
  // Desconectado durante o escaneamento: não traz de volta o workspace nem os repositórios.
  if (!db.workspaces.includes(workspace)) return [];
  db.repos = db.repos.filter((r) => r.workspaceId !== workspace.id).concat(repos);
  workspace.scannedAt = now();
  save();
  broadcast({ type: 'repos', workspaceId: workspace.id, repos });
  broadcast({ type: 'workspace', workspace });
  return repos;
}

function workspaceTerminalOptions(workspace: Workspace, body: Record<string, unknown>) {
  const account = getAccount(str(body.accountId) || workspace.defaultAccountId || db.accounts[0]?.id);
  return {
    workspace,
    account,
    settings: sessionSettings(workspace, body),
    extraInstructions: str(body.instructions),
  };
}

// ---------------------------------------------------------------- app

const app = express();

// O servidor executa o Claude Code na sua máquina: só aceita chamadas da própria interface.
// A porta real entra aqui quando o servidor começa a escutar.
const allowedHosts = new Set<string>();
app.use((req, res, next) => {
  const host = req.headers.host ?? '';
  const origin = req.headers.origin;
  if (!allowedHosts.has(host) || (origin && !allowedHosts.has(origin.replace(/^https?:\/\//, '')))) {
    res.status(403).json({ error: 'Origem não permitida.' });
    return;
  }
  // Exigir JSON força o preflight de CORS em requisições de outros sites (DELETE já força por si só).
  if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.path.startsWith('/api/') && !req.is('application/json')) {
    res.status(415).json({ error: 'Use Content-Type: application/json.' });
    return;
  }
  next();
});

/**
 * Rotas que recebem imagens (as que usam imageJson): o corpo delas é lido na própria rota, depois do
 * token e com um limite maior. As demais leem o corpo aqui, com até 2 MB.
 */
const IMAGE_ROUTE = /^\/api\/(sessions\/[^/]+\/message|issues\/[^/]+\/delegate)\/?$/i;

function takesImages(req: Request): boolean {
  return req.method === 'POST' && IMAGE_ROUTE.test(req.path);
}

const json = express.json({ limit: '2mb' });
app.use((req, res, next) => (takesImages(req) ? next() : json(req, res, next)));

/** Corpo das rotas com imagens: as imagens (até MAX_IMAGES_TOTAL_BASE64 somadas), mais 2 MB para o texto e as opções. */
const imageJson = express.json({ limit: MAX_IMAGES_TOTAL_BASE64 + 2 * 1024 * 1024 });

function cookieName(): string {
  return `octo_${listeningPort}`;
}

function cookie(req: Request, name: string): string {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return '';
}

// A interface abre com ?token=… (o app desktop e o `npm start` já fazem isso) e troca por um cookie.
app.get('/api/auth', (req, res) => {
  if (!sameToken(str(req.query.token), TOKEN)) throw new HttpError(401, 'Link de acesso inválido.');
  res.cookie(cookieName(), TOKEN, { httpOnly: true, sameSite: 'strict', path: '/', maxAge: 400 * 24 * 3600 * 1000 });
  res.json({ ok: true });
});

// Toda a API exige o token, exceto o health check (que só diz "sou o Octo, pid X").
app.use('/api', (req, _res, next) => {
  if (req.path === '/health') return next();
  const given = cookie(req, cookieName()) || str(req.headers['x-octo-token']);
  if (!sameToken(given, TOKEN)) throw new HttpError(401, 'Não autorizado: abra o Octo pelo app ou pelo link mostrado no terminal.');
  next();
});

app.get('/api/state', (_req, res) => {
  const resolved = claude();
  const state: AppState = {
    workspaces: db.workspaces,
    repos: db.repos,
    accounts: db.accounts,
    accountStatus,
    issues: db.issues,
    sessions: db.sessions,
    preferences: db.preferences,
    meta: {
      version: APP_VERSION,
      platform: process.platform,
      home: homedir(),
      suggestedRoot,
      claudeBin: resolved.command?.display ?? null,
      claudeVersion: resolved.version,
      claudeProblem: resolved.problem,
      claudeWarning: resolved.warning,
      dataDir: DATA_DIR,
      dbNotice: dbNotice(),
    },
  };
  res.json(state);
});

app.get('/api/events', (_req, res) => subscribe(res));

app.get('/api/health', (_req, res) => {
  res.json({ app: 'octo', pid: process.pid });
});

// ---------------------------------------------------------------- pastas

app.post('/api/fs/pick-folder', async (_req, res) => {
  res.json({ path: await pick() });
});

app.post('/api/fs/inspect', async (req, res) => {
  const target = userPath(req.body.path);
  if (!existsSync(target) || !statSync(target).isDirectory()) throw new HttpError(400, 'Pasta não encontrada.');
  const depth = Math.min(Math.max(Number(req.body.scanDepth) || 3, 1), 6);
  // A interface pergunta de novo a cada pausa na digitação: a busca anterior para quando a pessoa desiste dela.
  const abort = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) abort.abort();
  });
  const { dirs, partial } = await findRepoDirs(target, depth, { maxDirs: 20_000, signal: abort.signal });
  if (abort.signal.aborted) return;
  res.json({ path: target, name: path.basename(target), repos: dirs.map((dir) => path.relative(target, dir).split(path.sep).join('/') || '.'), partial });
});

// ---------------------------------------------------------------- workspaces

app.post('/api/workspaces', async (req, res) => {
  const rootPath = userPath(req.body.rootPath);
  if (!existsSync(rootPath) || !statSync(rootPath).isDirectory()) throw new HttpError(400, 'Pasta não encontrada.');
  const existing = db.workspaces.find((w) => samePath(w.rootPath, rootPath));
  if (existing) throw new HttpError(400, `Essa pasta já está conectada no workspace ${existing.name}.`);
  const name = str(req.body.name).trim() || path.basename(rootPath);
  const workspace: Workspace = {
    id: randomUUID(),
    name,
    rootPath,
    key: (str(req.body.key).trim().toUpperCase().replace(/[^A-Z0-9]/g, '') || deriveKey(name)).slice(0, 6),
    scanDepth: Math.min(Math.max(Number(req.body.scanDepth) || 3, 1), 6),
    issueCounter: 0,
    guidance: '',
    defaultAccountId: db.accounts[0]?.id ?? null,
    defaultPermissionMode: 'acceptEdits',
    defaultModel: null,
    defaultEffort: null,
    defaultWorktree: false,
    createdAt: now(),
    scannedAt: null,
  };
  db.workspaces.push(workspace);
  broadcast({ type: 'workspace', workspace });
  await rescan(workspace);
  res.json(workspace);
});

app.patch('/api/workspaces/:id', async (req, res) => {
  const workspace = getWorkspace(req.params.id);
  const body = req.body as Record<string, unknown>;
  if (typeof body.name === 'string' && body.name.trim()) workspace.name = body.name.trim();
  if (typeof body.key === 'string' && body.key.trim()) workspace.key = body.key.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  if (typeof body.guidance === 'string') workspace.guidance = body.guidance;
  if (body.defaultAccountId !== undefined) workspace.defaultAccountId = body.defaultAccountId ? getAccount(str(body.defaultAccountId)).id : null;
  if (asPermission(body.defaultPermissionMode)) workspace.defaultPermissionMode = asPermission(body.defaultPermissionMode)!;
  if (body.defaultModel !== undefined) workspace.defaultModel = cliValue(body.defaultModel, 'Modelo');
  if (body.defaultEffort !== undefined) workspace.defaultEffort = asEffort(body.defaultEffort);
  if (typeof body.defaultWorktree === 'boolean') workspace.defaultWorktree = body.defaultWorktree;
  let depthChanged = false;
  if (body.scanDepth !== undefined) {
    const depth = Math.min(Math.max(Number(body.scanDepth) || 3, 1), 6);
    depthChanged = depth !== workspace.scanDepth;
    workspace.scanDepth = depth;
  }
  save();
  broadcast({ type: 'workspace', workspace });
  // Outra profundidade acha outros repositórios: reescaneia e só então responde (os repositórios já chegam atualizados).
  if (depthChanged) await rescan(workspace);
  res.json(workspace);
});

app.delete('/api/workspaces/:id', (req, res) => {
  const workspace = getWorkspace(req.params.id);
  // Sem o workspace, nada no Octo removeria os worktrees das issues: as branches ficariam presas em pastas sem dono.
  const withWorktree = db.issues.filter((i) => i.workspaceId === workspace.id && (i.worktree || isPreparing(i.id)));
  if (withWorktree.length) {
    throw new HttpError(
      409,
      `Remova antes os worktrees das issues ${withWorktree.map((i) => i.identifier).join(', ')} (no painel de cada uma, Mais ações → Remover worktree…). As branches continuam nos repositórios.`,
    );
  }
  for (const session of db.sessions) if (session.workspaceId === workspace.id && isRunning(session.id)) stopSession(session);
  db.workspaces = db.workspaces.filter((w) => w.id !== workspace.id);
  db.repos = db.repos.filter((r) => r.workspaceId !== workspace.id);
  db.issues = db.issues.filter((i) => i.workspaceId !== workspace.id);
  db.sessions = db.sessions.filter((s) => s.workspaceId !== workspace.id);
  save();
  broadcast({ type: 'workspace.deleted', id: workspace.id });
  res.json({ ok: true });
});

app.post('/api/workspaces/:id/scan', async (req, res) => {
  res.json(await rescan(getWorkspace(req.params.id)));
});

// CLAUDE.md com o mapa dos repositórios, na raiz ou numa pasta de grupo (?dir=).
app.get('/api/workspaces/:id/context', (req, res) => {
  const workspace = getWorkspace(req.params.id);
  const dir = folderIn(workspace, req.query.dir);
  const repos = reposAt(workspace, dir).filter((r) => isInside(dir, r.absPath));
  res.json({ ...readContextStatus(dir), preview: renderContextBlock(workspace, dir, repos) });
});

app.post('/api/workspaces/:id/context', (req, res) => {
  const workspace = getWorkspace(req.params.id);
  const dir = folderIn(workspace, req.body.dir);
  const repos = reposAt(workspace, dir).filter((r) => isInside(dir, r.absPath));
  res.json({ file: writeContext(workspace, dir, repos) });
});

/**
 * Pasta dentro do workspace (raiz, pasta de grupo ou repo) enviada pela interface. Vale também uma
 * pasta de um worktree do workspace (o de uma issue ou o de uma sessão), que fica fora dele.
 */
function folderIn(workspace: Workspace, value: unknown): string {
  const dir = typeof value === 'string' && value ? path.resolve(value) : workspace.rootPath;
  const inside = isInside(workspace.rootPath, dir) || worktreeAt(workspace, dir) !== null;
  if (!inside || !existsSync(dir)) throw new HttpError(400, 'Pasta fora do workspace.');
  return dir;
}

// Abre o Claude numa pasta do workspace — o "abrir a pasta, cmd, claude" de sempre, com a conta escolhida.
app.post('/api/workspaces/:id/terminal', async (req, res) => {
  const workspace = getWorkspace(req.params.id);
  const options = workspaceTerminalOptions(workspace, req.body);
  const cwd = folderIn(workspace, req.body.dir);
  // Numa pasta de worktree, o Claude recebe o contexto dele: os repositórios nos caminhos do worktree e as regras.
  res.json(await startInTerminal({ ...options, issue: null, cwd, worktree: worktreeAt(workspace, cwd) }));
});

// ---------------------------------------------------------------- editores, terminal e mudanças

app.get('/api/update', async (_req, res) => {
  res.json(db.preferences.checkUpdates ? await checkUpdate(APP_VERSION) : null);
});

app.get('/api/integrations', (_req, res) => {
  res.json(integrations());
});

app.patch('/api/preferences', (req, res) => {
  const body = req.body as Record<string, unknown>;
  if (body.terminal !== undefined) {
    const terminal = str(body.terminal) || null;
    if (terminal && !isKnownTerminal(terminal)) throw new HttpError(400, 'Terminal não encontrado neste computador.');
    db.preferences.terminal = terminal;
  }
  if (typeof body.checkUpdates === 'boolean') db.preferences.checkUpdates = body.checkUpdates;
  if (body.editor !== undefined) {
    const editor = str(body.editor) || null;
    if (editor && !isKnownEditor(editor)) throw new HttpError(400, 'Editor não encontrado neste computador.');
    db.preferences.editor = editor;
  }
  save();
  broadcast({ type: 'preferences', preferences: db.preferences });
  res.json(integrations());
});

/**
 * Repositórios que importam numa sessão: os que ela tocou e os da issue; senão, todos da pasta dela.
 * Numa sessão em worktree, nos caminhos do worktree.
 */
function sessionScope(sessionId: string): { session: ReturnType<typeof getSession>; focused: Repo[]; inScope: Repo[] } {
  const session = getSession(sessionId);
  const inScope = sessionRepos(session).filter((r) => isInside(session.cwd, r.absPath));
  const issue = session.issueId ? db.issues.find((i) => i.id === session.issueId) : null;
  const focused = inScope.filter((r) => session.touchedRepoIds.includes(r.id) || issue?.repoIds.includes(r.id));
  return { session, focused, inScope };
}

/** Pastas para o editor: até 12 repositórios viram um .code-workspace; acima disso, abre a pasta. */
function editorFolders(dir: string, repos: Repo[]): string[] {
  return repos.length && repos.length <= 12 ? repos.map((r) => r.absPath) : [dir];
}

app.post('/api/workspaces/:id/open-editor', async (req, res) => {
  const workspace = getWorkspace(req.params.id);
  const dir = folderIn(workspace, req.body.dir);
  const ids = Array.isArray(req.body.repoIds) ? new Set(req.body.repoIds.filter((id: unknown) => typeof id === 'string')) : null;
  const repos = reposAt(workspace, dir).filter((r) => (ids ? ids.has(r.id) : isInside(dir, r.absPath)));
  const name = `${workspace.name}-${path.basename(dir)}`;
  res.json({ editor: await openInEditor({ editorId: str(req.body.editor) || null, name, dir, folders: editorFolders(dir, repos) }) });
});

app.post('/api/workspaces/:id/shell', async (req, res) => {
  const workspace = getWorkspace(req.params.id);
  const dir = folderIn(workspace, req.body.dir);
  await openShell(dir, `Octo · ${path.basename(dir)}`);
  res.json({ ok: true });
});

app.get('/api/workspaces/:id/changes', async (req, res) => {
  const workspace = getWorkspace(req.params.id);
  const dir = folderIn(workspace, req.query.dir);
  res.json(await changesFor(reposAt(workspace, dir).filter((r) => isInside(dir, r.absPath)).slice(0, 40)));
});

app.post('/api/sessions/:id/open-editor', async (req, res) => {
  const { session, focused, inScope } = sessionScope(req.params.id);
  const repos = focused.length ? focused : inScope;
  const name = `${path.basename(session.cwd)}-${session.id.slice(0, 8)}`;
  res.json({ editor: await openInEditor({ editorId: str(req.body.editor) || null, name, dir: session.cwd, folders: editorFolders(session.cwd, repos) }) });
});

app.post('/api/sessions/:id/shell', async (req, res) => {
  const session = getSession(req.params.id);
  requireFolder(session.cwd, `A pasta desta sessão não existe mais: ${session.cwd}. Ela pode ter sido movida, renomeada ou apagada.`);
  await openShell(session.cwd, `Octo · ${path.basename(session.cwd)}`);
  res.json({ ok: true });
});

app.get('/api/sessions/:id/changes', async (req, res) => {
  const { session, focused, inScope } = sessionScope(req.params.id);
  const changes = await changesFor((focused.length ? focused : inScope).slice(0, 40));
  // Separa o que já estava alterado quando a sessão começou do que mudou durante ela.
  const baseline = readBaseline(session.id);
  if (baseline) markPreexisting(changes, baseline.repos, Date.parse(session.startedAt));
  res.json(changes);
});

app.post('/api/workspaces/:id/reveal', async (req, res) => {
  await revealFolder(folderIn(getWorkspace(req.params.id), req.body.dir));
  res.json({ ok: true });
});

// ---------------------------------------------------------------- contas

/** Variáveis do `env` do settings.json que levariam a chave ou o login da conta principal junto. */
const CREDENTIAL_ENV = /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|AWS_BEARER_TOKEN_BEDROCK)$/;

/**
 * Copia o settings.json para a conta nova sem o que identifica quem paga: chaves no `env`,
 * `apiKeyHelper` e os comandos de credencial da AWS. Com eles, a conta nova usaria a mesma chave
 * da principal. Um settings.json que não é JSON válido fica de fora.
 */
function copySettingsWithoutCredentials(from: string, to: string): void {
  let settings: unknown;
  try {
    settings = JSON.parse(readFileSync(from, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return;
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return;
  const data = settings as Record<string, unknown>;
  for (const key of ['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport']) delete data[key];
  if (data.env && typeof data.env === 'object' && !Array.isArray(data.env)) {
    const env = data.env as Record<string, unknown>;
    for (const key of Object.keys(env)) if (CREDENTIAL_ENV.test(key)) delete env[key];
  }
  writeFileSync(to, `${JSON.stringify(data, null, 2)}\n`);
}

app.post('/api/accounts', async (req, res) => {
  const name = str(req.body.name).trim();
  if (!name) throw new HttpError(400, 'Dê um nome para a conta.');
  const configDir = str(req.body.configDir).trim() ? userPath(req.body.configDir) : path.join(homedir(), `.claude-${slug(name)}`);
  const mainDir = path.join(homedir(), '.claude');
  if (db.accounts.some((a) => samePath(a.configDir ?? mainDir, configDir))) {
    throw new HttpError(400, 'Já existe uma conta usando essa pasta de configuração.');
  }
  mkdirSync(configDir, { recursive: true });
  if (req.body.inherit !== false) {
    // Copia suas preferências (não credenciais nem histórico) da conta padrão.
    const source = path.join(homedir(), '.claude');
    for (const item of ['settings.json', 'CLAUDE.md', 'agents', 'commands', 'skills']) {
      const from = path.join(source, item);
      const to = path.join(configDir, item);
      if (!existsSync(from) || existsSync(to)) continue;
      if (item === 'settings.json') copySettingsWithoutCredentials(from, to);
      else copyTree(from, to);
    }
  }
  const account: ClaudeAccount = {
    id: randomUUID(),
    name,
    configDir,
    color: ACCOUNT_COLORS[db.accounts.length % ACCOUNT_COLORS.length],
    createdAt: now(),
  };
  db.accounts.push(account);
  save();
  broadcast({ type: 'account', account });
  refreshStatusLater(account);
  res.json(account);
});

app.patch('/api/accounts/:id', (req, res) => {
  const account = getAccount(req.params.id);
  if (typeof req.body.name === 'string' && req.body.name.trim()) account.name = req.body.name.trim();
  if (typeof req.body.color === 'string' && /^#[0-9a-f]{6}$/i.test(req.body.color)) account.color = req.body.color;
  save();
  broadcast({ type: 'account', account });
  res.json(account);
});

app.delete('/api/accounts/:id', (req, res) => {
  const account = getAccount(req.params.id);
  if (db.sessions.some((s) => s.accountId === account.id && isRunning(s.id))) throw new HttpError(400, 'Há sessões rodando com essa conta.');
  db.accounts = db.accounts.filter((a) => a.id !== account.id);
  // A interface recebe o workspace com a nova conta padrão: ela não adivinha qual é.
  for (const workspace of db.workspaces) {
    if (workspace.defaultAccountId === account.id) {
      workspace.defaultAccountId = db.accounts[0]?.id ?? null;
      broadcast({ type: 'workspace', workspace });
    }
  }
  for (const issue of db.issues) {
    if (issue.delegateAccountId === account.id) {
      issue.delegateAccountId = null;
      commitIssue(issue);
    }
  }
  delete accountStatus[account.id];
  save();
  broadcast({ type: 'account.deleted', id: account.id });
  res.json({ ok: true });
});

app.post('/api/accounts/:id/status', async (req, res) => {
  res.json(await refreshStatus(getAccount(req.params.id)));
});

app.post('/api/accounts/:id/login', async (req, res) => {
  const account = getAccount(req.params.id);
  await openClaudeTerminal({
    cwd: homedir(),
    account,
    args: ['auth', 'login'],
    title: `Login · ${account.name}`,
    banner: `Octo · login da conta "${account.name}"${account.configDir ? ` (CLAUDE_CONFIG_DIR=${account.configDir})` : ''}`,
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- configuração do Claude Code da conta

app.get('/api/accounts/:id/config', async (req, res) => {
  res.json(await readAccountConfig(getAccount(req.params.id), projectDir(req.query.cwd), req.query.fresh ? 0 : undefined));
});

app.put('/api/accounts/:id/settings', (req, res) => {
  writeSettingsRaw(getAccount(req.params.id), str(req.body.raw));
  res.json({ ok: true });
});

// Campos do formulário (modelo, effort…): mexe só nessas chaves e preserva o resto do arquivo.
app.patch('/api/accounts/:id/settings', (req, res) => {
  const body = req.body as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  if (body.model !== undefined) patch.model = cliValue(body.model, 'Modelo');
  if (body.effortLevel !== undefined) patch.effortLevel = asEffort(body.effortLevel);
  if (body.alwaysThinkingEnabled !== undefined) patch.alwaysThinkingEnabled = typeof body.alwaysThinkingEnabled === 'boolean' ? body.alwaysThinkingEnabled : null;
  patchSettings(getAccount(req.params.id), patch);
  res.json({ ok: true });
});

app.get('/api/accounts/:id/item', async (req, res) => {
  res.json(await readItem(getAccount(req.params.id), req.query.path, projectDir(req.query.cwd)));
});

app.post('/api/accounts/:id/items', (req, res) => {
  res.json({ path: createItem(getAccount(req.params.id), req.body.kind, req.body.name, req.body.content) });
});

app.put('/api/accounts/:id/item', async (req, res) => {
  await saveItem(getAccount(req.params.id), req.body.path, req.body.content, projectDir(req.body.cwd));
  res.json({ ok: true });
});

app.delete('/api/accounts/:id/item', async (req, res) => {
  res.json({ trash: await deleteItem(getAccount(req.params.id), req.query.path, projectDir(req.query.cwd)) });
});

app.post('/api/accounts/:id/item/copy', async (req, res) => {
  await copyItem(getAccount(req.params.id), req.body.path, getAccount(str(req.body.targetAccountId)), projectDir(req.body.cwd));
  res.json({ ok: true });
});

app.post('/api/accounts/:id/mcp', async (req, res) => {
  await addMcpServer(getAccount(req.params.id), req.body.name, req.body.config);
  res.json({ ok: true });
});

app.delete('/api/accounts/:id/mcp/:name', async (req, res) => {
  await removeMcpServer(getAccount(req.params.id), req.params.name);
  res.json({ ok: true });
});

app.get('/api/accounts/:id/plugins/available', async (req, res) => {
  res.json(await availablePlugins(getAccount(req.params.id)));
});

app.post('/api/accounts/:id/plugins', async (req, res) => {
  await pluginAction(getAccount(req.params.id), req.body.action, req.body.id);
  res.json({ ok: true });
});

app.post('/api/accounts/:id/reveal', async (req, res) => {
  const account = getAccount(req.params.id);
  const dir = account.configDir ?? path.join(homedir(), '.claude');
  requireFolder(dir, `A pasta ${dir} ainda não existe. Ela é criada no primeiro login desta conta.`);
  await revealFolder(dir);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- issues

app.post('/api/workspaces/:id/issues', (req, res) => {
  const workspace = getWorkspace(req.params.id);
  const title = str(req.body.title).trim();
  if (!title) throw new HttpError(400, 'A issue precisa de um título.');
  const repoIds = new Set(workspaceRepos(workspace.id).map((r) => r.id));
  workspace.issueCounter += 1;
  const status = asStatus(req.body.status) ?? 'todo';
  const issue: Issue = {
    id: randomUUID(),
    workspaceId: workspace.id,
    number: workspace.issueCounter,
    identifier: `${workspace.key}-${workspace.issueCounter}`,
    title,
    description: str(req.body.description),
    status,
    priority: asPriority(req.body.priority) ?? 0,
    repoIds: Array.isArray(req.body.repoIds) ? req.body.repoIds.filter((id: string) => repoIds.has(id)) : [],
    delegateAccountId: req.body.delegateAccountId ? getAccount(str(req.body.delegateAccountId)).id : null,
    reviewPending: false,
    worktree: null,
    sortOrder: -Date.now(),
    createdAt: now(),
    updatedAt: now(),
    history: [],
  };
  addHistory(issue, 'created', 'Você', 'criou a issue');
  db.issues.push(issue);
  broadcast({ type: 'workspace', workspace });
  commitIssue(issue);
  res.json(issue);
});

app.patch('/api/issues/:id', (req, res) => {
  const issue = getIssue(req.params.id);
  const body = req.body as Record<string, unknown>;
  if (typeof body.title === 'string' && body.title.trim()) issue.title = body.title.trim();
  if (typeof body.description === 'string') issue.description = body.description;
  const status = asStatus(body.status);
  if (status && status !== issue.status) {
    issue.status = status;
    issue.reviewPending = false; // mudou à mão: a revisão adiada não passa por cima
    addHistory(issue, 'status', 'Você', `moveu para ${STATUS_LABEL[status]}`);
  }
  const priority = asPriority(body.priority);
  if (priority !== undefined && priority !== issue.priority) {
    issue.priority = priority;
    addHistory(issue, 'priority', 'Você', 'mudou a prioridade');
  }
  if (Array.isArray(body.repoIds)) {
    const valid = new Set(workspaceRepos(issue.workspaceId).map((r) => r.id));
    issue.repoIds = (body.repoIds as string[]).filter((id) => valid.has(id));
    addHistory(issue, 'repos', 'Você', 'atualizou os repositórios');
  }
  if (body.delegateAccountId !== undefined) {
    const account = body.delegateAccountId ? getAccount(str(body.delegateAccountId)) : null;
    if ((account?.id ?? null) !== issue.delegateAccountId) {
      issue.delegateAccountId = account?.id ?? null;
      addHistory(issue, 'delegate', 'Você', account ? `definiu a conta como ${account.name}` : 'voltou para a conta padrão do workspace');
    }
  }
  if (typeof body.sortOrder === 'number') issue.sortOrder = body.sortOrder;
  commitIssue(issue);
  res.json(issue);
});

app.delete('/api/issues/:id', (req, res) => {
  const issue = getIssue(req.params.id);
  // O worktree sai antes (a interface o remove ao excluir, e recusa se houver algo a perder): sem a issue, a branch ficaria presa numa pasta sem dono.
  if (isPreparing(issue.id)) throw new HttpError(409, 'O worktree desta issue está sendo preparado. Espere a delegação terminar e tente de novo.');
  if (issue.worktree) {
    throw new HttpError(409, `Esta issue tem o worktree ${path.basename(issue.worktree.root)}. Remova-o antes, em Mais ações → Remover worktree…; as branches continuam nos repositórios.`);
  }
  for (const session of db.sessions) if (session.issueId === issue.id && isRunning(session.id)) stopSession(session);
  db.issues = db.issues.filter((i) => i.id !== issue.id);
  save();
  broadcast({ type: 'issue.deleted', id: issue.id });
  res.json({ ok: true });
});

app.post('/api/issues/:id/delegate', imageJson, async (req, res) => {
  const issue = getIssue(req.params.id);
  const workspace = getWorkspace(issue.workspaceId);
  const terminal = req.body.mode === 'terminal';
  const base = asWorktreeBase(req.body.worktree);
  // Antes de preparar o worktree, tudo que recusaria a delegação (conta, configurações, imagens, que só vão
  // em segundo plano, e o Claude Code instalado): uma delegação recusada não deixa um worktree para trás.
  const options = { ...workspaceTerminalOptions(workspace, req.body), issue, images: parseImages(req.body.images) };
  if (terminal) refuseTerminalImages(options.images);
  if (base) requireClaude();
  // As imagens vão para o disco antes do worktree: se a gravação falhar, nenhum worktree fica para trás.
  const sessionId = randomUUID();
  const savedImages = saveImages(sessionId, options.images);
  // Se a issue já tem um worktree, a sessão continua nele (a base só vale para um novo).
  const hadWorktree = Boolean(issue.worktree);
  const prepared = base ? await prepareWorktree(workspace, issue, base) : null;
  const start = { ...options, sessionId, savedImages, worktree: prepared?.worktree ?? null, notes: prepared?.notes ?? [] };
  try {
    res.json(terminal ? await startInTerminal(start) : startHeadless(start));
  } catch (error) {
    // Um worktree criado agora para uma delegação que não começou (o terminal não abriu, o comando ficou
    // longo demais) não fica para trás.
    if (prepared && !hadWorktree) await discardNewWorktree(issue, prepared.worktree).catch(() => undefined);
    throw error;
  }
});

/** Sessões que rodam (ou rodaram) no worktree da issue. */
function sessionsInWorktree(issue: Issue) {
  const root = issue.worktree?.root;
  return root ? db.sessions.filter((s) => s.worktree && samePath(s.worktree.root, root)) : [];
}

/**
 * Uma sessão em segundo plano roda agora no worktree da issue: não dá para removê-lo. Com `still =
 * isWorking`, uma que já respondeu e só está saindo não conta (a remoção espera por ela).
 */
function worktreeBusy(issue: Issue, still = isRunning): boolean {
  return sessionsInWorktree(issue).some((s) => still(s.id));
}

// A pasta e a branch que um worktree novo teria agora (a prévia ao delegar), ou o worktree que a issue já tem.
app.get('/api/issues/:id/worktree/plan', async (req, res) => {
  const issue = getIssue(req.params.id);
  res.json(await planWorktree(getWorkspace(issue.workspaceId), issue));
});

app.get('/api/issues/:id/worktree', async (req, res) => {
  const issue = getIssue(req.params.id);
  res.json(await worktreeStatus(issue, worktreeBusy(issue, isWorking)));
});

// Remove o worktree da issue (?force=1: mesmo com alterações sem commit, que se perdem). As branches continuam nos repositórios.
app.delete('/api/issues/:id/worktree', async (req, res) => {
  const issue = getIssue(req.params.id);
  // Uma sessão que já respondeu ainda pode estar saindo, com a pasta aberta: espera ela terminar.
  await Promise.all(sessionsInWorktree(issue).map((s) => settleRun(s.id)));
  await removeWorktree(issue, { force: req.query.force === '1', busy: worktreeBusy(issue) });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- sessões

app.get('/api/sessions/:id/activities', (req, res) => {
  res.json(sessionActivities(getSession(req.params.id).id));
});

// Imagem que foi junto de uma mensagem. O nome vem do conteúdo, então o arquivo nunca muda.
app.get('/api/sessions/:id/images/:name', (req, res) => {
  const file = imageFile(getSession(req.params.id).id, req.params.name);
  if (!file) throw new HttpError(404, 'Imagem não encontrada.');
  // Relativo à pasta: pelo caminho completo, o ".octo" contaria como arquivo oculto e daria 404.
  res.sendFile(path.basename(file), {
    root: path.dirname(file),
    headers: { 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' },
  });
});

app.post('/api/sessions/:id/message', imageJson, async (req, res) => {
  const session = getSession(req.params.id);
  const text = str(req.body.text).trim();
  const images = parseImages(req.body.images);
  if (!text && !images.length) throw new HttpError(400, 'Escreva uma mensagem ou anexe uma imagem.');
  await sendMessage(session, text, allowedRules(req.body.allowedTools), settingsChanges(req.body), images);
  res.json(session);
});

app.post('/api/sessions/:id/dismiss-denials', (req, res) => {
  dismissDenials(getSession(req.params.id));
  res.json({ ok: true });
});

// "Concluir": sessão aberta no terminal (ou aguardando permissão) que a pessoa dá por encerrada.
app.post('/api/sessions/:id/finish', (req, res) => {
  finishSession(getSession(req.params.id));
  res.json({ ok: true });
});

app.post('/api/sessions/:id/stop', (req, res) => {
  stopSession(getSession(req.params.id));
  res.json({ ok: true });
});

app.post('/api/sessions/:id/terminal', async (req, res) => {
  const session = getSession(req.params.id);
  await resumeInTerminal(session);
  res.json(session);
});

app.post('/api/sessions/:id/sync', (req, res) => {
  const session = getSession(req.params.id);
  if (isRunning(session.id)) throw new HttpError(409, 'A sessão está rodando em segundo plano; sincronize depois que ela terminar.');
  res.json({ count: syncFromTranscript(session) });
});

// ---------------------------------------------------------------- estáticos e erros

/**
 * A interface só carrega o que vem do próprio Octo: uma resposta do agente com uma imagem
 * remota (ex.: ![x](https://site/?dados=…)) não faz a janela buscar nada lá fora.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "script-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

if (existsSync(DIST)) {
  app.use(
    express.static(DIST, {
      setHeaders: (res, file) => {
        if (file.endsWith('.html')) res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
      },
    }),
  );
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    res.sendFile(path.join(DIST, 'index.html'));
  });
}

app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
  // HttpError e erros do body-parser trazem o status; o resto é falha interna.
  const status = Number((error as { status?: number })?.status) || 500;
  let message = error instanceof Error ? error.message : String(error);
  if ((error as { type?: string })?.type === 'entity.too.large') {
    message = takesImages(req) ? 'A mensagem ficou grande demais: envie menos imagens ou imagens menores.' : 'O conteúdo enviado passa do limite de 2 MB.';
  }
  if (status >= 500) console.error('[octo]', error);
  res.status(status).json({ error: message });
});

// ---------------------------------------------------------------- ciclo de vida

function listen(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer(app);
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

export async function startServer(options: ServerOptions): Promise<{ url: string; server: Server }> {
  if (options.pickFolder) pick = options.pickFolder;
  if (options.suggestedRoot !== undefined) suggestedRoot = options.suggestedRoot;
  if (options.devOrigin) for (const host of ['127.0.0.1:5173', 'localhost:5173']) allowedHosts.add(host);

  const server = await listen(options.port).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE' && options.anyPortIfBusy) return listen(0);
    throw error;
  });
  const { port } = server.address() as AddressInfo;
  listeningPort = port;
  allowedHosts.add(`127.0.0.1:${port}`);
  allowedHosts.add(`localhost:${port}`);
  const url = `http://127.0.0.1:${port}`;
  writeLock(url);
  return { url, server };
}

/** Endereço que já autentica a interface (abre com o token e troca por um cookie). */
export function authUrl(url: string): string {
  return `${url}/?token=${TOKEN}`;
}

export function describeServer(url: string): string {
  return [
    `  Octo rodando em ${url}`,
    `  Dados em ${DATA_DIR}`,
    `  Claude Code: ${claude().command ? `${claude().version} (${claude().command?.display})` : (claude().problem ?? 'NÃO ENCONTRADO')}`,
  ].join('\n');
}

export function runningSessionCount(): number {
  return db.sessions.filter((s) => isRunning(s.id)).length;
}

/** Ao sair: encerra as sessões em segundo plano (e o que elas abriram) e grava tudo. */
export function shutdown(): void {
  for (const session of db.sessions) if (isRunning(session.id)) stopSession(session);
  flush();
  releaseLock();
}
