// Nomes curtos para os worktrees das issues (pasta e branch): os mesmos no servidor e na prévia da interface.

/** Tamanho máximo da branch, já com o identificador (ex.: red-7-api-typescript). */
const MAX_BRANCH = 30;

/** Palavras que não ajudam a reconhecer a issue no nome da branch: artigos, preposições e verbos genéricos de título. */
const SKIP = new Set([
  'a', 'o', 'as', 'os', 'um', 'uma', 'uns', 'umas', 'de', 'da', 'do', 'das', 'dos', 'em', 'na', 'no', 'nas', 'nos', 'ao', 'aos', 'e', 'ou',
  'que', 'com', 'sem', 'para', 'pra', 'pro', 'por', 'pelo', 'pela', 'se', 'sobre', 'entre', 'ate', 'mais', 'menos', 'muito', 'nao', 'este',
  'esta', 'esse', 'essa', 'isso', 'isto', 'seu', 'sua', 'quando', 'como', 'onde',
  'the', 'an', 'of', 'to', 'for', 'and', 'or', 'in', 'on', 'at', 'with', 'without', 'from', 'by', 'into', 'is', 'be', 'it', 'this', 'that',
  'atualizar', 'atualiza', 'atualizacao', 'ajustar', 'ajusta', 'ajuste', 'ajustes', 'corrigir', 'corrige', 'correcao', 'criar', 'cria',
  'adicionar', 'adiciona', 'implementar', 'implementa', 'implementacao', 'remover', 'remove', 'melhorar', 'melhora', 'melhoria', 'resolver',
  'resolve', 'revisar', 'revisa', 'fazer', 'faz', 'refatorar', 'refatora', 'mudar', 'muda', 'alterar', 'altera', 'trocar', 'troca', 'usar',
  'update', 'updates', 'fix', 'fixes', 'add', 'adds', 'implement', 'create', 'improve', 'refactor', 'change', 'use', 'make',
]);

/** Sem acentos, em minúsculas, só letras e números: "Criação" vira "criacao" (e não "cria-o"). */
function words(text: string): string[] {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** Nome de pasta a partir de um texto qualquer (ex.: a pasta do workspace), com até `max` caracteres. */
export function folderSlug(text: string, max = 24, fallback = 'workspace'): string {
  return words(text).join('-').slice(0, max).replace(/-+$/, '') || fallback;
}

/** Pasta do worktree da issue: o identificador em minúsculas (RED-7 → red-7). */
export function worktreeFolderName(identifier: string): string {
  return folderSlug(identifier, 24, 'issue');
}

/**
 * Branch do worktree: o identificador e até duas palavras do título que ajudam a reconhecer a issue,
 * com no máximo 30 caracteres. Ex.: "API: atualizar o TypeScript do redd-api de 4.6 para 5.9.3" na
 * RED-7 vira red-7-api-typescript. Se já existir, o servidor acrescenta -2, -3…
 */
export function worktreeBranchName(identifier: string, title: string): string {
  const base = worktreeFolderName(identifier);
  const own = new Set(base.split('-'));
  const picked: string[] = [];
  for (const word of words(title)) {
    if (picked.length === 2) break;
    if (word.length < 2 || /^\d+$/.test(word) || SKIP.has(word) || own.has(word) || picked.includes(word)) continue;
    const room = MAX_BRANCH - [base, ...picked].join('-').length - 1;
    if (room < 3) break;
    picked.push(word.slice(0, room));
  }
  return [base, ...picked].join('-');
}
