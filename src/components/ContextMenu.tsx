import {
  useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronRight } from 'lucide-react';
import { focusNearby, useEscapeLayer } from './ui.tsx';

// ---------------------------------------------------------------- itens

/** Uma ação do menu do botão direito. */
export interface ContextItem {
  key: string;
  label: string;
  icon?: ReactNode;
  /** À direita: o programa que vai abrir, o valor atual ou, num item desativado, o porquê. */
  hint?: string;
  danger?: boolean;
  /** Fica à vista, mas não faz nada: diga o porquê em `hint`. */
  disabled?: boolean;
  /** Opção que liga e desliga, com o visto quando ligada. */
  checked?: boolean;
  /** Com `checked`: uma entre várias opções (o status atual, no submenu de status). */
  radio?: boolean;
  onSelect?: () => void;
  /** Um nível de submenu (Status ▸). */
  submenu?: ContextEntry[];
}

/** Um item, ou uma linha entre grupos de itens. */
export type ContextEntry = ContextItem | 'separator';

// ---------------------------------------------------------------- o menu aberto

type Placement =
  | { kind: 'point'; x: number; y: number }
  /** Pelo teclado: logo abaixo (ou acima) do elemento focado. */
  | { kind: 'below'; rect: DOMRect }
  /** Submenu: ao lado do item que o abre. */
  | { kind: 'beside'; rect: DOMRect };

/**
 * Por que o menu fechou: um item escolhido, Esc, Tab, um clique fora (ou o foco foi para fora dele) ou, em 'dismiss',
 * a página rolou, a janela mudou de tamanho ou perdeu o foco, o elemento do menu saiu da tela ou outra camada vai abrir.
 */
export type CloseReason = 'select' | 'escape' | 'tab' | 'outside' | 'dismiss';

interface OpenMenu {
  id: number;
  label: string;
  entries: ContextEntry[];
  placement: Placement;
  /** Aberto pelo teclado: o foco começa no primeiro item. */
  keyboard: boolean;
  /** Quem tinha o foco: o recebe de volta quando o menu fecha (menos num clique fora, que leva o foco para onde foi). */
  returnFocus: HTMLElement | null;
  /** O que o menu mostra (o card, a linha): se ele sai da tela, por exemplo a issue excluída por outra janela, o menu fecha. */
  subject: HTMLElement | null;
  /** O que o menu mostra ainda existe? Para quando o elemento fica na tela sem ele (o botão do seletor de pastas). */
  alive?: () => boolean;
  /** Para onde o foco vai se quem o tinha sair da tela (medido quando o menu abre, com tudo ainda no lugar). */
  refocus: () => void;
  onClose?: (reason: CloseReason) => void;
}

/** Um menu aberto por vez, para a interface inteira: o ContextMenuHost o mostra. */
let current: OpenMenu | null = null;
let lastId = 0;
const listeners = new Set<() => void>();

function publish(next: OpenMenu | null): void {
  current = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Fecha o menu. Ao escolher um item, a ação roda depois que o foco voltou para quem abriu o menu. */
function closeMenu(id: number, reason: CloseReason, action?: () => void): void {
  const menu = current;
  if (!menu || menu.id !== id) return;
  publish(null);
  const target = menu.returnFocus;
  const restore = reason !== 'outside';
  if (restore && target?.isConnected) target.focus({ preventScroll: true });
  try {
    action?.();
  } finally {
    menu.onClose?.(reason);
  }
  // A ação pode ter recriado quem abriu o menu (o card que mudou de coluna): o foco vai para o novo, que tem o mesmo id.
  // Se ele saiu da tela (a issue cancelada com as canceladas ocultas, ou excluída), o foco vai para um vizinho.
  if (restore && target) {
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (target.isConnected || (active && active !== document.body)) return;
      const again = target.id ? document.getElementById(target.id) : null;
      if (again) again.focus();
      else menu.refocus();
    });
  }
}

