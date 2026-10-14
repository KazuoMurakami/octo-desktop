// Imagens na conversa: o que você cola, arrasta ou escolhe vira o conteúdo que vai junto com a mensagem.
import { MAX_IMAGE_BASE64, type ImageInput, type ImageType } from '../shared/types.ts';
import { isMac } from './util.ts';

/** Imagem anexada e ainda não enviada. `url` é a miniatura, em data: (a CSP só carrega imagens do Octo e data:). */
export type PendingImage = ImageInput & { id: string; url: string; width: number; height: number; name: string };

/** Lado maior, em pixels, a partir do qual a imagem é reduzida: acima disso o Claude não aproveita o detalhe. */
const MAX_EDGE = 2000;

let sequence = 0;

/** Tamanho em base64 de um conteúdo de `bytes` bytes. */
const base64Length = (bytes: number) => Math.ceil(bytes / 3) * 4;

/**
 * O formato pela assinatura no começo do arquivo, como o servidor confere. O tipo de um arquivo vem
 * da extensão: um WebP baixado como .png chegaria como image/png, e o servidor recusaria a imagem.
 */
async function contentType(blob: Blob): Promise<ImageType | null> {
  const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  const ascii = (start: number, end: number) => String.fromCharCode(...head.subarray(start, end));
  if (ascii(0, 8) === '\x89PNG\r\n\x1a\n') return 'image/png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return 'image/gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/**
 * Prepara uma imagem para ir ao Claude. Num formato aceito, com até 2000 px e dentro do limite da API,
 * ela vai como veio (um GIF continua animado). Senão é redesenhada: em PNG, que mantém a transparência
 * e o texto nítido dos prints, ou em JPEG com qualidade decrescente e, se preciso, menor.
 */
export async function prepareImage(blob: Blob, name = blob instanceof File ? blob.name : ''): Promise<PendingImage> {
  const label = name ? `“${name}”` : 'a imagem';
  if (/svg/i.test(blob.type)) throw new Error(`Não dá para anexar ${label}: o Claude não recebe SVG. Exporte como PNG ou JPEG.`);
  if (blob.type && !blob.type.startsWith('image/')) throw new Error('Só imagens podem ser anexadas.');
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    throw new Error(`Não foi possível abrir ${label}: o formato não é suportado ou o arquivo está danificado.`);
  }
  try {
    const type = await contentType(blob);
    const keep = type !== null && Math.max(bitmap.width, bitmap.height) <= MAX_EDGE && base64Length(blob.size) <= MAX_IMAGE_BASE64;
    const image = keep
      ? { blob, mediaType: type, width: bitmap.width, height: bitmap.height }
      : await reencode(bitmap, type === 'image/jpeg');
    return {
      id: `imagem-${++sequence}`,
      mediaType: image.mediaType,
      data: await readBase64(image.blob),
      url: thumbnail(bitmap),
      width: image.width,
      height: image.height,
      name: name || 'imagem',
    };
  } finally {
    bitmap.close();
  }
}

interface Encoded {
  blob: Blob;
  mediaType: ImageType;
  width: number;
  height: number;
}

async function reencode(bitmap: ImageBitmap, photo: boolean): Promise<Encoded> {
  let scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  // Uma foto em PNG passaria do limite de qualquer jeito: ela vai direto para o JPEG.
  if (!photo) {
    const canvas = draw(bitmap, scale, false);
    const png = await encode(canvas, 'image/png');
    if (base64Length(png.size) <= MAX_IMAGE_BASE64) return { blob: png, mediaType: 'image/png', width: canvas.width, height: canvas.height };
  }
  // JPEG não tem transparência (o fundo fica branco). Se nem a qualidade menor couber, a imagem diminui.
  for (let attempt = 0; attempt < 6; attempt++, scale *= 0.75) {
    const canvas = draw(bitmap, scale, true);
    for (const quality of [0.9, 0.8, 0.7]) {
      const jpeg = await encode(canvas, 'image/jpeg', quality);
      if (base64Length(jpeg.size) <= MAX_IMAGE_BASE64) return { blob: jpeg, mediaType: 'image/jpeg', width: canvas.width, height: canvas.height };
    }
  }
  throw new Error('A imagem é grande demais, mesmo reduzida.');
}

function draw(bitmap: ImageBitmap, scale: number, opaque: boolean): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Não foi possível converter a imagem.');
  if (opaque) {
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
  }
  context.imageSmoothingQuality = 'high';
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function encode(canvas: HTMLCanvasElement, type: 'image/png' | 'image/jpeg', quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Não foi possível converter a imagem.'))), type, quality);
  });
}

