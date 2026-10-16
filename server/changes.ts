// O que mudou em cada repositório (git status + git diff contra o HEAD), para a aba "Mudanças".
// Só leitura: nada aqui altera o repositório.
import { execFile } from 'node:child_process';
import { openSync, readSync, closeSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import type { FileChangeStatus, Repo, RepoChanges } from '../shared/types.ts';
import { readOnlyGit, UnsafeGitConfig, type SafeGit } from './gitSafe.ts';
import { baseEnv, gitPath } from './system.ts';

/** Teto do diff por repositório; acima disso os arquivos aparecem sem o conteúdo. */
const MAX_PATCH = 400_000;
/** Arquivos novos (ainda fora do git) até este tamanho aparecem inteiros. */
const MAX_NEW_FILE = 64_000;
const MAX_NEW_FILES = 60;
/** Arquivos listados por repositório (ex.: um node_modules fora do .gitignore); o resto vira só a contagem. */
const MAX_FILES = 500;
/** Linhas guardadas no retrato do início da sessão, por repositório. */
const MAX_BASELINE = 2000;

// `safe`: o prefixo e o ambiente do gitSafe, para a config do repositório não rodar nenhum programa nesta leitura.
function git(cwd: string, args: string[], safe: SafeGit): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      // Por caminho absoluto: com o nome solto, o Windows rodaria um git.exe de dentro do repositório.
      // Sem git, o gitPath() lança ENOENT, que vira a rejeição (e a mensagem do gitError).
      gitPath(),
      ['-c', 'core.quotepath=off', '-c', 'color.ui=never', ...safe.args, ...args],
      {
        cwd,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: 64 * 1024 * 1024,
        // Sem o lock opcional do índice: o git status não disputa o .git/index.lock com o agente.
        env: { ...baseEnv(), GIT_OPTIONAL_LOCKS: '0', ...safe.env },
      },
      (error, stdout, stderr) => (error ? reject(Object.assign(error, { stderr })) : resolve(stdout)),
    );
  });
}

/** `git status --porcelain=v1 -z`: XY + caminho; renomeações trazem o caminho antigo no item seguinte. */
function parseStatus(out: string): Map<string, { status: FileChangeStatus; oldPath: string | null }> {
  const entries = out.split('\0');
  const files = new Map<string, { status: FileChangeStatus; oldPath: string | null }>();
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const file = entry.slice(3);
    let oldPath: string | null = null;
    if (xy.includes('R') || xy.includes('C')) oldPath = entries[++i] ?? null;
    files.set(file, { status: statusOf(xy), oldPath });
  }
  return files;
}

function statusOf(xy: string): FileChangeStatus {
  if (xy === '??') return 'untracked';
  if (xy.includes('U') || xy === 'AA' || xy === 'DD') return 'conflict';
  if (xy.includes('R')) return 'renamed';
  if (xy.includes('D')) return 'deleted';
  if (xy.includes('A')) return 'added';
  return 'modified';
}

function unquote(value: string): string {
  return value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\') : value;
}