/**
 * Fecha o menu do botão direito, se houver um aberto, e devolve o foco a quem o abriu: antes de abrir por fora dele uma
 * camada que fica por cima (as Preferências do menu do app desktop), que depois devolve o foco para lá.
 */
export function closeContextMenu(): void {
  if (current) closeMenu(current.id, 'dismiss');
}

// ---------------------------------------------------------------- abrir

/** Quando a tecla Menu ou o Shift+F10 foi apertado (performance.now()): o contextmenu que vem logo depois é do teclado. */
let menuKeyAt = -Infinity;

/**
 * Pelo teclado, o evento não traz um ponto de clique útil (às vezes vem em 0, 0; às vezes no canto do elemento). O
 * botão direito do mouse vem com button 2, e o Ctrl+clique do macOS com o botão ainda apertado.
 */
function fromKeyboard(event: ReactMouseEvent<Element>): boolean {
  if (performance.now() - menuKeyAt < 1000) return true;
  return (event.button !== 2 && event.buttons === 0) || (event.clientX === 0 && event.clientY === 0);
}

/** Campos de texto e texto selecionado ficam com o menu nativo: o do navegador ou, no app desktop, o de edição. */
function wantsNativeMenu(event: ReactMouseEvent<Element>, keyboard: boolean): boolean {
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest('input, textarea, select') || (target instanceof HTMLElement && target.isContentEditable)) return true;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.toString().trim()) return false;
  for (let i = 0; i < selection.rangeCount; i++) {
    const range = selection.getRangeAt(i);
    // Pelo teclado, só a seleção que fica dentro do elemento focado: um Ctrl+A na página também "contém" o card, e aí
    // o Shift+F10 nunca mais abriria o menu do app.
    if (keyboard) {
      if (target?.contains(range.commonAncestorContainer)) return true;
      continue;
    }
    for (const rect of range.getClientRects()) {
      if (event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom) return true;
    }
  }
  return false;
}

/**
 * Abre o menu do botão direito com os itens de `build` (montados na hora). Pelo mouse, ele aparece no ponto do clique;
 * pelo teclado (Shift+F10 ou a tecla Menu), junto do elemento focado ou de `anchor`. Num campo de texto ou sobre texto
 * selecionado não faz nada, e o menu nativo aparece. `onClose` diz por que ele fechou ('select' quando um item foi escolhido).
 * O menu fecha sozinho quando o elemento dele sai da tela ou quando `alive` passa a dizer que o que ele mostra não existe mais.
 */
export function openContextMenu(
  event: ReactMouseEvent<Element>,
  build: () => ContextEntry[],
  { label, anchor, alive, onClose }: {
    label: string;
    anchor?: HTMLElement | null;
    alive?: () => boolean;
    onClose?: (reason: CloseReason) => void;
  },
): void {
  // Um menu de dentro (o de um item) já tratou o clique.
  if (event.defaultPrevented) return;
  // O evento veio de um portal, só pela árvore do React (o menu suspenso "Abrir em…" de uma linha, desenhado no fim do
  // body): não é um clique na linha, e o menu dela não abre por cima do menu suspenso.
  if (event.currentTarget instanceof Node && event.target instanceof Node && !event.currentTarget.contains(event.target)) return;
  const keyboard = fromKeyboard(event);
  if (wantsNativeMenu(event, keyboard)) return;
  const entries = build();
  if (!entries.length) return;
  event.preventDefault();
  if (current) closeMenu(current.id, 'outside');
  const focused = document.activeElement;
  const returnFocus = focused instanceof HTMLElement && focused !== document.body && !focused.closest('[data-context-menu]') ? focused : null;
  const own = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  const target = anchor ?? returnFocus ?? own;
  publish({
    id: ++lastId,
    label,
    entries,
    placement: keyboard && target ? { kind: 'below', rect: target.getBoundingClientRect() } : { kind: 'point', x: event.clientX, y: event.clientY },
    keyboard,
    returnFocus,
    subject: anchor ?? own,
    alive,
    refocus: returnFocus ? focusNearby(returnFocus) : () => undefined,
    onClose,
  });
}

