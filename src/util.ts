import type { Repo, Workspace } from '../shared/types.ts';

const rtf = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' });
const STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31_536_000], ['month', 2_592_000], ['week', 604_800], ['day', 86_400], ['hour', 3600], ['minute', 60],
];

export function ago(iso: string | null | undefined): string {
  if (!iso) return '—';
  const seconds = (new Date(iso).getTime() - Date.now()) / 1000;
  for (const [unit, size] of STEPS) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  }
  return 'agora';
}

export function money(value: number): string {
  return value ? `US$ ${value.toFixed(value < 1 ? 3 : 2)}` : '—';
}

export function duration(ms: number): string {
  if (!ms) return '—';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}min ${s % 60}s`;
}

/** Cor estável por nome, para pontos de repositório. */
export function hue(text: string): string {
  // FNV-1a espalha melhor nomes parecidos (loja-api × loja-web).
  let hash = 0x811c9dc5;
  for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193);
  return `oklch(0.74 0.13 ${(hash >>> 0) % 360})`;
}

const sep = (p: string) => (p.includes('\\') ? '\\' : '/');

export function relativeTo(root: string, target: string): string {
  const a = root.replace(/[\\/]+$/, '');
  if (target.toLowerCase() === a.toLowerCase()) return '.';
  return target.toLowerCase().startsWith(a.toLowerCase()) ? target.slice(a.length + 1).replace(/\\/g, '/') : target;
}

export function isUnder(dir: string, target: string): boolean {
  const a = dir.replace(/[\\/]+$/, '').toLowerCase();
  const b = target.toLowerCase();
  return b === a || b.startsWith(`${a}\\`) || b.startsWith(`${a}/`);
}

/** Mesma regra do servidor: a sessão roda na menor pasta que contém os repositórios da issue. */
export function commonFolder(workspace: Workspace, repos: Repo[]): string {
  if (!repos.length) return workspace.rootPath;
  const s = sep(workspace.rootPath);
  let common = repos[0].absPath.split(/[\\/]/);
  for (const repo of repos.slice(1)) {
    const parts = repo.absPath.split(/[\\/]/);
    let i = 0;
    while (i < common.length && i < parts.length && common[i].toLowerCase() === parts[i].toLowerCase()) i++;
    common = common.slice(0, i);
  }
  const joined = common.join(s);
  return joined.toLowerCase().startsWith(workspace.rootPath.toLowerCase()) ? joined : workspace.rootPath;
}

export interface RepoGroup {
  /** Caminho absoluto da pasta que agrupa os repositórios. */
  dir: string;
  rel: string;
  repos: Repo[];
}

/** Pastas que agrupam vários repositórios (ex.: loja/ com api + client). */
export function repoGroups(workspace: Workspace, repos: Repo[]): RepoGroup[] {
  const groups = new Map<string, RepoGroup>();
  for (const repo of repos) {
    const parts = repo.relPath.split(/[\\/]/);
    if (repo.relPath === '.' || parts.length < 2) continue;
    const rel = parts.slice(0, -1).join('/');
    const dir = [workspace.rootPath.replace(/[\\/]+$/, ''), ...parts.slice(0, -1)].join(sep(workspace.rootPath));
    const group = groups.get(rel) ?? { dir, rel, repos: [] };
    group.repos.push(repo);
    groups.set(rel, group);
  }
  return [...groups.values()].sort((a, b) => b.repos.length - a.repos.length || a.rel.localeCompare(b.rel));
}

export function shortRepoName(repo: Repo): string {
  return repo.name.split('/').at(-1) ?? repo.name;
}

export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return Boolean(el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable));
}
