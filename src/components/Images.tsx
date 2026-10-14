import {
  useEffect, useLayoutEffect, useRef, useState,
  type ClipboardEvent as ReactClipboardEvent, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent, type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, ImagePlus, LoaderCircle, X } from 'lucide-react';
import { MAX_IMAGES, MAX_IMAGES_TOTAL_BASE64 } from '../../shared/types.ts';
import { imageUrl } from '../api.ts';
import {
  carriesFiles, dataUrl, hasText, imageFiles, imageSize, isImagePasteShortcut, prepareImage, readClipboardImages, transferFiles, type PendingImage,
} from '../images.ts';
import { toast } from '../store.ts';
import { isMac } from '../util.ts';
import { trapTab, useDialog, useEscapeLayer } from './ui.tsx';

// ---------------------------------------------------------------- anexar

type DragHandler = (event: ReactDragEvent<HTMLElement>) => void;

export interface ImageAttachments {
  images: PendingImage[];
  /** Quantas ainda estão sendo preparadas: o envio espera por elas. */
  processing: number;
  /** Um arrastar com arquivos está sobre a área. */
  dragging: boolean;
  add: (blobs: Blob[]) => void;
  remove: (id: string) => void;
  /** Tira todas e devolve as que estavam: se o envio falhar, elas voltam com `restore`. */
  clear: () => PendingImage[];
  restore: (list: PendingImage[]) => void;
  /** Colar com uma imagem e sem texto (um print, "copiar imagem" no navegador): anexa. Com texto junto, cola o texto. */
  onPaste: (event: ReactClipboardEvent<HTMLElement>) => void;
  /** Alt+V (⌥V no macOS). Devolve true quando a tecla era essa: quem chamou não faz mais nada com ela. */
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => boolean;
  /** Para a área que aceita imagens arrastadas. */
  dropProps: { onDragEnter: DragHandler; onDragOver: DragHandler; onDragLeave: DragHandler; onDrop: DragHandler };
}

/**
 * Imagens anexadas a uma mensagem: colar, Alt+V, arrastar e o botão de anexar. Cada imagem é
 * preparada (reduzida, se preciso) uma de cada vez, na ordem em que chegou: #1, #2… é como a
 * mensagem se refere a elas. Uma que ainda estava sendo preparada quando a tela fechou é descartada.
 */
