// Leitura segura de um repositório que pode ter vindo de fora do git (um .git que chegou num zip/tar,
// numa pasta copiada ou num disco externo). A config de um repositório pode nomear programas que o git
// roda sozinho — core.fsmonitor, filter.<x>.clean/smudge/process, diff.<x>.textconv, gpg.program, o hook
// post-index-change, o core.sshCommand do fetch automático de um clone parcial — e o Octo lê esses
// repositórios sem pedir permissão (varredura, aba Mudanças, início/fim de sessão). O readOnlyGit monta
// a configuração que neutraliza só o que vem do próprio repositório e dos submódulos dele (escopo
// local/worktree), deixando as configurações globais e do sistema (git-lfs, gerenciador de credenciais)
// funcionando. Na dúvida, falha fechado: sem conseguir ler a config com segurança, as leituras
// automáticas daquele repositório não rodam.
//
// Criar um worktree (worktrees.ts) não passa por aqui: é uma ação pedida pela pessoa, e o `git worktree
// add` roda de qualquer jeito os hooks e os filtros do repositório.
import { isUtf8 } from 'node:buffer';
import { execFile, spawn } from 'node:child_process';
import { access, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { baseEnv, gitPath } from './system.ts';

/** O mesmo tempo da leitura mais lenta (a aba Mudanças): num repositório normal, a config sai em milissegundos. */
const TIMEOUT = 30_000;
/** Submódulos inicializados lidos por repositório (somando os aninhados) e até que nível: acima disso, o status e o diff não entram neles. */
const MAX_SUBMODULES = 50;
const MAX_DEPTH = 6;
/** Gitlinks no índice de um repositório (inicializados ou não) que ainda vale conferir um a um. */
const MAX_GITLINKS = 500;
/** Índice maior que isso: quem procura os gitlinks é o `git ls-files`, sem o Octo ler o arquivo. */
const MAX_INDEX = 32 * 1024 * 1024;
/** Uma chave ou um caminho maior que isso na saída do git não vem de um repositório normal. */
const MAX_ITEM = 64 * 1024;
/**
 * Tamanho máximo das neutralizações somadas (caracteres). No git 2.26 a 2.30 elas vão na linha de
 * comando (no Windows, até 32 mil caracteres); do 2.31 em diante, no ambiente.
 */
const MAX_OVERRIDES = { args: 16_000, env: 256_000 };

/** Um filtro (o status e o diff rodam o programa dele). O nome pode ser vazio ou ter ".", "=" e "\r". */
const FILTER_KEY = /^filter\.(.*)\.(clean|smudge|process)$/is;
/** Uma extensão do git-lfs: o filtro lfs, mesmo vindo do global ou do sistema, roda o programa dela. */
const LFS_EXTENSION = /^lfs\.extension\./i;
/** Um gitlink (submódulo) na saída do `git ls-files --stage`. */
const GITLINK = Buffer.from('160000 ');
/** O modo de um gitlink (160000) como ele fica gravado no registro do índice, em qualquer versão do índice. */
const GITLINK_MODE = Buffer.from([0x00, 0x00, 0xe0, 0x00]);

const UNSAFE = 'Não deu para ler a configuração do git deste repositório com segurança';

type Override = [key: string, value: string];

/** Sempre neutralizadas, sem depender do repositório. */
const FIXED: Override[] = [
  ['core.fsmonitor', 'false'],
  // O gpg.program roda para mostrar as assinaturas no log.
  ['log.showSignature', 'false'],
  // O `git diff` grava o índice quando acha arquivos só com a data mudada (mesmo com GIT_OPTIONAL_LOCKS=0),
  // e gravar o índice roda o hook post-index-change do repositório. Sem gravar, o diff sai igual.
  ['diff.autoRefreshIndex', 'false'],
];

/**
 * Ambiente das leituras, em qualquer versão do git: num clone parcial, uma leitura que precisa de um
 * objeto ausente faz o git buscá-lo sozinho, e esse fetch roda o core.sshCommand (ou o uploadpack) da
 * config do repositório. GIT_NO_LAZY_FETCH (git 2.45 em diante) nem tenta; GIT_ALLOW_PROTOCOL recusa
 * todo transporte, por cima da config (com um nome que nenhum endereço produz). Sem o objeto, a leitura
 * falha; as do Octo só precisam do que o checkout já trouxe.
 */
const OFFLINE: NodeJS.ProcessEnv = { GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: 'octo_nenhum' };

/**
 * As neutralizações no formato que o git recebe: prefixo `-c` (git 2.26 a 2.30) ou GIT_CONFIG_* no
 * ambiente (2.31 ou mais novo). O ambiente sempre leva também o OFFLINE.
 */
interface GitOptions {
  args: string[];
  env: NodeJS.ProcessEnv;
}

export interface SafeGit extends GitOptions {
  /**
   * Para o status e o diff: `--ignore-submodules=dirty` quando não deu para ler a config de algum
   * submódulo (o git deixa de entrar neles, e o que mudou lá dentro fica de fora). Vazio no caso normal.
   */
  submodules: string[];
}

/** A leitura automática não roda: não deu para garantir que a config do repositório não execute nada. */
export class UnsafeGitConfig extends Error {}

// ---------------------------------------------------------------- versão do git

interface Version {
  text: string;
  major: number;
  minor: number;
}

let known: { git: string; version: Promise<Version> } | null = null;

/** A versão do git, lida uma vez por executável. Rejeita, com o erro do próprio git, se ele não roda. */
function gitVersion(): Promise<Version> {
  const git = gitPath(); // sem git, lança ENOENT (e a aba Mudanças diz que falta o git)
  if (known?.git === git) return known.version;
  const version = new Promise<Version>((resolve, reject) => {
    execFile(git, ['--version'], { windowsHide: true, timeout: TIMEOUT, env: baseEnv() }, (error, stdout, stderr) => {
      if (error) return reject(Object.assign(error, { stderr }));
      const text = /git version (\S+)/.exec(String(stdout))?.[1] ?? String(stdout).trim();
      const [major = 0, minor = 0] = (/^(\d+)\.(\d+)/.exec(text) ?? []).slice(1).map(Number);
      resolve({ text, major, minor });
    });
  });
  known = { git, version };
  // Uma falha (ex.: o git do macOS sem as ferramentas da Apple) não fica guardada: a próxima leitura tenta de novo.
  version.catch(() => {
    if (known?.version === version) known = null;
  });
  return version;
}

const atLeast = (version: Version, major: number, minor: number) => version.major > major || (version.major === major && version.minor >= minor);

// ---------------------------------------------------------------- o que vem do repositório

/**
 * Roda um git que só lê (config, ls-files) e passa cada item da saída (separados por NUL, com -z) para
 * `each`, sem juntar a saída inteira na memória: a config de um repositório pode ter megabytes de
 * chaves. Rejeita se o git falhar ou passar do tempo.
 */
function eachItem(cwd: string, args: string[], env: NodeJS.ProcessEnv, each: (item: Buffer) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      // Por caminho absoluto: com o nome solto, o Windows rodaria um git.exe de dentro do repositório.
      child = spawn(gitPath(), args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      reject(error);
      return;
    }
    let rest: Buffer = Buffer.alloc(0);
    let stderr = '';
    let stopped = false;
    // Para na hora (sem esperar o processo fechar): o que vier depois é ignorado.
    const stop = (error: unknown) => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      child.kill();
      reject(error);
    };
    const timer = setTimeout(() => stop(new Error('o git demorou demais para responder')), TIMEOUT);
    child.stdout.on('data', (chunk: Buffer) => {
      if (stopped) return;
      const data = rest.length ? Buffer.concat([rest, chunk]) : chunk;
      let start = 0;
      try {
        for (let end = data.indexOf(0); end !== -1; end = data.indexOf(0, start)) {
          each(data.subarray(start, end));
          start = end + 1;
        }
      } catch (error) {
        stop(error);
        return;
      }
      rest = data.subarray(start);
      if (rest.length > MAX_ITEM) stop(new Error('a saída do git tem um item grande demais'));
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr = (stderr + chunk).slice(-2000)));
    child.once('error', stop);
    child.once('close', (code) => {
      if (stopped) return;
      const said = stderr.split('\n').map((line) => line.trim()).find(Boolean);
      if (code !== 0) return stop(new Error(said ?? `o git saiu com o código ${code}`));
      try {
        if (rest.length) each(rest);
      } catch (error) {
        return stop(error);
      }
      stopped = true;
      clearTimeout(timer);
      resolve();
    });
  });
}

