import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { AccountStatus, ClaudeAccount } from '../shared/types.ts';
import { baseEnv, describeSpawnError, findAllOnPath } from './system.ts';

const WINDOWS = process.platform === 'win32';

export interface ClaudeCommand {
  /** Executável a ser chamado sem shell (claude.exe, ou node.exe + cli.js). */
  command: string;
  prefixArgs: string[];
  display: string;
}

/** O Claude Code que o Octo vai usar, ou por que nenhum serve. */
export interface ClaudeResolution {
  command: ClaudeCommand | null;
  version: string | null;
  /** Por que não há Claude Code utilizável (null quando há). */
  problem: string | null;
  /** O `claude` do PATH está quebrado, mas outro executável funciona e está sendo usado. */
  warning: string | null;
  /** Tamanho + data do arquivo escolhido: se mudar (o Claude Code se atualizou), procura de novo. */
  fingerprint: string | null;
  at: number;
}

/** Variáveis que o Claude Code injeta nas próprias sessões; não podem vazar para processos filhos. */
const SESSION_ENV = [
  'CLAUDECODE', 'AI_AGENT', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_SSE_PORT',
];

/** Ambiente para rodar o Claude com uma conta específica (CLAUDE_CONFIG_DIR isola login, histórico e config). */
export function claudeEnv(account: ClaudeAccount | null): NodeJS.ProcessEnv {
  const env = baseEnv();
  for (const key of SESSION_ENV) delete env[key];
  delete env.CLAUDE_CONFIG_DIR;
  if (account?.configDir) env.CLAUDE_CONFIG_DIR = account.configDir;
  return env;
}

const NOT_FOUND = 'Claude Code não encontrado. Instale-o (docs.claude.com/en/docs/claude-code/setup) e reabra o Octo, ou defina OCTO_CLAUDE_BIN.';

/** Erro que a API devolve como 400 (o tratador de erros lê o `status`). */
function userError(message: string): Error {
  return Object.assign(new Error(message), { status: 400 });
}

/**
 * O que um shim .cmd do npm ou do pnpm executa de verdade: o binário ou o cli.js dentro de
 * node_modules. O npm escreve "%dp0%\<alvo>" e o pnpm, "%~dp0\<alvo>" (ou o caminho completo,
 * quando o alvo está em outro disco); os dois citam antes o node.exe da mesma pasta (na linha
 * IF EXIST), que é só o Node.
 */
function shimTargets(shim: string): string[] {
  let text: string;
  try {
    text = readFileSync(shim, 'utf8');
  } catch {
    return []; // shim ilegível
  }
  const targets = [...text.matchAll(/"(%~?dp0%?\\|[a-z]:\\)([^"]+\.(?:exe|js|cjs|mjs))"/gi)]
    .map(([, base, target]) => (base.startsWith('%') ? target : base + target))
    .filter((target) => path.basename(target).toLowerCase() !== 'node.exe');
  // O pacote em si (dentro de node_modules) primeiro e, nele, o binário nativo antes do script.
  const rank = (target: string) => (/node_modules/i.test(target) ? 0 : 2) + (/\.exe$/i.test(target) ? 0 : 1);
  return targets.sort((a, b) => rank(a) - rank(b)).map((target) => path.resolve(path.dirname(shim), target));
}