/** Quebra o `git diff` em um bloco por arquivo e conta linhas adicionadas/removidas. */
function splitPatch(patch: string): { path: string; oldPath: string | null; binary: boolean; text: string; additions: number; deletions: number }[] {
  const chunks = patch.split(/^(?=diff --git )/m).filter((chunk) => chunk.startsWith('diff --git '));
  return chunks.map((text) => {
    const lines = text.split('\n');
    let newPath: string | null = null;
    let oldPath: string | null = null;
    let renameFrom: string | null = null;
    let additions = 0;
    let deletions = 0;
    let inHunk = false;
    for (const line of lines) {
      if (!inHunk) {
        // Com espaço no nome, o git põe um TAB no fim das linhas ---/+++: sai antes de tirar as aspas.
        if (line.startsWith('+++ ')) newPath = line === '+++ /dev/null' ? null : unquote(line.slice(4).replace(/\t$/, '')).replace(/^b\//, '');
        else if (line.startsWith('--- ')) oldPath = line === '--- /dev/null' ? null : unquote(line.slice(4).replace(/\t$/, '')).replace(/^a\//, '');
        else if (line.startsWith('rename from ')) renameFrom = line.slice(12);
        else if (line.startsWith('rename to ')) newPath = line.slice(10);
        else if (line.startsWith('@@')) inHunk = true;
        continue;
      }
      if (line.startsWith('+')) additions++;
      else if (line.startsWith('-')) deletions++;
    }
    const header = /^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/.exec(lines[0] ?? '');
    const file = newPath ?? oldPath ?? header?.[2] ?? '';
    return {
      path: file,
      oldPath: renameFrom ?? (oldPath && oldPath !== file ? oldPath : null),
      binary: /^Binary files /m.test(text),
      text,
      additions,
      deletions,
    };
  });
}

/** Arquivo novo fora do git: mostra o conteúdo como linhas adicionadas (se for texto e pequeno). */
function newFilePatch(repoPath: string, file: string): { patch: string; additions: number; binary: boolean } {
  try {
    const full = path.join(repoPath, file);
    const size = statSync(full).size;
    if (size > MAX_NEW_FILE) return { patch: '', additions: 0, binary: false };
    const buffer = Buffer.alloc(size);
    const fd = openSync(full, 'r');
    try {
      readSync(fd, buffer, 0, size, 0);
    } finally {
      closeSync(fd);
    }
    if (buffer.includes(0)) return { patch: '', additions: 0, binary: true };
    const lines = buffer.toString('utf8').replace(/\r\n/g, '\n').split('\n');
    if (lines.at(-1) === '') lines.pop();
    const patch = `--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}\n`;
    return { patch, additions: lines.length, binary: false };
  } catch {
    return { patch: '', additions: 0, binary: false };
  }
}

/** Bytes que um pedido lê, somando os arquivos novos de todos os repositórios, só para contar linhas. */
const MEASURE_BUDGET = 64 * 1024 * 1024;
const MEASURE_BLOCK = 1024 * 1024;

/**
 * Conta as linhas de um arquivo novo sem montar a prévia inteira (para não mostrar "+0" quando a
 * prévia foi pulada por orçamento ou tamanho). Assíncrono, em blocos de 1 MB e com a busca nativa do
 * Buffer: o servidor segue respondendo enquanto lê. Cada arquivo desconta o tamanho inteiro do
 * orçamento do pedido; o que não cabe nele fica sem contagem (`uncounted`, com 0, que a interface não
 * mostra), em vez de uma contagem pela metade.
 */
async function measureNewFile(repoPath: string, file: string, budget: { bytes: number }): Promise<{ additions: number; binary: boolean; uncounted?: boolean }> {
  let handle;
  try {
    handle = await open(path.join(repoPath, file), 'r');
    const { size } = await handle.stat();
    if (size === 0) return { additions: 0, binary: false };
    if (size > budget.bytes) return { additions: 0, binary: false, uncounted: true };
    budget.bytes -= size;
    const chunk = Buffer.allocUnsafe(Math.min(size, MEASURE_BLOCK));
    let newlines = 0;
    let lastByte = 0x0a;
    for (let offset = 0; offset < size; ) {
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, size - offset), offset);
      if (!bytesRead) break;
      const view = chunk.subarray(0, bytesRead);
      if (view.indexOf(0) !== -1) return { additions: 0, binary: true };
      for (let i = view.indexOf(0x0a); i !== -1; i = view.indexOf(0x0a, i + 1)) newlines++;
      lastByte = view[bytesRead - 1];
      offset += bytesRead;
    }
    // Igual ao newFilePatch: +1 na última linha sem quebra no fim (o git conta tudo como adicionado).
    return { additions: newlines + (lastByte === 0x0a ? 0 : 1), binary: false };
  } catch {
    return { additions: 0, binary: false };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** `git diff --numstat -z`: contagens por arquivo; renomeações trazem os dois caminhos nos itens seguintes. */
function parseNumstat(out: string): { path: string; oldPath: string | null; binary: boolean; text: string; additions: number; deletions: number }[] {
  const parts = out.split('\0');
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const match = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(parts[i]);
    if (!match) continue;
    let file = match[3];
    let oldPath: string | null = null;
    if (!file) {
      oldPath = parts[++i] ?? null;
      file = parts[++i] ?? '';
    }
    const binary = match[1] === '-';
    files.push({ path: file, oldPath, binary, text: '', additions: binary ? 0 : Number(match[1]), deletions: binary ? 0 : Number(match[2]) });
  }
  return files;
}

/** O diff contra o HEAD, em blocos por arquivo; se for gigante, só a lista com as contagens. */
async function diffChunks(repo: Repo, safe: SafeGit): Promise<{ chunks: ReturnType<typeof splitPatch>; complete: boolean }> {
  try {
    // Contra o HEAD: junta o que está e o que não está no stage, como "o que mudou desde o último commit".
    // Sem cor, com os prefixos a/ e b/ fixos e os submódulos no formato padrão: o splitPatch não
    // entende o formato que configurações do git da pessoa produzem (color.diff=always,
    // diff.mnemonicPrefix, diff.noprefix, diff.submodule=log…).
    // --no-textconv (além do --no-ext-diff): a config do repositório não roda um textconv ao montar o diff.
    // Os submódulos entram com as mesmas neutralizações, ou não entram (safe.submodules; ver gitSafe.ts).
    const patch = await git(repo.absPath, [
      'diff', 'HEAD', '--no-ext-diff', '--no-textconv', ...safe.submodules, '--no-color', '--src-prefix=a/', '--dst-prefix=b/', '--submodule=short', '--find-renames', '--unified=3',
    ], safe);
    return { chunks: splitPatch(patch), complete: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw error;
    // Ex.: um arquivo gerado enorme: os arquivos aparecem sem o conteúdo, em vez de o repositório dar erro.
    return { chunks: parseNumstat(await git(repo.absPath, ['diff', 'HEAD', '--no-ext-diff', '--no-textconv', ...safe.submodules, '--no-color', '--find-renames', '--numstat', '-z'], safe)), complete: false };
  }
}

/** `measure`: o orçamento de bytes para contar linhas dos arquivos novos, dividido entre os repositórios de um pedido. */
export async function repoChanges(repo: Repo, measure = { bytes: MEASURE_BUDGET }): Promise<RepoChanges> {
  const result: RepoChanges = { repoId: repo.id, name: repo.name, absPath: repo.absPath, branch: repo.branch, files: [], truncated: false, error: null };
  if (mtimeOf(repo.absPath) === null) {
    result.error = 'A pasta deste repositório não existe mais (ele pode ter sido movido ou apagado). Reescaneie o workspace.';
    return result;
  }
  try {
    // Calculado uma vez por repositório: a config dele não roda nada nestas leituras (ver gitSafe.ts).
    // Sem conseguir garantir isso, ele rejeita, e o repositório aparece com o motivo (gitError).
    const safe = await readOnlyGit(repo.absPath);
    const status = parseStatus(await git(repo.absPath, ['status', '--porcelain=v1', '-z', '--untracked-files=all', ...safe.submodules], safe));
    if (!status.size) return result;
    const hasHead = await git(repo.absPath, ['rev-parse', '--verify', '--quiet', 'HEAD'], safe).then(() => true, () => false);
    const { chunks, complete } = hasHead ? await diffChunks(repo, safe) : { chunks: [], complete: true };
    if (!complete) result.truncated = true;
    let budget = MAX_PATCH;
    for (const chunk of chunks) {
      const info = status.get(chunk.path);
      const fits = chunk.text.length <= budget;
      // Só desconta quando o bloco cabe: um arquivo gigante não zera o orçamento dos arquivos seguintes.
      if (fits) budget -= chunk.text.length;
      else result.truncated = true;
      result.files.push({
        path: chunk.path,
        oldPath: info?.oldPath ?? chunk.oldPath,
        status: info?.status ?? (chunk.oldPath ? 'renamed' : 'modified'),
        additions: chunk.additions,
        deletions: chunk.deletions,
        binary: chunk.binary,
        patch: fits && !chunk.binary ? chunk.text : '',
      });
    }
    // Arquivos novos (e, num repo sem nenhum commit, tudo) não aparecem no diff contra o HEAD.
    const listed = new Set(result.files.map((f) => f.path));
    const pending = [...status].filter(([file, info]) => !listed.has(file) && (info.status === 'untracked' || !hasHead));
    for (const [index, [file, info]] of pending.entries()) {
      // Além do teto de arquivos com prévia: nem lê o arquivo (podem ser milhares), só lista com "+0".
      if (index >= MAX_NEW_FILES) {
        result.truncated = true;
        result.files.push({ path: file, oldPath: info.oldPath, status: info.status, additions: 0, deletions: 0, binary: false, patch: '' });
        continue;
      }
      // A prévia (conteúdo inteiro) só quando há orçamento e o arquivo é pequeno; só desconta se ela coube.
      const preview = budget > 0 ? newFilePatch(repo.absPath, file) : { patch: '', additions: 0, binary: false };
      const fits = preview.patch.length > 0 && preview.patch.length <= budget;
      if (fits) {
        budget -= preview.patch.length;
        result.files.push({ path: file, oldPath: info.oldPath, status: info.status, additions: preview.additions, deletions: 0, binary: preview.binary, patch: preview.patch });
        continue;
      }
      // Sem prévia utilizável (sem orçamento, grande demais ou binário): conta as linhas assim mesmo, para não mostrar "+0".
      if (preview.patch.length > budget) result.truncated = true; // a prévia foi montada, mas não coube
      const measured = await measureNewFile(repo.absPath, file, measure);
      if (!measured.binary && (measured.additions > 0 || measured.uncounted)) result.truncated = true; // texto mostrado sem o conteúdo
      result.files.push({ path: file, oldPath: info.oldPath, status: info.status, additions: measured.additions, deletions: 0, binary: measured.binary, patch: '' });
    }
    // Dezenas de milhares de arquivos (ex.: dependências fora do .gitignore) travariam a interface.
    if (result.files.length > MAX_FILES) {
      result.omittedFiles = result.files.length - MAX_FILES;
      result.files = result.files.slice(0, MAX_FILES);
      result.truncated = true;
    }
  } catch (error) {
    result.error = gitError(error);
  }
  return result;
}

/** No macOS, sem as ferramentas de linha de comando da Apple, o /usr/bin/git existe mas só responde com erro do xcrun. */
const MAC_GIT_MISSING = 'O git não está instalado. No Terminal, rode xcode-select --install (ou instale pelo Homebrew) e abra o Octo de novo.';

/** Erro do git em português (o "Command failed: git …" cru não diz nada a quem lê). */
function gitError(error: unknown): string {
  if (error instanceof UnsafeGitConfig) return error.message; // já explica o motivo (ver gitSafe.ts)
  const failure = error as NodeJS.ErrnoException & { killed?: boolean; stderr?: string };
  if (failure.code === 'ENOENT') return process.platform === 'darwin' ? MAC_GIT_MISSING : 'O git não foi encontrado. Instale o git e abra o Octo de novo.';
  if (failure.killed) return 'O git demorou demais para responder neste repositório.';
  const said = String(failure.stderr ?? '').trim().split('\n').find((line) => line.trim());
  if (said && /xcrun: error|active developer path/i.test(said)) return MAC_GIT_MISSING;
  return said ? `O git respondeu: ${said}` : (failure.message ?? String(error)).split('\n')[0];
}

/** Lê vários repositórios em paralelo, poucos de cada vez (git em pastas grandes pesa). */
export async function changesFor(repos: Repo[]): Promise<RepoChanges[]> {
  const results: RepoChanges[] = new Array(repos.length);
  // Um orçamento só para o pedido inteiro: 40 repositórios não leem 40 vezes 64 MB.
  const measure = { bytes: MEASURE_BUDGET };
  let next = 0;
  const worker = async () => {
    while (next < repos.length) {
      const index = next++;
      results[index] = await repoChanges(repos[index], measure);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, repos.length) }, worker));
  return results;
}

