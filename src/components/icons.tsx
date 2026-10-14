import type { AccountStatus, ClaudeAccount, IssueStatus, Priority, SessionState } from '../../shared/types.ts';

const STATUS_COLOR: Record<IssueStatus, string> = {
  backlog: 'var(--st-backlog)',
  todo: 'var(--st-todo)',
  in_progress: 'var(--st-progress)',
  in_review: 'var(--st-review)',
  done: 'var(--st-done)',
  canceled: 'var(--st-canceled)',
};

/** Ícones de status no estilo do Linear: o preenchimento do círculo indica o avanço. */
export function StatusIcon({ status, size = 14 }: { status: IssueStatus; size?: number }) {
  const color = STATUS_COLOR[status];
  const r = 6;
  const pie = (fraction: number) => {
    const angle = fraction * Math.PI * 2;
    const x = 7 + 3.5 * Math.sin(angle);
    const y = 7 - 3.5 * Math.cos(angle);
    return `M7 7 L7 3.5 A3.5 3.5 0 ${fraction > 0.5 ? 1 : 0} 1 ${x} ${y} Z`;
  };
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" className="status-icon" aria-label={status}>
      {status === 'backlog' && <circle cx="7" cy="7" r={r} fill="none" stroke={color} strokeWidth="1.5" strokeDasharray="1.6 1.9" />}
      {status === 'todo' && <circle cx="7" cy="7" r={r} fill="none" stroke={color} strokeWidth="1.5" />}
      {(status === 'in_progress' || status === 'in_review') && (
        <>
          <circle cx="7" cy="7" r={r} fill="none" stroke={color} strokeWidth="1.5" />
          <path d={pie(status === 'in_progress' ? 0.5 : 0.75)} fill={color} />
        </>
      )}
      {status === 'done' && (
        <>
          <circle cx="7" cy="7" r="6.75" fill={color} />
          <path d="M4.2 7.2 6.1 9 9.8 5.2" fill="none" stroke="var(--bg)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
      {status === 'canceled' && (
        <>
          <circle cx="7" cy="7" r="6.75" fill={color} />
          <path d="M4.9 4.9 9.1 9.1M9.1 4.9 4.9 9.1" stroke="var(--bg)" strokeWidth="1.5" strokeLinecap="round" />
        </>
      )}
    </svg>
  );
}

export function PriorityIcon({ priority, size = 14 }: { priority: Priority; size?: number }) {
  if (priority === 1) {
    return (
      <svg width={size} height={size} viewBox="0 0 14 14" aria-label="Urgente">
        <rect x="1" y="1" width="12" height="12" rx="3" fill="var(--urgent)" />
        <path d="M7 3.8v4" stroke="var(--bg)" strokeWidth="1.8" strokeLinecap="round" />
        <circle cx="7" cy="10.2" r="1" fill="var(--bg)" />
      </svg>
    );
  }
  if (priority === 0) {
    return (
      <svg width={size} height={size} viewBox="0 0 14 14" aria-label="Sem prioridade">
        {[2.5, 6, 9.5].map((x) => <rect key={x} x={x} y="6.3" width="2" height="1.4" rx=".7" fill="var(--text-3)" />)}
      </svg>
    );
  }
  const filled = 5 - priority; // alta = 3 barras, média = 2, baixa = 1
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" aria-label={`Prioridade ${priority}`}>
      {[0, 1, 2].map((i) => (
        <rect key={i} x={1.5 + i * 4} y={8 - i * 3} width="3" height={5 + i * 3} rx="1"
          fill={i < filled ? 'var(--text-2)' : 'var(--border-strong)'} />
      ))}
    </svg>
  );
}

/** Marca do agente: um núcleo com órbita — o Claude rodando no centro da pasta, enxergando os repos ao redor. */
export function OrbitMark({ size = 16, active = false }: { size?: number; active?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" className={active ? 'orbit is-active' : 'orbit'}>
      <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeOpacity=".35" strokeWidth="1.2" />
      <circle cx="10" cy="10" r="3.2" fill="currentColor" />
      <circle className="orbit-moon" cx="18" cy="10" r="1.6" fill="currentColor" />
    </svg>
  );
}

export function AccountAvatar({ account, status, size = 18 }: { account?: ClaudeAccount | null; status?: AccountStatus; size?: number }) {
  if (!account) {
    return <span className="avatar is-empty" style={{ width: size, height: size }} />;
  }
  const initials = account.name.slice(0, 1).toUpperCase();
  return (
    <span
      className="avatar"
      title={`${account.name}${status?.email ? ` · ${status.email}` : ''}`}
      style={{ width: size, height: size, background: account.color, fontSize: size * 0.5 }}
    >
      {initials}
      {status && <i className={`avatar-dot ${status.loggedIn ? 'is-on' : 'is-off'}`} />}
    </span>
  );
}

export const SESSION_STATE_LABEL: Record<SessionState, string> = {
  pending: 'Na fila',
  active: 'Trabalhando',
  awaiting_input: 'Aguardando você',
  complete: 'Concluída',
  error: 'Erro',
  stopped: 'Interrompida',
  terminal: 'No terminal',
};

export function SessionBadge({ state }: { state: SessionState }) {
  return (
    <span className={`session-badge is-${state}`}>
      {state === 'active' || state === 'pending' ? <OrbitMark size={12} active /> : <i />}
      {SESSION_STATE_LABEL[state]}
    </span>
  );
}
