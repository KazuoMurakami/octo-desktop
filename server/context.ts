import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Repo, Workspace } from '../shared/types.ts';
import { HttpError } from './model.ts';

const START = '<!-- octo:workspace:start -->';
const END = '<!-- octo:workspace:end -->';
/** Marcadores gravados quando o app ainda se chamava Nexo: o bloco antigo é reconhecido e substituído. */
const MARKERS = [[START, END], ['<!-- nexo:workspace:start -->', '<!-- nexo:workspace:end -->']] as const;
const ALL_MARKERS = MARKERS.flat();

/** Um marcador do bloco no CLAUDE.md, como a interface o mostra quando o arquivo precisa ser corrigido à mão. */
export interface ContextMarker {
  /** Linha do arquivo, a partir de 1. */
  line: number;
  marker: string;
  family: 'octo' | 'nexo';
  kind: 'start' | 'end';
}

interface Found extends ContextMarker {
  /** Onde o marcador começa e acaba no texto do arquivo. */
  from: number;
  to: number;
}

interface Fence {
  char: string;
  length: number;
}

/** Linha que abre um bloco de código cercado (``` ou ~~~, com ou sem a linguagem), como no Markdown. */
function opens(line: string): Fence | null {
  const match = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(line);
  // Com crases, o que vem depois não pode ter outra crase: ```a``` é código no meio da linha, e não uma cerca.
  if (!match || (match[1][0] === '`' && match[2].includes('`'))) return null;
  return { char: match[1][0], length: match[1].length };
}