/** O que interessa da config de um repositório: só os escopos local e worktree, que vêm dele. */
interface RepoConfig {
  /** Nomes dos filtros que o repositório define ou redefine (clean, smudge ou process). */
  filters: Set<string>;
  /** O repositório configura uma extensão do git-lfs. */
  lfsExtension: boolean;
  /** Algum nome de filtro não é UTF-8 válido: não dá para repassá-lo ao git, nem pelo ambiente nem por -c. */
  undecodable: boolean;
}

/**
 * `git config --list` só lê os arquivos de configuração (e segue os include.path, que contam como do
 * escopo de quem os inclui), sem rodar nenhum programa. `--name-only` não imprime os valores e preserva
 * as maiúsculas do nome do filtro; com `-z`, escopo e chave vêm separados por NUL.
 */
async function repoConfig(cwd: string, options: GitOptions, env: NodeJS.ProcessEnv): Promise<RepoConfig> {
  const config: RepoConfig = { filters: new Set(), lfsExtension: false, undecodable: false };
  let scope: string | null = null;
  await eachItem(cwd, [...options.args, 'config', '--list', '--show-scope', '--name-only', '-z'], env, (item) => {
    // Os itens vêm em pares: o escopo, depois a chave.
    if (scope === null) {
      scope = item.toString('latin1');
      return;
    }
    const fromRepo = scope === 'local' || scope === 'worktree';
    scope = null;
    // Só as chaves filter.* e lfs.* (as seções vêm em minúsculas): as outras nem são decodificadas.
    if (!fromRepo || (item[0] !== 0x66 && item[0] !== 0x6c)) return;
    const key = item.toString('utf8');
    if (LFS_EXTENSION.test(key)) config.lfsExtension = true;
    const filter = FILTER_KEY.exec(key);
    if (!filter) return;
    if (isUtf8(item)) config.filters.add(filter[1]);
    else config.undecodable = true;
  });
  return config;
}

