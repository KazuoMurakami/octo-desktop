// Regras das ações bloqueadas que a pessoa libera numa resposta (vão no permissions.allow do --settings).
// A mesma classificação no servidor, que recusa as que o Octo não libera, e no painel de permissões, que só deixa
// marcadas de saída as que liberam apenas o que foi bloqueado. E a divisão de um comando do Bash nas partes que o
// Claude Code confere uma a uma, com que o servidor monta as regras de um comando encadeado.

import type { PermissionDenial } from './types.ts';

/**
 * Por que o Octo não libera uma regra. Valeria para qualquer comando: sem comando ('empty'), com o * no lugar do
 * programa ('program'), ou é o Monitor ('monitor'). Valeria para qualquer site: o domínio do WebFetch só com curingas
 * ('domain'). Ou é um comando com partes que o Claude Code confere uma a uma, e uma regra com ele inteiro não vale
 * para nenhuma delas ('compound', ver bashParts).
 */
export type RefusedReason = 'empty' | 'program' | 'monitor' | 'domain' | 'compound';

/**
 * O que uma regra libera:
 * - refused: o Octo não libera (ver refusedReason); o servidor recusa;
 * - wildcard: com "*", que vale também para outros comandos, endereços ou arquivos além do bloqueado;
 * - whole-tool: só o nome da ferramenta (ex.: WebFetch, Write, mcp__servidor__ferramenta), todo uso dela na execução;
 * - scoped: só o que foi bloqueado (ex.: Bash(npm test), WebFetch(domain:exemplo.com)).
 */
export type RuleKind = 'refused' | 'wildcard' | 'whole-tool' | 'scoped';

/** Bash ou PowerShell, sozinhos ou com o comando entre parênteses (o nome sem diferenciar maiúsculas). */
const SHELL_RULE = /^(?:Bash|PowerShell)(?:\(([\s\S]*)\))?$/i;

/**
 * Uma regra que o Octo não libera, apesar de às vezes parecer um comando só: Bash ou PowerShell sozinhos (a
 * ferramenta inteira), sem comando ou com um curinga no lugar do programa ("Bash(*)", "Bash(* --version)",
 * "Bash(/*)", e também depois do que o Claude Code tira antes de conferir: "Bash(timeout 30 *)",
 * "Bash(NODE_ENV=test *)"), o Monitor em qualquer forma (ele roda o comando pelo shell, com as regras do Bash, então
 * a regra certa para ele é a do comando, Bash(...)), o WebFetch para qualquer site, e um comando com mais de uma
 * parte, ou com algo que a divisão daqui não modela (ver bashParts). Null nas outras.
 */
export function refusedReason(rule: string): RefusedReason | null {
  if (/^Monitor(?:\(|$)/i.test(rule)) return 'monitor';
  const shell = SHELL_RULE.exec(rule);
  if (!shell) return anyDomain(rule) ? 'domain' : null;
  // "npm:*" é a forma antiga de "npm *": o curinga do fim não conta como parte do programa.
  const program = /^\S*/.exec((shell[1] ?? '').replace(/:\*$/, '').trimStart())![0];
  if (!program) return 'empty';
  if (program.includes('*')) return 'program';
  if (/^PowerShell/i.test(rule)) return powerShellParts(shell[1]) ? 'compound' : null;
  const command = shell[1].replace(/:\*$/, ' *');
  // Uma parte só e nada depois dela (um ; ou & no fim também separa): o Claude Code confere o comando como ele está.
  const part = splitBash(command, 1)?.[0];
  if (!part || /[;&]/.test(command.slice(part.end))) return 'compound';
  // Com formas demais (variáveis de ambiente demais no começo), bashParts também deixa o comando numa regra só.
  const found = walk(command, part);
  if (!found || found.starts.length > MAX_RULES) return 'compound';
  return found.wild || found.program?.includes('*') ? 'program' : null;
}

export function ruleKind(rule: string): RuleKind {
  if (refusedReason(rule)) return 'refused';
  const open = rule.indexOf('(');
  const content = open < 0 ? '' : rule.slice(open + 1).replace(/\)$/, '');
  // Sem nada entre os parênteses, a regra vale para todo uso da ferramenta, como só o nome dela.
  if (!content.trim()) return 'whole-tool';
  // O * vale por qualquer texto: nas regras do Bash, inclusive espaços ("Bash(rm *.log)" libera também
  // "rm -rf ~/projeto/a.log", e "Bash(sh -c *)", qualquer comando); nas outras, outros domínios ou caminhos
  // ("WebFetch(domain:*.exemplo.com)", "Read(/**)").
  return content.includes('*') ? 'wildcard' : 'scoped';
}

