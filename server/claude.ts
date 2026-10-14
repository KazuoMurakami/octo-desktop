import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { AccountStatus, ClaudeAccount } from '../shared/types.ts';

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
  const env = { ...process.env };
  for (const key of SESSION_ENV) delete env[key];
  delete env.CLAUDE_CONFIG_DIR;
  delete env.ELECTRON_RUN_AS_NODE;
  if (account?.configDir) env.CLAUDE_CONFIG_DIR = account.configDir;
  return env;
}

const NOT_FOUND = 'Claude Code não encontrado. Instale-o (docs.claude.com/en/docs/claude-code/setup) e reabra o Octo, ou defina OCTO_CLAUDE_BIN.';

function which(command: string): string[] {
  try {
    return execFileSync(process.platform === 'win32' ? 'where' : 'which', [command], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
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
 * Executáveis candidatos, em ordem. No Windows o `claude` do npm é um .cmd (que exigiria
 * cmd.exe e escaping frágil), então seguimos o shim até o binário real. Para cada instalação
 * via npm, o binário nativo da plataforma também entra: se a atualização automática deixar o
 * `bin/claude.exe` quebrado, ele ainda funciona.
 */
function candidates(): string[] {
  const override = process.env.OCTO_CLAUDE_BIN;
  if (override) return [override];
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
  for (const found of which('claude')) {
    const lower = found.toLowerCase();
    if (process.platform !== 'win32') add(found);
    else if (lower.endsWith('.exe')) add(found);
    else if (lower.endsWith('.cmd')) {
      try {
        const match = /"%dp0%\\([^"]+\.(?:exe|js|cjs|mjs))"/i.exec(readFileSync(found, 'utf8'));
        if (match) add(path.join(path.dirname(found), match[1]));
      } catch {
        /* shim ilegível */
      }
    }
  }
  list.push(...knownLocations());
  const seen = new Set<string>();
  return list.filter((target) => {
    const key = process.platform === 'win32' ? path.resolve(target).toLowerCase() : path.resolve(target);
    if (seen.has(key) || !existsSync(target)) return false;
    seen.add(key);
    return true;
  });
}

function fromTarget(target: string): ClaudeCommand | null {
  if (/\.(c|m)?js$/i.test(target)) {
    // Instalações antigas via npm são um script: precisam de um Node de verdade, não do executável do app.
    const node = process.versions.electron ? which('node')[0] : process.execPath;
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
    if (!command) continue;
    const { version, output } = probe(command);
    if (version) {
      const warning = broken.length
        ? `O comando \`claude\` do seu terminal está quebrado (${broken[0]}). O Octo está usando ${target}. Para consertar o terminal, reinstale o Claude Code com "npm install -g @anthropic-ai/claude-code".`
        : null;
      return { command, version, problem: null, warning, fingerprint: fingerprintOf(target), at: Date.now() };
    }
    broken.push(`${target} respondeu "${output.trim().split(/\r?\n/)[0]?.slice(0, 80) || 'nada'}" para --version`);
  }
  const problem = broken.length
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
  if (!command) throw new Error(problem ?? NOT_FOUND);
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
          resolve({ ...base, error: said ? `claude auth status: ${said.slice(0, 200)}` : (error?.message.split('\n')[0] ?? 'Resposta inesperada do claude auth status.') });
        }
      },
    );
  });
}
