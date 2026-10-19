import {
  Children, Component, cloneElement, isValidElement, useEffect, useId, useLayoutEffect, useRef, useState,
  type ErrorInfo, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject,
  type TextareaHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy, RotateCw, X } from 'lucide-react';
import type { Repo } from '../../shared/types.ts';
import { dismissToast, holdToasts, useStore } from '../store.ts';
import { hue, leaveTextField, modKey, shortRepoName } from '../util.ts';

// ---------------------------------------------------------------- camadas que fecham com Esc

type LayerKind = 'palette' | 'menu' | 'modal' | 'nav';

interface Layer {
  kind: LayerKind;
  escape: () => void;
}

/** Paleta, menus, modais e a gaveta de navegação abertos, na ordem em que abriram. */
const layers: Layer[] = [];

/**
 * Registra uma camada que fecha com Esc. Um Esc fecha só a camada de cima; o painel da
 * issue fica por baixo de todas e é tratado em App.tsx.
 */
export function useEscapeLayer(open: boolean, onEscape: () => void, kind: LayerKind): void {
  const latest = useRef(onEscape);
  useLayoutEffect(() => {
    latest.current = onEscape;
  });
  useEffect(() => {
    if (!open) return;
    const layer: Layer = { kind, escape: () => latest.current() };
    layers.push(layer);
    return () => {
      const index = layers.indexOf(layer);
      if (index !== -1) layers.splice(index, 1);
    };
  }, [open, kind]);
}

/** Há alguma camada aberta (de um destes tipos, se informados)? */
export function hasLayer(...kinds: LayerKind[]): boolean {
  return layers.some((layer) => !kinds.length || kinds.includes(layer.kind));
}

/** Esc global: fecha a camada de cima. Num modal, o primeiro Esc num campo com texto só tira o foco. */
export function escapeTopLayer(event: KeyboardEvent): boolean {
  const top = layers.at(-1);
  if (!top) return false;
  event.preventDefault();
  if (top.kind === 'modal' && leaveTextField(event.target)) return true;
  top.escape();
  return true;
}

// ---------------------------------------------------------------- diálogos: foco e fundo inerte

const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"])';
let inertDepth = 0;

/**
 * Comportamento de diálogo: o resto da interface (#root) fica inerte para o teclado e para
 * leitores de tela, o foco entra no diálogo (no campo com autoFocus ou no próprio diálogo)
 * e volta para onde estava quando ele fecha.
 */