/** Linha que só tem uma cerca (ela fecha uma aberta com o mesmo caractere e no máximo o mesmo tamanho). */
function closer(line: string): Fence | null {
  const match = /^[ \t]*(`{3,}|~{3,})[ \t]*$/.exec(line);
  return match ? { char: match[1][0], length: match[1].length } : null;
}

const closes = (line: string, fence: Fence): boolean => {
  const end = closer(line);
  return end !== null && end.char === fence.char && end.length >= fence.length;
};

/** O marcador com que a linha começa (depois de espaços, tabs ou da marca de UTF-8 no começo do arquivo). */
function markerAt(line: string): { marker: string; lead: number } | null {
  const lead = /^[ \t\uFEFF]*/.exec(line)![0].length;
  const marker = ALL_MARKERS.find((m) => line.startsWith(m, lead));
  return marker ? { marker, lead } : null;
}

/**
 * Os marcadores do bloco que contam: os que começam uma linha, como o Octo sempre os grava, fora de blocos de
 * código. Um marcador citado no meio de uma frase, ou num exemplo entre ``` ou ~~~, é só texto. Uma cerca que
 * nunca fecha não abre bloco de código: senão, uma cerca esquecida antes do bloco o esconderia, e cada geração
 * acrescentaria outro bloco no fim. `fenced` conta os marcadores ignorados por estarem dentro de um bloco de código.
 */
function structuralMarkers(content: string): { found: Found[]; fenced: number } {
  const raw = content.split('\n');
  const lines = raw.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  // O maior fechamento de cada tipo de cerca da linha i em diante: diz na hora se uma abertura fecha (e a leitura fica linear).
  const longest: Record<string, Int32Array> = { '`': new Int32Array(lines.length + 1), '~': new Int32Array(lines.length + 1) };
  for (let i = lines.length - 1; i >= 0; i--) {
    const end = closer(lines[i]);
    for (const char of ['`', '~']) longest[char][i] = Math.max(longest[char][i + 1], end?.char === char ? end.length : 0);
  }
  const found: Found[] = [];
  let fenced = 0;
  let offset = 0;
  for (let i = 0; i < lines.length; offset += raw[i].length + 1, i++) {
    const fence = opens(lines[i]);
    if (fence && longest[fence.char][i + 1] >= fence.length) {
      while (!closes(lines[i + 1], fence)) {
        offset += raw[i].length + 1;
        i++;
        if (markerAt(lines[i])) fenced++;
      }
      offset += raw[i].length + 1;
      i++; // a linha que fecha
      continue;
    }
    const at = markerAt(lines[i]);
    if (!at) continue;
    const from = offset + at.lead;
    found.push({
      line: i + 1,
      marker: at.marker,
      family: at.marker.includes('nexo:') ? 'nexo' : 'octo',
      kind: at.marker.includes(':start') ? 'start' : 'end',
      from,
      to: from + at.marker.length,
    });
  }
  return { found, fenced };
}

/** "na linha 3", "nas linhas 3, 7 e 12" (as primeiras dez, quando são muitas). */
function lineList(found: Found[]): string {
  const lines = found.map((m) => m.line);
  if (lines.length === 1) return `na linha ${lines[0]}`;
  const shown = lines.slice(0, 10);
  const rest = lines.length - shown.length;
  return `nas linhas ${rest ? `${shown.join(', ')} e mais ${rest}` : `${shown.slice(0, -1).join(', ')} e ${shown.at(-1)}`}`;
}

/** "o início do bloco do Octo (na linha 3)", "2 inícios do bloco do Octo (nas linhas 3 e 9)". */
const counted = (found: Found[], one: string, many: string, block = ''): string =>
  `${found.length === 1 ? one : `${found.length} ${many}`}${block && ` ${block}`} (${lineList(found)})`;

/** O que há de errado com os marcadores e como corrigir, com as linhas e a família (Octo ou Nexo) que estão no arquivo. */
function damageMessage(found: Found[], fenced: number): string {
  const families = [...new Set(found.map((m) => m.family))];
  const label = (family: string) => (family === 'nexo' ? 'do Nexo' : 'do Octo');
  const leftovers = 'apague à mão o que sobrou do bloco antigo, conferindo se não há texto seu entre os marcadores';
  let problem: string;
  let fix = leftovers;
  if (families.length > 1) {
    problem = `tem marcadores de duas versões do bloco: ${families.map((f) => `${label(f)} (${lineList(found.filter((m) => m.family === f))})`).join(' e ')}`;
  } else {
    const [start, end] = MARKERS[families[0] === 'nexo' ? 1 : 0];
    const block = `do bloco ${label(families[0])}`;
    const starts = found.filter((m) => m.kind === 'start');
    const ends = found.filter((m) => m.kind === 'end');
    if (!ends.length) {
      problem = `tem ${counted(starts, 'o início', 'inícios', block)}, mas ${starts.length === 1 ? 'não o fim' : 'nenhum fim'}`;
      if (starts.length === 1) fix = `recoloque o ${end} logo depois do bloco antigo, ou apague o bloco antigo à mão`;
    } else if (!starts.length) {
      problem = `tem ${counted(ends, 'o fim', 'fins', block)}, mas ${ends.length === 1 ? 'não o início' : 'nenhum início'}`;
      if (ends.length === 1) fix = `recoloque o ${start} logo antes do bloco antigo, ou apague à mão o que sobrou dele`;
    } else if (starts.length === 1 && ends.length === 1) {
      problem = `tem ${counted(ends, 'o fim', 'fins', block)} antes do início (${lineList(starts)})`;
    } else {
      problem = `tem ${counted(starts, 'um início', 'inícios', block)} e ${counted(ends, 'um fim', 'fins')}, mas um bloco tem um início e um fim só (versões anteriores do Octo podiam deixar o arquivo assim)`;
      fix = `${leftovers}, até sobrar um início e um fim`;
    }
  }
  const notes = [
    families.includes('nexo') ? 'Nexo é o nome antigo do Octo.' : '',
    fenced ? 'Marcadores dentro de blocos de código (entre ``` ou ~~~) não contam.' : '',
  ].filter(Boolean);
  return `O CLAUDE.md desta pasta ${problem}. Para gerar de novo, ${fix}.${notes.length ? ` ${notes.join(' ')}` : ''}`;
}

/** Decodifica UTF-8 sem trocar nada: um byte inválido é erro, e a marca do começo (BOM), se houver, continua no texto. */
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * O texto do arquivo, ou por que não dá para regravá-lo: o Octo grava em UTF-8, e um arquivo em outra
 * codificação sairia com os acentos (ou tudo) estragados.
 */
function decode(bytes: Buffer): { text: string; problem: null } | { text: null; problem: string } {
  let reason: string;
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) {
    reason = 'está em UTF-16 (o Windows PowerShell grava assim com > e Out-File)';
  } else if (bytes.subarray(0, 1024).includes(0)) {
    reason = 'tem bytes nulos (parece UTF-16 sem a marca do começo, ou não é um arquivo de texto)';
  } else {
    try {
      return { text: utf8.decode(bytes), problem: null };
    } catch {
      reason = 'não está em UTF-8 (talvez em ANSI/Windows-1252)';
    }
  }
  return {
    text: null,
    problem: `O CLAUDE.md desta pasta ${reason}, e o Octo só grava em UTF-8: regravá-lo estragaria os acentos. Salve-o como UTF-8 (no VS Code, Salvar com Codificação › UTF-8) e tente de novo.`,
  };
}

interface Inspection {
  exists: boolean;
  /** Conteúdo atual ('' sem arquivo, null quando ele não está em UTF-8), já com a marca de UTF-8 e os CRLF de como está. */
  text: string | null;
  /** Onde está o bloco do Octo (null sem bloco, ou quando os marcadores não formam um bloco só). */
  block: { from: number; to: number } | null;
  found: Found[];
  /** Por que o Octo não grava no arquivo até ele ser corrigido à mão (null quando pode gravar). */
  problem: string | null;
}

/**
 * Lê o CLAUDE.md da pasta e acha o bloco do Octo: exatamente um início e um fim, nessa ordem e da mesma
 * família (Octo ou Nexo). Outro arranjo de marcadores (repetidos, fora de ordem ou sem par; versões anteriores
 * deixavam o arquivo assim quando a descrição de um repositório trazia um marcador) é um problema: aí não dá para
 * saber o que é do Octo no arquivo.
 */
function inspect(file: string): Inspection {
  if (!existsSync(file)) return { exists: false, text: '', block: null, found: [], problem: null };
  const { text, problem } = decode(readFileSync(file));
  if (text === null) return { exists: true, text, block: null, found: [], problem };
  const { found, fenced } = structuralMarkers(text);
  const [first, second] = found;
  const pair = MARKERS.find(([start, end]) => first?.marker === start && second?.marker === end);
  const block = found.length === 2 && pair ? { from: first.from, to: second.to } : null;
  return { exists: true, text, block, found, problem: found.length && !block ? damageMessage(found, fenced) : null };
}

/** Até onde vai um texto de repositório no bloco: sobra para nomes, caminhos e descrições, e mantém barata a limpeza abaixo. */
const MAX_INLINE = 1000;

/**
 * Texto que vem do repositório (nome, caminho, branch, descrição do package.json ou do README) numa linha
 * só e sem delimitadores de comentário HTML: um `<!-- octo:workspace:end -->` ali fecharia o bloco antes
 * da hora. Espaços, quebras de linha e caracteres de controle ou invisíveis viram um espaço antes: trocados, e
 * nunca apagados, eles não juntam as metades de um delimitador (um espaço de largura zero no meio de `<!--`).
 * Depois os delimitadores saem, repetindo até não sobrar nenhum, porque tirar um pode juntar as metades de outro
 * (`<!-<!---->-`).
 */
function inline(text: string): string {
  let line = (text.length > MAX_INLINE ? `${text.slice(0, MAX_INLINE)}…` : text).replace(/[\s\p{Cc}\p{Cf}]+/gu, ' ');
  while (/<!--|-->/.test(line)) line = line.replace(/<!--|-->/g, '');
  return line.replace(/ {2,}/g, ' ').trim();
}

/** Célula da tabela: além de `inline`, um `|` do texto não pode abrir outra coluna. */
function cell(text: string): string {
  return inline(text).replace(/\|/g, '\\|');
}

/**
 * As diretrizes são do usuário e podem ter várias linhas, mas não os marcadores do bloco: cada um vira texto
 * (`&lt;!-- …`) numa passada só. Sem apagar nada, os pedaços em volta não se juntam num marcador novo, e
 * marcadores aninhados não fazem a limpeza demorar.
 */
function withoutMarkers(text: string): string {
  let clean = text;
  for (const marker of ALL_MARKERS) clean = clean.replaceAll(marker, marker.replace('<!--', '&lt;!--'));
  return clean;
}

/** Fecha um bloco de código que as diretrizes deixaram aberto: senão, ele engoliria o fim do bloco do Octo no arquivo. */
function closeFences(text: string): string {
  let open: Fence | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!open) open = opens(line);
    else if (closes(line, open)) open = null;
  }
  return open ? `${text}\n${open.char.repeat(open.length)}` : text;
}

