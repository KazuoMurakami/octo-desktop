// Worktrees das issues na interface: nomes, caminhos e a pasta da sessão, com as mesmas regras do servidor (server/worktrees.ts).
import type { Repo, Workspace, Worktree } from '../shared/types.ts';
import { folderSlug, worktreeFolderName } from '../shared/worktree.ts';
import { folderLabel } from './components/OpenMenu.tsx';
import { isUnder, relativeTo, smallestFolder } from './util.ts';

const sep = (p: string) => (p.includes('\\') ? '\\' : '/');
const join = (dir: string, ...parts: string[]) => [dir.replace(/[\\/]+$/, ''), ...parts].join(sep(dir));

/** Nome curto do worktree: a pasta dele (red-7). */
export function worktreeName(worktree: Pick<Worktree, 'root'>): string {
  return worktree.root.split(/[\\/]/).filter(Boolean).at(-1) ?? worktree.root;
}

/** A branch do worktree: a mesma em todos os repositórios ou, se forem diferentes, a de cada um ("a, b"). */
export function worktreeBranch(worktree: Worktree): string {
  return [...new Set(worktree.repos.map((entry) => entry.branch))].join(', ');
}

/** Caminho com a pasta pessoal abreviada: ~/.octo/worktrees/redd/red-7. */
export function homePath(dir: string, home: string | undefined): string {
  if (!home) return dir;
  const rel = relativeTo(home, dir);
  return rel === '.' ? '~' : rel === dir ? dir : `~/${rel}`;
}

/** Pasta de todos os worktrees: <dados>/worktrees. */
export function worktreesFolder(dataDir: string): string {
  return join(dataDir, 'worktrees');
}

/**
 * Onde o worktree de uma issue vai ficar: <dados>/worktrees/<pasta do workspace>/<issue>. Se a pasta
 * já existir, o servidor usa red-7-2, red-7-3…
 */
export function plannedWorktreeRoot(dataDir: string, workspace: Workspace, identifier: string): string {
  const last = workspace.rootPath.split(/[\\/]/).filter(Boolean).at(-1) ?? '';
  // A raiz de um disco (C:\) não tem nome de pasta, como no path.basename do servidor.
  return join(worktreesFolder(dataDir), folderSlug(/^[a-z]:$/i.test(last) ? '' : last), worktreeFolderName(identifier));
}

/** A mesma pasta do workspace dentro do worktree, que espelha o workspace (loja/ vira red-7/loja). */
export function mirrorIn(root: string, workspace: Workspace, dir: string): string {
  const rel = relativeTo(workspace.rootPath, dir);
  return rel === '.' || rel === dir ? root : join(root, ...rel.split('/'));
}

/** Pasta da sessão num worktree: a menor pasta dele que contém os repositórios da issue (a regra do servidor). */
export function worktreeDir(worktree: Worktree, repoIds: string[]): string {
  const own = worktree.repos.filter((entry) => repoIds.includes(entry.repoId));
  const dir = smallestFolder((own.length ? own : worktree.repos).map((entry) => entry.path), worktree.root);
  return isUnder(worktree.root, dir) ? dir : worktree.root;
}

/**
 * Pasta de uma sessão (ou da issue) como aparece na tela: num worktree, o nome dele e o caminho lá
 * dentro (red-7/loja); fora, o caminho relativo ao workspace.
 */
export function sessionFolderLabel(workspace: Workspace, dir: string, worktree?: Pick<Worktree, 'root'> | null): string {
  if (!worktree || !isUnder(worktree.root, dir)) return folderLabel(workspace, dir);
  const rel = relativeTo(worktree.root, dir);
  return rel === '.' ? worktreeName(worktree) : `${worktreeName(worktree)}/${rel}`;
}

/** Os repositórios como a sessão os vê: os do worktree no caminho e na branch dele; os outros, na pasta original. */
export function sessionRepos(repos: Repo[], worktree: Worktree | null | undefined): Repo[] {
  if (!worktree) return repos;
  return repos.map((repo) => {
    const entry = worktree.repos.find((e) => e.repoId === repo.id);
    return entry ? { ...repo, absPath: entry.path, branch: entry.branch } : repo;
  });
}