/** Onde o menu do botão direito aparece: um só para a interface inteira (fica em App). */
export function ContextMenuHost() {
  const menu = useSyncExternalStore(subscribe, () => current);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) menuKeyAt = performance.now();
    };
    const onPointer = () => {
      menuKeyAt = -Infinity;
    };
    // No Windows, a tecla Menu abre o menu ao ser solta: vale o keyup também.
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);
    window.addEventListener('pointerdown', onPointer, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKey, true);
      window.removeEventListener('pointerdown', onPointer, true);
    };
  }, []);

  return menu ? <RootMenu key={menu.id} menu={menu} /> : null;
}

function RootMenu({ menu }: { menu: OpenMenu }) {
  useEscapeLayer(true, () => closeMenu(menu.id, 'escape'), 'menu');

  // Fecha num clique fora, ao rolar, ao redimensionar a janela e quando ela perde o foco.
  useEffect(() => {
    const inside = (target: EventTarget | null) => target instanceof Element && Boolean(target.closest('[data-context-menu]'));
    const onPointerDown = (event: PointerEvent) => {
      if (!inside(event.target)) closeMenu(menu.id, 'outside');
    };
    // O foco foi para outro lugar (um modal que abriu por cima, como as Preferências do app desktop): o menu fecha e
    // não pega o foco de volta.
    const onFocusOut = (event: FocusEvent) => {
      if (event.relatedTarget instanceof Element && !inside(event.relatedTarget)) closeMenu(menu.id, 'outside');
    };
    const onScroll = (event: Event) => {
      if (!inside(event.target)) closeMenu(menu.id, 'dismiss');
    };
    const onDismiss = () => closeMenu(menu.id, 'dismiss');
    // O card ou a linha do menu saiu da tela (a issue excluída por outra janela), ou o que ele mostra deixou de existir
    // (a pasta desconectada por outra janela, com o botão do seletor ainda na tela): as ações dele não valem mais. A tela
    // muda junto com os dados, então conferir a cada mudança dela basta.
    const { subject, alive } = menu;
    const gone = subject || alive
      ? new MutationObserver(() => {
          if ((subject && !subject.isConnected) || alive?.() === false) closeMenu(menu.id, 'dismiss');
        })
      : null;
    gone?.observe(document.body, { childList: true, subtree: true });
    // A rolagem que já estava a caminho quando o menu abriu (pôr o foco num card meio fora da tela rola o quadro) só é
    // avisada no quadro seguinte, antes dos requestAnimationFrame: ela não fecha o menu, só as que vêm depois.
    const frame = requestAnimationFrame(() => document.addEventListener('scroll', onScroll, true));
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('focusout', onFocusOut, true);
    document.addEventListener('wheel', onScroll, { capture: true, passive: true });
    window.addEventListener('blur', onDismiss);
    window.addEventListener('resize', onDismiss);
    return () => {
      cancelAnimationFrame(frame);
      gone?.disconnect();
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('focusout', onFocusOut, true);
      document.removeEventListener('scroll', onScroll, true);
      document.removeEventListener('wheel', onScroll, { capture: true });
      window.removeEventListener('blur', onDismiss);
      window.removeEventListener('resize', onDismiss);
    };
  }, [menu]);

  return (
    <MenuPanel
      entries={menu.entries}
      label={menu.label}
      placement={menu.placement}
      focusFirst={menu.keyboard}
      onChoose={(item) => closeMenu(menu.id, 'select', item.onSelect)}
      onLeave={(reason) => closeMenu(menu.id, reason === 'back' ? 'escape' : reason)}
    />
  );
}

// ---------------------------------------------------------------- o painel (menu ou submenu)

/** Distância mínima das bordas da janela. */
const MARGIN = 8;

