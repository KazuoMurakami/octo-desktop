import { useEffect, useState } from 'react';
import { Cpu, Gauge, ShieldCheck } from 'lucide-react';
import {
  EFFORTS, EFFORT_LABEL, MODEL_ALIASES, PERMISSION_HELP, PERMISSION_LABEL, PERMISSION_MODES,
  type Effort, type PermissionMode, type SessionSettings,
} from '../../shared/types.ts';
import { setting, useAccountConfig } from '../claudeConfig.ts';
import { Field, Menu } from './ui.tsx';

export function modelLabel(model: string | null): string {
  return MODEL_ALIASES.find((m) => m.id === model)?.label ?? model ?? 'Padrão';
}

/** Modelo da sessão: padrão da conta, um apelido (fable, opus…) ou um ID completo. */
export function ModelPicker({ value, onChange, accountDefault }: {
  value: string | null;
  onChange: (model: string | null) => void;
  accountDefault: string | null;
}) {
  const isCustomValue = value !== null && !MODEL_ALIASES.some((m) => m.id === value);
  const [customMode, setCustomMode] = useState(false);
  const custom = customMode || isCustomValue;
  const label = custom ? 'Outro modelo' : value === null ? `Padrão${accountDefault ? ` · ${modelLabel(accountDefault)}` : ''}` : modelLabel(value);
  return (
    <div className="picker-with-input">
      <Menu
        className="prop-btn"
        width={290}
        trigger={<><Cpu size={13} /> {label}</>}
        items={[
          {
            key: 'default', label: 'Padrão da conta', hint: accountDefault ?? 'settings.json', selected: !custom && value === null,
            onSelect: () => { setCustomMode(false); onChange(null); },
          },
          ...MODEL_ALIASES.map((m) => ({
            key: m.id, label: m.label, hint: m.hint, selected: !custom && value === m.id,
            onSelect: () => { setCustomMode(false); onChange(m.id); },
          })),
          { key: 'custom', label: 'Outro (ID completo)…', selected: custom, onSelect: () => setCustomMode(true) },
        ]}
      />
      {custom && <CustomModelInput value={isCustomValue ? value : null} onCommit={onChange} />}
    </div>
  );
}

/** ID de modelo digitado: só vale ao sair do campo ou com Enter, não a cada tecla. */
function CustomModelInput({ value, onCommit }: { value: string | null; onCommit: (model: string | null) => void }) {
  const [draft, setDraft] = useState(value ?? '');
  useEffect(() => setDraft(value ?? ''), [value]);
  const commit = () => {
    const next = draft.trim() || null;
    if (next !== value) onCommit(next);
  };
  return (
    <input
      autoFocus={!value}
      className="input is-compact mono"
      placeholder="ex.: claude-opus-5-5"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        }
      }}
    />
  );
}

/** Esforço (--effort). null = o que estiver no settings.json da conta. */
export function EffortPicker({ value, onChange, accountDefault, compact = false }: {
  value: Effort | null;
  onChange: (effort: Effort | null) => void;
  accountDefault: string | null;
  compact?: boolean;
}) {
  const defaultLabel = `Padrão${accountDefault ? ` · ${EFFORT_LABEL[accountDefault as Effort] ?? accountDefault}` : ''}`;
  if (compact) {
    return (
      <Menu
        className="prop-btn"
        width={220}
        trigger={<><Gauge size={13} /> {value ? EFFORT_LABEL[value] : defaultLabel}</>}
        items={[
          { key: 'default', label: 'Padrão da conta', hint: accountDefault ?? '', selected: value === null, onSelect: () => onChange(null) },
          ...EFFORTS.map((e) => ({ key: e, label: EFFORT_LABEL[e], hint: e, selected: value === e, onSelect: () => onChange(e) })),
        ]}
      />
    );
  }
  return (
    <div className="segmented is-wide">
      <button type="button" className={value === null ? 'is-on' : ''} onClick={() => onChange(null)} title={`Usa o effortLevel da conta${accountDefault ? ` (${accountDefault})` : ''}`}>
        Padrão
      </button>
      {EFFORTS.map((e) => (
        <button type="button" key={e} className={value === e ? 'is-on' : ''} onClick={() => onChange(e)} title={e}>{EFFORT_LABEL[e]}</button>
      ))}
    </div>
  );
}