/** Onde o instalador oficial costuma colocar o Claude Code, para quando ele não está no PATH do app. */
function knownLocations(): string[] {
  const home = homedir();
  if (process.platform === 'win32') return [path.join(home, '.local', 'bin', 'claude.exe')];
  return [
    path.join(home, '.local', 'bin', 'claude'),
    path.join(home, '.claude', 'local', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ];
}

/** Pacote npm do binário nativo desta plataforma (o mesmo mapa do install.cjs do Claude Code). */
function platformPackage(): { name: string; bin: string } {
  const bin = process.platform === 'win32' ? 'claude.exe' : 'claude';
  return { name: `claude-code-${process.platform}-${process.arch}`, bin };
}

/**
 * Caminho de OCTO_CLAUDE_BIN, sem as aspas que o "Copiar como caminho" do Windows acrescenta.
 * Sempre absoluto: um caminho relativo seria procurado na pasta de cada sessão.
 */
function overridePath(): string | null {
  const value = process.env.OCTO_CLAUDE_BIN?.trim().replace(/^"(.*)"$/, '$1');
  return value ? path.resolve(value) : null;
}

/**
 * Executáveis candidatos, em ordem. No Windows o `claude` do npm é um .cmd (que exigiria
 * cmd.exe e escaping frágil), então seguimos o shim até o binário real. Para cada instalação
 * via npm, o binário nativo da plataforma também entra: se a atualização automática deixar o
 * `bin/claude.exe` quebrado, ele ainda funciona.
 */
function candidates(): string[] {
  const override = overridePath();
  // O `where claude` mostra o claude.cmd do npm: um .cmd em OCTO_CLAUDE_BIN é seguido até o executável.
  if (override) return (WINDOWS && /\.(cmd|bat)$/i.test(override) ? shimTargets(override) : [override]).filter((target) => existsSync(target));
  const { name, bin } = platformPackage();
  const list: string[] = [];
  // Cada instalação entra com o binário nativo dela logo em seguida: se o bin/claude.exe de uma
  // instalação quebrar, o Octo usa o binário bom da mesma instalação antes de cair numa outra
  // (talvez bem mais antiga) que esteja no PATH.
  const add = (target: string) => {
    list.push(target);
    // .../@anthropic-ai/claude-code/bin/claude.exe → pacote em .../@anthropic-ai/claude-code
    const pkg = path.basename(path.dirname(target)) === 'bin' ? path.dirname(path.dirname(target)) : null;
    if (pkg && path.basename(pkg) === 'claude-code') {
      list.push(path.join(pkg, 'node_modules', '@anthropic-ai', name, bin), path.join(path.dirname(pkg), name, bin));
    }
  };
  for (const found of findAllOnPath('claude')) {
    const lower = found.toLowerCase();
    if (!WINDOWS) add(found);
    else if (lower.endsWith('.exe')) add(found);
    else if (lower.endsWith('.cmd') || lower.endsWith('.bat')) for (const target of shimTargets(found)) add(target);
  }
  list.push(...knownLocations());
  const seen = new Set<string>();
  return list.filter((target) => {
    const key = WINDOWS ? path.resolve(target).toLowerCase() : path.resolve(target);
    if (seen.has(key) || !existsSync(target)) return false;
    seen.add(key);
    return true;
  });
}

function fromTarget(target: string): ClaudeCommand | null {
  // O Node não executa .cmd/.bat sem shell (o spawn lança EINVAL).
  if (WINDOWS && /\.(cmd|bat)$/i.test(target)) return null;
  if (/\.(c|m)?js$/i.test(target)) {
    // Instalações antigas via npm são um script: precisam de um Node de verdade, não do executável do app.
    const node = process.versions.electron ? findAllOnPath('node').find((file) => !WINDOWS || file.toLowerCase().endsWith('.exe')) : process.execPath;
    return node ? { command: node, prefixArgs: [target], display: target } : null;
  }
  return { command: target, prefixArgs: [], display: target };
}

function fingerprintOf(file: string): string {
  try {
    const stat = statSync(file);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return 'ausente';
  }
}

/** Roda `--version` e só aceita quem responde como Claude Code (ex.: "2.1.296 (Claude Code)"). */
function probe(command: ClaudeCommand): { version: string | null; output: string } {
  try {
    const output = execFileSync(command.command, [...command.prefixArgs, '--version'], {
      encoding: 'utf8',
      windowsHide: true,
      env: claudeEnv(null),
      timeout: 20_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { version: /(\d+\.\d+\.\d+\S*)\s*\(Claude Code\)/.exec(output)?.[1] ?? null, output };
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string; message: string };
    return { version: null, output: `${failed.stdout ?? ''}${failed.stderr ?? ''}`.trim() || 'erro, sem saída' };
  }
}

function resolveClaude(): ClaudeResolution {
  const broken: string[] = [];
  for (const target of candidates()) {
    const command = fromTarget(target);
    if (!command) {
      if (/\.(c|m)?js$/i.test(target)) broken.push(`${target} precisa do Node.js instalado, e o Octo não o encontrou no PATH`);
      continue;
    }
    const { version, output } = probe(command);
    if (version) {
      const warning = broken.length
        ? `O comando \`claude\` do seu terminal está quebrado (${broken[0]}). O Octo está usando ${target}. Para consertar o terminal, reinstale o Claude Code com "npm install -g @anthropic-ai/claude-code".`
        : null;
      return { command, version, problem: null, warning, fingerprint: fingerprintOf(target), at: Date.now() };
    }
    broken.push(`${target} respondeu "${output.trim().split(/\r?\n/)[0]?.slice(0, 80) || 'nada'}" para --version`);
  }
  const override = overridePath();
  const problem = override && !broken.length
    ? WINDOWS && /\.(cmd|bat)$/i.test(override)
      ? `OCTO_CLAUDE_BIN aponta para ${override}, um atalho .cmd em que o Octo não achou o Claude Code. Aponte para o claude.exe.`
      : `OCTO_CLAUDE_BIN aponta para ${override}, que não existe.`
    : broken.length
      ? `O Claude Code instalado não está funcionando: ${broken[0]}. Uma atualização automática pode ter falhado. Feche os terminais com o Claude aberto e reinstale com "npm install -g @anthropic-ai/claude-code" (ou "claude install").`
      : NOT_FOUND;
  return { command: null, version: null, problem, warning: null, fingerprint: null, at: Date.now() };
}

let current = resolveClaude();

/**
 * O Claude Code em uso. O Octo fica aberto por dias e o Claude Code se atualiza sozinho:
 * se o arquivo escolhido mudar, ou se nenhum funcionava, procura de novo.
 */
export function claude(): ClaudeResolution {
  const changed = current.command ? fingerprintOf(current.command.display) !== current.fingerprint : Date.now() - current.at > 30_000;
  if (changed) current = resolveClaude();
  return current;
}

export function requireClaude(): ClaudeCommand {
  const { command, problem } = claude();
  if (!command) throw userError(problem ?? NOT_FOUND);
  return command;
}

export function checkAccountStatus(account: ClaudeAccount): Promise<AccountStatus> {
  const base: AccountStatus = {
    accountId: account.id,
    loggedIn: false,
    email: null,
    orgName: null,
    subscriptionType: null,
    authMethod: null,
    configDirectory: account.configDir,
    error: null,
    checkedAt: new Date().toISOString(),
  };
  const { command, problem } = claude();
  if (!command) return Promise.resolve({ ...base, error: problem ?? NOT_FOUND });

  return new Promise((resolve) => {
    try {
      execFile(
        command.command,
        [...command.prefixArgs, 'auth', 'status', '--json'],
        { env: claudeEnv(account), windowsHide: true, timeout: 20_000 },
        (error, stdout, stderr) => {
          // `auth status` sai com código ≠ 0 quando não há login, mas ainda imprime o JSON.
          try {
            const data = JSON.parse(stdout.toString());
            resolve({
              ...base,
              loggedIn: Boolean(data.loggedIn),
              email: data.email ?? null,
              orgName: data.orgName ?? null,
              subscriptionType: data.subscriptionType ?? null,
              authMethod: data.authMethod ?? null,
              configDirectory: data.configDirectory ?? account.configDir,
            });
          } catch {
            // Mostra o que o claude respondeu de fato, não só "Command failed".
            const said = `${stderr}\n${stdout}`.trim().split(/\r?\n/).find((line) => line.trim());
            resolve({
              ...base,
              error: said
                ? `Não foi possível verificar o login. O Claude Code respondeu: ${said.slice(0, 200)}`
                : error?.killed
                  ? 'Não foi possível verificar o login: o Claude Code não respondeu a tempo.'
                  : error
                    ? describeSpawnError(error, 'Não foi possível verificar o login')
                    : 'Não foi possível verificar o login: resposta inesperada do Claude Code.',
            });
          }
        },
      );
    } catch (error) {
      // Falhas síncronas do spawn (ex.: EINVAL) virariam uma rejeição sem tratamento.
      resolve({ ...base, error: describeSpawnError(error, 'Não foi possível verificar o login') });
    }
  });
}