/** Onde o painel fica, já medido: dentro da janela, virando para a esquerda ou para cima quando não cabe. */
function place(placement: Placement, width: number, height: number): { left: number; top: number } {
  const maxLeft = window.innerWidth - MARGIN - width;
  const maxTop = window.innerHeight - MARGIN - height;
  let left: number;
  let top: number;
  if (placement.kind === 'point') {
    // Como os menus do sistema: sem espaço à direita (ou embaixo) do clique, abre para a esquerda (ou para cima).
    left = placement.x > maxLeft ? placement.x - width : placement.x;
    top = placement.y > maxTop ? placement.y - height : placement.y;
  } else if (placement.kind === 'below') {
    const { rect } = placement;
    left = rect.left > maxLeft ? rect.right - width : rect.left;
    top = rect.bottom + 4 > maxTop ? rect.top - 4 - height : rect.bottom + 4;
  } else {
    // À direita do item que o abre ou, sem espaço, à esquerda, com o primeiro item na altura dele (4px de espaçamento +
    // 1px de borda). Numa janela estreita demais para os dois lados, logo abaixo do item (ou acima), sem cobrir a linha dele.
    const { rect } = placement;
    top = rect.top - 5;
    if (rect.right + 4 <= maxLeft) left = rect.right + 4;
    else if (rect.left - 4 - width >= MARGIN) left = rect.left - 4 - width;
    else {
      left = rect.left + 16;
      top = rect.bottom + 4 > maxTop ? rect.top - 4 - height : rect.bottom + 4;
    }
  }
  return { left: Math.max(MARGIN, Math.min(left, maxLeft)), top: Math.max(MARGIN, Math.min(top, maxTop)) };
}

