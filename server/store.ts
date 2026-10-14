import { mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import {
  PERMISSION_MODES, type Activity, type AgentSession, type ClaudeAccount, type Issue, type PermissionMode, type Preferences, type Repo,
  type Workspace,
} from '../shared/types.ts';
import { ensureDataDir } from './instance.ts';
import { DATA_DIR, DB_FILE, RUNTIME_DIR, SESSIONS_DIR } from './paths.ts';

export { DATA_DIR, RUNTIME_DIR };

interface Db {
  version: 1;
  workspaces: Workspace[];
  repos: Repo[];
  accounts: ClaudeAccount[];
  issues: Issue[];
  sessions: AgentSession[];
  preferences: Preferences;
}

function emptyDb(): Db {
  return { version: 1, workspaces: [], repos: [], accounts: [], issues: [], sessions: [], preferences: { terminal: null, editor: null, checkUpdates: true } };
}

function load(): Db {
  ensureDataDir();
  mkdirSync(SESSIONS_DIR, { recursive: true });
  mkdirSync(RUNTIME_DIR, { recursive: true });
  if (!existsSync(DB_FILE)) return emptyDb();
  try {
    return { ...emptyDb(), ...(JSON.parse(readFileSync(DB_FILE, 'utf8')) as Partial<Db>) };
  } catch (error) {
    const backup = `${DB_FILE}.corrupt-${Date.now()}`;
    renameSync(DB_FILE, backup);
    console.error(`[octo] db.json ilegível; movido para ${backup}`, error);
    return emptyDb();
  }
}

export const db: Db = load();

let saveTimer: NodeJS.Timeout | null = null;

/** Agenda uma gravação atômica do banco (escreve em .tmp e renomeia). */
export function save(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(flush, 150);
}

export function flush(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  const tmp = `${DB_FILE}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(db, null, 2));
    renameSync(tmp, DB_FILE);
  } catch (error) {
    // No Windows, antivírus/indexador podem segurar o arquivo por um instante: tenta de novo.
    console.error('[octo] falha ao salvar db.json; nova tentativa em 1s', error);
    saveTimer = setTimeout(flush, 1000);
  }
}

function activityFile(sessionId: string): string {
  return path.join(SESSIONS_DIR, `${sessionId}.jsonl`);
}

export function appendActivity(activity: Activity): void {
  appendFileSync(activityFile(activity.sessionId), `${JSON.stringify(activity)}\n`);
}

export function writeActivities(sessionId: string, activities: Activity[]): void {
  const file = activityFile(sessionId);
  writeFileSync(`${file}.tmp`, activities.map((a) => `${JSON.stringify(a)}\n`).join(''));
  renameSync(`${file}.tmp`, file);
}

export function readActivities(sessionId: string): Activity[] {
  const file = activityFile(sessionId);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Activity];
      } catch {
        return [];
      }
    });
}

// Dados gravados por versões anteriores do Octo: completa os campos que vieram depois.
db.preferences.checkUpdates ??= true;
const validMode = (mode: string): PermissionMode =>
  PERMISSION_MODES.includes(mode as PermissionMode) ? (mode as PermissionMode) : mode === 'default' ? 'manual' : 'acceptEdits';
for (const workspace of db.workspaces) {
  workspace.defaultPermissionMode = validMode(workspace.defaultPermissionMode);
  workspace.defaultModel ??= null;
  workspace.defaultEffort ??= null;
}
for (const session of db.sessions) {
  session.permissionMode = validMode(session.permissionMode);
  session.effort ??= null;
  session.agent ??= null;
  session.fallbackModel ??= null;
  session.addDirs ??= [];
  session.maxBudgetUsd ??= null;
}

// Sessões que estavam rodando quando o servidor caiu não têm mais processo.
for (const session of db.sessions) {
  if (session.state === 'active' || session.state === 'pending') {
    session.state = 'stopped';
    session.lastError = 'Servidor reiniciado durante a execução.';
  }
}