// ---------------------------------------------------------------- o que já estava alterado antes da sessão

/**
 * Linhas "XY caminho" do git status de agora, para guardar no início da sessão. Pastas novas
 * inteiras aparecem como "?? pasta/" (sem listar cada arquivo). null se o git não respondeu.
 */
export async function dirtyEntries(repo: Repo): Promise<string[] | null> {
  try {
    // Como no repoChanges (para o markPreexisting casar as duas listas); sem leitura segura, fica sem retrato.
    const safe = await readOnlyGit(repo.absPath);
    const parts = (await git(repo.absPath, ['status', '--porcelain=v1', '-z', '--untracked-files=normal', ...safe.submodules], safe)).split('\0');
    const entries: string[] = [];
    for (let i = 0; i < parts.length && entries.length < MAX_BASELINE; i++) {
      const entry = parts[i];
      if (entry.length < 4) continue;
      if (entry[0] === 'R' || entry[0] === 'C' || entry[1] === 'R' || entry[1] === 'C') i++; // o caminho antigo vem no item seguinte
      entries.push(entry);
    }
    return entries;
  } catch {
    return null;
  }
}

function mtimeOf(file: string): number | null {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Marca `preexisting` nos arquivos que já tinham alterações sem commit quando a sessão começou e
 * não mudaram desde então (o agente mexer num arquivo que já estava alterado faz ele voltar a
 * contar como desta sessão). Repositórios sem retrato ficam sem a marca.
 */
export function markPreexisting(changes: RepoChanges[], baseline: Record<string, string[]>, startedAt: number): void {
  for (const repo of changes) {
    const entries = baseline[repo.repoId];
    if (!entries) continue;
    const before = new Map<string, string>();
    const folders: string[] = [];
    for (const entry of entries) {
      const file = entry.slice(3);
      if (file.endsWith('/')) folders.push(file);
      else before.set(file, entry.slice(0, 2));
    }
    for (const file of repo.files) {
      const xy = before.get(file.path) ?? (folders.some((folder) => file.path.startsWith(folder)) ? '??' : null);
      if (!xy) {
        file.preexisting = false;
        continue;
      }
      const mtime = mtimeOf(path.join(repo.absPath, file.path));
      // Arquivo que não existe mais: só é anterior se já estava apagado no início.
      file.preexisting = mtime === null ? xy.includes('D') : mtime <= startedAt;
    }
  }
}