/** Para achar o item pela primeira letra sem se importar com acentos: "é" acha "Excluir". */
function plain(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

interface PanelProps {
  entries: ContextEntry[];
  placement: Placement;
  /** Nome do menu para leitores de tela; o submenu é nomeado pelo item que o abre (`labelledBy`). */
  label?: string;
  labelledBy?: string;
  id?: string;
  /** Pelo teclado, o foco vai para o primeiro item. Pelo mouse, para o menu (um submenu aberto pelo mouse não o pega). */
  focusFirst: boolean;
  nested?: boolean;
  onChoose: (item: ContextItem) => void;
  /** Esc e Tab fecham o menu; ← e Esc num submenu voltam para o item que o abriu ('back'). */
  onLeave: (reason: 'escape' | 'tab' | 'back') => void;
  onPointerEnter?: () => void;
}

/**
 * Um menu na tela, com o foco itinerante nos itens: as setas, Home/End e a primeira letra movem o foco, Enter e Espaço
 * escolhem, → abre o submenu e ← volta dele. Itens desativados recebem o foco (o leitor de tela os anuncia), mas não fazem nada.
 * O destaque e o foco andam juntos; as teclas valem para o item com o foco, o que o leitor de tela anunciou.
 */
function MenuPanel({ entries, placement, label, labelledBy, id, focusFirst, nested = false, onChoose, onLeave, onPointerEnter }: PanelProps) {
  const ref = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const baseId = useId();
  const subId = `${baseId}-sub`;
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const [active, setActive] = useState(-1);
  /** O submenu aberto: de qual item, onde, e se o foco entra nele (pelo teclado). `token` o recria para focar de novo. */
  const [sub, setSub] = useState<{ index: number; placement: Placement; focus: boolean; token: number } | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  /** O item em que o mouse se mexeu por último. O menu que aparece sob o ponteiro parado não conta como passar o mouse. */
  const pointed = useRef(-1);
  const placed = useRef(false);
  /** Os índices dos itens, sem os separadores: é por eles que as setas andam. */
  const items = entries.flatMap((entry, index) => (entry === 'separator' ? [] : [index]));
  const itemAt = (index: number) => entries[index] as ContextItem;

  useLayoutEffect(() => {
    const el = ref.current;
    if (el) setPosition(place(placement, el.offsetWidth, el.offsetHeight));
  }, [placement]);

  const move = (index: number | undefined) => {
    if (index === undefined) return;
    // Um submenu que o mouse ia abrir (ou fechar) não passa por cima da escolha pelo teclado.
    clearTimeout(hoverTimer.current);
    setActive(index);
    if (sub && sub.index !== index) setSub(null);
    const el = itemRefs.current[index];
    el?.focus({ preventScroll: true });
    el?.scrollIntoView({ block: 'nearest' });
  };

  // Já no lugar (antes de aparecer na tela): pelo teclado, o foco vai para o primeiro item; pelo mouse, para o menu.
  useLayoutEffect(() => {
    if (!position || placed.current) return;
    placed.current = true;
    if (focusFirst) move(items[0]);
    else if (!nested) ref.current?.focus({ preventScroll: true });
  }, [position]);

  useEffect(() => () => clearTimeout(hoverTimer.current), []);

  const openSub = (index: number, focus: boolean) => {
    const el = itemRefs.current[index];
    clearTimeout(hoverTimer.current);
    if (!el || nested) return;
    setActive(index);
    // Aberto pelo mouse, o foco fica no item que o abriu: destaque e foco nunca se separam.
    if (!focus) el.focus({ preventScroll: true });
    // Já aberto pelo mouse: só é recriado se o foco precisa entrar nele.
    setSub((open) =>
      open?.index === index && !focus
        ? open
        : { index, placement: { kind: 'beside', rect: el.getBoundingClientRect() }, focus, token: (open?.token ?? 0) + 1 },
    );
  };

  const backFromSub = () => {
    if (!sub) return;
    const index = sub.index;
    setSub(null);
    setActive(index);
    itemRefs.current[index]?.focus({ preventScroll: true });
  };

  const activate = (index: number, keyboard: boolean) => {
    const item = itemAt(index);
    if (item.disabled) return;
    if (item.submenu) openSub(index, keyboard);
    else onChoose(item);
  };

  /** O foco acompanha o mouse (as setas continuam de onde ele está). */
  const hover = (index: number) => {
    const el = itemRefs.current[index];
    if (index === active && el === document.activeElement) return;
    // Voltando do submenu para o item que o abriu, o foco que está no submenu fica lá.
    if (index === sub?.index && document.getElementById(subId)?.contains(document.activeElement)) return;
    setActive(index);
    el?.focus({ preventScroll: true });
  };

  /** O submenu abre quando o mouse para no item que o tem, e fecha quando ele passa para outro item. */
  const enter = (index: number) => {
    clearTimeout(hoverTimer.current);
    const item = itemAt(index);
    if (item.submenu && !item.disabled) {
      if (sub?.index !== index) hoverTimer.current = setTimeout(() => openSub(index, false), 150);
    } else if (sub) {
      hoverTimer.current = setTimeout(() => setSub(null), 200);
    }
  };

  // As teclas que o menu usa não chegam a quem está em volta (nem ao Esc global, nem aos atalhos de uma letra).
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const handled = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    const focused = itemRefs.current.findIndex((el) => el !== null && el === document.activeElement);
    const at = focused >= 0 ? focused : active;
    const order = items.indexOf(at);
    switch (event.key) {
      case 'ArrowDown':
        handled();
        move(items[(order + 1) % items.length]);
        break;
      case 'ArrowUp':
        handled();
        move(items[order <= 0 ? items.length - 1 : order - 1]);
        break;
      case 'Home':
      case 'End':
        handled();
        move(event.key === 'Home' ? items[0] : items[items.length - 1]);
        break;
      case 'Enter':
      case ' ':
        handled();
        if (at >= 0) activate(at, true);
        break;
      case 'ArrowRight':
        // No submenu, a seta não volta a abrir o submenu do item de cima.
        if (nested) handled();
        else if (at >= 0 && itemAt(at).submenu && !itemAt(at).disabled) {
          handled();
          openSub(at, true);
        }
        break;
      case 'ArrowLeft':
        if (nested) {
          handled();
          onLeave('back');
        }
        break;
      case 'Escape':
        handled();
        onLeave(nested ? 'back' : 'escape');
        break;
      case 'Tab':
        // Sem preventDefault: o foco volta para quem abriu o menu e o Tab segue dali.
        event.stopPropagation();
        onLeave('tab');
        break;
      default:
        if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          handled();
          const key = plain(event.key);
          const next = [...items.slice(order + 1), ...items.slice(0, order + 1)];
          move(next.find((index) => plain(itemAt(index).label).startsWith(key)));
        }
    }
  };

  const subItem = sub ? itemAt(sub.index) : null;

  return createPortal(
    <div
      ref={ref}
      id={id}
      className="menu context-menu"
      role="menu"
      aria-label={label}
      aria-labelledby={labelledBy}
      tabIndex={-1}
      data-context-menu=""
      // Até ser medido, fica invisível no canto: é medido e posto no lugar antes de a tela ser desenhada.
      style={position ?? { left: 0, top: 0, visibility: 'hidden' }}
      onKeyDown={onKeyDown}
      // O foco fica no item, e arrastar o mouse aqui não seleciona texto.
      onMouseDown={(event) => event.preventDefault()}
      onContextMenu={(event) => event.preventDefault()}
      onMouseEnter={onPointerEnter}
    >
      {entries.map((entry, index) =>
        entry === 'separator' ? (
          <div key={`separator-${index}`} role="separator" className="menu-sep" />
        ) : (
          <button
            key={entry.key}
            ref={(el) => {
              itemRefs.current[index] = el;
            }}
            id={`${baseId}-${index}`}
            type="button"
            role={entry.checked === undefined ? 'menuitem' : entry.radio ? 'menuitemradio' : 'menuitemcheckbox'}
            aria-checked={entry.checked}
            aria-disabled={entry.disabled || undefined}
            aria-haspopup={entry.submenu ? 'menu' : undefined}
            aria-expanded={entry.submenu ? sub?.index === index : undefined}
            aria-controls={entry.submenu && sub?.index === index ? subId : undefined}
            aria-label={entry.label}
            aria-describedby={entry.hint ? `${baseId}-${index}-hint` : undefined}
            tabIndex={-1}
            className={`menu-item${index === active ? ' is-active' : ''}${entry.danger ? ' is-danger' : ''}`}
            // Só um movimento de verdade do mouse conta: o mouseenter também chega quando o menu aparece sob o ponteiro
            // parado, e aí um submenu abriria sozinho, longe do foco.
            onMouseMove={() => {
              if (pointed.current !== index) {
                pointed.current = index;
                enter(index);
              }
              hover(index);
            }}
            onMouseLeave={() => {
              if (pointed.current === index) pointed.current = -1;
            }}
            onClick={() => activate(index, false)}
          >
            <span className="menu-icon" aria-hidden>{entry.icon}</span>
            <span className="menu-label">{entry.label}</span>
            {entry.hint && <span className="menu-hint" id={`${baseId}-${index}-hint`}>{entry.hint}</span>}
            {entry.checked && <Check size={14} className="menu-check" aria-hidden />}
            {entry.submenu && <ChevronRight size={14} className="menu-more" aria-hidden />}
          </button>
        ),
      )}
      {sub && subItem?.submenu && (
        <MenuPanel
          key={sub.token}
          id={subId}
          entries={subItem.submenu}
          labelledBy={`${baseId}-${sub.index}`}
          placement={sub.placement}
          focusFirst={sub.focus}
          nested
          onChoose={onChoose}
          onLeave={(reason) => (reason === 'back' ? backFromSub() : onLeave(reason))}
          // O mouse chegou ao submenu: ele não fecha, e o item que o abriu continua destacado (e com o foco, se o foco
          // ainda não entrou no submenu: o mouse pode ter passado por outro item no caminho).
          onPointerEnter={() => {
            clearTimeout(hoverTimer.current);
            setActive(sub.index);
            if (!document.getElementById(subId)?.contains(document.activeElement)) itemRefs.current[sub.index]?.focus({ preventScroll: true });
          }}
        />
      )}
    </div>,
    document.body,
  );
}