/** WebFetch para qualquer site: o domínio só com curingas e pontos ("domain:*", "*.*"). */
function anyDomain(rule: string): boolean {
  const fetch = /^WebFetch\(([\s\S]*)\)$/i.exec(rule);
  const domain = fetch ? fetch[1].trim().replace(/^domain:/i, '').trim() : '';
  return domain.includes('*') && /^[*.]+$/.test(domain);
}

/**
 * Um comando do PowerShell com mais de uma parte, que o Claude Code confere uma a uma: ;, |, &&, || ou uma quebra de
 * linha fora de aspas (nas simples, '' é uma aspa; nas duplas, "" também, e ` escapa o próximo caractere). Aspas sem
 * fechar contam como partes, por não dar para saber. O Octo não divide o PowerShell: libera o comando só inteiro.
 */
function powerShellParts(command: string): boolean {
  const text = command.trim();
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '`') {
      i++; // o próximo caractere vale como ele mesmo (no fim da linha, ela continua na seguinte)
    } else if (char === "'" || char === '"') {
      let j = i + 1;
      for (; j < text.length; j++) {
        if (char === '"' && text[j] === '`') j++;
        else if (text[j] === char) {
          if (text[j + 1] !== char) break;
          j++;
        }
      }
      if (j >= text.length) return true;
      i = j;
    } else if (char === ';' || char === '|' || char === '\n' || char === '\r' || (char === '&' && text[i + 1] === '&')) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------- comandos do Bash

/**
 * Até quantas regras um comando bloqueado vira (uma por parte, mais as formas sem as variáveis de ambiente do
 * começo). Acima disso ele fica numa regra só, que o painel mostra recusada: aí é melhor seguir no terminal.
 */
const MAX_RULES = 12;

/** Quantas palavras do começo de cada parte ficam guardadas (ver Part.words). */
const LEAD_WORDS = 64;

/** Uma palavra do comando, pela posição no texto; num redirecionamento ("> saida.log", "2>&1"), o operador e o alvo. */
interface Word {
  start: number;
  end: number;
  redirect: boolean;
}

/** Uma parte do comando, entre separadores. */
interface Part {
  /** O fim da última palavra. */
  end: number;
  /** As primeiras palavras: bastam para achar as variáveis de ambiente, os wrappers e o programa. */
  words: Word[];
  /** A parte tem mais palavras do que as guardadas. */
  more: boolean;
}

/**
 * As regras de um comando do Bash bloqueado, como o Claude Code o confere (o conteúdo de cada Bash(...)): uma por
 * parte, nos separadores &&, ||, ;, |, |&, & e nas quebras de linha, e sem os wrappers que ele tira antes de
 * conferir (timeout 30, time, nice -n 10, nohup, stdbuf -oL, command, builtin, noglob e o xargs sem opções). Com uma
 * variável de ambiente no começo (NODE_ENV=test npm test), vão as duas formas, com e sem ela: o Claude Code só tira
 * as que sabe seguras, e as duas liberam só o que foi bloqueado. Null quando o comando tem algo que a divisão não
 * modela (ver splitBash) ou partes demais: ele fica numa regra só, que o painel mostra recusada (ver refusedReason).
 */
export function bashParts(command: string): string[] | null {
  const parts = splitBash(command, MAX_RULES);
  if (!parts) return null;
  const rules = new Set<string>();
  for (const part of parts) {
    const found = walk(command, part);
    if (!found) return null;
    for (const start of found.starts) rules.add(command.slice(part.words[start].start, part.end));
    if (rules.size > MAX_RULES) return null;
  }
  return [...rules];
}