export function PermissionPicker({ value, onChange }: { value: PermissionMode; onChange: (mode: PermissionMode) => void }) {
  return (
    <Menu
      className="prop-btn"
      width={360}
      trigger={<><ShieldCheck size={13} /> {PERMISSION_LABEL[value]}</>}
      items={PERMISSION_MODES.map((m) => ({
        key: m,
        label: <span className="two-line"><strong>{PERMISSION_LABEL[m]}</strong><small>{PERMISSION_HELP[m]}</small></span>,
        selected: m === value,
        danger: m === 'bypassPermissions',
        onSelect: () => onChange(m),
      }))}
    />
  );
}

/**
 * As opções de uma sessão, como as flags do `claude`: modelo, effort, permissões
 * e, em "Mais opções", agente, modelo reserva, pastas extras e orçamento.
 */
export function SessionSettingsForm({ settings, onChange, accountId, cwd, mode }: {
  settings: SessionSettings;
  onChange: (changes: Partial<SessionSettings>) => void;
  accountId: string;
  cwd?: string;
  mode: 'headless' | 'terminal';
}) {
  const { config } = useAccountConfig(accountId, cwd);
  const agents = config?.items.filter((i) => i.kind === 'agent') ?? [];
  // Abre 'Mais opções' já no início se algo ali estiver preenchido; depois, quem decide é você.
  const [advancedOpen] = useState(() => Boolean(settings.agent || settings.fallbackModel || settings.addDirs.length || settings.maxBudgetUsd));

  return (
    <div className="session-settings">
      <div className="settings-row">
        <Field label="Modelo">
          <ModelPicker value={settings.model} onChange={(model) => onChange({ model })} accountDefault={setting(config, 'model')} />
        </Field>
        <Field label="Permissões" hint={PERMISSION_HELP[settings.permissionMode]}>
          <PermissionPicker value={settings.permissionMode} onChange={(permissionMode) => onChange({ permissionMode })} />
        </Field>
      </div>
      <Field label="Esforço (effort)" hint="Quanto o modelo pensa antes de agir. Mais esforço: respostas melhores, mais lentas e mais caras.">
        <EffortPicker value={settings.effort} onChange={(effort) => onChange({ effort })} accountDefault={setting(config, 'effortLevel')} />
      </Field>

      <details className="advanced" open={advancedOpen}>
        <summary>Mais opções do CLI</summary>
        <div className="settings-row">
          <Field label="Agente" hint="Um dos seus subagentes como agente principal (--agent).">
            <Menu
              className="prop-btn"
              width={320}
              filter
              trigger={settings.agent ?? 'Nenhum'}
              items={[
                { key: '', label: 'Nenhum', selected: !settings.agent, onSelect: () => onChange({ agent: null }) },
                ...agents.map((a) => ({
                  key: a.name, label: a.name, hint: a.source === 'plugin' ? 'plugin' : a.source === 'project' ? 'projeto' : '',
                  selected: settings.agent === a.name, onSelect: () => onChange({ agent: a.name }),
                })),
              ]}
            />
          </Field>
          <Field label="Modelo reserva" hint="Usado se o principal estiver sobrecarregado (--fallback-model).">
            <input
              className="input mono"
              placeholder="ex.: sonnet"
              value={settings.fallbackModel ?? ''}
              onChange={(e) => onChange({ fallbackModel: e.target.value.trim() || null })}
            />
          </Field>
        </div>
        <Field label="Pastas extras" hint="Uma por linha. O Claude também pode ler e editar nelas (--add-dir).">
          <textarea
            className="mono"
            rows={2}
            placeholder={'C:\\outro\\repositorio'}
            value={settings.addDirs.join('\n')}
            onChange={(e) => onChange({ addDirs: e.target.value.split('\n') })}
            onBlur={() => onChange({ addDirs: settings.addDirs.map((d) => d.trim()).filter(Boolean) })}
          />
        </Field>
        {mode === 'headless' && (
          <Field label="Orçamento máximo (US$)" hint="Interrompe a execução ao atingir o valor (--max-budget-usd).">
            <input
              className="input"
              type="number"
              min={0}
              step={0.5}
              placeholder="sem limite"
              value={settings.maxBudgetUsd ?? ''}
              onChange={(e) => onChange({ maxBudgetUsd: Number(e.target.value) > 0 ? Number(e.target.value) : null })}
            />
          </Field>
        )}
      </details>
    </div>
  );
}