export function useImageAttachments({ initial, onChange, blocked }: {
  /** O que já estava anexado (o rascunho da sessão, por exemplo). */
  initial?: PendingImage[];
  /** A cada mudança da lista. */
  onChange?: (images: PendingImage[]) => void;
  /** Por que não dá para anexar agora: vira o aviso quando você tenta. */
  blocked?: string;
} = {}): ImageAttachments {
  const [images, setImages] = useState<PendingImage[]>(() => initial ?? []);
  const [processing, setProcessing] = useState(0);
  const [dragging, setDragging] = useState(false);
  // A lista mais recente: uma imagem termina de carregar fora do ciclo de renderização.
  const latest = useRef(images);
  const queue = useRef(Promise.resolve());
  const pending = useRef(0);
  const depth = useRef(0);
  const changed = useRef(onChange);
  useLayoutEffect(() => {
    changed.current = onChange;
  });
  // Com a tela fechada (outra sessão, o painel fechado), uma imagem que termina de carregar não entra em lugar nenhum: gravada
  // no rascunho por um hook que já saiu, ela sumiria da caixa de resposta ou voltaria depois, junto com outra mensagem.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const commit = (next: PendingImage[]) => {
    latest.current = next;
    setImages(next);
    changed.current?.(next);
  };

  const add = (blobs: Blob[]) => {
    if (blocked) {
      toast(blocked);
      return;
    }
    const accepted = blobs.filter((blob) => blob.type.startsWith('image/'));
    if (accepted.length < blobs.length) toast('Só imagens podem ser anexadas.');
    const room = Math.max(0, MAX_IMAGES - latest.current.length - pending.current);
    if (accepted.length > room) toast(`Até ${MAX_IMAGES} imagens por mensagem.`);
    const chosen = accepted.slice(0, room);
    if (!chosen.length) return;
    pending.current += chosen.length;
    setProcessing(pending.current);
    for (const blob of chosen) {
      queue.current = queue.current.then(async () => {
        try {
          if (!mounted.current) return; // a tela fechou antes da vez desta imagem
          const image = await prepareImage(blob);
          if (!mounted.current) return; // fechou enquanto ela era preparada
          // A API recusa a requisição inteira acima de 32 MB: as imagens de uma mensagem têm um teto somadas.
          const total = latest.current.reduce((sum, item) => sum + item.data.length, 0) + image.data.length;
          if (total > MAX_IMAGES_TOTAL_BASE64) {
            toast(`As imagens de uma mensagem somam no máximo ${MAX_IMAGES_TOTAL_BASE64 / 1024 / 1024} MB: ${image.name} ficou de fora.`, 'error');
          } else {
            commit([...latest.current, image]);
          }
        } catch (error) {
          if (mounted.current) toast(error instanceof Error ? error.message : String(error), 'error');
        } finally {
          pending.current--;
          setProcessing(pending.current);
        }
      });
    }
  };

  const clear = () => {
    const previous = latest.current;
    if (previous.length) commit([]);
    return previous;
  };

  // As que você anexou enquanto o envio acontecia ficam, depois das que voltaram.
  const restore = (list: PendingImage[]) => {
    const added = latest.current.filter((image) => !list.some((old) => old.id === image.id));
    commit([...list, ...added]);
  };

  const onPaste = (event: ReactClipboardEvent<HTMLElement>) => {
    const files = imageFiles(event.clipboardData);
    if (!files.length || hasText(event.clipboardData, files)) return;
    event.preventDefault();
    add(files);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (!isImagePasteShortcut(event)) return false;
    // No macOS o ⌥V digitaria "√". No Windows e no Linux o Alt+V não digita nada, e um V tratado pela página
    // faz o Electron achar que o Alt foi pressionado sozinho: soltá-lo antes do V mostraria a barra de menu.
    if (isMac()) event.preventDefault();
    // Segurar a tecla não cola a mesma imagem várias vezes.
    if (event.repeat) return true;
    if (blocked) {
      toast(blocked);
      return true;
    }
    readClipboardImages()
      .then((blobs) => (blobs.length ? add(blobs) : toast('Não há imagem na área de transferência.')))
      .catch((error: Error) => toast(error.message, 'error'));
    return true;
  };

  // Entrar num elemento de dentro conta antes de sair do anterior: o destaque só some ao sair da área (não pisca).
  const dropProps = {
    onDragEnter: (event: ReactDragEvent<HTMLElement>) => {
      if (!carriesFiles(event.dataTransfer)) return;
      event.preventDefault();
      depth.current++;
      if (!blocked) setDragging(true);
    },
    onDragOver: (event: ReactDragEvent<HTMLElement>) => {
      if (!carriesFiles(event.dataTransfer)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = blocked ? 'none' : 'copy';
    },
    onDragLeave: (event: ReactDragEvent<HTMLElement>) => {
      if (!carriesFiles(event.dataTransfer)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (!depth.current) setDragging(false);
    },
    onDrop: (event: ReactDragEvent<HTMLElement>) => {
      if (!carriesFiles(event.dataTransfer)) return;
      event.preventDefault();
      depth.current = 0;
      setDragging(false);
      add(transferFiles(event.dataTransfer));
    },
  };

  return {
    images, processing, dragging, add, clear, restore, onPaste, onKeyDown, dropProps,
    remove: (id) => commit(latest.current.filter((image) => image.id !== id)),
  };
}

/**
 * Botão que abre a escolha de imagens. O campo de arquivo fica escondido e é zerado a cada uso:
 * escolher de novo o mesmo arquivo também conta. Sem `children`, mostra só o ícone.
 */
export function AttachButton({ onFiles, className, children }: { onFiles: (files: File[]) => void; className: string; children?: ReactNode }) {
  const input = useRef<HTMLInputElement>(null);
  const hint = isMac()
    ? 'Anexar imagem. Também dá para colar (⌘V, ou ⌥V com texto copiado junto) ou arrastar para cá.'
    : 'Anexar imagem. Também dá para colar (Ctrl+V, ou Alt+V com texto copiado junto) ou arrastar para cá.';
  return (
    <>
      <button type="button" className={className} onClick={() => input.current?.click()} title={hint} aria-label={children ? undefined : 'Anexar imagem'}>
        {children ?? <ImagePlus size={15} />}
      </button>
      <input
        ref={input}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (files.length) onFiles(files);
        }}
      />
    </>
  );
}

/** Aviso sobre a área enquanto você arrasta imagens para ela. Fica fora dos eventos do arrastar. */
export function DropHint({ show }: { show: boolean }) {
  if (!show) return null;
  return <div className="drop-hint" aria-hidden="true"><ImagePlus size={16} /> Solte para anexar</div>;
}

/**
 * Miniaturas das imagens anexadas, antes de enviar: clicar amplia, o × tira. O #N é como a mensagem
 * pode se referir a cada uma.
 */