/** Miniatura leve para a bandeja: a imagem inteira só vai para o Claude e para o visualizador. */
function thumbnail(bitmap: ImageBitmap): string {
  // Cobre o quadrado da bandeja em telas de alta densidade, sem ficar enorme num panorama.
  const scale = Math.min(1, 128 / Math.min(bitmap.width, bitmap.height), 512 / Math.max(bitmap.width, bitmap.height));
  // WebP é pequeno e mantém a transparência; onde o navegador não gera WebP, sai PNG.
  return draw(bitmap, scale, false).toDataURL('image/webp', 0.8);
}

/** O conteúdo em base64, sem o "data:…,". O FileReader converte o arquivo inteiro de uma vez, sem estourar a pilha. */
function readBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.onerror = () => reject(new Error('Não foi possível ler a imagem.'));
    reader.readAsDataURL(blob);
  });
}

/** A imagem inteira como data: (para o visualizador, antes de enviar). */
export function dataUrl(image: ImageInput): string {
  return `data:${image.mediaType};base64,${image.data}`;
}

/** Tamanho real da imagem (o base64 tem 4/3 dele), como aparece na bandeja. */
export function imageSize(image: ImageInput): string {
  const padding = image.data.endsWith('==') ? 2 : image.data.endsWith('=') ? 1 : 0;
  const bytes = (image.data.length / 4) * 3 - padding;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB`;
}

// ---------------------------------------------------------------- área de transferência e arrastar

/** O arrastar traz arquivos (e não um texto ou um link)? */
export function carriesFiles(data: DataTransfer | null): data is DataTransfer {
  return Boolean(data && Array.from(data.types).includes('Files'));
}

/** Arquivos de um colar ou de um arrastar: os itens do tipo arquivo ou, sem eles, a lista de arquivos. Sem repetir. */
export function transferFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  const items = Array.from(data.items)
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
  const seen = new Set<string>();
  return (items.length ? items : Array.from(data.files)).filter((file) => {
    const key = `${file.name}|${file.size}|${file.type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Só as imagens entre os arquivos de um colar ou de um arrastar. */
export function imageFiles(data: DataTransfer | null): File[] {
  return transferFiles(data).filter((file) => file.type.startsWith('image/'));
}

/**
 * O colar traz texto de verdade? Planilhas e editores de texto copiam, junto com o texto, uma imagem
 * dele: aí vale o texto. O nome do arquivo que o Explorador ou o Finder põem junto com um arquivo
 * copiado não conta.
 */
export function hasText(data: DataTransfer | null, files: File[] = []): boolean {
  const text = data?.getData('text/plain').trim() ?? '';
  if (!text) return false;
  const names = files.map((file) => file.name).filter(Boolean);
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return !names.length || lines.some((line) => !names.some((name) => line.endsWith(name)));
}

/**
 * Alt+V (⌥V no macOS, onde a tecla digitaria "√"): cola a imagem copiada mesmo com texto junto, como
 * o Claude Code no Windows. Pela posição da tecla, que não muda com o Alt.
 */
export function isImagePasteShortcut(event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; code: string }): boolean {
  return event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.code === 'KeyV';
}

/**
 * Lê as imagens da área de transferência (o Alt+V). Diferente do Ctrl+V, não depende do que mais foi
 * copiado, mas precisa da permissão de leitura: o app desktop já a tem; o navegador pergunta.
 */
export async function readClipboardImages(): Promise<Blob[]> {
  const paste = isMac() ? '⌘V' : 'Ctrl+V';
  if (!navigator.clipboard?.read) throw new Error(`Este navegador não deixa ler imagens da área de transferência por atalho: use ${paste}.`);
  let items: ClipboardItems;
  try {
    items = await navigator.clipboard.read();
  } catch {
    throw new Error(`Sem permissão para ler a área de transferência: use ${paste} para colar a imagem.`);
  }
  const blobs: Blob[] = [];
  for (const item of items) {
    const type = item.types.find((t) => t.startsWith('image/'));
    if (!type) continue;
    try {
      blobs.push(await item.getType(type));
    } catch {
      /* formato anunciado mas ilegível: fica de fora */
    }
  }
  return blobs;
}

/**
 * Um arquivo solto fora de uma área que aceita imagens não abre no lugar da interface (no navegador,
 * a aba trocaria o Octo pelo arquivo, e os rascunhos se perderiam). Chamada uma vez, ao iniciar.
 */
export function blockStrayFileDrops(): void {
  window.addEventListener('dragover', (event) => {
    if (event.defaultPrevented || !carriesFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'none';
  });
  window.addEventListener('drop', (event) => {
    if (carriesFiles(event.dataTransfer)) event.preventDefault();
  });
}
