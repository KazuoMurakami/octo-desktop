// Regras das ações bloqueadas que a pessoa libera numa resposta (vão no permissions.allow do --settings).
// A mesma classificação no servidor, que recusa as que valeriam para qualquer comando, e no painel de
// permissões, que só deixa marcadas de saída as que liberam apenas o que foi bloqueado.

/** Por que uma regra valeria para qualquer comando: sem comando, com o * no lugar do programa, ou é o Monitor. */
export type RefusedReason = 'empty' | 'program' | 'monitor';

/**
 * O que uma regra libera:
 * - refused: qualquer comando (ver refusedReason); o servidor recusa;
 * - wildcard: Bash/PowerShell com "*", que vale também para outros comandos além do bloqueado;
 * - whole-tool: só o nome da ferramenta (ex.: WebFetch, Write, mcp__servidor__ferramenta), todo uso dela na execução;
 * - scoped: só o que foi bloqueado (ex.: Bash(npm test), WebFetch(domain:exemplo.com)).
 */
export type RuleKind = 'refused' | 'wildcard' | 'whole-tool' | 'scoped';

/** Bash ou PowerShell, sozinhos ou com o comando entre parênteses (o nome sem diferenciar maiúsculas). */
const SHELL_RULE = /^(?:Bash|PowerShell)(?:\(([\s\S]*)\))?$/i;

/**
 * Uma regra que liberaria qualquer comando, apesar de às vezes parecer um comando só: Bash ou PowerShell
 * sozinhos (a ferramenta inteira), sem comando ou com um curinga na primeira palavra ("Bash(*)",
 * "Bash(* --version)", "Bash(/*)"), e o Monitor em qualquer forma: ele roda o comando pelo shell, com as
 * regras do Bash, então a regra certa para ele é a do comando, Bash(...). Null nas outras.
 */
export function refusedReason(rule: string): RefusedReason | null {
  if (/^Monitor(?:\(|$)/i.test(rule)) return 'monitor';
  const shell = SHELL_RULE.exec(rule);
  if (!shell) return null;
  // "npm:*" é a forma antiga de "npm *": o curinga do fim não conta como parte do programa.
  const program = (shell[1] ?? '').replace(/:\*$/, '').trim().split(/\s/)[0];
  if (!program) return 'empty';
  return program.includes('*') ? 'program' : null;
}

export function ruleKind(rule: string): RuleKind {
  if (refusedReason(rule)) return 'refused';
  // Nas regras do Claude Code o * vale por qualquer texto, inclusive espaços: "Bash(rm *.log)" libera também
  // "rm -rf ~/projeto/a.log", e "Bash(sh -c *)", qualquer comando.
  if (SHELL_RULE.exec(rule)?.[1]?.includes('*')) return 'wildcard';
  return rule.includes('(') ? 'scoped' : 'whole-tool';
}
