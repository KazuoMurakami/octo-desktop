import { randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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

/** Última versão boa do banco: recuperada se o db.json aparecer danificado. */
const BACKUP_FILE = `${DB_FILE}.bak`;
let lastBackupAt = 0;

/** Aviso para a interface quando o db.json estava danificado ao abrir (null quando tudo certo). */
let notice: string | null = null;

/** A cópia de segurança restaurada não chegou ao disco ao abrir: o fim deste arquivo tenta de novo. */
let restoreUnsaved = false;

export function dbNotice(): string | null {
  return notice;
}

function emptyDb(): Db {
  return { version: 1, workspaces: [], repos: [], accounts: [], issues: [], sessions: [], preferences: { terminal: null, editor: null, checkUpdates: true } };
}

/**
 * Lê o arquivo, tentando de novo por um instante: no Windows, antivírus, backup e OneDrive podem
 * segurá-lo. Não conseguir LER não quer dizer que ele está corrompido; começar vazio aqui faria a
 * próxima gravação apagar os dados, então o Octo prefere não abrir.
 */
function readDbText(file: string): string {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return readFileSync(file, 'utf8');
    } catch (error) {
      lastError = error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  }
  throw new Error(
    `Não foi possível ler ${file} (${(lastError as Error)?.message ?? lastError}). Feche programas que possam estar usando o arquivo (antivírus, backup, OneDrive) e abra o Octo de novo.`,
  );
}

function parseDb(text: string): Partial<Db> {
  const data = JSON.parse(text) as unknown;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('o conteúdo não é um objeto JSON');
  return data as Partial<Db>;
}

function backupDb(): void {
  try {
    copyFileSync(DB_FILE, BACKUP_FILE);
    lastBackupAt = Date.now();
  } catch {
    /* sem cópia desta vez */
  }
}

interface Backup {
  text: string;
  data: Partial<Db>;
}

/** A cópia de segurança, se existir e for um banco válido. Presa por outro programa, o Octo não abre (como com o db.json). */
function readBackup(): Backup | null {
  if (!existsSync(BACKUP_FILE)) return null;
  const text = readDbText(BACKUP_FILE);
  try {
    return { text, data: parseDb(text) };
  } catch {
    return null;
  }
}

/**
 * Volta a cópia de segurança e já a grava como db.json: se o Octo fechasse antes da primeira
 * gravação, a próxima abertura não acharia o db.json, começaria vazia e depois gravaria esse vazio
 * por cima da cópia. Aqui não dá para usar flush(): o `db` ainda não existe.
 */
function restoreBackup(backup: Backup): Db {
  try {
    renameSync(writeTemp(backup.text), DB_FILE);
  } catch (error) {
    console.error('[octo] não foi possível gravar o db.json restaurado; nova tentativa em seguida', error);
    restoreUnsaved = true;
  }
  return { ...emptyDb(), ...backup.data };
}

function load(): Db {
  ensureDataDir();
  mkdirSync(SESSIONS_DIR, { recursive: true });
  mkdirSync(RUNTIME_DIR, { recursive: true });
  if (!existsSync(DB_FILE)) {
    if (!existsSync(BACKUP_FILE)) return emptyDb(); // primeira execução
    // Sem db.json mas com a cópia de segurança (ex.: o Octo fechou logo depois de restaurá-la): volta a cópia.
    const backup = readBackup();
    if (!backup) {
      notice = 'O arquivo de dados do Octo (db.json) não foi encontrado e a cópia de segurança (db.json.bak) estava danificada, então o Octo começou vazio.';
      return emptyDb();
    }
    notice = 'O arquivo de dados do Octo (db.json) não foi encontrado e foi restaurado a partir da cópia de segurança (db.json.bak). Mudanças feitas depois dessa cópia podem ter se perdido.';
    return restoreBackup(backup);
  }
  const text = readDbText(DB_FILE);
  try {
    const data = parseDb(text);
    backupDb(); // abriu bem: esta é a "última versão boa"
    return { ...emptyDb(), ...data };
  } catch (error) {
    // A cópia é lida antes de mexer no db.json: se não der para lê-la, o Octo não abre e nada muda.
    const backup = readBackup();
    const damaged = `${DB_FILE}.corrupt-${Date.now()}`;
    renameSync(DB_FILE, damaged);
    console.error(`[octo] db.json ilegível; movido para ${damaged}`, error);
    if (backup) {
      notice = `O arquivo de dados do Octo (db.json) estava danificado e foi restaurado a partir da cópia de segurança (db.json.bak). Mudanças feitas depois dessa cópia podem ter se perdido. O arquivo danificado foi guardado em ${damaged}.`;
      return restoreBackup(backup);
    }
    notice = `O arquivo de dados do Octo (db.json) estava danificado e não havia cópia de segurança válida, então o Octo começou vazio. O arquivo danificado foi guardado em ${damaged}.`;
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

/** Escreve o banco em db.json.tmp e devolve o caminho; quem chama renomeia para db.json. */
function writeTemp(text: string): string {
  const tmp = `${DB_FILE}.tmp`;
  // fsync antes do rename: depois de uma queda de energia, o db.json é o antigo ou o novo, nunca um arquivo pela metade.
  const fd = openSync(tmp, 'w');
  try {
    writeFileSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return tmp;
}

export function flush(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  try {
    const tmp = writeTemp(JSON.stringify(db, null, 2));
    // De tempos em tempos, a versão anterior vira a cópia de segurança.
    if (Date.now() - lastBackupAt > 30 * 60_000 && existsSync(DB_FILE)) backupDb();
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

/**
 * O que já estava alterado (sem commit) em cada repositório quando a sessão começou: linhas
 * "XY caminho" do git status, por repositório. Fica num arquivo à parte para não pesar nos
 * eventos da sessão, que vão inteiros para a interface a cada mudança.
 */
export interface Baseline {
  at: string;
  repos: Record<string, string[]>;
}

function baselineFile(sessionId: string): string {
  return path.join(SESSIONS_DIR, `${sessionId}.baseline.json`);
}

export function writeBaseline(sessionId: string, baseline: Baseline): void {
  writeFileSync(baselineFile(sessionId), JSON.stringify(baseline));
}

export function readBaseline(sessionId: string): Baseline | null {
  try {
    const data = JSON.parse(readFileSync(baselineFile(sessionId), 'utf8')) as Baseline;
    return data && typeof data.repos === 'object' ? data : null;
  } catch {
    return null; // sessão anterior a este recurso
  }
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
for (const issue of db.issues) issue.reviewPending ??= false;
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
    session.lastError = 'O Octo foi fechado ou reiniciado enquanto a sessão rodava.';
  }
}

// Revisão adiada (uma sessão concluiu enquanto outra da mesma issue rodava; ver onSessionSettled):
// a outra parou junto com o Octo, então a issue vai para revisão agora.
const openedAt = new Date().toISOString();
for (const issue of db.issues) {
  if (!issue.reviewPending) continue;
  issue.reviewPending = false;
  if (issue.status !== 'in_progress') continue;
  issue.status = 'in_review';
  issue.updatedAt = openedAt;
  issue.history.push({ id: randomUUID(), ts: openedAt, kind: 'status', actor: 'Octo', text: 'moveu para Em revisão (foi fechado ou reiniciado enquanto outra sessão desta issue rodava)' });
}

// A cópia restaurada não foi gravada ao abrir (ex.: arquivo preso pelo antivírus): flush() tenta de
// novo a cada segundo. Até lá o db.json.bak fica intacto, e uma nova abertura a restauraria outra vez.
if (restoreUnsaved) flush();