/** O que termina uma palavra fora de aspas: espaço, tab, quebra de linha e os operadores do shell. */
const WORD_END = new Set([' ', '\t', '\n', ';', '&', '|', '<', '>', '(', ')']);

/**
 * Divide um comando do Bash nas partes que o Claude Code confere uma a uma: nos separadores &&, ||, ;, |, |&, & e nas
 * quebras de linha fora de aspas. Um redirecionamento (>, >>, <, 2>&1, &>, >|, <&...) fica na parte dele. Null com
 * mais de `max` partes, ou com algo que a divisão não modela com segurança: aspas sem fechar, substituição de
 * comando ($( ) e crases, também entre aspas duplas), substituição de processo, subshells e grupos com ( ), here-docs,
 * comentários, uma parte vazia ou um &&, ||, | no fim (aí o Claude Code nem divide o comando). Os grupos com { } e
 * as estruturas como if e for ficam para walk, que olha o lugar do programa. Uma passada só pelo texto: o tempo
 * cresce em linha com o tamanho do comando.
 */
function splitBash(text: string, max: number): Part[] | null {
  const parts: Part[] = [];
  let part: Part | null = null;
  /** Depois de &&, ||, | e |&, o comando tem de continuar (pode ser na linha seguinte). */
  let open = false;
  /** Onde começa um redirecionamento esperando o alvo (a próxima palavra); -1 sem nenhum. */
  let redirect = -1;
  const add = (start: number, end: number, isRedirect: boolean) => {
    if (!part) part = { end, words: [], more: false };
    part.end = end;
    if (part.words.length < LEAD_WORDS) part.words.push({ start, end, redirect: isRedirect });
    else part.more = true;
    open = false;
  };
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    const next = text[i + 1];
    if (char === ' ' || char === '\t') {
      i++;
    } else if (char === '\\' && next === '\n') {
      i += 2; // continua na linha seguinte
    } else if (redirect >= 0) {
      // O alvo: uma palavra, e não um operador, um comentário ou o fim da linha.
      const end = WORD_END.has(char) || char === '#' ? -1 : wordEnd(text, i);
      if (end < 0) return null;
      add(redirect, end, true);
      redirect = -1;
      i = end;
    } else if (char === '\n' || char === ';' || char === '|' || (char === '&' && next !== '>')) {
      // &&, ||, | e |& pedem outro comando depois; ;, & e a quebra de linha podem terminar o comando.
      const pair = (char === '&' && next === '&') || (char === '|' && (next === '|' || next === '&'));
      i += pair ? 2 : 1;
      if (!part) {
        // Sem comando antes: só uma quebra de linha passa (uma linha em branco, ou o resto depois de um && ou |).
        if (char !== '\n') return null;
        continue;
      }
      parts.push(part);
      part = null;
      if (parts.length > max) return null;
      open = pair || char === '|';
    } else if (char === '<' || char === '>' || char === '&') {
      const length = redirection(text, i);
      if (!length) return null;
      redirect = i;
      i += length;
    } else if (char === '(' || char === ')' || char === '#') {
      return null;
    } else {
      const end = wordEnd(text, i);
      if (end < 0) return null;
      if ((text[end] === '<' || text[end] === '>') && digits(text, i, end)) {
        // Só algarismos colados num < ou >: o descritor do redirecionamento ("2>&1", "2>erros.log").
        const length = redirection(text, end);
        if (!length) return null;
        redirect = i;
        i = end + length;
      } else {
        add(i, end, false);
        i = end;
      }
    }
  }
  if (redirect >= 0) return null;
  if (part) {
    parts.push(part);
    if (parts.length > max) return null;
  } else if (open || !parts.length) {
    return null;
  }
  return parts;
}

/** Só algarismos de `start` a `end`. */
function digits(text: string, start: number, end: number): boolean {
  for (let k = start; k < end; k++) {
    const code = text.charCodeAt(k);
    if (code < 48 || code > 57) return false;
  }
  return end > start;
}