/**
 * Bloco gerenciado do CLAUDE.md de uma pasta que agrupa repositórios (a raiz ou um grupo).
 * Qualquer `claude` aberto nessa pasta (pelo Octo ou pelo seu "cmd → claude" de sempre)
 * passa a enxergar o mapa dos repositórios.
 */
export function renderContextBlock(workspace: Workspace, dir: string, repos: Repo[]): string {
  const atRoot = path.resolve(dir) === path.resolve(workspace.rootPath);
  const rows = repos.map((repo) => {
    const where = `\`./${cell(path.relative(dir, repo.absPath).split(path.sep).join('/'))}\``;
    const scripts = repo.scripts.filter((s) => /^(dev|start|build|test|lint|typecheck)$/.test(s));
    const run = scripts.length ? scripts.map((s) => `\`${repo.packageManager ?? 'npm'} run ${s}\``).join(' ') : '—';
    return `| ${cell(repo.name)} | ${where} | ${repo.stack.slice(0, 4).join(', ') || '—'} | ${cell(repo.branch ?? '') || '—'} | ${run} |`;
  });
  const notes = repos
    .filter((repo) => repo.description || repo.hasClaudeMd || repo.hasAgentsMd)
    .map((repo) => {
      const guides = [repo.hasClaudeMd && 'CLAUDE.md', repo.hasAgentsMd && 'AGENTS.md'].filter(Boolean).join(' e ');
      const description = repo.description ? inline(repo.description) : '';
      return `- **${inline(repo.name)}**${description ? `: ${description}` : ''}${guides ? ` _(tem ${guides} próprio — leia antes de mexer)_` : ''}`;
    });
  const guidance = closeFences(withoutMarkers(workspace.guidance).trim());

  return [
    START,
    `# Workspace ${inline(workspace.name)}${atRoot ? '' : ` · ${inline(path.basename(dir))}`}`,
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
    ...(guidance ? ['', '## Diretrizes do workspace', guidance] : []),
    '',
    `_Gerado pelo Octo em ${new Date().toLocaleString('pt-BR')}. Edite fora deste bloco; ele é substituído ao regenerar._`,
    END,
  ].join('\n');
}

