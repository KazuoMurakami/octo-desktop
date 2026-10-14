// Executado dentro da janela de terminal aberta pelo Octo.
// Lê um job JSON (cwd, env, comando) e roda o Claude Code de forma interativa.
// Usar um arquivo evita escapar prompts e caminhos com acentos na linha de comando do cmd.exe.
import { openSync, readFileSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const jobFile = process.argv[2];
const job = JSON.parse(readFileSync(jobFile, 'utf8'));
try {
  unlinkSync(jobFile);
} catch {}

const env = { ...process.env, ...job.env };
for (const key of job.unsetEnv ?? []) delete env[key];
// Usadas só para iniciar este script (ver terminal.ts); não devem chegar ao Claude.
for (const key of ['ELECTRON_RUN_AS_NODE', 'OCTO_NODE', 'OCTO_LAUNCHER', 'OCTO_JOB', 'OCTO_SCRIPT']) delete env[key];
// Este script roda com o NODE_OPTIONS vazio; o valor de verdade, se havia, veio no job.env.
if (!env.NODE_OPTIONS) delete env.NODE_OPTIONS;

if (job.banner) console.log(`\x1b[2m${job.banner}\x1b[0m\n`);

/**
 * No Windows, o executável do app desktop rodando como Node se liga ao console para escrever,
 * mas não recebe o teclado como entrada; sem isso o Claude interativo não funciona.
 * Abrir o CONIN$ entrega ao Claude a entrada do console diretamente.
 */
function consoleInput() {
  if (process.platform !== 'win32' || process.stdin.isTTY) return 'inherit';
  try {
    return openSync('\\\\.\\CONIN$', 'r+');
  } catch {
    return 'inherit';
  }
}

/** O motivo em português (em vez de "spawnSync … ENOENT"). */
function describe(error) {
  switch (error.code) {
    case 'ENOENT':
      return `o Claude Code não foi encontrado em ${job.command}, ou a pasta ${job.cwd} não existe mais.`;
    case 'EACCES':
    case 'EPERM':
      return `sem permissão para executar ${job.command}.`;
    case 'ENAMETOOLONG':
    case 'E2BIG':
      return 'a linha de comando ficou longa demais para o sistema (texto da issue grande demais).';
    default:
      return error.message;
  }
}

const result = spawnSync(job.command, job.args, { stdio: [consoleInput(), 'inherit', 'inherit'], cwd: job.cwd, env });
if (result.error) {
  console.error(`\nNão foi possível iniciar o Claude Code: ${describe(result.error)}`);
  process.exit(1);
}
process.exit(result.status ?? 0);
