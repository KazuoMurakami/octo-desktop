import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Repo, Workspace } from '../shared/types.ts';
import { readOnlyGit, type SafeGit } from './gitSafe.ts';
import { baseEnv, gitPath, samePath } from './system.ts';

const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', 'coverage', 'vendor', 'target', 'venv', '__pycache__', 'bin', 'obj', 'AppData',
]);
/**
 * Pastas do sistema na raiz do disco: enormes e sem repositórios (ex.: ao digitar C:\ ou /). Só as
 * do sistema atual: num D:\ do Windows, pastas como dev ou lib costumam ser de projetos.
 */
const SYSTEM_ROOT_DIRS = new Set(
  process.platform === 'win32'
    ? ['Windows', 'Program Files', 'Program Files (x86)', 'ProgramData', 'System Volume Information', 'Recovery', 'PerfLogs']
    : process.platform === 'darwin'
      ? ['System', 'Library', 'private', 'usr', 'bin', 'sbin', 'dev', 'etc', 'var', 'cores']
      : ['usr', 'bin', 'sbin', 'dev', 'proc', 'sys', 'etc', 'var', 'boot', 'lib', 'lib64', 'run', 'snap'],
);
/** Pastas da pasta pessoal com dados de apps e mídia, não projetos (o ~/Library do macOS tem milhares de pastas). */
const HOME_SYSTEM_DIRS = new Set([
  'Library', 'Applications', 'Pictures', 'Music', 'Movies', 'Videos', 'snap', 'Application Data', 'Local Settings', 'Saved Games',
]);
const HOME = homedir();

function skip(dir: string, name: string): boolean {
  // "." = ocultas (.git, .cache…); "$" = pastas do Windows como $Recycle.Bin.
  if (name.startsWith('.') || name.startsWith('$') || SKIP_DIRS.has(name)) return true;
  if (path.parse(dir).root === dir && SYSTEM_ROOT_DIRS.has(name)) return true;
  return HOME_SYSTEM_DIRS.has(name) && samePath(dir, HOME);
}

export interface FindLimits {
  /** Máximo de pastas lidas; acima disso o resultado volta parcial. */
  maxDirs?: number;
  /** Interrompe a busca (ex.: a pessoa continuou digitando o caminho). */
  signal?: AbortSignal;
}

/**
 * Encontra pastas que são repositórios git abaixo da raiz, sem descer dentro de repos.
 * `partial` indica que a busca parou no limite de pastas (ou foi cancelada).
 */
export async function findRepoDirs(root: string, maxDepth: number, limits: FindLimits = {}): Promise<{ dirs: string[]; partial: boolean }> {
  const maxDirs = limits.maxDirs ?? 100_000;
  const found: string[] = [];
  let visited = 0;
  let partial = false;
  let level = [root];
  for (let depth = 0; depth <= maxDepth && level.length > 0 && !partial; depth++) {
    const next: string[] = [];
    let cursor = 0;
    // Poucas leituras de pasta ao mesmo tempo: não enche a fila de E/S do servidor.
    const worker = async () => {
      while (cursor < level.length) {
        if (limits.signal?.aborted || visited >= maxDirs) {
          partial = true;
          return;
        }
        const dir = level[cursor++];
        visited++;
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
        const isRepo = entries.some((e) => e.name === '.git');
        if (isRepo) found.push(dir);
        // A raiz pode ser um repo e ainda conter outros repos independentes.
        if (isRepo && dir !== root) continue;
        for (const entry of entries) {
          if (entry.isDirectory() && !skip(dir, entry.name)) next.push(path.join(dir, entry.name));
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(16, level.length) }, worker));
    level = next;
  }
  return { dirs: found.sort((a, b) => a.localeCompare(b)), partial };
}