/**
 * managed: o arquivo tem um bloco do Octo, e só ele é atualizado. damaged: o Octo não grava no arquivo até ele
 * ser corrigido à mão (marcadores que não formam um bloco só, ou arquivo fora de UTF-8); `problem` diz o que
 * fazer, e `markers` traz os marcadores encontrados.
 */
export function readContextStatus(dir: string) {
  const file = path.join(dir, 'CLAUDE.md');
  const { exists, block, found, problem } = inspect(file);
  const markers: ContextMarker[] = found.slice(0, 50).map(({ line, marker, family, kind }) => ({ line, marker, family, kind }));
  return { file, exists, managed: block !== null, damaged: problem !== null, problem, markers };
}

export function writeContext(workspace: Workspace, dir: string, repos: Repo[]): string {
  const file = path.join(dir, 'CLAUDE.md');
  const block = renderContextBlock(workspace, dir, repos);
  const current = inspect(file);
  // Substituir um trecho ou acrescentar outro bloco poderia apagar texto do usuário ou multiplicar as sobras, e
  // regravar um arquivo que não está em UTF-8 estragaria o texto dele.
  if (current.problem !== null || current.text === null) throw new HttpError(409, current.problem ?? 'O CLAUDE.md desta pasta não pôde ser lido.');
  const text = current.text;
  const next = current.block
    ? text.slice(0, current.block.from) + block + text.slice(current.block.to)
    : text.trim()
      ? `${text.trimEnd()}\n\n${block}\n`
      : `${block}\n`;
  writeFileSync(file, next);
  return file;
}