export function ImageTray({ images, processing, onRemove, children }: {
  images: PendingImage[];
  processing: number;
  onRemove: (id: string) => void;
  /** Vai no fim da fileira (o botão de anexar, por exemplo). */
  children?: ReactNode;
}) {
  const [viewing, setViewing] = useState<number | null>(null);
  if (!images.length && !processing && !children) return null;

  // O foco passa para o × da miniatura vizinha (ou para o diálogo em volta) e não se perde com o botão que sumiu.
  const removeAt = (event: ReactMouseEvent<HTMLButtonElement>, id: string) => {
    const buttons = [...(event.currentTarget.closest('.image-tray')?.querySelectorAll<HTMLElement>('.image-remove') ?? [])];
    const at = buttons.indexOf(event.currentTarget);
    const neighbor = buttons[at + 1] ?? buttons[at - 1];
    if (neighbor) neighbor.focus();
    else event.currentTarget.closest<HTMLElement>('[role="dialog"][tabindex]')?.focus({ preventScroll: true });
    onRemove(id);
  };

  return (
    <div className="image-tray">
      {images.map((image, index) => {
        const label = `Imagem #${index + 1} · ${image.width}×${image.height} · ${imageSize(image)}`;
        return (
          <div key={image.id} className="image-thumb">
            <button type="button" className="image-thumb-open" onClick={() => setViewing(index)} title={label}>
              <img src={image.url} alt={label} />
            </button>
            <span className="image-badge" aria-hidden="true">#{index + 1}</span>
            <button type="button" className="image-remove" onClick={(e) => removeAt(e, image.id)} aria-label={`Remover imagem ${index + 1}`} title="Remover">
              <X size={11} />
            </button>
          </div>
        );
      })}
      {Array.from({ length: processing }, (_, index) => (
        <div key={`preparando-${index}`} className="image-thumb is-pending" role="img" aria-label="Preparando a imagem…" title="Preparando a imagem…">
          <LoaderCircle size={16} className="spin" />
        </div>
      ))}
      {children}
      {viewing !== null && images[viewing] && (
        <ImageViewer
          images={images.map((image, index) => ({ src: dataUrl(image), label: `Imagem #${index + 1}` }))}
          start={viewing}
          onClose={() => setViewing(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- no feed

/** Imagens que foram junto com uma mensagem: miniaturas que abrem no visualizador. */
export function SentImages({ sessionId, names }: { sessionId: string; names: string[] }) {
  const [viewing, setViewing] = useState<number | null>(null);
  const images = names.map((name, index) => ({ src: imageUrl(sessionId, name), label: `Imagem #${index + 1}` }));
  return (
    <div className="act-images">
      {images.map((image, index) => (
        <SentImage key={`${index}:${names[index]}`} src={image.src} label={image.label} onOpen={() => setViewing(index)} />
      ))}
      {viewing !== null && <ImageViewer images={images} start={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}

function SentImage({ src, label, onOpen }: { src: string; label: string; onOpen: () => void }) {
  const [missing, setMissing] = useState(false);
  if (missing) {
    return <span className="act-image is-missing" title="O arquivo desta imagem não está mais na pasta de dados do Octo.">[imagem indisponível]</span>;
  }
  return (
    <button type="button" className="act-image" onClick={onOpen} title={`Ampliar a ${label.toLowerCase()}`}>
      <img src={src} alt={label} loading="lazy" decoding="async" onError={() => setMissing(true)} />
    </button>
  );
}

// ---------------------------------------------------------------- visualizador

export interface ViewerImage {
  src: string;
  label: string;
}

/**
 * Imagem ampliada, por cima de tudo: aberta sobre um modal, o Esc fecha só ela. ← e → passam pelas
 * outras imagens da mesma mensagem; um clique fora da imagem fecha.
 */
export function ImageViewer({ images, start, onClose }: { images: ViewerImage[]; start: number; onClose: () => void }) {
  const [index, setIndex] = useState(start);
  const [missing, setMissing] = useState<ReadonlySet<string>>(() => new Set());
  const ref = useRef<HTMLDivElement>(null);
  useEscapeLayer(true, onClose, 'modal');
  useDialog(ref);
  const count = images.length;
  const current = Math.min(index, count - 1);
  const image = images[current];
  if (!image) return null;
  const step = (delta: number) => setIndex((i) => (Math.min(i, count - 1) + delta + count) % count);
  const closeOutside = (event: ReactMouseEvent) => event.target === event.currentTarget && onClose();

  return createPortal(
    <div className="viewer-backdrop" onClick={closeOutside}>
      <div
        ref={ref}
        className="viewer"
        role="dialog"
        aria-modal="true"
        aria-label={count > 1 ? `${image.label} de ${count}` : image.label}
        tabIndex={-1}
        onClick={closeOutside}
        onKeyDown={(e) => {
          if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && count > 1) {
            e.preventDefault();
            e.stopPropagation();
            step(e.key === 'ArrowLeft' ? -1 : 1);
          } else if (e.key === 'Tab') {
            e.stopPropagation(); // o Tab fica aqui, sem passar pelo painel ou modal de baixo
            trapTab(e);
          }
        }}
      >
        {missing.has(image.src) ? (
          <div className="viewer-missing">[imagem indisponível]</div>
        ) : (
          <img key={image.src} src={image.src} alt={image.label} onError={() => setMissing((m) => new Set(m).add(image.src))} />
        )}
        <div className="viewer-bar">
          {count > 1 && (
            <button type="button" className="icon-btn" onClick={() => step(-1)} aria-label="Imagem anterior" title="Anterior (←)">
              <ChevronLeft size={16} />
            </button>
          )}
          <span className="viewer-count" aria-live="polite">{count > 1 ? `${current + 1} de ${count}` : image.label}</span>
          {count > 1 && (
            <button type="button" className="icon-btn" onClick={() => step(1)} aria-label="Próxima imagem" title="Próxima (→)">
              <ChevronRight size={16} />
            </button>
          )}
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Fechar" title="Fechar (Esc)">
            <X size={16} />
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
