// Worktrees das issues: uma pasta por issue em <dados>/worktrees/<workspace>/<issue> que espelha o
// workspace, com um worktree git de cada repositório em foco, todos numa branch curta só dela
// (ex.: red-7-api-typescript). As sessões rodam lá dentro sem mexer na pasta original dos repositórios.
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { chmod, lstat, readdir, rmdir, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { AgentSession, Issue, Repo, Workspace, Worktree, WorktreeBase, WorktreeRepo, WorktreeStatus } from '../shared/types.ts';
import { folderSlug, worktreeBranchName, worktreeFolderName } from '../shared/worktree.ts';
import { HttpError, addHistory, commitIssue, now, workspaceRepos } from './model.ts';
import { WORKTREES_DIR } from './paths.ts';
import { db } from './store.ts';
import { baseEnv, gitPath, samePath } from './system.ts';

export { WORKTREES_DIR };

/** Arquivos de contexto das pastas que agrupam repositórios: no worktree eles viram cópias, para o Claude ver o mesmo que veria na pasta original. */
const CONTEXT_FILES = ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', '.mcp.json'];

/**
 * O que vem do .claude/ de uma pasta de grupo: só a configuração do projeto. Nunca o resto (um
 * .claude/ que é a pasta de uma conta traria login, histórico e transcripts de todos os projetos).
 */
const CLAUDE_PROJECT_ENTRIES = new Set(['CLAUDE.md', 'settings.json', 'settings.local.json', 'commands', 'agents', 'skills', 'output-styles', 'rules', 'hooks']);

/** Teto das cópias de contexto de um worktree: um .claude/ fora do comum não trava a delegação. */
const COPY_LIMIT = { files: 2000, bytes: 50 * 1024 * 1024 };

/** Arquivos fora dos repositórios listados antes de remover um worktree (o resto vira só "e mais"). */
const OUTSIDE_LIMIT = 20;

/**
 * Issues com o worktree sendo preparado ou removido agora: duas delegações ao mesmo tempo não criam
 * dois, e uma delegação não começa no meio de uma remoção (nem o contrário).
 */
const preparing = new Set<string>();

/** O worktree desta issue está sendo preparado ou removido agora (apagar a issue no meio deixaria a pasta sem dono). */
export function isPreparing(issueId: string): boolean {
  return preparing.has(issueId);
}

/** O checkout de um repositório grande pode demorar (no Windows, principalmente). */
const CHECKOUT_TIMEOUT = 10 * 60_000;

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * O caminho de verdade, com links e nomes curtos do Windows (C:\Users\FULANO~1) resolvidos na parte
 * que existe. O último nome fica como está: um link no fim do caminho é ele mesmo, e não o que ele aponta.
 */
function realPath(target: string): string {
  const resolved = path.resolve(target);
  const rest = [path.basename(resolved)];
  let dir = path.dirname(resolved);
  while (!existsSync(dir)) {
    const parent = path.dirname(dir);
    if (parent === dir) return resolved;
    rest.unshift(path.basename(dir));
    dir = parent;
  }
  try {
    return path.join(realpathSync.native(dir), ...rest);
  } catch {
    return resolved;
  }
}

/** A pasta de worktrees do Octo como ela é de fato (ela mesma pode estar atrás de um link). */
function worktreesRoot(): string {
  try {
    return realpathSync.native(WORKTREES_DIR);
  } catch {
    return realPath(WORKTREES_DIR);
  }
}

/** Dentro da pasta de worktrees do Octo (e não ela mesma): o único lugar onde este módulo apaga algo. */
function isOurs(dir: string): boolean {
  const root = worktreesRoot();
  const real = realPath(dir);
  return isInside(root, real) && !samePath(real, root);
}

// ---------------------------------------------------------------- git

interface GitFailure extends Error {
  stderr?: string;
  exitCode?: number | null;
}

/**
 * Roda o git por caminho absoluto (ver gitPath). Nunca pede senha: sem rede ou sem login, um
 * `git fetch` falha na hora, em vez de travar a delegação ou abrir uma janela pedindo a senha (do Git
 * Credential Manager, de um GIT_ASKPASS herdado do editor ou de um SSH_ASKPASS da área de trabalho).
 */
function git(cwd: string, args: string[], options: { timeout?: number; input?: string; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(gitPath(), args, {
        cwd,
        windowsHide: true,
        env: {
          ...baseEnv(),
          GIT_TERMINAL_PROMPT: '0',
          GCM_INTERACTIVE: 'never',
          // Vazio: o git não chama nenhum programa de senha (nem o core.askPass, que só é lido sem GIT_ASKPASS).
          GIT_ASKPASS: '',
          SSH_ASKPASS: '',
          SSH_ASKPASS_REQUIRE: 'never',
          ...options.env,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(Object.assign(new Error('o git demorou demais para responder'), { stderr: '' }) as GitFailure);
    }, options.timeout ?? 60_000);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr = (stderr + chunk).slice(-4000)));
    child.stdin.on('error', () => {});
    child.stdin.end(options.input ?? '');
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(Object.assign(new Error(`git ${args[0]} terminou com código ${code}`), { stderr, exitCode: code }) as GitFailure);
    });
  });
}

const succeeds = (cwd: string, args: string[]) => git(cwd, args).then(() => true, () => false);

