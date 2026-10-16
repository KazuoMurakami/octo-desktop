import { randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
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
/**
 * A cópia de segurança anterior: o db.json.bak passa para cá antes de ser trocado por um conteúdo diferente.
 * Assim, abrir um db.json ruim que passou na conferência (e virou a cópia) não apaga a última cópia boa.
 */
const PREVIOUS_BACKUP_FILE = `${BACKUP_FILE}.1`;
let lastBackupAt = 0;

/**
 * O db.json do disco, quando se sabe que ele é bom: o que abriu e passou pelas migrações, ou o que este
 * processo gravou depois. É ele que vira a cópia de segurança, e não o arquivo relido do disco, que pode
 * ter sido trocado por fora nesse meio-tempo.
 */
let savedText: string | null = null;

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

const LISTS = ['workspaces', 'repos', 'accounts', 'issues', 'sessions'] as const;
type List = (typeof LISTS)[number];

/** Textos que identificam cada item, além do id: sem eles, as rotas e a interface não acham nem mostram o item. */
const KEY_TEXTS: Record<List, string[]> = {
  workspaces: ['name', 'rootPath', 'key'],
  repos: ['workspaceId', 'name', 'relPath', 'absPath'],
  accounts: [],
  issues: ['workspaceId', 'identifier', 'title', 'status'],
  sessions: ['workspaceId'],
};

/**
 * Níveis de listas e objetos dentro uns dos outros. Um banco do Octo não passa de poucas dezenas; com mais de
 * ~1.500 (menos, conforme a versão do Node e a pilha de quem chama), o JSON.stringify estoura a pilha, e o banco
 * aberto não poderia ser gravado de volta nem mandado para a interface. Por isso o limite fica bem abaixo: tentar
 * o JSON.stringify ao abrir passaria com a pilha curta da abertura e falharia depois, numa rota.
 */
const MAX_NESTING = 256;

/** Se `value` tem mais de `limit` níveis de listas e objetos. Sem recursão (o JSON.parse aceita qualquer profundidade). */
function tooDeep(value: object, limit: number): boolean {
  const pending: [object, number][] = [[value, 1]];
  while (pending.length) {
    const [current, depth] = pending.pop()!;
    if (depth > limit) return true;
    for (const child of Object.values(current)) if (typeof child === 'object' && child !== null) pending.push([child, depth + 1]);
  }
  return false;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Lê o banco e confere o que não dá para consertar: listas e preferências no formato certo, o id e os textos que
 * identificam cada item, e o aninhamento. JSON válido assim, num formato que nenhuma versão do Octo gravou (editado
 * à mão ou por outra ferramenta), conta como danificado, como um JSON quebrado: aberto, o Octo quebraria logo
 * depois, nas rotas ou na interface. O resto (um campo ausente, de uma versão anterior, ou no tipo errado) a
 * migração conserta: um banco que uma versão do Octo gravou nunca é recusado.
 */
function parseDb(text: string): Partial<Db> {
  // A marca de UTF-8 (BOM) que o Bloco de Notas e o PowerShell põem no começo não faz parte do JSON.
  const data = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown;
  if (!isObject(data)) throw new Error('o conteúdo não é um objeto JSON');
  if (tooDeep(data, MAX_NESTING)) throw new Error(`o conteúdo tem mais de ${MAX_NESTING} níveis de listas e objetos`);
  for (const key of LISTS) {
    const list = data[key];
    if (list === undefined) continue;
    if (!Array.isArray(list) || !list.every(isObject)) throw new Error(`"${key}" não é uma lista de objetos`);
    for (const item of list as Record<string, unknown>[]) {
      if (typeof item.id !== 'string' || !item.id) throw new Error(`há um item de "${key}" sem id`);
      const field = KEY_TEXTS[key].find((name) => typeof item[name] !== 'string');
      if (field) throw new Error(`o item ${item.id} de "${key}" não tem o texto "${field}"`);
    }
  }
  if (data.preferences !== undefined && !isObject(data.preferences)) throw new Error('"preferences" não é um objeto');
  return data as Partial<Db>;
}

/**
 * Grava `text` como a cópia de segurança, com o mesmo cuidado do db.json (.tmp, fsync e rename). Uma cópia
 * diferente que já estava lá passa antes para db.json.bak.1; se não der para movê-la (presa por outro
 * programa), nada muda desta vez.
 */
function backupDb(text: string): void {
  try {
    // Só lê a cópia atual para comparar quando o tamanho bate (o banco pode ter dezenas de MB).
    const same = existsSync(BACKUP_FILE) && statSync(BACKUP_FILE).size === Buffer.byteLength(text) && readFileSync(BACKUP_FILE, 'utf8') === text;
    if (!same) {
      const tmp = writeTemp(text, BACKUP_FILE);
      if (existsSync(BACKUP_FILE)) renameSync(BACKUP_FILE, PREVIOUS_BACKUP_FILE);
      renameSync(tmp, BACKUP_FILE);
    }
    lastBackupAt = Date.now();
  } catch {
    /* sem cópia desta vez */
  }
}

/** Guarda ao lado um arquivo danificado, com a hora no nome, e devolve o caminho novo. */
function setAside(file: string): string {
  const damaged = `${file}.corrupt-${Date.now()}`;
  renameSync(file, damaged);
  return damaged;
}

/**
 * Guarda à parte as cópias de segurança danificadas: as próximas cópias as substituiriam, e elas podem ser o
 * único lugar com os dados. Se não der (presas por outro programa), o Octo abre assim mesmo, porque elas já não
 * servem para restaurar. Devolve o trecho do aviso que diz onde cada uma ficou.
 */
function setAsideBackups(files: string[]): string {
  return files
    .map((file) => {
      try {
        return ` A cópia de segurança ${path.basename(file)}, danificada, foi guardada em ${setAside(file)}.`;
      } catch (error) {
        console.error(`[octo] não foi possível guardar à parte ${file}`, error);
        return ` A cópia de segurança danificada continua em ${file}: não deu para guardá-la à parte (outro programa pode estar usando o arquivo), e as próximas cópias de segurança vão substituí-la.`;
      }
    })
    .join('');
}

/** Arquivos danificados que aberturas anteriores guardaram à parte (db.json.corrupt-<hora>). */
function earlierDamaged(): string[] {
  try {
    return readdirSync(DATA_DIR).filter((name) => /^db\.json\.corrupt-\d+$/.test(name)).sort();
  } catch {
    return [];
  }
}

interface Backup {
  file: string;
  text: string;
  /** Já com as migrações. */
  data: Db;
}

/**
 * A cópia de segurança mais nova que for um banco válido: o db.json.bak, ou o db.json.bak.1 se ele não servir.
 * As danificadas entram em `damaged`. Presa por outro programa, o Octo não abre (como com o db.json).
 */
function readBackup(damaged: string[]): Backup | null {
  for (const file of [BACKUP_FILE, PREVIOUS_BACKUP_FILE]) {
    if (!existsSync(file)) continue;
    const text = readDbText(file);
    let data: Partial<Db>;
    try {
      data = parseDb(text);
    } catch {
      damaged.push(file);
      continue;
    }
    return { file, text, data: migrate({ ...emptyDb(), ...data }, file) };
  }
  return null;
}

/**
 * Volta a cópia de segurança e já a grava como db.json: se o Octo fechasse antes da primeira
 * gravação, a próxima abertura não acharia o db.json, começaria vazia e depois gravaria esse vazio
 * por cima da cópia. Aqui não dá para usar flush(): o `db` ainda não existe.
 */
function restoreBackup(backup: Backup): Db {
  try {
    renameSync(writeTemp(backup.text), DB_FILE);
    savedText = backup.text;
  } catch (error) {
    console.error('[octo] não foi possível gravar o db.json restaurado; nova tentativa em seguida', error);
    restoreUnsaved = true;
  }
  return backup.data;
}

const validMode = (mode: string): PermissionMode =>
  PERMISSION_MODES.includes(mode as PermissionMode) ? (mode as PermissionMode) : mode === 'default' ? 'manual' : 'acceptEdits';

/** Devolve o valor que fica num campo: o mesmo, se ele já estiver no tipo certo, ou o padrão do campo. */
type Fix = (value: unknown) => unknown;
/** Os campos de um tipo de item e o conserto de cada um (em lista: o banco pode ter milhares de itens). */
type Shape = [string, Fix][];

const shape = (fields: Record<string, Fix>): Shape => Object.entries(fields);
const textOr = (fallback: string | null): Fix => (value) => (typeof value === 'string' ? value : fallback);
const numberOr = (fallback: number | null): Fix => (value) => {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : fallback;
};
const flagOr = (fallback: boolean): Fix => (value) => (typeof value === 'boolean' ? value : fallback);
/** Lista de textos: fora de uma lista, vira []; o que não for texto sai dela. */
const textList: Fix = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []);

/** Põe cada campo de `fields` no tipo certo; os outros campos do item ficam como estão. */
function fit<T extends object>(item: T, fields: Shape): T {
  const record = item as Record<string, unknown>;
  for (const [key, fix] of fields) record[key] = fix(record[key]);
  return item;
}

/** Lista de objetos (o histórico de uma issue, as ações bloqueadas de uma sessão): fora de uma lista, vira []. */
const objectList = (fields: Shape): Fix => (value) => (Array.isArray(value) ? value.filter(isObject).map((item) => fit(item, fields)) : []);

/** Um repositório no worktree: sem a pasta e o id do repositório, ele não serve para nada (nem para ser removido). */
const isWorktreeRepo = (entry: unknown): entry is Record<string, unknown> =>
  isObject(entry) && typeof entry.path === 'string' && entry.path !== '' && typeof entry.repoId === 'string';
const WORKTREE_REPO = shape({ branch: textOr(''), base: textOr('') });
const WORKTREE = shape({ createdAt: textOr(''), removing: (removing) => removing === true || undefined });

/** O worktree de uma issue ou sessão. Sem a pasta dele, não há como usá-lo nem removê-lo: fica sem worktree. */
const worktree: Fix = (value) => {
  if (!isObject(value) || typeof value.root !== 'string' || !value.root) return null;
  value.repos = (Array.isArray(value.repos) ? value.repos.filter(isWorktreeRepo) : []).map((entry) => fit(entry, WORKTREE_REPO));
  return fit(value, WORKTREE);
};

/**
 * O tipo de cada campo que o Octo lê dos itens (ver shared/types.ts) e o valor que fica no lugar de um ausente
 * (gravado por uma versão anterior, que ainda não tinha o campo) ou no tipo errado (arquivo editado à mão): a
 * interface lê as listas e os textos sem conferir. O id e os textos de KEY_TEXTS o parseDb já conferiu. Um campo
 * novo nos tipos entra aqui também.
 */
const FIELDS: Record<List, Shape> = {
  workspaces: shape({
    scanDepth: numberOr(3), issueCounter: numberOr(0), guidance: textOr(''), defaultAccountId: textOr(null), defaultModel: textOr(null),
    defaultEffort: textOr(null), defaultWorktree: flagOr(false), createdAt: textOr(''), scannedAt: textOr(null),
  }),
  repos: shape({
    branch: textOr(null), remoteUrl: textOr(null), lastCommitAt: textOr(null), lastCommitMessage: textOr(null), dirty: numberOr(null),
    ahead: numberOr(null), behind: numberOr(null), stack: textList, packageManager: textOr(null), scripts: textList, description: textOr(null),
    hasClaudeMd: flagOr(false), hasAgentsMd: flagOr(false),
  }),
  accounts: shape({ name: textOr(''), configDir: textOr(null), color: textOr(''), createdAt: textOr('') }),
  issues: shape({
    number: numberOr(0), description: textOr(''), priority: numberOr(0), repoIds: textList, delegateAccountId: textOr(null),
    reviewPending: flagOr(false), worktree, sortOrder: numberOr(0), createdAt: textOr(''), updatedAt: textOr(''),
    history: objectList(shape({ id: textOr(''), ts: textOr(''), kind: textOr(''), actor: textOr(''), text: textOr('') })),
  }),
  sessions: shape({
    issueId: textOr(null), accountId: textOr(''), claudeSessionId: textOr(''), mode: textOr(''), state: textOr(''), activeModel: textOr(null),
    title: textOr(''), cwd: textOr(''), startedAt: textOr(''), updatedAt: textOr(''), endedAt: textOr(null), costUsd: numberOr(0),
    durationMs: numberOr(0), turns: numberOr(0), touchedRepoIds: textList,
    pendingDenials: objectList(shape({ tool: textOr(''), rule: textOr(''), input: (input) => (isObject(input) ? input : {}) })),
    lastError: textOr(null), baselineAt: textOr(null), worktree, model: textOr(null), effort: textOr(null), agent: textOr(null),
    fallbackModel: textOr(null), addDirs: textList, maxBudgetUsd: numberOr(null),
  }),
};

const PREFERENCES = shape({ terminal: textOr(null), editor: textOr(null), checkUpdates: flagOr(true) });

/**
 * Prepara o banco recém-lido de `file`. Só recebe o que passou pelo parseDb, então uma falha aqui é
 * defeito do Octo, e não do arquivo: em vez de tratá-lo como danificado (e trocá-lo pela cópia), o Octo
 * não abre, e nada muda no disco.
 */
function migrate(data: Db, file: string): Db {
  try {
    // Campos ausentes (versões anteriores do Octo) ou no tipo errado ganham o valor padrão. Um id repetido numa
    // lista (editada à mão) fica só no primeiro item: com dois iguais, apagar um apagaria os dois.
    data.preferences = fit(data.preferences, PREFERENCES);
    const lists = data as unknown as Record<List, Record<string, unknown>[]>;
    for (const key of LISTS) {
      const seen = new Set<unknown>();
      const unique = lists[key].filter((item) => {
        if (seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
      });
      if (unique.length < lists[key].length) {
        console.error(`[octo] ${file}: ${lists[key].length - unique.length} item(ns) de "${key}" com id repetido ficaram de fora (vale o primeiro de cada id)`);
      }
      lists[key] = unique.map((item) => fit(item, FIELDS[key]));
    }
    for (const workspace of data.workspaces) workspace.defaultPermissionMode = validMode(workspace.defaultPermissionMode);
    for (const session of data.sessions) session.permissionMode = validMode(session.permissionMode);

    // Sessões que estavam rodando quando o servidor caiu não têm mais processo.
    for (const session of data.sessions) {
      if (session.state === 'active' || session.state === 'pending') {
        session.state = 'stopped';
        session.lastError = 'O Octo foi fechado ou reiniciado enquanto a sessão rodava.';
      }
    }

    // Revisão adiada (uma sessão concluiu enquanto outra da mesma issue rodava; ver onSessionSettled):
    // a outra parou junto com o Octo, então a issue vai para revisão agora.
    const openedAt = new Date().toISOString();
    for (const issue of data.issues) {
      if (!issue.reviewPending) continue;
      issue.reviewPending = false;
      if (issue.status !== 'in_progress') continue;
      issue.status = 'in_review';
      issue.updatedAt = openedAt;
      issue.history.push({ id: randomUUID(), ts: openedAt, kind: 'status', actor: 'Octo', text: 'moveu para Em revisão (foi fechado ou reiniciado enquanto outra sessão desta issue rodava)' });
    }
  } catch (error) {
    throw new Error(`Não foi possível preparar os dados de ${file} para esta versão do Octo (${(error as Error)?.message ?? error}). Nenhum arquivo foi alterado.`, { cause: error });
  }
  return data;
}

function load(): Db {
  ensureDataDir();
  mkdirSync(SESSIONS_DIR, { recursive: true });
  mkdirSync(RUNTIME_DIR, { recursive: true });
  if (!existsSync(DB_FILE)) {
    const earlier = earlierDamaged();
    if (!existsSync(BACKUP_FILE) && !existsSync(PREVIOUS_BACKUP_FILE) && !earlier.length) return emptyDb(); // primeira execução
    // Sem db.json mas com a cópia de segurança (ex.: o Octo fechou logo depois de restaurá-la): volta a cópia.
    const damagedBackups: string[] = [];
    const backup = readBackup(damagedBackups);
    const kept = setAsideBackups(damagedBackups);
    // Um db.json danificado guardado à parte numa abertura que não terminou (queda de energia, por exemplo) ainda pode ter os dados.
    const leftovers = earlier.length ? ` Arquivos danificados de aberturas anteriores continuam em ${DATA_DIR}: ${earlier.join(', ')}.` : '';
    if (backup) {
      notice = `O arquivo de dados do Octo (db.json) não foi encontrado e foi restaurado a partir da cópia de segurança (${path.basename(backup.file)}). Mudanças feitas depois dessa cópia podem ter se perdido.${kept}${leftovers}`;
      return restoreBackup(backup);
    }
    notice = `O arquivo de dados do Octo (db.json) não foi encontrado${damagedBackups.length ? ' e a cópia de segurança estava danificada' : ''}, então o Octo começou vazio.${kept}${leftovers}`;
    return emptyDb();
  }
  const text = readDbText(DB_FILE);
  let data: Partial<Db>;
  try {
    data = parseDb(text);
  } catch (error) {
    // A cópia é lida antes de mexer no db.json: se não der para lê-la, o Octo não abre e nada muda.
    const damagedBackups: string[] = [];
    const backup = readBackup(damagedBackups);
    const damaged = setAside(DB_FILE);
    console.error(`[octo] db.json danificado; movido para ${damaged}`, error);
    const kept = setAsideBackups(damagedBackups);
    if (backup) {
      notice = `O arquivo de dados do Octo (db.json) estava danificado e foi restaurado a partir da cópia de segurança (${path.basename(backup.file)}). Mudanças feitas depois dessa cópia podem ter se perdido. O arquivo danificado foi guardado em ${damaged}.${kept}`;
      return restoreBackup(backup);
    }
    notice = `O arquivo de dados do Octo (db.json) estava danificado e não havia cópia de segurança válida, então o Octo começou vazio. O arquivo danificado foi guardado em ${damaged}.${kept}`;
    return emptyDb();
  }
  const opened = migrate({ ...emptyDb(), ...data }, DB_FILE);
  // Abriu e passou pelas migrações: esta é a "última versão boa". A cópia leva o texto lido do disco, de
  // antes das migrações, e não o banco já migrado: logo depois de uma atualização, se uma migração nova
  // estragar algo, a cópia ainda tem os dados como a versão anterior do Octo os gravou (e que ela abre).
  savedText = text;
  backupDb(text);
  return opened;
}

export const db: Db = load();

let saveTimer: NodeJS.Timeout | null = null;

/** Agenda uma gravação atômica do banco (escreve em .tmp e renomeia). */
export function save(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(flush, 150);
}

/** Escreve `text` em <arquivo>.tmp (o db.json, se nada for dito) e devolve o caminho; quem chama renomeia para o arquivo. */
function writeTemp(text: string, file = DB_FILE): string {
  const tmp = `${file}.tmp`;
  // fsync antes do rename: depois de uma queda de energia, o arquivo é o antigo ou o novo, nunca um arquivo pela metade.
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
    const text = JSON.stringify(db, null, 2);
    const tmp = writeTemp(text);
    // De tempos em tempos, a versão anterior vira a cópia de segurança.
    if (Date.now() - lastBackupAt > 30 * 60_000 && savedText !== null) backupDb(savedText);
    renameSync(tmp, DB_FILE);
    savedText = text;
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

// A cópia restaurada não foi gravada ao abrir (ex.: arquivo preso pelo antivírus): flush() tenta de
// novo a cada segundo. Até lá o db.json.bak fica intacto, e uma nova abertura a restauraria outra vez.
if (restoreUnsaved) flush();