/**
 * O tamanho do operador de redirecionamento em `i` (<, >, >>, <&, >&, <>, >|, &>, &>>), ou 0 nos que a divisão não
 * modela: here-docs e here-strings (<<, <<<) e a substituição de processo (<( e >().
 */
function redirection(text: string, i: number): number {
  const char = text[i];
  const next = text[i + 1];
  if (char === '&') return text[i + 2] === '>' ? 3 : 2;
  if (next === '(' || (char === '<' && next === '<')) return 0;
  if (char === '<') return next === '&' || next === '>' ? 2 : 1;
  return next === '>' || next === '&' || next === '|' ? 2 : 1;
}

/**
 * O fim da palavra que começa em `i`, com as aspas e os escapes do Bash, ou -1 quando ela tem algo que a divisão não
 * modela: aspas sem fechar, substituição de comando ($( ) e crases), aritmética ($[ ]), as aspas $'...' e $"...", ou
 * um ${...} com aspas, escapes ou outras expansões dentro.
 */
function wordEnd(text: string, i: number): number {
  while (i < text.length && !WORD_END.has(text[i])) {
    const char = text[i];
    if (char === '\\') {
      // O próximo caractere vale como ele mesmo (uma quebra de linha escapada continua a linha); sem nenhum, não modela.
      if (i + 1 >= text.length) return -1;
      i += 2;
    } else if (char === "'") {
      const close = text.indexOf("'", i + 1);
      if (close < 0) return -1;
      i = close + 1;
    } else if (char === '"') {
      i = quotedEnd(text, i + 1);
      if (i < 0) return -1;
    } else if (char === '`') {
      return -1;
    } else if (char === '$') {
      i = dollarEnd(text, i, false);
      if (i < 0) return -1;
    } else {
      i++;
    }
  }
  return i;
}

/** Depois das aspas duplas que fecham as abertas antes de `i` (\ escapa o próximo caractere), ou -1. */
function quotedEnd(text: string, i: number): number {
  while (i < text.length) {
    const char = text[i];
    if (char === '"') return i + 1;
    if (char === '`') return -1;
    if (char === '\\') {
      i += 2;
    } else if (char === '$') {
      i = dollarEnd(text, i, true);
      if (i < 0) return -1;
    } else {
      i++;
    }
  }
  return -1;
}

/**
 * Depois de um $ em `i`. $NOME e ${NOME} (também ${NOME:-padrão} e outras formas, sem aspas, escapes nem outras
 * expansões dentro) ficam na palavra; $( ), $[ ] e, fora de aspas, $'...' e $"..." não são modelados (-1).
 */
function dollarEnd(text: string, i: number, quoted: boolean): number {
  const next = text[i + 1];
  if (next === '(' || next === '[' || (!quoted && (next === "'" || next === '"'))) return -1;
  if (next !== '{') return i + 1;
  for (let j = i + 2; j < text.length; j++) {
    const char = text[j];
    if (char === '}') return j + 1;
    if (char === "'" || char === '"' || char === '\\' || char === '`' || char === '$' || char === '{' || char === '\n') return -1;
  }
  return -1;
}

/** Uma variável de ambiente antes do comando (NOME=valor). */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Palavras que, no lugar do programa, abrem ou fecham estruturas do shell (condições, laços, funções, grupos). */
const KEYWORDS = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'select', 'function', 'coproc',
  '{', '}', '!', '[[', ']]',
]);

/** O começo de uma parte do comando, como o Claude Code o lê antes de conferir as regras. */
interface Walk {
  /** Onde começa cada forma da parte que vira regra: ela inteira e sem cada variável de ambiente, já sem os wrappers. */
  starts: number[];
  /** O programa, depois das variáveis de ambiente, dos wrappers e dos redirecionamentos (null se não tiver). */
  program: string | null;
  /** Um * antes do programa (o * de uma regra vale por qualquer texto), ou depois de um wrapper que não deu para ler. */
  wild: boolean;
}

