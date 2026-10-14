import { useEffect, useState } from 'react';
import type { AccountConfig } from '../shared/types.ts';
import { api } from './api.ts';

// A configuração vem de arquivos e do `claude plugin list` (lento): guardamos por alguns segundos,
// para que modal de delegação, composer e tela de configuração não repitam a leitura.
const cache = new Map<string, { at: number; promise: Promise<AccountConfig> }>();
const listeners = new Set<() => void>();
/** Contas cuja próxima leitura deve pedir a lista de plugins de novo ao CLI. */
const fresh = new Set<string>();

function load(accountId: string, cwd: string | undefined): Promise<AccountConfig> {
  const key = `${accountId}|${cwd ?? ''}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 30_000) return hit.promise;
  const promise = api.accountConfig(accountId, cwd, fresh.delete(accountId));
  promise.catch(() => cache.delete(key));
  cache.set(key, { at: Date.now(), promise });
  return promise;
}

/** Descarta o cache da conta e avisa quem estiver exibindo a configuração dela. */
export function invalidateAccountConfig(accountId: string, refreshPlugins = false): void {
  if (refreshPlugins) fresh.add(accountId);
  for (const key of cache.keys()) if (key.startsWith(`${accountId}|`)) cache.delete(key);
  for (const listener of listeners) listener();
}

export function useAccountConfig(accountId: string | null | undefined, cwd?: string): { config: AccountConfig | null; loading: boolean } {
  const [config, setConfig] = useState<AccountConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const bump = () => setVersion((v) => v + 1);
    listeners.add(bump);
    return () => void listeners.delete(bump);
  }, []);

  useEffect(() => {
    if (!accountId) return setConfig(null);
    let alive = true;
    setLoading(true);
    load(accountId, cwd)
      .then((next) => alive && setConfig(next))
      .catch(() => alive && setConfig(null))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [accountId, cwd, version]);

  // Ao trocar de conta, não mostra a configuração da anterior.
  return { config: config?.accountId === accountId ? config : null, loading };
}

/** Valor de uma chave do settings.json como texto (ex.: model, effortLevel). */
export function setting(config: AccountConfig | null, key: string): string | null {
  const value = config?.settings?.[key];
  return typeof value === 'string' && value ? value : null;
}
