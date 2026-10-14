import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { DATA_DIR, LOCK_FILE, TOKEN_FILE } from './paths.ts';

/**
 * A pasta de dados guarda prompts, transcrições e o token de acesso: no macOS e no Linux
 * ela fica legível só para você (no Windows, a pasta do usuário já é protegida).
 */
export function ensureDataDir(): void {
  migrateFromNexo();
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    try {
      chmodSync(DATA_DIR, 0o700);
    } catch {
      /* pasta de outro dono (OCTO_DATA_DIR): mantém como está */
    }
  }
}

/**
 * O app se chamava Nexo e guardava tudo em ~/.nexo. Na primeira execução como Octo, copia
 * workspaces, issues, contas e sessões para ~/.octo. A pasta antiga fica intacta.
 * Cópia arquivo a arquivo: o cpSync do Node 24 tem falhas com caminhos acentuados no Windows.
 */
function migrateFromNexo(): void {
  if (process.env.OCTO_DATA_DIR || existsSync(DATA_DIR)) return;
  const legacy = path.join(homedir(), '.nexo');
  if (!existsSync(path.join(legacy, 'db.json'))) return;
  const skip = new Set(['server.json', 'token', 'runtime']); // pertencem ao processo antigo
  const copy = (from: string, to: string): void => {
    mkdirSync(to, { recursive: true, mode: 0o700 });
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      if (from === legacy && skip.has(entry.name)) continue;
      const source = path.join(from, entry.name);
      if (entry.isDirectory()) copy(source, path.join(to, entry.name));
      else if (entry.isFile()) copyFileSync(source, path.join(to, entry.name));
    }
  };
  try {
    copy(legacy, DATA_DIR);
    console.log(`[octo] dados copiados de ${legacy} para ${DATA_DIR}`);
  } catch (error) {
    console.error('[octo] não foi possível copiar os dados do Nexo', error);
  }
}

/**
 * O servidor só escuta em 127.0.0.1, mas numa máquina com vários usuários qualquer um deles
 * alcança essa porta. A API exige este segredo, que só quem lê a pasta de dados conhece.
 * Ele persiste entre reinícios para não derrubar abas já abertas.
 */
export function apiToken(): string {
  ensureDataDir();
  try {
    const saved = readFileSync(TOKEN_FILE, 'utf8').trim();
    if (/^[a-f0-9]{48}$/.test(saved)) return saved;
  } catch {
    /* ainda não existe */
  }
  const token = randomBytes(24).toString('hex');
  writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
  return token;
}

export function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

interface Lock {
  pid: number;
  url: string;
}

function readLock(): Lock | null {
  try {
    const lock = JSON.parse(readFileSync(LOCK_FILE, 'utf8')) as Lock;
    return typeof lock.pid === 'number' && typeof lock.url === 'string' ? lock : null;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Dois servidores na mesma pasta de dados sobrescreveriam o db.json um do outro.
 * Retorna o endereço do Octo que já está rodando (app desktop ou `npm start`), se houver.
 */
export async function findRunningServer(): Promise<string | null> {
  const lock = readLock();
  if (!lock || lock.pid === process.pid || !alive(lock.pid)) return null;
  try {
    const response = await fetch(`${lock.url}/api/health`, { signal: AbortSignal.timeout(1500) });
    const health = (await response.json()) as { app?: string; pid?: number };
    return health.app === 'octo' && health.pid === lock.pid ? lock.url : null;
  } catch {
    return null;
  }
}

export function writeLock(url: string): void {
  ensureDataDir();
  writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, url } satisfies Lock));
}

export function releaseLock(): void {
  if (readLock()?.pid !== process.pid) return;
  try {
    unlinkSync(LOCK_FILE);
  } catch {
    /* já removido */
  }
}