export function useDialog(ref: RefObject<HTMLElement | null>): void {
  const [opener] = useState(() => document.activeElement as HTMLElement | null);
  useEffect(() => {
    const root = document.getElementById('root');
    if (inertDepth++ === 0) root?.setAttribute('inert', '');
    const box = ref.current;
    if (box && !box.contains(document.activeElement)) box.focus({ preventScroll: true });
    return () => {
      if (--inertDepth === 0) root?.removeAttribute('inert');
      // Só quando o diálogo saiu da tela de fato (no StrictMode o efeito também roda de novo sem
      // desmontar) e ninguém pegou o foco depois (um modal que abriu em seguida com autoFocus).
      const active = document.activeElement;
      if (!box?.isConnected && (!active || active === document.body) && opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [ref, opener]);
}

/**
 * Para onde vai o foco se `el` sair da tela (a issue excluída, ou cancelada com as canceladas ocultas): o item focável
 * mais perto dele no mesmo grupo (o card de baixo, o de cima ou, sem nenhum, o botão de nova issue da coluna) e, sem
 * nenhum, no grupo de fora. Medido enquanto `el` ainda está na tela; a função devolvida, chamada depois, só age se o
 * foco se perdeu (ficou no body), e vale o primeiro desses itens que continuar à vista.
 */
export function focusNearby(el: HTMLElement): () => void {
  const candidates: HTMLElement[] = [];
  for (let group = el.parentElement; group && group !== document.body && candidates.length < 4; group = group.parentElement) {
    const near = [...group.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.tabIndex >= 0 && !el.contains(x) && !x.contains(el));
    const after = near.find((x) => el.compareDocumentPosition(x) & Node.DOCUMENT_POSITION_FOLLOWING);
    const before = near.findLast((x) => el.compareDocumentPosition(x) & Node.DOCUMENT_POSITION_PRECEDING);
    for (const x of [after, before]) if (x && !candidates.includes(x)) candidates.push(x);
  }
  return () => {
    const active = document.activeElement;
    if (active && active !== document.body) return;
    candidates.find((x) => x.isConnected && !x.closest('[inert]') && x.getClientRects().length > 0)?.focus();
  };
}

/** Tab e Shift+Tab circulam dentro do diálogo, sem escapar para o que está por trás. */
export function trapTab(event: ReactKeyboardEvent<HTMLElement>): void {
  if (event.key !== 'Tab') return;
  const box = event.currentTarget;
  // Só o que o Tab alcança: opções com tabIndex -1 (as da paleta, por exemplo) são escolhidas pelas setas.
  const items = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.tabIndex >= 0 && el.getClientRects().length > 0);
  if (!items.length) {
    event.preventDefault();
    box.focus();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (event.shiftKey && (active === first || active === box)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

// ---------------------------------------------------------------- menu suspenso

export interface MenuItem {
  key: string;
  label: ReactNode;
  icon?: ReactNode;
  hint?: ReactNode;
  selected?: boolean;
  danger?: boolean;
  onSelect: () => void;
  /**
   * Botão direito no item (ou Shift+F10 com ele destacado): abre o menu de ações dele. `anchor` é o item na tela, e
   * `closeMenu` fecha este menu (depois de uma ação escolhida lá, por exemplo).
   */
  onContextMenu?: (event: ReactMouseEvent<HTMLElement>, anchor: HTMLElement, closeMenu: () => void) => void;
}

/**
 * Menu flutuante posicionado em `fixed` a partir do gatilho — não é cortado por painéis com
 * scroll. O foco fica no filtro (ou na lista) e o item destacado é o que o Enter escolhe:
 * setas e Home/End movem o destaque, Esc fecha e devolve o foco ao gatilho, Tab sai do menu.
 */
export function Menu({
  trigger, items, multi = false, filter = false, width = 240, align = 'start', className = '', label, onContextMenu,
}: {
  trigger: ReactNode;
  items: MenuItem[];
  multi?: boolean;
  filter?: boolean;
  width?: number;
  align?: 'start' | 'end';
  className?: string;
  /** Nome do gatilho para leitores de tela (e dica ao passar o mouse); use em gatilhos só com ícone. */
  label?: string;
  /** Botão direito no gatilho (aberto, o menu suspenso fecha antes, e o foco fica no gatilho). */
  onContextMenu?: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const id = useId();
  const listId = `${id}-list`;
  const optionId = (index: number) => `${id}-option-${index}`;

  const q = query.toLowerCase();
  const visible = items.filter((item) => !q || String(item.label).toLowerCase().includes(q) || item.key.toLowerCase().includes(q));
  const current = Math.min(active, visible.length - 1);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const height = Math.min(360, 44 + items.length * 32);
    const top = rect.bottom + 6 + height > window.innerHeight ? Math.max(8, rect.top - 6 - height) : rect.bottom + 6;
    const left = align === 'end' ? rect.right - width : rect.left;
    setPosition({ top, left: Math.max(8, Math.min(left, window.innerWidth - width - 8)) });
  }, [open, align, width, items.length]);

  useEffect(() => {
    if (!open) return;
    (filterRef.current ?? listRef.current)?.focus({ preventScroll: true });
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      // O menu do botão direito de um item, aberto por cima deste, não conta como fora.
      if (target instanceof Element && target.closest('[data-context-menu]')) return;
      if (!menuRef.current?.contains(target) && !triggerRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  // O item destacado sempre fica à vista, mesmo em listas longas.
  useEffect(() => {
    if (open && current >= 0) itemRefs.current[current]?.scrollIntoView({ block: 'nearest' });
  }, [open, current]);

  /** Fecha; por teclado ou ao escolher, o foco volta ao gatilho (num clique fora, fica onde foi clicado). */
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus({ preventScroll: true });
  };
  useEscapeLayer(open, () => close(true), 'menu');

  const show = () => {
    setQuery('');
    setActive(Math.max(0, items.findIndex((item) => item.selected)));
    setOpen(true);
  };

  const choose = (item: MenuItem) => {
    item.onSelect();
    if (!multi) close(true);
  };

  // As teclas que o menu usa não chegam a quem está em volta (um Ctrl+Enter de formulário, por exemplo).
  const onKeyDown = (event: ReactKeyboardEvent) => {
    const last = visible.length - 1;
    const handled = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    if (event.key === 'Escape') {
      handled();
      close(true);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      handled();
      setActive(Math.min(Math.max(current + (event.key === 'ArrowDown' ? 1 : -1), 0), last));
    } else if ((event.key === 'Home' || event.key === 'End') && !filter) {
      handled();
      setActive(event.key === 'Home' ? 0 : last);
    } else if (event.key === 'Enter' || (event.key === ' ' && !filter)) {
      handled();
      if (visible[current]) choose(visible[current]);
    } else if (event.key === 'Tab') {
      // Sem preventDefault: o Tab segue a partir do gatilho, como num <select>.
      close(true);
    }
  };

  const activeId = visible[current] ? optionId(current) : undefined;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        id={`${id}-trigger`}
        className={`menu-trigger ${className}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={label}
        title={label}
        onClick={(event) => {
          event.stopPropagation();
          if (open) setOpen(false);
          else show();
        }}
        onKeyDown={(event) => {
          if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !open) {
            event.preventDefault();
            show();
          }
        }}
        // O botão direito no gatilho fecha este menu suspenso: o menu do botão direito (o dele ou o da linha em volta,
        // como em "Abrir em…") não abre por cima dele.
        onContextMenu={(event) => {
          if (open) {
            setOpen(false);
            triggerRef.current?.focus({ preventScroll: true });
          }
          onContextMenu?.(event);
        }}
      >
        {trigger}
      </button>
      {open &&
        createPortal(
          <div ref={menuRef} className="menu" style={{ top: position.top, left: position.left, width }} onKeyDown={onKeyDown}>
            {filter && (
              <input
                ref={filterRef}
                className="menu-filter"
                placeholder="Filtrar…"
                role="combobox"
                aria-label="Filtrar"
                aria-expanded="true"
                aria-autocomplete="list"
                aria-controls={listId}
                aria-activedescendant={activeId}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActive(0);
                }}
              />
            )}
            <div
              ref={listRef}
              id={listId}
              className="menu-list"
              role="listbox"
              aria-labelledby={`${id}-trigger`}
              aria-multiselectable={multi || undefined}
              aria-activedescendant={filter ? undefined : activeId}
              tabIndex={filter ? undefined : -1}
              // Pelo mouse, vale o item clicado; pelo teclado (o foco fica na lista), o destacado.
              onContextMenu={(event) => {
                const option = event.target instanceof Element ? event.target.closest('[role="option"]') : null;
                const index = option ? itemRefs.current.indexOf(option as HTMLButtonElement) : current;
                const item = visible[index];
                const anchor = itemRefs.current[index];
                if (!item?.onContextMenu || !anchor) return;
                if (index !== current) setActive(index);
                item.onContextMenu(event, anchor, () => close(true));
              }}
            >
              {visible.map((item, index) => (
                <button
                  key={item.key}
                  ref={(el) => {
                    itemRefs.current[index] = el;
                  }}
                  id={optionId(index)}
                  type="button"
                  role="option"
                  aria-selected={Boolean(item.selected)}
                  tabIndex={-1}
                  className={`menu-item${index === current ? ' is-active' : ''}${item.danger ? ' is-danger' : ''}`}
                  onMouseDown={(event) => event.preventDefault()} // o foco fica no filtro/lista
                  onMouseMove={() => index !== current && setActive(index)}
                  onClick={() => choose(item)}
                >
                  <span className="menu-icon">{item.icon}</span>
                  <span className="menu-label">{item.label}</span>
                  {item.hint && <span className="menu-hint">{item.hint}</span>}
                  {item.selected && <Check size={14} className="menu-check" aria-hidden />}
                </button>
              ))}
            </div>
            {!visible.length && <div className="menu-empty">Nada encontrado</div>}
          </div>,
          document.body,
        )}
    </>
  );
}

// ---------------------------------------------------------------- modal

export function Modal({ title, onClose, children, width = 560, footer, dirty = false }: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  width?: number;
  footer?: ReactNode;
  /** Há algo digitado: fechar (Esc, clique fora ou X) pergunta antes de descartar. */
  dirty?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const requestClose = () => {
    if (!dirty || confirm('Descartar as alterações?')) onClose();
  };
  useEscapeLayer(true, requestClose, 'modal');
  useDialog(ref);

  return createPortal(
    // Com um menu do modal aberto, o clique fora fecha só o menu.
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !hasLayer('menu') && requestClose()}>
      <div ref={ref} className="modal" style={{ width }} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={trapTab}>
        <header className="modal-head">
          <div className="modal-title" id={titleId}>{title}</div>
          <button type="button" className="icon-btn" onClick={requestClose} aria-label="Fechar" title="Fechar (Esc)"><X size={16} /></button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------- avisos

/**
 * Avisos no canto da tela, anunciados por leitores de tela (erros com prioridade). Ficam
 * parados enquanto o mouse ou o foco estão sobre eles e enquanto a janela está em segundo plano.
 */
export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const boxRef = useRef<HTMLDivElement>(null);
  const shown = toasts.length > 0;

  useEffect(() => {
    const away = () => holdToasts('window', true);
    const back = () => holdToasts('window', false);
    window.addEventListener('blur', away);
    window.addEventListener('focus', back);
    return () => {
      window.removeEventListener('blur', away);
      window.removeEventListener('focus', back);
    };
  }, []);

  // Um aviso que sai da tela com o foco ou o mouse sobre ele não dispara o blur nem o mouseleave do
  // contêiner (o React ignora os eventos no meio da atualização). A cada mudança, o foco é conferido de
  // novo; sem avisos na tela, nada os segura.
  useEffect(() => {
    if (!toasts.length) holdToasts('hover', false);
    if (!boxRef.current?.contains(document.activeElement)) holdToasts('focus', false);
  }, [toasts]);

  // A pausa pelo mouse cai no primeiro movimento dele fora dos avisos.
  useEffect(() => {
    if (!shown) return;
    const onMove = (event: MouseEvent) => {
      if (!boxRef.current?.contains(event.target as Node | null)) holdToasts('hover', false);
    };
    document.addEventListener('mousemove', onMove, true);
    return () => document.removeEventListener('mousemove', onMove, true);
  }, [shown]);

  return createPortal(
    <div
      ref={boxRef}
      className="toasts"
      role="status"
      aria-live="polite"
      onMouseEnter={() => holdToasts('hover', true)}
      onMouseLeave={() => holdToasts('hover', false)}
      onFocus={() => holdToasts('focus', true)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && holdToasts('focus', false)}
    >
      {toasts.map((t) => (
        <div key={t.id} className={`toast is-${t.tone}`} role={t.tone === 'error' ? 'alert' : undefined}>
          <span className="toast-text">{t.text}</span>
          {t.action && (
            <button
              type="button"
              className="toast-action"
              onClick={() => {
                t.action?.run();
                dismissToast(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          <button type="button" className="toast-close" aria-label="Fechar aviso" title="Fechar" onClick={() => dismissToast(t.id)}>
            <X size={13} />
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------- pequenos componentes

const MARKDOWN: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
  // Imagens nunca carregam sozinhas: uma resposta do agente (talvez induzida por um arquivo
  // do repositório) poderia usar a URL da imagem para enviar dados para fora. Viram um link.
  img: ({ src, alt }) => {
    const url = typeof src === 'string' ? src : '';
    const text = `[imagem${alt ? `: ${alt}` : ''}]`;
    return /^https?:\/\//i.test(url)
      ? <a className="md-image" href={url} target="_blank" rel="noreferrer" title={url}>{text}</a>
      : <span className="md-image">{text}</span>;
  },
};

export function Markdown({ children }: { children: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN}>
        {children}
      </ReactMarkdown>
    </div>
  );
}

export function RepoChip({ repo, lit = false, onClick }: { repo: Repo; lit?: boolean; onClick?: () => void }) {
  return (
    <span className={`repo-chip${lit ? ' is-lit' : ''}${onClick ? ' is-clickable' : ''}`} title={repo.absPath} onClick={onClick}>
      <i style={{ background: hue(repo.name) }} />
      {shortRepoName(repo)}
    </span>
  );
}

/** Tecla(s) de atalho. "Ctrl" aparece como ⌘ no macOS, onde os atalhos aceitam as duas. */
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="kbd">
      {Children.map(children, (child) => (typeof child === 'string' ? child.replace(/\bCtrl\b/g, modKey()) : child))}
    </kbd>
  );
}

type FieldControlProps = { id?: string; 'aria-describedby'?: string };

/**
 * Rótulo, campo e dica. Com um único input/textarea/select, o rótulo é um <label> ligado a
 * ele. Com qualquer outra coisa (botões, menus, checkboxes), vira um grupo rotulado: dentro de
 * um <label>, clicar no rótulo ou na dica acionaria o primeiro botão do grupo.
 */
export function Field({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const single =
    isValidElement<FieldControlProps>(children) &&
    (children.type === 'input' || children.type === 'textarea' || children.type === 'select' || children.type === AutoTextarea);

  if (single) {
    const controlId = children.props.id ?? `${id}-control`;
    const describedBy = [children.props['aria-describedby'], hintId].filter(Boolean).join(' ') || undefined;
    return (
      <div className="field">
        <label className="field-label" htmlFor={controlId}>{label}</label>
        {cloneElement(children, { id: controlId, 'aria-describedby': describedBy })}
        {hint && <span className="field-hint" id={hintId}>{hint}</span>}
      </div>
    );
  }

  // Comodidade para o mouse: clicar no rótulo do grupo foca o campo de texto dele, se houver.
  const focusField = (event: ReactMouseEvent<HTMLElement>) =>
    event.currentTarget.parentElement
      ?.querySelector<HTMLElement>('input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]), textarea, select')
      ?.focus();

  return (
    <div className="field" role="group" aria-labelledby={`${id}-label`} aria-describedby={hintId}>
      <span className="field-label" id={`${id}-label`} onClick={focusField}>{label}</span>
      {children}
      {hint && <span className="field-hint" id={hintId}>{hint}</span>}
    </div>
  );
}

/** Textarea que cresce com o conteúdo até `maxRows` linhas; daí em diante, rola. */
export function AutoTextarea({ minRows = 3, maxRows = 12, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { minRows?: number; maxRows?: number }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const style = getComputedStyle(el);
    const px = (value: string) => parseFloat(value) || 0;
    const line = px(style.lineHeight) || px(style.fontSize) * 1.45;
    const borders = px(style.borderTopWidth) + px(style.borderBottomWidth);
    const max = line * Math.max(maxRows, minRows) + px(style.paddingTop) + px(style.paddingBottom) + borders;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight + borders, max)}px`;
  }, [rest.value, minRows, maxRows]);
  return <textarea ref={ref} rows={minRows} {...rest} />;
}

// ---------------------------------------------------------------- erros de interface

interface BoundaryProps {
  children: ReactNode;
  fallback?: (error: Error, reset: () => void) => ReactNode;
  /** Quando muda (outra issue aberta, painel fechado), o erro anterior é esquecido. */
  resetKey?: unknown;
}

/**
 * Segura um erro de renderização para ele não apagar a janela inteira. Sem `fallback`, mostra
 * a tela de recuperação; com `fallback`, quem usa decide (o painel da issue, por exemplo).
 */
export class ErrorBoundary extends Component<BoundaryProps, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: unknown): { error: Error } {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('[octo] erro na interface', error, info.componentStack);
  }

  componentDidUpdate(previous: BoundaryProps): void {
    if (this.state.error && previous.resetKey !== this.props.resetKey) this.reset();
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return this.props.fallback ? this.props.fallback(error, this.reset) : <CrashScreen error={error} />;
  }
}

/** "Algo deu errado": explica, recarrega e copia os detalhes para relatar o problema. */
export function CrashScreen({ error, compact = false, onClose }: { error: Error; compact?: boolean; onClose?: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    let version = '?';
    try {
      version = useStore.getState().meta?.version ?? '?';
    } catch {
      /* o próprio estado pode ser o problema */
    }
    const details = `${error.name}: ${error.message}\n\n${error.stack ?? ''}\n\nOcto ${version} · ${navigator.userAgent}`;
    void navigator.clipboard?.writeText(details).then(() => setCopied(true)).catch(() => undefined);
  };
  return (
    <div className={`crash${compact ? ' is-compact' : ''}`} role="alert">
      <h1>{compact ? 'Não foi possível mostrar este painel' : 'Algo deu errado'}</h1>
      <p>
        {compact
          ? 'Um erro interrompeu a exibição. O resto do Octo continua funcionando.'
          : 'A interface do Octo encontrou um erro e parou. Seus dados e os agentes em segundo plano não foram afetados: recarregar costuma resolver.'}
      </p>
      <pre className="crash-detail">{error.message || error.name}</pre>
      <div className="crash-actions">
        {onClose && <button type="button" className="primary-btn" onClick={onClose}>Fechar painel</button>}
        <button type="button" className={onClose ? 'ghost-btn' : 'primary-btn'} onClick={() => location.reload()}>
          <RotateCw size={14} /> Recarregar
        </button>
        <button type="button" className="ghost-btn" onClick={copy}>
          {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copiado' : 'Copiar detalhes'}
        </button>
        <a href="https://github.com/KazuoMurakami/octo-desktop/issues/new" target="_blank" rel="noreferrer">Relatar no GitHub</a>
      </div>
    </div>
  );
}
