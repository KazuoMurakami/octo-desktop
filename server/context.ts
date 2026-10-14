import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Repo, Workspace } from '../shared/types.ts';

const START = '<!-- octo:workspace:start -->';
const END = '<!-- octo:workspace:end -->';
/** Marcadores gravados quando o app ainda se chamava Nexo: o bloco antigo é reconhecido e substituído. */
const MARKERS = [[START, END], ['<!-- nexo:workspace:start -->', '<!-- nexo:workspace:end -->']] as const;

function findBlock(content: string): { start: number; end: number } | null {
  for (const [open, close] of MARKERS) {
    const start = content.indexOf(open);
    const end = content.indexOf(close);
    if (start !== -1 && end > start) return { start, end: end + close.length };
  }
  return null;
}

/**
 * Bloco gerenciado do CLAUDE.md de uma pasta que agrupa repositórios (a raiz ou um grupo).
 * Qualquer `claude` aberto nessa pasta (pelo Octo ou pelo seu "cmd → claude" de sempre)
 * passa a enxergar o mapa dos repositórios.
 */
export function renderContextBlock(workspace: Workspace, dir: string, repos: Repo[]): string {
  const atRoot = path.resolve(dir) === path.resolve(workspace.rootPath);
  const rows = repos.map((repo) => {
    const where = `\`./${path.relative(dir, repo.absPath).split(path.sep).join('/')}\``;
    const scripts = repo.scripts.filter((s) => /^(dev|start|build|test|lint|typecheck)$/.test(s));
    const run = scripts.length ? scripts.map((s) => `\`${repo.packageManager ?? 'npm'} run ${s}\``).join(' ') : '—';
    return `| ${repo.name} | ${where} | ${repo.stack.slice(0, 4).join(', ') || '—'} | ${repo.branch ?? '—'} | ${run} |`;
  });
  const notes = repos
    .filter((repo) => repo.description || repo.hasClaudeMd || repo.hasAgentsMd)
    .map((repo) => {
      const guides = [repo.hasClaudeMd && 'CLAUDE.md', repo.hasAgentsMd && 'AGENTS.md'].filter(Boolean).join(' e ');
      return `- **${repo.name}**${repo.description ? `: ${repo.description}` : ''}${guides ? ` _(tem ${guides} próprio — leia antes de mexer)_` : ''}`;
    });

  return [
    START,
    `# Workspace ${workspace.name}${atRoot ? '' : ` · ${path.basename(dir)}`}`,
    '',
    `Esta pasta **não é um repositório único**: ela agrupa ${repos.length} repositórios git independentes.`,
    'Você está aqui para ter o contexto de todos eles ao mesmo tempo.',
    '',
    '## Regras',
    '- Cada subpasta abaixo tem o próprio git. Rode comandos git dentro dela (`git -C <repo> ...`); nunca rode `git init` nesta pasta.',
    '- Instale dependências e rode scripts dentro da pasta do repositório correspondente.',
    '- Mudanças que atravessam repositórios devem ser feitas e descritas por repositório.',
    '- Não faça commit, push ou operações destrutivas sem pedido explícito.',
    '',
    '## Repositórios',
    '| Repo | Caminho | Stack | Branch | Scripts |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    ...(notes.length ? ['', '## Sobre cada repositório', ...notes] : []),
    ...(workspace.guidance.trim() ? ['', '## Diretrizes do workspace', workspace.guidance.trim()] : []),
    '',
    `_Gerado pelo Octo em ${new Date().toLocaleString('pt-BR')}. Edite fora deste bloco; ele é substituído ao regenerar._`,
    END,
  ].join('\n');
}

export function readContextStatus(dir: string) {
  const file = path.join(dir, 'CLAUDE.md');
  const exists = existsSync(file);
  const content = exists ? readFileSync(file, 'utf8') : '';
  return { file, exists, managed: findBlock(content) !== null };
}

export function writeContext(workspace: Workspace, dir: string, repos: Repo[]): string {
  const file = path.join(dir, 'CLAUDE.md');
  const block = renderContextBlock(workspace, dir, repos);
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const found = findBlock(current);
  const next =
    found
      ? current.slice(0, found.start) + block + current.slice(found.end)
      : current.trim()
        ? `${current.trimEnd()}\n\n${block}\n`
        : `${block}\n`;
  writeFileSync(file, next);
  return file;
}