// `safe`: o prefixo e o ambiente do gitSafe, para a config do repositório não rodar nenhum programa nesta leitura.
function git(cwd: string, args: string[], timeout: number, safe: SafeGit): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        // Por caminho absoluto: com o nome solto, o Windows rodaria um git.exe de dentro do repositório.
        gitPath(),
        [...safe.args, ...args],
        // Sem o lock opcional do índice: o git status do Octo não disputa o .git/index.lock com o agente.
        { cwd, timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024, env: { ...baseEnv(), GIT_OPTIONAL_LOCKS: '0', ...safe.env } },
        (error, stdout) => resolve(error ? null : stdout.toString()),
      );
    } catch {
      resolve(null); // git não encontrado
    }
  });
}

async function resolveGitDir(repoDir: string): Promise<string> {
  const dotGit = path.join(repoDir, '.git');
  const info = await stat(dotGit);
  if (info.isDirectory()) return dotGit;
  // Worktrees e submódulos usam um arquivo ".git" com "gitdir: <caminho>".
  const content = await readFile(dotGit, 'utf8');
  const match = /gitdir:\s*(.+)/.exec(content);
  return match ? path.resolve(repoDir, match[1].trim()) : dotGit;
}

async function readBranch(gitDir: string): Promise<string | null> {
  const head = await readFile(path.join(gitDir, 'HEAD'), 'utf8').catch(() => null);
  if (!head) return null;
  const ref = /^ref:\s*refs\/heads\/(.+)$/m.exec(head);
  return ref ? ref[1].trim() : head.trim().slice(0, 7);
}