/**
 * Atalho para não abrir o `git ls-files` à toa num repositório sem submódulos (o caso comum): todo
 * gitlink grava o modo 160000 como os bytes 00 00 E0 00 no registro dele, então, se essa sequência não
 * aparece em lugar nenhum do índice, não há gitlink. Na dúvida (índice em outro lugar, dividido ou
 * grande demais, ou a sequência aparecendo por acaso em outro campo), o ls-files confere.
 */
async function mayHaveGitlinks(cwd: string): Promise<boolean> {
  // O ambiente de quem abriu o Octo pode apontar outro repositório ou outro índice.
  if (['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_COMMON_DIR'].some((name) => process.env[name])) return true;
  try {
    let gitDir = path.join(cwd, '.git');
    if (!(await stat(gitDir)).isDirectory()) {
      // Worktrees e submódulos: um arquivo .git com "gitdir: <caminho>", relativo à pasta dele.
      const pointer = /^gitdir: (.+)$/m.exec(await readFile(gitDir, 'utf8'));
      if (!pointer) return true;
      gitDir = path.resolve(cwd, pointer[1].trim());
    }
    // Índice dividido (core.splitIndex): parte dos registros fica num sharedindex.* ao lado dele.
    if ((await readdir(gitDir)).some((name) => name.startsWith('sharedindex.'))) return true;
    const file = path.join(gitDir, 'index');
    const index = await stat(file).catch((error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
    if (!index) return false; // ainda sem índice: nada foi adicionado, nenhum gitlink
    return index.size > MAX_INDEX || (await readFile(file)).includes(GITLINK_MODE);
  } catch {
    return true;
  }
}

/**
 * Os submódulos inicializados de um repositório, em caminhos absolutos: os gitlinks do índice (com ou
 * sem .gitmodules) que têm o .git no lugar, que é quando o status e o diff entram neles. O ls-files só
 * lê o índice.
 */
async function gitlinks(cwd: string, options: GitOptions, env: NodeJS.ProcessEnv): Promise<string[]> {
  if (!(await mayHaveGitlinks(cwd))) return [];
  const found = new Set<string>();
  let undecodable = false;
  await eachItem(cwd, [...options.args, 'ls-files', '--stage', '-z'], env, (item) => {
    // "<modo> <objeto> <estágio>\t<caminho>"
    if (item.length <= GITLINK.length || item.compare(GITLINK, 0, GITLINK.length, 0, GITLINK.length) !== 0) return;
    const tab = item.indexOf(0x09);
    const name = item.subarray(tab + 1);
    if (tab === -1 || !isUtf8(name)) undecodable = true;
    else found.add(name.toString('utf8'));
  });
  if (undecodable) throw new Error('um submódulo com o caminho fora do UTF-8');
  if (found.size > MAX_GITLINKS) throw new Error('submódulos demais');
  // resolve, e não join: o git usa o caminho do índice como ele é, relativo à pasta do repositório.
  const dirs = [...found].map((link) => path.resolve(cwd, link));
  const initialized = await Promise.all(dirs.map((dir) => access(path.join(dir, '.git')).then(() => true, () => false)));
  return dirs.filter((_, i) => initialized[i]);
}

/** Roda `fn` em cada item, poucos de cada vez (cada um abre processos do git); para no primeiro erro. */
async function eachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      try {
        await fn(items[next++]);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * Os filtros dos submódulos inicializados (e dos submódulos deles): o status e o diff do repositório
 * entram neles, onde vale a config de cada um, e as neutralizações daqui chegam até lá pelo ambiente.
 * null quando não deu para ler algum: aí o status e o diff não entram em nenhum (--ignore-submodules=dirty).
 */
async function submoduleConfig(links: string[], options: GitOptions, viaEnv: boolean): Promise<RepoConfig | null> {
  const merged: RepoConfig = { filters: new Set(), lfsExtension: false, undecodable: false };
  let level = links;
  let total = 0;
  for (let depth = 1; level.length; depth++) {
    total += level.length;
    if (depth > MAX_DEPTH || total > MAX_SUBMODULES) return null;
    const next: string[] = [];
    try {
      await eachLimit(level, 4, async (dir) => {
        // Como o próprio git entra num submódulo: GIT_DIR=.git na pasta dele, sem procurar um repositório nas pastas de cima.
        const env: NodeJS.ProcessEnv = { ...baseEnv(), ...options.env, GIT_DIR: '.git' };
        delete env.GIT_WORK_TREE;
        delete env.GIT_CONFIG; // faria o `git config` ler só esse arquivo
        const [config, inner] = await Promise.all([repoConfig(dir, options, env), gitlinks(dir, options, env)]);
        // Um nome que não dá para neutralizar (fora do UTF-8, ou com "=" no git 2.26 a 2.30).
        if (config.undecodable || (!viaEnv && [...config.filters].some((name) => name.includes('=')))) throw new Error('filtro sem neutralização');
        for (const name of config.filters) merged.filters.add(name);
        merged.lfsExtension ||= config.lfsExtension;
        next.push(...inner);
      });
    } catch {
      return null;
    }
    level = next;
  }
  return merged;
}

// ---------------------------------------------------------------- neutralizações

/**
 * As chaves no formato que o git recebe. Do 2.31 em diante, pelo ambiente (GIT_CONFIG_COUNT/KEY/VALUE),
 * que separa a chave do valor: o `-c chave=valor` quebra no primeiro "=", e um filtro com "=" no nome
 * escaparia. As que já vierem no ambiente de quem abriu o Octo continuam valendo: as daqui vêm depois.
 */
function pack(overrides: Override[], viaEnv: boolean): GitOptions {
  if (!viaEnv) return { args: overrides.flatMap(([key, value]) => ['-c', `${key}=${value}`]), env: { ...OFFLINE } };
  const count = process.env.GIT_CONFIG_COUNT ?? '';
  const first = /^\s*\d+$/.test(count) ? Number(count) : 0;
  const env: NodeJS.ProcessEnv = { ...OFFLINE, GIT_CONFIG_COUNT: String(first + overrides.length) };
  overrides.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${first + i}`] = key;
    env[`GIT_CONFIG_VALUE_${first + i}`] = value;
  });
  return { args: [], env };
}

/**
 * Cada filtro fica sem programa e sem `required`: com ele, um filtro local legítimo (git-crypt, `git lfs
 * install --local`) faria o status e o diff falharem, e a aba Mudanças do repositório viraria um erro.
 */
const neutralize = (name: string): Override[] => [
  [`filter.${name}.clean`, ''],
  [`filter.${name}.smudge`, ''],
  [`filter.${name}.process`, ''],
  [`filter.${name}.required`, 'false'],
];

function build(names: Set<string>, viaEnv: boolean): GitOptions | null {
  const overrides = [...FIXED, ...[...names].flatMap(neutralize)];
  const size = overrides.reduce((sum, [key, value]) => sum + key.length + value.length + 8, 0);
  return size > (viaEnv ? MAX_OVERRIDES.env : MAX_OVERRIDES.args) ? null : pack(overrides, viaEnv);
}

/**
 * A configuração das leituras automáticas (git status/diff/log/rev-list/rev-parse) num repositório que
 * pode ter vindo de fora: a config dele não roda nada.
 * - sempre core.fsmonitor=false, log.showSignature=false e diff.autoRefreshIndex=false (ver FIXED), e sem
 *   rede: um clone parcial não busca objetos sozinho (ver OFFLINE);
 * - os filtros definidos pelo próprio repositório e pelos submódulos inicializados dele ficam vazios e sem
 *   `required` (ver neutralize); o filtro lfs também, quando eles configuram uma extensão do git-lfs. O
 *   git-lfs do global ou do sistema continua funcionando nos outros repositórios.
 * O `--no-textconv` e o `--no-ext-diff` ficam no comando do diff (changes.ts): são opções dele, não config.
 *
 * Rejeita com UnsafeGitConfig (e a leitura não deve rodar) quando não dá para garantir isso: git anterior
 * ao 2.26 (sem --show-scope), config que não pôde ser lida (erro, ou mais de 30 s) ou um filtro com um
 * nome que não dá para neutralizar. Sem git, rejeita com o erro dele.
 */
export async function readOnlyGit(cwd: string): Promise<SafeGit> {
  const version = await gitVersion();
  if (!atLeast(version, 2, 26)) {
    throw new UnsafeGitConfig(`O git ${version.text} é antigo demais para o Octo ler os repositórios com segurança. Atualize o git para a versão 2.31 ou mais nova e abra o Octo de novo.`);
  }
  const viaEnv = atLeast(version, 2, 31);
  // As fixas valem também para listar: o ls-files lê o índice, e com o core.fsmonitor do repositório rodaria o programa dele.
  const fixed = pack(FIXED, viaEnv);
  const env: NodeJS.ProcessEnv = { ...baseEnv(), ...fixed.env };
  delete env.GIT_CONFIG; // faria o `git config` ler só esse arquivo, e não a config do repositório

  let own: RepoConfig;
  let links: string[] | null;
  try {
    [own, links] = await Promise.all([repoConfig(cwd, fixed, env), gitlinks(cwd, fixed, env).catch(() => null)]);
  } catch (error) {
    throw new UnsafeGitConfig(`${UNSAFE} (${(error as Error).message}).`);
  }
  if (own.undecodable) throw new UnsafeGitConfig(`${UNSAFE} (um filtro tem um nome fora do UTF-8).`);
  if (!viaEnv && [...own.filters].some((name) => name.includes('='))) {
    throw new UnsafeGitConfig(`Este repositório tem um filtro do git com "=" no nome, que o git ${version.text} não deixa o Octo neutralizar. Atualize o git para a versão 2.31 ou mais nova e abra o Octo de novo.`);
  }

  // Sem conseguir ler os submódulos (ou com filtros demais neles), o status e o diff não entram neles.
  let subs = links ? await submoduleConfig(links, fixed, viaEnv) : null;
  const names = (config: RepoConfig | null) => {
    const all = new Set([...own.filters, ...(config?.filters ?? [])]);
    if (own.lfsExtension || config?.lfsExtension) all.add('lfs');
    return all;
  };
  let options = build(names(subs), viaEnv);
  if (!options && subs) {
    subs = null;
    options = build(names(null), viaEnv);
  }
  if (!options) throw new UnsafeGitConfig(`${UNSAFE} (filtros demais na configuração).`);
  return { ...options, submodules: subs ? [] : ['--ignore-submodules=dirty'] };
}
