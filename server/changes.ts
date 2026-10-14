// O que mudou em cada repositório (git status + git diff contra o HEAD), para a aba "Mudanças".
// Só leitura: nada aqui altera o repositório.
import { execFile } from 'node:child_process';
import { openSync, readSync, closeSync, statSync } from 'node:fs';
import path from 'node:path';
import type { FileChangeStatus, Repo, RepoChanges } from '../shared/types.ts';

/** Teto do diff por repositório; acima disso os arquivos aparecem sem o conteúdo. */
const MAX_PATCH = 400_000;
/** Arquivos novos (ainda fora do git) até este tamanho aparecem inteiros. */
const MAX_NEW_FILE = 64_000;
const MAX_NEW_FILES = 60;

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'core.quotepath=off', '-c', 'color.ui=never', ...args],
      { cwd, encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
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
        if (line.startsWith('+++ ')) newPath = line === '+++ /dev/null' ? null : unquote(line.slice(4)).replace(/^b\//, '');
        else if (line.startsWith('--- ')) oldPath = line === '--- /dev/null' ? null : unquote(line.slice(4)).replace(/^a\//, '');
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

export async function repoChanges(repo: Repo): Promise<RepoChanges> {
  const result: RepoChanges = { repoId: repo.id, name: repo.name, absPath: repo.absPath, branch: repo.branch, files: [], truncated: false, error: null };
  try {
    const status = parseStatus(await git(repo.absPath, ['status', '--porcelain=v1', '-z', '--untracked-files=all']));
    if (!status.size) return result;
    const hasHead = await git(repo.absPath, ['rev-parse', '--verify', '--quiet', 'HEAD']).then(() => true, () => false);
    // Contra o HEAD: junta o que está e o que não está no stage, como "o que mudou desde o último commit".
    const patch = hasHead ? await git(repo.absPath, ['diff', 'HEAD', '--no-ext-diff', '--find-renames', '--unified=3']) : '';
    let budget = MAX_PATCH;
    for (const chunk of splitPatch(patch)) {
      const info = status.get(chunk.path);
      const fits = chunk.text.length <= budget;
      budget -= Math.min(budget, chunk.text.length);
      if (!fits) result.truncated = true;
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
      const preview = index < MAX_NEW_FILES && budget > 0 ? newFilePatch(repo.absPath, file) : { patch: '', additions: 0, binary: false };
      if (preview.patch.length > budget) {
        preview.patch = '';
        result.truncated = true;
      }
      budget -= preview.patch.length;
      if (index >= MAX_NEW_FILES) result.truncated = true;
      result.files.push({ path: file, oldPath: info.oldPath, status: info.status, additions: preview.additions, deletions: 0, binary: preview.binary, patch: preview.patch });
    }
  } catch (error) {
    result.error = (error as Error).message.split('\n')[0];
  }
  return result;
}

/** Lê vários repositórios em paralelo, poucos de cada vez (git em pastas grandes pesa). */
export async function changesFor(repos: Repo[]): Promise<RepoChanges[]> {
  const results: RepoChanges[] = new Array(repos.length);
  let next = 0;
  const worker = async () => {
    while (next < repos.length) {
      const index = next++;
      results[index] = await repoChanges(repos[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, repos.length) }, worker));
  return results;
}