async function readRemote(gitDir: string): Promise<string | null> {
  const candidates = [path.join(gitDir, 'config')];
  const commonDir = await readFile(path.join(gitDir, 'commondir'), 'utf8').catch(() => null);
  if (commonDir) candidates.push(path.join(path.resolve(gitDir, commonDir.trim()), 'config'));
  for (const file of candidates) {
    const config = await readFile(file, 'utf8').catch(() => null);
    if (!config) continue;
    const match = /\[remote "origin"\][^[]*?url\s*=\s*(.+)/.exec(config);
    if (match) return toBrowseUrl(match[1].trim());
  }
  return null;
}

function toBrowseUrl(url: string): string {
  const ssh = /^git@([^:]+):(.+?)(\.git)?$/.exec(url);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  return url.replace(/\.git$/, '').replace(/\/\/[^@/]+@/, '//');
}

const STACK_MARKERS: [dep: string, label: string][] = [
  ['next', 'Next.js'], ['react-native', 'React Native'], ['expo', 'Expo'], ['react', 'React'], ['vue', 'Vue'],
  ['nuxt', 'Nuxt'], ['svelte', 'Svelte'], ['@angular/core', 'Angular'], ['astro', 'Astro'], ['electron', 'Electron'],
  ['vite', 'Vite'], ['express', 'Express'], ['fastify', 'Fastify'], ['@nestjs/core', 'NestJS'], ['hono', 'Hono'],
  ['prisma', 'Prisma'], ['@prisma/client', 'Prisma'], ['drizzle-orm', 'Drizzle'], ['tailwindcss', 'Tailwind'],
  ['typescript', 'TypeScript'], ['vitest', 'Vitest'], ['jest', 'Jest'],
];

async function readJson(file: string): Promise<Record<string, any> | null> {
  const text = await readFile(file, 'utf8').catch(() => null);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function detectProject(dir: string, names: Set<string>) {
  const stack: string[] = [];
  let scripts: string[] = [];
  let description: string | null = null;
  let packageManager: string | null = null;

  if (names.has('package.json')) {
    const pkg = await readJson(path.join(dir, 'package.json'));
    if (pkg) {
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      for (const [dep, label] of STACK_MARKERS) if (dep in deps && !stack.includes(label)) stack.push(label);
      if (stack.length === 0) stack.push('Node.js');
      scripts = Object.keys(pkg.scripts ?? {});
      description = typeof pkg.description === 'string' && pkg.description ? pkg.description : null;
    }
    packageManager = names.has('pnpm-lock.yaml') ? 'pnpm'
      : names.has('yarn.lock') ? 'yarn'
      : names.has('bun.lockb') || names.has('bun.lock') ? 'bun'
      : 'npm';
  }
  if (names.has('pyproject.toml') || names.has('requirements.txt')) stack.push('Python');
  if (names.has('go.mod')) stack.push('Go');
  if (names.has('Cargo.toml')) stack.push('Rust');
  if (names.has('Gemfile')) stack.push('Ruby');
  if (names.has('composer.json')) stack.push('PHP');
  if (names.has('pubspec.yaml')) stack.push('Flutter');
  if ([...names].some((n) => n.endsWith('.csproj') || n.endsWith('.sln'))) stack.push('.NET');
  if (names.has('docker-compose.yml') || names.has('docker-compose.yaml') || names.has('Dockerfile')) stack.push('Docker');

  if (!description) {
    const readme = [...names].find((n) => /^readme(\.md)?$/i.test(n));
    if (readme) description = await firstParagraph(path.join(dir, readme));
  }
  return { stack, scripts, description, packageManager };
}

async function firstParagraph(file: string): Promise<string | null> {
  const text = await readFile(file, 'utf8').catch(() => '');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^(#|<|!\[|\[!|---|```|\||>)/.test(line)) continue;
    const clean = line.replace(/[*_`]/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
    return clean.length > 160 ? `${clean.slice(0, 157)}…` : clean;
  }
  return null;
}

export function repoId(workspaceId: string, relPath: string): string {
  return createHash('sha1').update(`${workspaceId}:${relPath.toLowerCase()}`).digest('hex').slice(0, 12);
}

async function describeRepo(workspace: Workspace, dir: string): Promise<Repo> {
  const relPath = path.relative(workspace.rootPath, dir) || '.';
  const entries = await readdir(dir).catch(() => [] as string[]);
  const names = new Set(entries);
  const gitDir = await resolveGitDir(dir).catch(() => path.join(dir, '.git'));

  const [branch, remoteUrl, project, safe] = await Promise.all([
    readBranch(gitDir),
    readRemote(gitDir),
    detectProject(dir, names),
    // Calculado uma vez por repositório: a config dele não roda nada nas leituras abaixo (ver gitSafe.ts).
    // Sem conseguir garantir isso (ou sem git), elas nem rodam: alterações e último commit ficam sem valor.
    readOnlyGit(dir).catch(() => null),
  ]);
  const [log, status, aheadBehind] = safe
    ? await Promise.all([
        git(dir, ['log', '-1', '--format=%cI%x1f%s'], 8000, safe),
        // O status entra nos submódulos com as mesmas neutralizações (ou não entra: safe.submodules).
        git(dir, ['status', '--porcelain=v1', ...safe.submodules], 8000, safe),
        git(dir, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'], 4000, safe),
      ])
    : [null, null, null];

  const [lastCommitAt, lastCommitMessage] = log?.trim() ? log.trim().split('\x1f') : [null, null];
  const counts = aheadBehind?.trim().split(/\s+/).map(Number);

  return {
    id: repoId(workspace.id, relPath),
    workspaceId: workspace.id,
    name: relPath === '.' ? path.basename(dir) : relPath.split(path.sep).join('/'),
    relPath,
    absPath: dir,
    branch,
    remoteUrl,
    lastCommitAt: lastCommitAt ?? null,
    lastCommitMessage: lastCommitMessage ?? null,
    dirty: status === null ? null : status.split('\n').filter(Boolean).length,
    behind: counts?.length === 2 ? counts[0] : null,
    ahead: counts?.length === 2 ? counts[1] : null,
    ...project,
    hasClaudeMd: names.has('CLAUDE.md') || existsSync(path.join(dir, '.claude', 'CLAUDE.md')),
    hasAgentsMd: names.has('AGENTS.md'),
  };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function scanWorkspace(workspace: Workspace): Promise<Repo[]> {
  const { dirs } = await findRepoDirs(workspace.rootPath, workspace.scanDepth);
  return describeRepos(workspace, dirs);
}

/** Lê de novo só estes repositórios (branch, alterações, último commit), sem varrer o workspace. */
export function describeRepos(workspace: Workspace, dirs: string[]): Promise<Repo[]> {
  return mapLimit(dirs, 6, (dir) => describeRepo(workspace, dir));
}
