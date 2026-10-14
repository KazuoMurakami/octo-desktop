// Imagens na conversa: as que a interface manda junto da mensagem (coladas, arrastadas ou anexadas)
// e as que aparecem no transcript do Claude Code. Ficam em <dados>/images/<id da sessão>/, com o nome
// tirado do conteúdo: gravar a mesma imagem de novo (ex.: ao sincronizar) não cria outro arquivo.
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { IMAGE_TYPES, MAX_IMAGE_BASE64, MAX_IMAGES, MAX_IMAGES_TOTAL_BASE64, type ImageInput, type ImageType } from '../shared/types.ts';
import { HttpError } from './model.ts';
import { IMAGES_DIR } from './paths.ts';

/** Imagem já conferida: o base64 que vai para o Claude e os bytes que vão para o disco. */
export type ParsedImage = ImageInput & { bytes: Buffer };

/** Bloco do conteúdo de uma mensagem, no formato da API da Anthropic (o mesmo do stream-json do Claude Code). */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: ImageType; data: string } };

const EXTENSIONS: Record<ImageType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

/** Os nomes que o Octo grava: 32 caracteres do sha256 do conteúdo e a extensão. */
const FILE_NAME = /^[0-9a-f]{32}\.(png|jpg|gif|webp)$/;
/** IDs de sessão (randomUUID): sem pontos nem barras, nunca saem de IMAGES_DIR. */
const SESSION_ID = /^[\w-]+$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** O formato pela assinatura no começo do arquivo, sem confiar no tipo informado. */
function sniff(bytes: Buffer): ImageType | null {
  const ascii = (start: number, end: number) => bytes.toString('latin1', start, end);
  if (bytes.subarray(0, 8).equals(PNG)) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return 'image/gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** Base64 estrito de um PNG, JPEG, GIF ou WebP que é mesmo do tipo informado; null se não for. */
function decode(mediaType: unknown, data: unknown): ParsedImage | null {
  if (!IMAGE_TYPES.includes(mediaType as ImageType) || typeof data !== 'string' || !data) return null;
  if (data.length % 4 !== 0 || !BASE64.test(data)) return null;
  const bytes = Buffer.from(data, 'base64');
  return sniff(bytes) === mediaType ? { mediaType: mediaType as ImageType, data, bytes } : null;
}

/**
 * As imagens do corpo de uma requisição (`images: ImageInput[]`). Recusa com 400 o que o Claude não
 * aceitaria: mais de MAX_IMAGES, uma acima do limite da API, todas juntas acima de MAX_IMAGES_TOTAL_BASE64
 * ou algo que não é de fato uma imagem.
 */
export function parseImages(value: unknown): ParsedImage[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new HttpError(400, 'As imagens vieram num formato inválido.');
  if (value.length > MAX_IMAGES) throw new HttpError(400, `Envie no máximo ${MAX_IMAGES} imagens por mensagem.`);
  const total = value.reduce((sum: number, item) => sum + (typeof item?.data === 'string' ? item.data.length : 0), 0);
  if (total > MAX_IMAGES_TOTAL_BASE64) {
    throw new HttpError(400, `As imagens desta mensagem passam de ${MAX_IMAGES_TOTAL_BASE64 / 1024 / 1024} MB juntas: envie menos imagens ou imagens menores.`);
  }
  return value.map((item, index) => {
    const { mediaType, data } = (item ?? {}) as { mediaType?: unknown; data?: unknown };
    if (typeof data === 'string' && data.length > MAX_IMAGE_BASE64) {
      throw new HttpError(400, `A imagem ${index + 1} passa de ${MAX_IMAGE_BASE64 / 1024 / 1024} MB.`);
    }
    const image = decode(mediaType, data);
    if (!image) throw new HttpError(400, `A imagem ${index + 1} não é um PNG, JPEG, GIF ou WebP válido.`);
    return image;
  });
}

function sessionDir(sessionId: string): string | null {
  return SESSION_ID.test(sessionId) ? path.join(IMAGES_DIR, sessionId) : null;
}

/**
 * Grava as imagens da sessão e devolve os nomes, na ordem. A que já está lá (mesmo conteúdo, mesmo
 * nome) não é gravada de novo. Se falhar no meio (ex.: disco cheio), apaga o que esta chamada gravou.
 */
export function saveImages(sessionId: string, images: ParsedImage[]): string[] {
  if (!images.length) return [];
  const dir = sessionDir(sessionId);
  if (!dir) throw new Error(`ID de sessão inválido: ${sessionId}`);
  const created: string[] = [];
  try {
    mkdirSync(dir, { recursive: true });
    return images.map((image) => {
      const hash = createHash('sha256').update(image.bytes).digest('hex').slice(0, 32);
      const name = `${hash}.${EXTENSIONS[image.mediaType]}`;
      const file = path.join(dir, name);
      try {
        writeFileSync(file, image.bytes, { flag: 'wx' });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return name;
        created.push(file); // pode ter ficado pela metade
        throw error;
      }
      created.push(file);
      return name;
    });
  } catch (error) {
    for (const file of created) {
      try {
        rmSync(file, { force: true });
      } catch {
        /* preso por outro programa: fica para trás */
      }
    }
    throw new HttpError(500, `Não foi possível guardar as imagens: ${(error as Error).message}`);
  }
}

/** Caminho de uma imagem gravada, ou null se o nome não for de uma imagem do Octo ou ela não existir. */
export function imageFile(sessionId: string, name: string): string | null {
  const dir = sessionDir(sessionId);
  if (!dir || !FILE_NAME.test(name)) return null;
  const file = path.join(dir, name);
  try {
    return statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

/**
 * O conteúdo de uma mensagem com imagens: cada uma depois do rótulo "[Imagem #N]" e o texto por
 * último (sem texto, só as imagens). A ordem importa: só com o texto no fim um "/comando" ainda roda
 * como comando, e a Anthropic recomenda as imagens antes do texto.
 */
export function imageBlocks(images: ImageInput[], text: string): ContentBlock[] {
  const blocks = images.flatMap((image, index): ContentBlock[] => [
    { type: 'text', text: `[Imagem #${index + 1}]` },
    { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } },
  ]);
  return text.trim() ? [...blocks, { type: 'text', text }] : blocks;
}

/**
 * Grava as imagens de uma mensagem do transcript do Claude Code (blocos `image` com o conteúdo em
 * base64) e devolve os nomes. As que o Octo enviou já estão gravadas com o mesmo nome. Imagens por
 * URL ou arquivo e o que não for um PNG, JPEG, GIF ou WebP válido ficam de fora.
 */
export function saveTranscriptImages(sessionId: string, blocks: unknown[]): string[] {
  const images = blocks.flatMap((block) => {
    const { type, source } = (block ?? {}) as { type?: unknown; source?: { type?: unknown; media_type?: unknown; data?: unknown } | null };
    const image = type === 'image' && source?.type === 'base64' ? decode(source.media_type, source.data) : null;
    return image ? [image] : [];
  });
  return saveImages(sessionId, images);
}
