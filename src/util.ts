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
  // "/" e "\" valem o mesmo (o Claude às vezes escreve C:/…), e "C:\proj" não contém "C:\projeto".
  const normal = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '');
  const a = normal(root);
  const b = normal(target);
  if (b.toLowerCase() === a.toLowerCase()) return '.';
  if (!a) return b.replace(/^\//, ''); // raiz "/"
  return b.toLowerCase().startsWith(`${a.toLowerCase()}/`) ? b.slice(a.length + 1) : target;
}

export function isUnder(dir: string, target: string): boolean {
  const a = dir.replace(/[\\/]+$/, '').toLowerCase();
  const b = target.toLowerCase();
  return b === a || b.startsWith(`${a}\\`) || b.startsWith(`${a}/`);
}

/** A menor pasta que contém todas estas; sem nenhuma (ou sem nada em comum), `fallback`. */
export function smallestFolder(dirs: string[], fallback: string): string {
  if (!dirs.length) return fallback;
  let common = dirs[0].split(/[\\/]/);
  for (const dir of dirs.slice(1)) {
    const parts = dir.split(/[\\/]/);
    let i = 0;
    while (i < common.length && i < parts.length && common[i].toLowerCase() === parts[i].toLowerCase()) i++;
    common = common.slice(0, i);
  }
  return common.join(sep(fallback)) || fallback;
}

/** Mesma regra do servidor: a sessão roda na menor pasta que contém os repositórios da issue. */
export function commonFolder(workspace: Workspace, repos: Repo[]): string {
  const joined = smallestFolder(repos.map((repo) => repo.absPath), workspace.rootPath);
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

const TEXT_INPUTS = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number']);

/** Campo de texto livre (input de texto, textarea ou editável); checkbox, botão etc. não contam. */
export function isTextField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el?.tagName) return false;
  if (el.tagName === 'TEXTAREA') return true;
  if (el.tagName === 'INPUT') return TEXT_INPUTS.has((el as HTMLInputElement).type);
  return el.isContentEditable;
}

/**
 * Primeiro Esc num campo com texto: só tira o foco dele, para um Esc por hábito não fechar
 * o painel ou o modal com o rascunho. O Esc seguinte fecha. Devolve true se tirou o foco.
 */
export function leaveTextField(target: EventTarget | null): boolean {
  if (!isTextField(target)) return false;
  const el = target as HTMLElement;
  const text = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : (el.textContent ?? '');
  if (!text.trim()) return false;
  // Dentro de um modal ou painel, o foco vai para ele (e não para o <body>, fora do diálogo).
  const dialog = el.closest<HTMLElement>('[role="dialog"][tabindex]');
  if (dialog) dialog.focus({ preventScroll: true });
  else el.blur();
  return true;
}

/** macOS (no navegador ou no app desktop). */
export function isMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  const hints = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  return /mac|iphone|ipad/i.test(hints?.platform || navigator.platform || navigator.userAgent);
}

/** Tecla dos atalhos como aparece na tela: ⌘ no macOS, Ctrl nos outros sistemas (os atalhos aceitam as duas). */
export function modKey(): string {
  return isMac() ? '⌘' : 'Ctrl';
}