/** O erro que o git deu, em vez do "Command failed" cru: as linhas fatal:/error: antes das de progresso. */
function gitMessage(error: unknown): string {
  const failure = error as GitFailure & { code?: string };
  if (failure?.code === 'ENOENT') return 'o git não foi encontrado';
  const lines = String(failure?.stderr ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
  const said = lines.find((line) => /^(fatal|error):/i.test(line)) ?? lines.find((line) => !/^(hint:|Preparing worktree)/i.test(line));
  return (said ?? failure?.message ?? String(error)).replace(/^(fatal|error):\s*/i, '');
}

/**
 * Nome de branch que pode ir para a linha de comando do git: um nome vindo do origin (origin/HEAD) ou
 * da branch aberta começando com "-" viraria uma opção do git (até um comando, com --upload-pack).
 * Letras com acento valem (produção).
 */
function safeRef(name: string): boolean {
  return /^[\p{L}\p{N}_][\p{L}\p{N}_./-]*$/u.test(name) && !name.includes('..') && !name.endsWith('/') && !name.endsWith('.lock');
}

// ---------------------------------------------------------------- apagar sem seguir links

/**
 * Apaga uma pasta do Octo sem nunca entrar em links: um junction ou symlink (o `npm link`, o pnpm e
 * o yarn criam vários em node_modules) é desfeito, e o que ele aponta, fora do worktree, fica como
 * está. Nem o `git worktree remove` nem o fs.rmSync do Node no Windows garantem isso.
 */
async function removeTree(target: string): Promise<void> {
  if (!isOurs(target)) throw new Error(`recusei apagar fora da pasta de worktrees: ${target}`);
  await removeEntry(target);
}

async function removeEntry(target: string): Promise<void> {
  let info;
  try {
    info = await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (info.isSymbolicLink()) {
    // No Windows o lstat também chama o junction de link; um link para pasta sai com rmdir.
    await unlink(target).catch((error: NodeJS.ErrnoException) => (error.code === 'EPERM' || error.code === 'EISDIR' ? rmdir(target) : Promise.reject(error)));
    return;
  }
  if (info.isDirectory()) {
    // Um junction para um volume (\\?\Volume{…}) o lstat do Node chama de pasta comum: o rmdir desfaz
    // qualquer link de pasta sem entrar nele, e numa pasta de verdade com conteúdo só falha (ENOTEMPTY).
    try {
      await rmdir(target);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY' && (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const names = await readdir(target);
    for (let i = 0; i < names.length; i += 32) await Promise.all(names.slice(i, i + 32).map((name) => removeEntry(path.join(target, name))));
    await rmdir(target);
    return;
  }
  // Arquivo somente leitura (comum em node_modules no Windows): libera e apaga.
  await unlink(target).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPERM') throw error;
    await chmod(target, 0o666);
    await unlink(target);
  });
}

/** Apaga o que sobrou numa pasta antes de recriar o worktree nela, com uma mensagem clara se um programa a segura. */
async function clearFolder(target: string): Promise<void> {
  try {
    await removeTree(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
      throw new HttpError(409, `A pasta ${target} está presa por outro programa (um editor, um terminal ou o Explorador). Feche-o e tente de novo.`);
    }
    throw error;
  }
}

/** O worktree tem o arquivo .git que o liga ao repositório (uma pasta que sobrou de uma remoção pela metade não tem). */
function isWorktreeDir(dir: string): boolean {
  try {
    return lstatSync(path.join(dir, '.git')).isFile();
  } catch {
    return false;
  }
}

/** Para comparar caminhos: barras e maiúsculas de um jeito só, sem barra no fim. */
function comparable(target: string): string {
  const normal = realPath(target).replace(/[\\/]+$/, '').replace(/\\/g, '/');
  return process.platform === 'win32' || process.platform === 'darwin' ? normal.toLowerCase() : normal;
}

/**
 * Tira do repositório o registro do worktree deste caminho, quando a pasta dele já não existe (com a
 * pasta lá, o `git worktree remove` a apagaria, seguindo os links dela). Acha o registro pela lista do
 * próprio git, que pode ter escrito o caminho de outro jeito. Sem `git worktree prune`, que apagaria
 * também os registros de outros worktrees seus, como um num disco que não está conectado agora.
 */
async function forgetWorktree(repoPath: string, target: string): Promise<void> {
  if (existsSync(target)) return;
  const list = await git(repoPath, ['worktree', 'list', '--porcelain']).catch(() => '');
  const wanted = comparable(target);
  for (const line of list.split('\n')) {
    if (!line.startsWith('worktree ')) continue;
    const registered = line.slice('worktree '.length).trim();
    if (comparable(registered) !== wanted || existsSync(registered)) continue;
    // Duas vezes --force: um checkout interrompido deixa o registro travado ("initializing"). Sem a pasta, nada mais é apagado.
    await git(repoPath, ['worktree', 'remove', '--force', '--force', registered]).catch(() => undefined);
  }
}

// ---------------------------------------------------------------- nomes e caminhos

/**
 * Pastas de worktree de outras issues (e das sessões delas), mesmo que não existam mais no disco: nunca
 * são dadas a esta. A própria issue pode voltar à pasta de um worktree que ela já removeu; as sessões
 * antigas não continuam nele (ver requireSessionFolder, em agent.ts).
 */
function claimedRoots(issue: Issue): string[] {
  return [...db.issues.filter((other) => other.id !== issue.id), ...db.sessions.filter((session) => session.issueId !== issue.id)]
    .flatMap((item) => (item.worktree ? [item.worktree.root] : []));
}

/** A pasta dos worktrees do workspace: o nome da pasta dele, com um sufixo se outro workspace tiver o mesmo nome. */
function workspaceFolder(workspace: Workspace): string {
  const name = folderSlug(path.basename(workspace.rootPath));
  const shared = db.workspaces.some((w) => w.id !== workspace.id && folderSlug(path.basename(w.rootPath)) === name);
  return path.join(WORKTREES_DIR, shared ? `${name}-${workspace.id.slice(0, 4)}` : name);
}

/** As pastas candidatas para o worktree da issue, em ordem: red-7, red-7-2, red-7-3… */
function* rootCandidates(workspace: Workspace, issue: Issue): Generator<string> {
  const parent = workspaceFolder(workspace);
  const name = worktreeFolderName(issue.identifier);
  for (let n = 1; n <= 200; n++) yield path.join(parent, n === 1 ? name : `${name}-${n}`);
}

/** A pasta que um worktree novo usaria agora (para a prévia): a primeira que não existe e ninguém usa. */
function nextRoot(workspace: Workspace, issue: Issue): string {
  const claimed = claimedRoots(issue);
  for (const candidate of rootCandidates(workspace, issue)) {
    if (!existsSync(candidate) && !claimed.some((root) => samePath(root, candidate))) return candidate;
  }
  throw new HttpError(409, 'Há worktrees demais com o nome desta issue. Remova os que não usa mais e tente de novo.');
}

/** Cria a pasta do worktree novo: o mkdir sem `recursive` falha se ela já existir, então duas issues nunca ficam com a mesma. */
function reserveRoot(workspace: Workspace, issue: Issue): string {
  const claimed = claimedRoots(issue);
  for (const candidate of rootCandidates(workspace, issue)) {
    if (claimed.some((root) => samePath(root, candidate))) continue;
    mkdirSync(path.dirname(candidate), { recursive: true });
    try {
      mkdirSync(candidate);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw new HttpError(409, 'Há worktrees demais com o nome desta issue. Remova os que não usa mais e tente de novo.');
}

/** A primeira branch livre em todos os repositórios: red-7-api-typescript, red-7-api-typescript-2… */
async function freeBranch(repos: Repo[], name: string): Promise<string> {
  for (let n = 1; n <= 50; n++) {
    const candidate = n === 1 ? name : `${name}-${n}`;
    const taken = await Promise.all(repos.map((repo) => succeeds(repo.absPath, ['show-ref', '--verify', '--quiet', `refs/heads/${candidate}`])));
    if (!taken.some(Boolean)) return candidate;
  }
  throw new HttpError(409, `Já existem branches de ${name} até ${name}-50 nesses repositórios. Apague as que não usa mais e tente de novo.`);
}

/** Onde o repositório fica dentro do worktree: no mesmo caminho relativo que ele tem no workspace. */
function targetPath(root: string, repo: Repo): string {
  return repo.relPath === '.' ? root : path.join(root, ...repo.relPath.split(/[\\/]/));
}

/** Mesmo nome de pasta? No Windows e no macOS o sistema de arquivos costuma ignorar maiúsculas. */
function sameName(a: string, b: string): boolean {
  return process.platform === 'win32' || process.platform === 'darwin' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** A menor pasta que contém todas estas (a mesma regra da pasta da sessão). */
function commonFolder(dirs: string[], fallback: string): string {
  if (!dirs.length) return fallback;
  let common = path.resolve(dirs[0]).split(path.sep);
  for (const dir of dirs.slice(1)) {
    const parts = path.resolve(dir).split(path.sep);
    let i = 0;
    while (i < common.length && i < parts.length && sameName(common[i], parts[i])) i++;
    common = common.slice(0, i);
  }
  return common.join(path.sep) || fallback;
}

// ---------------------------------------------------------------- de onde a branch sai

interface BaseRef {
  /** O que vai para o `git worktree add`. */
  ref: string;
  /** Como aparece para a pessoa (origin/main, main ou a branch atual). */
  label: string;
  note: string | null;
}

async function currentBase(repo: Repo): Promise<BaseRef> {
  const sha = (await git(repo.absPath, ['rev-parse', '--verify', 'HEAD^{commit}']).catch(() => '')).trim();
  if (!sha) throw new HttpError(400, `${repo.name} ainda não tem nenhum commit: faça o primeiro commit para usar um worktree.`);
  const branch = (await git(repo.absPath, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')).trim();
  // O nome só aparece para você e conta os commits na branch; um nome estranho fica no commit.
  return { ref: sha, label: branch && safeRef(branch) ? branch : sha.slice(0, 7), note: null };
}

/** As refs que chegam aqui começam com refs/ (montadas pelo Octo): nunca viram opção do git. */
const hasRef = (repo: Repo, ref: string) => succeeds(repo.absPath, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);

/**
 * Um origin por SSH também não pergunta nada (senha da chave, host desconhecido): o fetch falha na hora
 * em vez de esperar até o tempo esgotar. Só quando você não configurou outro comando de ssh, que vale.
 */
async function quietSsh(repo: Repo): Promise<NodeJS.ProcessEnv> {
  if (process.env.GIT_SSH_COMMAND || process.env.GIT_SSH) return {};
  const configured = await succeeds(repo.absPath, ['config', '--get', 'core.sshCommand']);
  return configured ? {} : { GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' };
}

/**
 * A branch padrão do repositório: a que o origin diz agora (o origin/HEAD guardado no clone pode estar
 * velho), senão a do origin/HEAD, senão main ou master. Antes, tenta atualizá-la com `git fetch`; sem
 * rede ou sem login, segue com a versão que já está no computador.
 */
async function defaultBase(repo: Repo): Promise<BaseRef> {
  const hasOrigin = await succeeds(repo.absPath, ['remote', 'get-url', 'origin']);
  const env = hasOrigin ? await quietSsh(repo) : {};
  let reached = false;
  let unsafe = '';
  let name = '';
  if (hasOrigin) {
    try {
      const said = await git(repo.absPath, ['ls-remote', '--symref', '--end-of-options', 'origin', 'HEAD'], { timeout: 20_000, env });
      reached = true;
      const head = /^ref:\s*refs\/heads\/(\S+)\s+HEAD$/m.exec(said)?.[1] ?? '';
      if (safeRef(head)) name = head;
      else if (head) unsafe = head;
    } catch {
      /* sem rede ou sem login: fica com o que está no computador */
    }
  }
  if (!name) {
    const originHead = (await git(repo.absPath, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']).catch(() => '')).trim();
    const local = originHead.startsWith('origin/') ? originHead.slice('origin/'.length) : '';
    if (safeRef(local)) name = local;
    else if (local) unsafe ||= local;
  }
  let remote = Boolean(name) && hasOrigin;
  if (!name) {
    for (const candidate of ['main', 'master']) {
      if (await hasRef(repo, `refs/remotes/origin/${candidate}`)) {
        name = candidate;
        remote = true;
        break;
      }
      if (!name && (await hasRef(repo, `refs/heads/${candidate}`))) name = candidate;
    }
  }
  const odd = unsafe ? ` O nome da branch padrão do origin (${unsafe}) não é seguro para passar ao git e foi deixado de lado.` : '';
  if (!name) {
    const current = await currentBase(repo);
    return { ...current, note: `${repo.name} não tem uma branch padrão que dê para usar: o worktree saiu da branch atual (${current.label}).${odd}` };
  }
  let note: string | null = odd ? odd.trim() : null;
  if (remote) {
    if (reached) {
      try {
        // --end-of-options: o nome nunca é lido como uma opção do fetch.
        await git(repo.absPath, ['fetch', '--quiet', '--no-tags', '--end-of-options', 'origin', name], { timeout: 20_000, env });
      } catch (error) {
        note = `Não deu para atualizar ${name} de ${repo.name} com git fetch (${gitMessage(error)}): o worktree saiu da versão que já estava no computador.${odd}`;
      }
    } else {
      note = `Não deu para falar com o origin de ${repo.name} (sem rede ou sem login): o worktree saiu da versão de ${name} que já estava no computador.${odd}`;
    }
    if (await hasRef(repo, `refs/remotes/origin/${name}`)) return { ref: `origin/${name}`, label: `origin/${name}`, note };
  }
  if (await hasRef(repo, `refs/heads/${name}`)) return { ref: name, label: name, note };
  const current = await currentBase(repo);
  return { ...current, note: `Não achei ${name} em ${repo.name}: o worktree saiu da branch atual (${current.label}).${odd}` };
}

// ---------------------------------------------------------------- cópias para dentro do worktree

/**
 * Arquivos fora do git que o repositório pede para levar a worktrees novos, como o Claude Code faz:
 * o `.worktreeinclude` da raiz lista padrões no formato do .gitignore, e só vai o que casa com eles
 * e também é ignorado pelo git (ex.: .env). Devolve os caminhos copiados.
 */
async function copyIncluded(repo: Repo, target: string): Promise<string[]> {
  if (!existsSync(path.join(repo.absPath, '.worktreeinclude'))) return [];
  const listed = (await git(repo.absPath, ['ls-files', '--others', '--ignored', '--exclude-from=.worktreeinclude', '-z'])).split('\0').filter(Boolean);
  if (!listed.length) return [];
  // check-ignore sai com código 1 quando nenhum é ignorado.
  const ignored = (await git(repo.absPath, ['check-ignore', '--stdin', '-z'], { input: `${listed.join('\0')}\0` }).catch(() => ''))
    .split('\0')
    .filter(Boolean);
  const copied: string[] = [];
  for (const file of ignored) {
    const from = path.join(repo.absPath, file);
    const to = path.join(target, file);
    if (!isInside(repo.absPath, from) || !isInside(target, to) || existsSync(to)) continue;
    try {
      if (!statSync(from).isFile()) continue;
      mkdirSync(path.dirname(to), { recursive: true });
      copyFileSync(from, to);
      copied.push(file);
    } catch {
      /* sumiu ou não deu para ler: segue sem ele */
    }
  }
  return copied;
}

interface CopyBudget {
  files: number;
  bytes: number;
  /** O teto foi atingido e algo ficou de fora. */
  cut: boolean;
  /** As pastas de configuração das contas, como são de fato: nunca entram numa cópia, nem por um link. */
  accounts: string[];
}

/**
 * Cópia de verdade, seguindo os links: um link para pasta (as skills do `npx skills`, por exemplo) vira
 * uma cópia do conteúdo, e não outro link para o original. Assim, o que o agente mudar no worktree não
 * mexe no que outros projetos usam. Respeita o teto do worktree e nunca entra na pasta de uma conta.
 */
function copyReal(from: string, to: string, budget: CopyBudget, parents = new Set<string>()): void {
  if (budget.cut || path.basename(from) === '.credentials.json') return;
  let info;
  let real;
  try {
    info = statSync(from); // segue o link
    real = realpathSync.native(from);
  } catch {
    return; // link quebrado
  }
  if (budget.accounts.some((account) => samePath(account, real) || isInside(account, real))) return;
  if (info.isDirectory()) {
    if (parents.has(real)) return; // um link que aponta para cima viraria um laço
    parents.add(real);
    mkdirSync(to, { recursive: true });
    for (const name of readdirSync(from)) copyReal(path.join(from, name), path.join(to, name), budget, parents);
    parents.delete(real);
    return;
  }
  if (!info.isFile() || existsSync(to)) return;
  if (budget.files + 1 > COPY_LIMIT.files || budget.bytes + info.size > COPY_LIMIT.bytes) {
    budget.cut = true;
    return;
  }
  mkdirSync(path.dirname(to), { recursive: true });
  copyFileSync(from, to);
  budget.files++;
  budget.bytes += info.size;
}

/** Pastas de configuração do Claude Code das contas (~/.claude e as das contas extras), resolvidas: nunca são copiadas. */
function accountConfigDirs(): string[] {
  const dirs = [path.join(homedir(), '.claude'), ...db.accounts.flatMap((account) => (account.configDir ? [account.configDir] : []))];
  return dirs.map((dir) => {
    try {
      return realpathSync.native(dir);
    } catch {
      return path.resolve(dir);
    }
  });
}

/** A menor pasta do workspace que contém os repositórios em foco, e as pastas de grupo do caminho até ela, a partir da raiz. */
function groupChain(workspace: Workspace, focus: Repo[]): string[] {
  const original = commonFolder(focus.map((repo) => repo.absPath), workspace.rootPath);
  if (!isInside(workspace.rootPath, original)) return [];
  const chain: string[] = [];
  for (let dir = original; ; dir = path.dirname(dir)) {
    chain.unshift(dir);
    if (samePath(dir, workspace.rootPath) || path.dirname(dir) === dir) break;
  }
  return chain;
}

/**
 * Cópias do CLAUDE.md, AGENTS.md, .mcp.json e da configuração de projeto em .claude/ das pastas que
 * agrupam os repositórios, da raiz do workspace até a pasta da sessão: no worktree, o Claude lê as
 * mesmas instruções e configurações do projeto que leria na pasta original. Só copia o que ainda não
 * está lá. Devolve um aviso se o teto das cópias deixou algo de fora.
 */
function copyContext(workspace: Workspace, focus: Repo[], root: string): string | null {
  const budget: CopyBudget = { files: 0, bytes: 0, cut: false, accounts: accountConfigDirs() };
  for (const dir of groupChain(workspace, focus)) {
    // A pasta de um repositório em foco já vem com os arquivos dele pelo próprio worktree.
    if (focus.some((repo) => samePath(repo.absPath, dir))) continue;
    const dest = path.join(root, path.relative(workspace.rootPath, dir));
    for (const name of CONTEXT_FILES) {
      try {
        if (statSync(path.join(dir, name)).isFile()) copyReal(path.join(dir, name), path.join(dest, name), budget);
      } catch {
        /* não existe, ou não deu para copiar: segue sem ele */
      }
    }
    const claudeDir = path.join(dir, '.claude');
    try {
      if (!statSync(claudeDir).isDirectory()) continue;
      // Um workspace na sua pasta pessoal: o .claude/ dela é a configuração da conta (login, histórico), que o Claude já lê sozinho.
      const real = realpathSync.native(claudeDir);
      if (budget.accounts.some((account) => samePath(account, real))) continue;
      for (const entry of readdirSync(claudeDir)) {
        if (CLAUDE_PROJECT_ENTRIES.has(entry)) copyReal(path.join(claudeDir, entry), path.join(dest, '.claude', entry), budget);
      }
    } catch {
      /* sem .claude, ou não deu para copiar */
    }
  }
  return budget.cut ? `As cópias de contexto (CLAUDE.md, .claude/…) passaram de ${COPY_LIMIT.files} arquivos ou ${COPY_LIMIT.bytes / 1024 / 1024} MB, e o resto ficou de fora do worktree.` : null;
}

// ---------------------------------------------------------------- preparar

interface Created {
  repo: Repo;
  target: string;
  branch: string;
  /** A branch nasceu agora (desfazer apaga a branch também). */
  newBranch: boolean;
}

/** Desfaz o que uma preparação que falhou no meio criou. `root`: a pasta, se foi criada por ela. */
async function rollback(created: Created[], root: string | null): Promise<void> {
  for (const item of created.reverse()) {
    await removeTree(item.target).catch(() => undefined);
    await forgetWorktree(item.repo.absPath, item.target);
    if (item.newBranch) await git(item.repo.absPath, ['branch', '-D', item.branch]).catch(() => undefined);
  }
  if (root) await removeTree(root).catch(() => undefined);
}

/**
 * Recusa misturar, no mesmo worktree, o repositório da raiz do workspace com repositórios dentro dele:
 * eles ficariam uns dentro dos outros, e o da raiz veria os outros como arquivos novos.
 */
function refuseMixedRoot(focus: Repo[], current: Worktree | null): void {
  const rootRepo = focus.some((repo) => repo.relPath === '.');
  const nested = focus.some((repo) => repo.relPath !== '.');
  const hasRootEntry = Boolean(current?.repos.some((entry) => samePath(entry.path, current.root)));
  const hasNestedEntry = Boolean(current?.repos.some((entry) => !samePath(entry.path, current.root)));
  if (rootRepo && nested) {
    throw new HttpError(400, 'Esta issue junta o repositório da raiz do workspace com repositórios dentro dele, e um worktree não comporta isso. Deixe só um deles na issue, ou delegue sem worktree.');
  }
  if ((rootRepo && hasNestedEntry) || (nested && hasRootEntry)) {
    throw new HttpError(400, 'O worktree desta issue foi criado com outros repositórios, e o da raiz do workspace não cabe junto deles. Remova o worktree antes (Mais ações › Remover worktree), ou delegue sem worktree.');
  }
}

/**
 * O worktree da issue, pronto para uma sessão: reaproveita o que ela já tem (criando o que faltar,
 * ex.: um repositório marcado depois) ou cria um novo. Devolve também os avisos para o feed da sessão.
 */
export async function prepareWorktree(workspace: Workspace, issue: Issue, base: WorktreeBase): Promise<{ worktree: Worktree; notes: string[] }> {
  if (preparing.has(issue.id)) throw new HttpError(409, 'O worktree desta issue está sendo preparado ou removido. Espere um instante e tente de novo.');
  const focus = workspaceRepos(workspace.id).filter((repo) => issue.repoIds.includes(repo.id));
  if (!focus.length) throw new HttpError(400, 'Marque os repositórios da issue para trabalhar num worktree.');
  // Pasta do worktree apagada fora do Octo: ele volta no mesmo lugar, nas mesmas branches (como um repositório que sumiu, abaixo).
  const current = issue.worktree && isOurs(issue.worktree.root) ? issue.worktree : null;
  if (issue.worktree?.removing) {
    throw new HttpError(409, 'A remoção do worktree desta issue não terminou. Termine-a antes (Mais ações › Remover worktree) e delegue de novo.');
  }
  refuseMixedRoot(focus, current);
  for (const repo of focus) {
    if (!existsSync(repo.absPath)) throw new HttpError(400, `A pasta de ${repo.name} não existe mais (${repo.absPath}). Reescaneie o workspace.`);
  }

  preparing.add(issue.id);
  const created: Created[] = [];
  const notes: string[] = [];
  const repos: WorktreeRepo[] = [];
  let reserved: string | null = null;
  try {
    const root = current?.root ?? (reserved = reserveRoot(workspace, issue));
    if (current) mkdirSync(root, { recursive: true });
    const missing = focus.filter((repo) => {
      const entry = current?.repos.find((r) => r.repoId === repo.id);
      if (entry && isWorktreeDir(entry.path)) {
        repos.push(entry);
        return false;
      }
      return true;
    });
    // A mesma branch em todos os repositórios; num worktree que já existe, a mesma dos que já estão nele.
    const wanted = current?.repos[0]?.branch ?? worktreeBranchName(issue.identifier, issue.title);
    const fresh = missing.length ? await freeBranch(missing, wanted) : wanted;

    for (const repo of missing) {
      const target = targetPath(root, repo);
      const previous = current?.repos.find((r) => r.repoId === repo.id);
      // O que sobrou de um worktree desfeito pela metade (sem o .git) sai, e o registro antigo deste caminho
      // também. A pasta que acabou de ser reservada fica (vazia): soltá-la deixaria outra issue pegá-la.
      if (target !== reserved) await clearFolder(target);
      await forgetWorktree(repo.absPath, target);
      mkdirSync(path.dirname(target), { recursive: true });
      try {
        // A pasta deste repositório sumiu, mas a branch dele continua: volta para ela, com o trabalho que já tinha.
        if (previous && safeRef(previous.branch) && (await succeeds(repo.absPath, ['show-ref', '--verify', '--quiet', `refs/heads/${previous.branch}`]))) {
          await git(repo.absPath, ['worktree', 'add', '--quiet', target, previous.branch], { timeout: CHECKOUT_TIMEOUT });
          created.push({ repo, target, branch: previous.branch, newBranch: false });
          repos.push({ ...previous, path: target });
          notes.push(`${repo.name}: a pasta do worktree tinha sumido e foi recriada na branch ${previous.branch}.`);
        } else {
          const from = base === 'current' ? await currentBase(repo) : await defaultBase(repo);
          if (from.note) notes.push(from.note);
          try {
            // --no-track: a branch nova não segue a de origem (um `git push` dela nunca vai parar na main).
            await git(repo.absPath, ['worktree', 'add', '--quiet', '--no-track', '-b', fresh, target, from.ref], { timeout: CHECKOUT_TIMEOUT });
          } catch (error) {
            // O git cria a branch (e às vezes a pasta) antes de o checkout falhar (caminho longo demais, um hook
            // post-checkout que falhou): nada disso fica para trás. A branch era livre até agora. A raiz do
            // worktree não sai aqui: se for a pasta reservada, o rollback cuida dela.
            if (target !== root) await removeTree(target).catch(() => undefined);
            await forgetWorktree(repo.absPath, target);
            await git(repo.absPath, ['branch', '-D', fresh]).catch(() => undefined);
            throw error;
          }
          created.push({ repo, target, branch: fresh, newBranch: true });
          repos.push({ repoId: repo.id, path: target, branch: fresh, base: from.label });
        }
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(400, `Não foi possível criar o worktree de ${repo.name}: ${gitMessage(error)}`);
      }
      const copied = await copyIncluded(repo, target).catch(() => []);
      if (copied.length) notes.push(`${repo.name}: copiados do .worktreeinclude ${copied.slice(0, 6).join(', ')}${copied.length > 6 ? ` e mais ${copied.length - 6}` : ''}.`);
    }
    const cut = copyContext(workspace, focus, root);
    if (cut) notes.push(cut);

    // Repositórios que saíram da issue continuam no worktree (e saem junto quando ele for removido).
    const kept = current?.repos.filter((entry) => !repos.some((r) => r.repoId === entry.repoId)) ?? [];
    const worktree: Worktree = { root, repos: [...repos, ...kept], createdAt: current?.createdAt ?? now() };
    const folder = path.basename(root);
    const added = created.filter((item) => item.newBranch);
    const branches = [...new Set(repos.map((entry) => entry.branch))].join(', ');
    if (!current) {
      const bases = [...new Set(repos.map((entry) => entry.base))].join(', ');
      notes.unshift(`Worktree ${folder} criado em ${root}: branch ${branches}, a partir de ${bases}.`);
      addHistory(issue, 'session', 'Octo', `criou o worktree ${folder} (branch ${branches})`);
    } else {
      notes.unshift(`Continuando no worktree ${folder} (branch ${branches}).`);
      if (added.length) addHistory(issue, 'session', 'Octo', `acrescentou ${added.map((item) => item.repo.name).join(', ')} ao worktree ${folder}`);
    }
    issue.worktree = worktree;
    commitIssue(issue);
    return { worktree, notes };
  } catch (error) {
    await rollback(created, reserved);
    throw error;
  } finally {
    preparing.delete(issue.id);
  }
}

/**
 * Desfaz um worktree que acabou de ser criado para uma delegação que não chegou a começar (o terminal
 * não abriu, o comando ficou longo demais): sem isso, ele ficaria na issue sem nunca ter sido usado.
 * As branches dele nasceram agora e não têm nada: saem também, assim como o "criou o worktree" do histórico.
 */
export async function discardNewWorktree(issue: Issue, worktree: Worktree): Promise<void> {
  if (issue.worktree !== worktree || preparing.has(issue.id)) return;
  for (const entry of worktree.repos) {
    const main = await mainRepoOf(issue.workspaceId, entry);
    if (isOurs(entry.path)) await removeTree(entry.path).catch(() => undefined);
    if (!main) continue;
    await forgetWorktree(main, entry.path);
    if (safeRef(entry.branch)) await git(main, ['branch', '-D', entry.branch]).catch(() => undefined);
  }
  if (isOurs(worktree.root)) await removeTree(worktree.root).catch(() => undefined);
  issue.worktree = null;
  const last = issue.history.at(-1);
  if (last?.actor === 'Octo' && last.text.startsWith('criou o worktree')) issue.history.pop();
  commitIssue(issue);
}

/**
 * Como ficaria o worktree se a issue fosse delegada agora: a pasta e a branch, já com o -2, -3 quando
 * o nome está ocupado (a prévia ao delegar mostra o nome de verdade). Só consulta; null sem repositórios em foco.
 */
export async function planWorktree(workspace: Workspace, issue: Issue): Promise<{ root: string; branch: string; reuse: boolean } | null> {
  if (issue.worktree) return { root: issue.worktree.root, branch: issue.worktree.repos[0]?.branch ?? '', reuse: true };
  const focus = workspaceRepos(workspace.id).filter((repo) => issue.repoIds.includes(repo.id) && existsSync(repo.absPath));
  if (!focus.length) return null;
  return { root: nextRoot(workspace, issue), branch: await freeBranch(focus, worktreeBranchName(issue.identifier, issue.title)), reuse: false };
}

// ---------------------------------------------------------------- repositórios no worktree

/** Os repositórios do worktree onde eles estão de fato: Repo com o caminho e a branch do worktree. */
export function worktreeRepos(workspaceId: string, worktree: Worktree): Repo[] {
  const byId = new Map(workspaceRepos(workspaceId).map((repo) => [repo.id, repo]));
  return worktree.repos.flatMap((entry) => {
    const repo = byId.get(entry.repoId);
    return repo ? [{ ...repo, absPath: entry.path, branch: entry.branch }] : [];
  });
}

/**
 * Os repositórios do workspace como a sessão os vê: os do worktree nos caminhos dele, e os outros na
 * pasta original. Sem worktree, os do workspace.
 */
export function sessionRepos(session: Pick<AgentSession, 'workspaceId' | 'worktree'>): Repo[] {
  if (!session.worktree) return workspaceRepos(session.workspaceId);
  const inside = worktreeRepos(session.workspaceId, session.worktree);
  const ids = new Set(inside.map((repo) => repo.id));
  return [...inside, ...workspaceRepos(session.workspaceId).filter((repo) => !ids.has(repo.id))];
}

/**
 * O worktree do workspace que contém esta pasta (o de uma issue ou o guardado numa sessão), ou null.
 * Os das issues vêm antes: são os mais recentes. O de uma sessão continua valendo para ela mesmo
 * depois que a issue é apagada.
 */
export function worktreeAt(workspace: Workspace, dir: string): Worktree | null {
  const known = [...db.issues, ...db.sessions].filter((item) => item.workspaceId === workspace.id).map((item) => item.worktree);
  return known.find((worktree) => worktree && isInside(worktree.root, dir)) ?? null;
}

/** Os repositórios do workspace vistos desta pasta: dentro de um worktree, os dele nos caminhos do worktree. */
export function reposAt(workspace: Workspace, dir: string): Repo[] {
  const worktree = worktreeAt(workspace, dir);
  return worktree ? sessionRepos({ workspaceId: workspace.id, worktree }) : workspaceRepos(workspace.id);
}

/** Pasta da sessão num worktree: a menor pasta dele que contém os repositórios da issue. */
export function worktreeCwd(worktree: Worktree, repoIds: string[]): string {
  const dirs = worktree.repos.filter((entry) => repoIds.includes(entry.repoId)).map((entry) => entry.path);
  const common = commonFolder(dirs.length ? dirs : worktree.repos.map((entry) => entry.path), worktree.root);
  return isInside(worktree.root, common) ? common : worktree.root;
}

// ---------------------------------------------------------------- situação e remoção

/** O repositório principal de um worktree (para os comandos `git worktree`): o do workspace ou, se ele saiu, o que o próprio worktree aponta. */
async function mainRepoOf(workspaceId: string, entry: WorktreeRepo): Promise<string | null> {
  const repo = workspaceRepos(workspaceId).find((r) => r.id === entry.repoId);
  if (repo && existsSync(repo.absPath)) return repo.absPath;
  if (!isWorktreeDir(entry.path)) return null;
  const common = (await git(entry.path, ['rev-parse', '--path-format=absolute', '--git-common-dir']).catch(() => '')).trim();
  return common ? path.dirname(common) : null;
}

/** Arquivos com alterações sem commit; null quando não dá para saber (o git não respondeu, ou a pasta já não é um worktree). */
async function dirtyCount(dir: string): Promise<number | null> {
  // Sem o .git, o git procuraria um repositório nas pastas de cima e contaria as alterações de outro.
  if (!isWorktreeDir(dir)) return null;
  try {
    // Sem o lock opcional do índice: conferir não disputa o .git/index.lock com o agente.
    const parts = (await git(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=normal'], { env: { GIT_OPTIONAL_LOCKS: '0' } })).split('\0');
    let count = 0;
    for (let i = 0; i < parts.length; i++) {
      const entry = parts[i];
      if (entry.length < 4) continue;
      if (entry[0] === 'R' || entry[0] === 'C') i++; // o caminho antigo vem no item seguinte
      count++;
    }
    return count;
  } catch {
    return null;
  }
}

/**
 * Submódulos inicializados no worktree: commits feitos neles ficam só ali dentro (o git status do
 * repositório não os mostra se o ponteiro já foi commitado), e remover o worktree os perde.
 */
async function initializedSubmodules(dir: string): Promise<number> {
  if (!isWorktreeDir(dir) || !existsSync(path.join(dir, '.gitmodules'))) return 0;
  const out = await git(dir, ['submodule', 'status', '--recursive'], { env: { GIT_OPTIONAL_LOCKS: '0' } }).catch(() => '');
  return out.split('\n').filter((line) => line.trim() && !line.startsWith('-')).length;
}

async function aheadCount(dir: string, base: string): Promise<number | null> {
  if (!isWorktreeDir(dir)) return null;
  const out = await git(dir, ['rev-list', '--count', '--end-of-options', `${base}..HEAD`]).catch(() => null);
  const count = out === null ? NaN : Number(out.trim());
  return Number.isFinite(count) ? count : null;
}

function sameContent(a: string, b: string): boolean {
  try {
    if (statSync(a).size !== statSync(b).size) return false;
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

/**
 * Arquivos do worktree fora dos repositórios (na raiz dele ou em pastas de grupo) que não são cópias
 * iguais às da pasta original do workspace: o agente pode ter escrito ali (um PLANO.md, por exemplo).
 * O git status dos repositórios não os vê, e remover o worktree os perde.
 */
function outsideFiles(issue: Issue, worktree: Worktree): string[] {
  // Um repositório na própria raiz do worktree: tudo é dele, e o git status já conta.
  if (worktree.repos.some((entry) => samePath(entry.path, worktree.root))) return [];
  const workspace = db.workspaces.find((w) => w.id === issue.workspaceId);
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (found.length > OUTSIDE_LIMIT || depth > 8) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (worktree.repos.some((repo) => samePath(repo.path, full))) continue;
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile()) {
        const rel = path.relative(worktree.root, full);
        if (!workspace || !sameContent(full, path.join(workspace.rootPath, rel))) found.push(rel.split(path.sep).join('/'));
      }
      if (found.length > OUTSIDE_LIMIT) return;
    }
  };
  walk(worktree.root, 0);
  return found;
}

export async function worktreeStatus(issue: Issue, busy: boolean): Promise<WorktreeStatus> {
  const worktree = issue.worktree;
  if (!worktree) throw new HttpError(404, 'Esta issue não tem worktree.');
  const names = new Map(workspaceRepos(issue.workspaceId).map((repo) => [repo.id, repo.name]));
  const repos = await Promise.all(
    worktree.repos.map(async (entry) => {
      const exists = existsSync(entry.path);
      return {
        repoId: entry.repoId,
        name: names.get(entry.repoId) ?? path.basename(entry.path),
        path: entry.path,
        branch: entry.branch,
        exists,
        dirty: exists ? await dirtyCount(entry.path) : 0,
        ahead: exists ? await aheadCount(entry.path, entry.base) : null,
      };
    }),
  );
  return { root: worktree.root, exists: existsSync(worktree.root), busy, repos, outside: outsideFiles(issue, worktree) };
}

/**
 * Remove os worktrees da issue e a pasta dela. As branches (e os commits nelas) continuam nos
 * repositórios. Sem `force`, recusa se houver alterações sem commit, arquivos fora dos repositórios, ou
 * se não der para conferir. A pasta é apagada pelo Octo (sem seguir links) e o git só esquece o
 * registro: uma remoção que parou no meio (um arquivo preso por outro programa) pode ser repetida.
 */
export async function removeWorktree(issue: Issue, options: { force: boolean; busy: boolean }): Promise<void> {
  const worktree = issue.worktree;
  if (!worktree) throw new HttpError(404, 'Esta issue não tem worktree.');
  if (options.busy) throw new HttpError(409, 'Uma sessão desta issue está rodando no worktree. Pare-a antes de remover.');
  if (preparing.has(issue.id)) throw new HttpError(409, 'O worktree desta issue está sendo preparado ou removido. Espere um instante e tente de novo.');
  preparing.add(issue.id);
  try {
    if (!options.force) {
      const status = await worktreeStatus(issue, false);
      const dirty = status.repos.filter((repo) => repo.exists && repo.dirty !== 0);
      const problems = dirty.map((repo) =>
        repo.dirty === null ? `${repo.name} (não deu para conferir)` : `${repo.name} (${repo.dirty} ${repo.dirty === 1 ? 'arquivo' : 'arquivos'})`,
      );
      for (const repo of status.repos.filter((entry) => entry.exists)) {
        const modules = await initializedSubmodules(repo.path);
        if (modules) problems.push(`${repo.name} (${modules} ${modules === 1 ? 'submódulo inicializado' : 'submódulos inicializados'}, que podem ter commits só ali)`);
      }
      const outside = status.outside ?? [];
      if (outside.length) problems.push(`fora dos repositórios (${outside.slice(0, 3).join(', ')}${outside.length > 3 ? '…' : ''})`);
      if (problems.length) {
        throw new HttpError(409, `Há alterações que se perderiam, ou que não deu para conferir: ${problems.join(', ')}. Remover o worktree apaga essas alterações; as branches e os commits continuam.`);
      }
    }

    const failed: string[] = [];
    const remaining: WorktreeRepo[] = [];
    for (const entry of worktree.repos) {
      const main = await mainRepoOf(issue.workspaceId, entry);
      try {
        if (existsSync(entry.path)) {
          // Fora da pasta de worktrees do Octo (um db.json levado para outra pasta de dados), ninguém apaga nada.
          if (!isOurs(entry.path)) throw new Error('a pasta fica fora da pasta de worktrees do Octo; apague-a à mão, se não precisar mais');
          // O .git sai primeiro: se a remoção parar no meio, o que sobrou já não conta como worktree.
          await unlink(path.join(entry.path, '.git')).catch((error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? undefined : Promise.reject(error)));
          await removeTree(entry.path);
        }
        if (main) await forgetWorktree(main, entry.path);
      } catch (error) {
        failed.push(`${path.basename(entry.path)}: ${(error as Error).message}`);
        remaining.push(entry);
      }
    }
    // Sobram as cópias de contexto (CLAUDE.md…) e as pastas de grupo; a pasta de outra issue nunca é apagada.
    const shared = db.issues.some((other) => other !== issue && other.worktree && samePath(other.worktree.root, worktree.root));
    if (!failed.length && !shared && existsSync(worktree.root)) {
      if (isOurs(worktree.root)) await removeTree(worktree.root).catch((error: unknown) => failed.push(`${worktree.root}: ${(error as Error).message}`));
      else failed.push(`${worktree.root}: a pasta fica fora da pasta de worktrees do Octo; apague-a à mão, se não precisar mais`);
    }
    if (failed.length) {
      // Fica só o que não saiu, marcado como em remoção: repetir a remoção continua dali, e nenhuma sessão roda nele até lá.
      issue.worktree = { ...worktree, repos: remaining, removing: true };
      commitIssue(issue);
      throw new HttpError(
        400,
        `Não foi possível remover tudo: ${failed.join('; ')}. Feche editores, terminais e o Explorador abertos nessa pasta e tente de novo.`,
      );
    }
    const branches = [...new Set(worktree.repos.map((entry) => entry.branch))].join(', ');
    issue.worktree = null;
    addHistory(issue, 'session', 'Você', `removeu o worktree ${path.basename(worktree.root)} (a branch ${branches} continua nos repositórios)`);
    commitIssue(issue);
  } finally {
    preparing.delete(issue.id);
  }
}
