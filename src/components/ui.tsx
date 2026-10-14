import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type TextareaHTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, X } from 'lucide-react';
import type { Repo } from '../../shared/types.ts';
import { useStore } from '../store.ts';
import { hue, shortRepoName } from '../util.ts';

// ---------------------------------------------------------------- menu suspenso

export interface MenuItem {
  key: string;
  label: ReactNode;
  icon?: ReactNode;
  hint?: ReactNode;
  selected?: boolean;
  danger?: boolean;
  onSelect: () => void;
}

/**
 * Menu flutuante posicionado em `fixed` a partir do gatilho — não é cortado por
 * painéis com scroll. Fecha com Esc ou clique fora; aceita filtro por texto.
 */
export function Menu({
  trigger, items, multi = false, filter = false, width = 240, align = 'start', className = '',
}: {
  trigger: ReactNode;
  items: MenuItem[];
  multi?: boolean;
  filter?: boolean;
  width?: number;
  align?: 'start' | 'end';
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const visible = items.filter((item) => !query || String(item.label).toLowerCase().includes(query.toLowerCase()) || item.key.toLowerCase().includes(query.toLowerCase()));

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
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node) && !triggerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const choose = (item: MenuItem) => {
    item.onSelect();
    if (!multi) setOpen(false);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`menu-trigger ${className}`}
        onClick={(e) => {
          e.stopPropagation();
          setQuery('');
          setActive(0);
          setOpen((o) => !o);
        }}
      >
        {trigger}
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            className="menu"
            style={{ top: position.top, left: position.left, width }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                setOpen(false);
              } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, visible.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === 'Enter' && visible[active]) {
                e.preventDefault();
                choose(visible[active]);
              }
            }}
          >
            {filter ? (
              <input autoFocus className="menu-filter" placeholder="Filtrar…" value={query} onChange={(e) => { setQuery(e.target.value); setActive(0); }} />
            ) : (
              <input autoFocus className="menu-focus-sink" aria-hidden readOnly />
            )}
            <div className="menu-list">
              {visible.map((item, index) => (
                <button
                  key={item.key}
                  type="button"
                  className={`menu-item${index === active ? ' is-active' : ''}${item.danger ? ' is-danger' : ''}`}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => choose(item)}
                >
                  <span className="menu-icon">{item.icon}</span>
                  <span className="menu-label">{item.label}</span>
                  {item.hint && <span className="menu-hint">{item.hint}</span>}
                  {item.selected && <Check size={14} className="menu-check" />}
                </button>
              ))}
              {!visible.length && <div className="menu-empty">Nada encontrado</div>}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

// ---------------------------------------------------------------- modal

export function Modal({ title, onClose, children, width = 560, footer }: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  width?: number;
  footer?: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Com um menu aberto, o Esc fecha só o menu.
      if (e.key === 'Escape' && !document.querySelector('.menu')) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width }} role="dialog" aria-modal>
        <header className="modal-head">
          <div className="modal-title">{title}</div>
          <button className="icon-btn" onClick={onClose} aria-label="Fechar"><X size={16} /></button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------- pequenos componentes

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast is-${t.tone}`}>{t.text}</div>
      ))}
    </div>
  );
}

export function Markdown({ children }: { children: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{ a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" /> }}
      >
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

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

export function Field({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

/** Textarea que cresce com o conteúdo. */
export function AutoTextarea(props: TextareaHTMLAttributes<HTMLTextAreaElement> & { minRows?: number }) {
  const { minRows = 3, ...rest } = props;
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [props.value]);
  return <textarea ref={ref} rows={minRows} {...rest} />;
}