/**
 * Percorre o começo de uma parte como o Claude Code antes de conferir as regras: tira as variáveis de ambiente do
 * começo (ele só tira as que sabe seguras, e não dá para saber quais: ficam as formas com e sem cada uma) e os
 * wrappers (ver unwrap). Um redirecionamento no caminho para tudo: a parte fica como está. Null quando o programa é
 * uma palavra como if, for ou { (uma estrutura do shell, que a divisão não modela), ou quando ele fica além das
 * palavras guardadas.
 */
function walk(text: string, part: Part): Walk | null {
  const { words } = part;
  const raw = (index: number) => text.slice(words[index].start, words[index].end);
  const starts = [0];
  let forms = true;
  let wild = false;
  let i = 0;
  while (i < words.length) {
    // Perto do fim das palavras guardadas de uma parte comprida, não dá para saber onde fica o programa.
    if (part.more && i >= words.length - 8) return null;
    const word = raw(i);
    if (words[i].redirect) {
      forms = false;
      wild ||= word.includes('*');
      i++;
      continue;
    }
    if (ASSIGNMENT.test(word)) {
      wild ||= word.includes('*');
      i++;
      // A forma sem ela, se depois vier o comando (e não só um redirecionamento, ou nada).
      if (forms && i < words.length && !words[i].redirect) starts.push(i);
      continue;
    }
    const inner = unwrap(text, part, i);
    if (typeof inner === 'number') {
      for (let k = i; k < inner; k++) wild ||= raw(k).includes('*');
      // Só a forma sem variáveis de ambiente perde o wrapper: o Claude Code não tira um wrapper depois de uma variável que ficou.
      if (forms) starts[starts.length - 1] = inner;
      i = inner;
      continue;
    }
    if (KEYWORDS.has(word)) return null;
    // Um wrapper com uma opção que esta leitura não conhece: o programa pode ser qualquer palavra depois dele.
    if (inner === 'unknown') wild ||= text.slice(words[i].start, part.end).includes('*');
    return { starts, program: word, wild };
  }
  // Sem programa (só variáveis de ambiente ou redirecionamentos, como "FOO=1 BAR=2"): a parte fica como está.
  return part.more ? null : { starts: starts.slice(0, 1), program: null, wild };
}

/** A duração do timeout: 30, 1.5, 30s, 5m, 1h, 2d. */
const DURATION = /^\d+(?:\.\d+)?[smhd]?$/;

/**
 * Os wrappers que o Claude Code tira antes de conferir as regras (o xargs fica à parte, ver unwrap), com as opções
 * que esta leitura conhece: as sozinhas ou com o valor colado (flag, como -k5 e --signal=KILL) e as com o valor na
 * palavra seguinte (valued, como -k 5; value confere o valor). O timeout pede a duração antes do comando, o stdbuf
 * pede ao menos uma opção, e dashes aceita o "--" que encerra as opções.
 */
const WRAPPERS = new Map<string, { flag?: RegExp; valued?: RegExp; value?: RegExp; duration?: true; needsOption?: true; dashes?: true }>([
  ['timeout', {
    flag: /^(?:-v|--verbose|--foreground|--preserve-status|-[ks].+|--(?:kill-after|signal)=.+)$/,
    valued: /^(?:-[ks]|--(?:kill-after|signal))$/,
    duration: true,
    dashes: true,
  }],
  ['time', { flag: /^-p$/, dashes: true }],
  ['nice', { flag: /^(?:--?\d+|-n[+-]?\d+|--adjustment=[+-]?\d+)$/, valued: /^(?:-n|--adjustment)$/, value: /^[+-]?\d+$/, dashes: true }],
  ['nohup', { dashes: true }],
  ['stdbuf', { flag: /^(?:-[ioe].+|--(?:input|output|error)=.+)$/, valued: /^(?:-[ioe]|--(?:input|output|error))$/, needsOption: true, dashes: true }],
  ['command', { flag: /^-p$/, dashes: true }],
  ['builtin', { dashes: true }],
  ['noglob', {}],
]);

/**
 * Depois de um wrapper que o Claude Code tira antes de conferir as regras, com as opções dele: onde começa o comando
 * que ele roda. 'keep' quando a palavra é o próprio programa: outro programa, o xargs com opções (o Claude Code o
 * confere como um xargs), o command -v (que só procura o comando, sem rodar) ou um wrapper sem nada depois.
 * 'unknown' quando o wrapper tem uma opção que esta leitura não conhece (ou um redirecionamento no meio).
 */
function unwrap(text: string, part: Part, i: number): number | 'keep' | 'unknown' {
  const { words } = part;
  // A palavra em `index`: o texto, '' num redirecionamento e null depois da última guardada.
  const at = (index: number): string | null =>
    index >= words.length ? null : words[index].redirect ? '' : text.slice(words[index].start, words[index].end);
  // Acabaram as palavras: o wrapper é o próprio programa, a não ser que a parte tenha mais do que as guardadas.
  const done = part.more ? 'unknown' : 'keep';
  const name = at(i) ?? '';
  if (name === 'xargs') {
    const next = at(i + 1);
    if (next === null) return done;
    return next === '' ? 'unknown' : next.startsWith('-') ? 'keep' : i + 1;
  }
  const wrapper = WRAPPERS.get(name);
  if (!wrapper) return 'keep';
  let j = i + 1;
  let options = 0;
  for (;;) {
    const word = at(j);
    if (word === null) return done;
    if (word === '') return 'unknown';
    if (word === '--' && wrapper.dashes) {
      j++;
      break;
    }
    if (name === 'command' && /^-[pvV]+$/.test(word) && /[vV]/.test(word)) return 'keep';
    if (wrapper.flag?.test(word)) {
      j++;
      options++;
    } else if (wrapper.valued?.test(word)) {
      const value = at(j + 1);
      if (value === null) return done;
      if (value === '' || (wrapper.value && !wrapper.value.test(value))) return 'unknown';
      j += 2;
      options++;
    } else if (word.startsWith('-')) {
      return 'unknown';
    } else {
      break;
    }
  }
  if (wrapper.needsOption && !options) return 'unknown';
  if (wrapper.duration) {
    const duration = at(j);
    if (duration === null) return done;
    if (!DURATION.test(duration)) return 'unknown';
    j++;
  }
  const inner = at(j);
  if (inner === null) return done;
  return inner === '' || inner.startsWith('-') ? 'unknown' : j;
}

// ---------------------------------------------------------------- ações bloqueadas

/** Os campos da ação que dizem o que foi bloqueado: o comando, o endereço, o arquivo ou a busca. */
export const BLOCKED_KEYS = ['command', 'url', 'file_path', 'notebook_path', 'path', 'query'];

/** O que foi bloqueado numa ação: o primeiro desses campos com texto, se ela tiver. */
export function blockedValue(input: Record<string, unknown>): string | null {
  for (const key of BLOCKED_KEYS) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

/** Uma ação bloqueada e as regras que a liberam (um comando encadeado tem uma regra por parte). */
export interface BlockedAction {
  tool: string;
  /** O que foi bloqueado (ver blockedValue). */
  value: string | null;
  rules: string[];
}

/**
 * As ações bloqueadas de uma sessão, na ordem. As entradas com a mesma ferramenta e o mesmo bloqueado são da mesma
 * ação (o servidor grava uma entrada por regra, e as partes de um comando vêm com a mesma ação), e o agente repetir a
 * mesma ação conta uma vez.
 */
export function blockedActions(denials: PermissionDenial[]): BlockedAction[] {
  const actions = new Map<string, BlockedAction>();
  for (const denial of denials) {
    const value = blockedValue(denial.input ?? {});
    const key = `${denial.tool}\u0000${value ?? JSON.stringify(denial.input ?? {})}`;
    let action = actions.get(key);
    if (!action) actions.set(key, (action = { tool: denial.tool, value, rules: [] }));
    if (!action.rules.includes(denial.rule)) action.rules.push(denial.rule);
  }
  return [...actions.values()];
}
