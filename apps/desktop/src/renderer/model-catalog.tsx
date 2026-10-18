import { Check, Plus, Search, Star, X } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import type { DesktopModelOption } from '../shared/contract';
import { t } from './i18n';
import { ErrorNotice } from './ErrorNotice';
import { PaneSurfaceGate } from './PaneSurfaceGate';
import { record } from './record-utils';
import {
  modelDisplayName,
  modelOptionDescription,
  ProviderIcon,
  providerDisplayName,
  providerDisplayRank,
} from './provider-display';
import type { RecordValue } from './desktop-types';

const RECENT_MODELS_KEY = 'mixdog.desktop-recent-models';
const RECENT_MODELS_LIMIT = 7;
const FAVORITE_MODELS_KEY = 'mixdog.desktop-favorite-models';
// A drilled catalog can unmount between choices; acknowledgement order must
// not rewind recents across catalog instances.
let latestModelChoice = 0;

function providerSetupEntries(value: unknown): Array<RecordValue & { group: 'api' | 'oauth' | 'local' }> {
  const setup = record(value);
  return (['api', 'oauth', 'local'] as const).flatMap((group) => {
    const entries = setup[group];
    return Array.isArray(entries)
      ? entries.map(record).map((entry) => ({ ...entry, group }) as RecordValue & { group: typeof group })
      : [];
  });
}

/** Resolve generated provider ids to their setup names. */
export function customProviderDisplayNames(providerSetup: unknown): Record<string, string> {
  if (providerSetup == null) return {};
  const names: Record<string, string> = {};
  for (const entry of providerSetupEntries(providerSetup)) {
    const id = String(entry.id || entry.provider || '').trim();
    const name = String(entry.name || entry.label || '').trim();
    if (id && name) names[id] = name;
  }
  return names;
}

/** Setup names apply only to custom providers; built-ins keep curated labels. */
export function resolveProviderDisplayName(id: string, providerNames?: Record<string, string>): string {
  return (id.startsWith('custom-') && providerNames?.[id]) || providerDisplayName(id);
}

export function filterConfiguredModels(
  models: DesktopModelOption[],
  providerSetup: unknown,
  providerSetupError = ''
): DesktopModelOption[] {
  if (providerSetup == null || providerSetupError) return models;
  const entries = providerSetupEntries(providerSetup);
  return models.filter((model) => {
    const provider = entries.find((entry) => String(entry.id || entry.provider || '') === model.provider);
    if (!provider) return false;
    // Hidden by the effective row or by the model's own v2 override (a server
    // window receives the desktop's hidden models as overrides).
    const hidden =
      provider.custom === true &&
      ((Array.isArray(provider.models) &&
        provider.models.map(record).some((row) => row.id === model.model && row.hidden === true)) ||
        (Object.hasOwn(record(provider.modelOverrides), model.model) &&
          record(record(provider.modelOverrides)[model.model]).hidden === true));
    if (record(providerSetup).managedByClient === true) return provider.usable === true && !hidden;
    if (provider.custom === true) {
      // An invalid stored config (`usable: false` + configError) cannot run.
      if (provider.usable === false || provider.configError) return false;
      return !hidden && provider.enabled !== false && (provider.authenticated !== false || provider.auth === 'none');
    }
    return provider.group === 'local'
      ? provider.detected === true && provider.enabled === true
      : provider.authenticated === true;
  });
}

/** Touch surfaces raise the on-screen keyboard on focus. */
function coarsePointer(): boolean {
  try {
    return window.matchMedia?.('(pointer: coarse)').matches ?? false;
  } catch {
    return false;
  }
}

function modelKey(option: DesktopModelOption, scope = ''): string {
  return `${scope}model:${option.provider}:${option.model}`;
}

function readRecentModelKeys(): string[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(RECENT_MODELS_KEY) || '[]');
    return Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === 'string').slice(0, RECENT_MODELS_LIMIT)
      : [];
  } catch {
    return [];
  }
}

function writeRecentModelKeys(keys: string[]): void {
  try {
    window.localStorage.setItem(RECENT_MODELS_KEY, JSON.stringify(keys));
  } catch {
    // Selection still works when storage is unavailable.
  }
}

// Favorites keep keys of models that are currently unavailable; they only
// render while the catalog lists them.
function readFavoriteModelKeys(fallback: string[] = []): string[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(FAVORITE_MODELS_KEY) || '[]');
    return Array.isArray(value) ? [...new Set(value.filter((entry): entry is string => typeof entry === 'string'))] : [];
  } catch {
    return fallback;
  }
}

function writeFavoriteModelKeys(keys: string[]): void {
  try {
    window.localStorage.setItem(FAVORITE_MODELS_KEY, JSON.stringify(keys));
  } catch {
    // The star still toggles for this session when storage is unavailable.
  }
}

function emptyCatalogText(loading: boolean, hasQuery: boolean): string {
  if (loading) return t('Loading models…');
  return hasQuery ? t('No matching models.') : t('No connected provider models.');
}

export function ModelCatalog({
  models,
  provider,
  model,
  providerNames,
  active = true,
  catalogLoaded = true,
  catalogRefreshing = false,
  catalogError = '',
  providerSetupError = '',
  onSelect,
  onOpenProviders,
  onClose,
}: {
  models: DesktopModelOption[];
  provider: string;
  model: string;
  /** Setup-derived display names (custom providers), keyed by provider id. */
  providerNames?: Record<string, string>;
  active?: boolean;
  catalogLoaded?: boolean;
  catalogRefreshing?: boolean;
  catalogError?: string;
  providerSetupError?: string;
  onSelect(option: DesktopModelOption): unknown;
  onOpenProviders?: () => void;
  onClose(): void;
}) {
  const headingId = useId();
  const [query, setQuery] = useState('');
  const [activeRowKey, setActiveRowKey] = useState('');
  const [recentModelKeys, setRecentModelKeys] = useState<string[]>(readRecentModelKeys);
  const [favoriteModelKeys, setFavoriteModelKeys] = useState<string[]>(readFavoriteModelKeys);
  const dialog = useRef<HTMLElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const modelList = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // The composer's flyout keeps this catalog MOUNTED while it is hidden, so
    // the typed filter outlived its close and still trimmed the list at the
    // next open (user: 모델 선택하고 닫았는데 타이핑한게 남아있지 않게). The
    // close drops the query; the open re-reads recents and re-centers.
    if (!active) {
      setQuery('');
      return;
    }
    setRecentModelKeys(readRecentModelKeys());
    setFavoriteModelKeys(readFavoriteModelKeys());
    // Opening the list must not summon the keyboard on a phone: it covered
    // half the catalog before a single row was read (user: 검색창 터치도 안
    // 했는데 바로 타이핑창 열리게 하지 말고). The field waits for a tap.
    if (!coarsePointer()) search.current?.focus({ preventScroll: true });
    modelList.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'center' });
  }, [active]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: query is a deliberate trigger; a new filter resets the list scroll.
  useEffect(() => {
    if (active && modelList.current) modelList.current.scrollTop = 0;
  }, [active, query]);

  const resolveProviderLabel = useCallback(
    (id: string) => resolveProviderDisplayName(id, providerNames),
    [providerNames]
  );
  const providerEntries = useMemo(() => {
    const entries = new Map<string, DesktopModelOption[]>();
    for (const option of models) {
      const options = entries.get(option.provider) || [];
      options.push(option);
      entries.set(option.provider, options);
    }
    return [...entries].sort(
      ([left], [right]) =>
        providerDisplayRank(left) - providerDisplayRank(right) ||
        resolveProviderLabel(left).localeCompare(resolveProviderLabel(right)) ||
        left.localeCompare(right)
    );
  }, [models, resolveProviderLabel]);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matchesQuery = (option: DesktopModelOption) =>
    !normalizedQuery ||
    `${option.model} ${option.display} ${modelDisplayName(option.model, option.provider, option.display)} ${modelOptionDescription(option)} ${resolveProviderLabel(option.provider)}`
      .toLocaleLowerCase()
      .includes(normalizedQuery);
  const visibleProviderEntries = providerEntries
    .map(([entryProvider, options]) => [entryProvider, options.filter(matchesQuery)] as const)
    .filter(([, options]) => options.length > 0);
  const recentModels = recentModelKeys.flatMap((key) => {
    const option = models.find((entry) => modelKey(entry) === key);
    return option && matchesQuery(option) ? [option] : [];
  });
  const favoriteModels = favoriteModelKeys.flatMap((key) => {
    const option = models.find((entry) => modelKey(entry) === key);
    return option && matchesQuery(option) ? [option] : [];
  });
  const renderedKeys = [
    ...favoriteModels.map((option) => modelKey(option, 'favorite:')),
    ...recentModels.map((option) => modelKey(option, 'recent:')),
    ...visibleProviderEntries.flatMap(([, options]) => options.map((option) => modelKey(option))),
  ];
  const defaultActiveRowKey = () => {
    for (const [scope, scoped] of [
      ['favorite:', favoriteModels],
      ['recent:', recentModels],
    ] as const) {
      const match = scoped.find((option) => option.provider === provider && option.model === model);
      if (match) return modelKey(match, scope);
    }
    const visibleModels = visibleProviderEntries.flatMap(([, options]) => options);
    const preferred =
      visibleModels.find((option) => option.provider === provider && option.model === model) || visibleModels[0];
    return preferred ? modelKey(preferred) : '';
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: the derived lists are recomputed each render; the primitive inputs (normalizedQuery, models, recentModelKeys) are the intended triggers.
  useEffect(() => {
    if (active) setActiveRowKey(defaultActiveRowKey());
  }, [active, model, normalizedQuery, models, provider, recentModelKeys]);
  // Starring never moves the highlighted row unless its row left the list.
  // biome-ignore lint/correctness/useExhaustiveDependencies: favoriteModelKeys is the trigger; the derived lists are recomputed each render.
  useEffect(() => {
    if (active) setActiveRowKey((current) => (renderedKeys.includes(current) ? current : defaultActiveRowKey()));
  }, [favoriteModelKeys]);

  const focusRow = (index: number) => {
    const options = Array.from(
      dialog.current?.querySelectorAll<HTMLButtonElement>('.model-list [role="option"]') || []
    );
    const target = options[Math.max(0, Math.min(index, options.length - 1))];
    if (!target) return;
    setActiveRowKey(target.dataset.rowKey || '');
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'nearest' });
  };
  const toggleFavorite = (option: DesktopModelOption) => {
    const key = modelKey(option);
    // Re-read so another catalog instance's stars are not overwritten.
    const stored = readFavoriteModelKeys(favoriteModelKeys);
    const next = stored.includes(key) ? stored.filter((entry) => entry !== key) : [...stored, key];
    writeFavoriteModelKeys(next);
    setFavoriteModelKeys(next);
    // A removed Favorites row takes its star with it; keep keyboard focus in the list.
    window.requestAnimationFrame(() => {
      if (dialog.current?.contains(document.activeElement)) return;
      const candidates = Array.from(
        dialog.current?.querySelectorAll<HTMLButtonElement>('.model-favorite-toggle') || []
      );
      (candidates.find((button) => button.dataset.modelKey === key) || candidates[0])?.focus({ preventScroll: true });
    });
  };
  const navigateRows = (event: React.KeyboardEvent, fromSearch = false) => {
    if (event.key === 'Enter' && fromSearch && !event.nativeEvent.isComposing) {
      const target = Array.from(
        dialog.current?.querySelectorAll<HTMLButtonElement>('.model-list [role="option"]') || []
      ).find((option) => option.dataset.rowKey === activeRowKey);
      if (target) {
        event.preventDefault();
        target.click();
      }
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const options = Array.from(
      dialog.current?.querySelectorAll<HTMLButtonElement>('.model-list [role="option"]') || []
    );
    if (!options.length) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Home') return focusRow(0);
    if (event.key === 'End') return focusRow(options.length - 1);
    if (fromSearch) {
      const initialized = options.findIndex((option) => option.dataset.rowKey === activeRowKey);
      if (initialized >= 0) return focusRow(initialized);
      return focusRow(event.key === 'ArrowDown' ? 0 : options.length - 1);
    }
    // A row's star carries the same row key, so arrows continue from its row.
    const focusedKey = (document.activeElement as HTMLElement | null)?.dataset.rowKey;
    const current = options.findIndex((option) => option.dataset.rowKey === focusedKey);
    focusRow(current + (event.key === 'ArrowDown' ? 1 : -1));
  };
  const choose = async (option: DesktopModelOption) => {
    const token = ++latestModelChoice;
    // Selection owns this close, not the eventual persistence reply. A late
    // reply must never close a menu the user has opened in the meantime.
    onClose();
    try {
      const selected = await onSelect(option);
      if (selected === false || token !== latestModelChoice) return;
      const key = modelKey(option);
      const next = [key, ...readRecentModelKeys().filter((entry) => entry !== key)].slice(0, RECENT_MODELS_LIMIT);
      writeRecentModelKeys(next);
    } catch {
      // The mutation owner reports failure. Do not move the reopened list or
      // overwrite a newer choice's history while handling an old response.
    }
  };
  const renderModelOption = (option: DesktopModelOption, scope = '') => {
    const selected = option.provider === provider && option.model === model;
    const key = modelKey(option, scope);
    return (
      <button
        type="button"
        className="model-option-row"
        role="option"
        aria-selected={selected}
        key={key}
        data-row-key={key}
        data-active={activeRowKey === key}
        tabIndex={activeRowKey === key ? 0 : -1}
        onKeyDown={(event) => navigateRows(event)}
        onMouseMove={() => setActiveRowKey(key)}
        onClick={() => void choose(option)}
      >
        <span className="model-row-copy">
          <span className="model-row-title">
            <strong>
              {modelDisplayName(option.model, option.provider, option.display)}
              {scope !== '' && (
                <span className="model-row-source">{` (${resolveProviderLabel(option.provider)})`}</span>
              )}
            </strong>
          </span>
        </span>
        {selected && (
          <span className="route-selection-check">
            <Check size={14} aria-hidden="true" />
          </span>
        )}
      </button>
    );
  };

  // Options stay the only children of their listbox; each row's star lives in
  // a parallel column of equal-height rows, so no button nests in an option.
  const renderModelItems = (options: DesktopModelOption[], scope: string, labelledBy: string) => (
    <div className="model-items">
      <div className="model-options" role="listbox" aria-labelledby={labelledBy}>
        {options.map((option) => renderModelOption(option, scope))}
      </div>
      <div className="model-favorite-actions">
        {options.map((option) => {
          const favorite = favoriteModelKeys.includes(modelKey(option));
          const name = `${modelDisplayName(option.model, option.provider, option.display)} (${resolveProviderLabel(option.provider)})`;
          const label = favorite
            ? t('Remove {{model}} from favorites', { model: name })
            : t('Add {{model}} to favorites', { model: name });
          return (
            <button
              type="button"
              className="model-favorite-toggle"
              key={modelKey(option, scope)}
              data-row-key={modelKey(option, scope)}
              data-model-key={modelKey(option)}
              data-favorite={favorite}
              aria-label={label}
              data-tooltip={favorite ? t('Remove from favorites') : t('Add to favorites')}
              onKeyDown={(event) => navigateRows(event)}
              onClick={() => toggleFavorite(option)}
            >
              <Star size={14} aria-hidden="true" fill={favorite ? 'currentColor' : 'none'} />
            </button>
          );
        })}
      </div>
    </div>
  );

  return (
    <section
      ref={dialog}
      className="model-catalog-panel"
      role="dialog"
      aria-modal="false"
      aria-label={t('Select model')}
      tabIndex={-1}
    >
      <div className="model-catalog-body">
        <PaneSurfaceGate ready={catalogLoaded || models.length > 0} label={t('Loading models…')}>
          <div className="model-catalog-list">
            <div className="model-search-wrapper">
              <div className="model-search">
                <div className="model-search-container">
                  <Search size={16} aria-hidden="true" />
                  <input
                    ref={search}
                    type="text"
                    value={query}
                    placeholder={t('Search models…')}
                    aria-label={t('Search models')}
                    autoComplete="off"
                    spellCheck={false}
                    onInput={(event) => setQuery(event.currentTarget.value)}
                    onKeyDown={(event) => navigateRows(event, true)}
                  />
                </div>
                {query && (
                  <button
                    type="button"
                    data-component="icon-button"
                    onClick={() => {
                      setQuery('');
                      search.current?.focus();
                    }}
                    aria-label={t('Clear picker search')}
                  >
                    <X size={14} />
                  </button>
                )}
              </div>
              {onOpenProviders && (
                <button
                  type="button"
                  className="model-provider-add"
                  aria-label={t('Add provider')}
                  data-tooltip={t('Add provider')}
                  onClick={onOpenProviders}
                >
                  <Plus size={16} aria-hidden="true" />
                </button>
              )}
            </div>
            <div ref={modelList} className="model-list" role="group" aria-label={t('Available models')}>
              {catalogError && <ErrorNotice error={catalogError} role="status" />}
              {providerSetupError && (
                <p className="model-notice" role="status">
                  {t('Provider status is temporarily unavailable. Try again.')}
                </p>
              )}
              {renderedKeys.length === 0 && (
                <p className="model-empty">
                  {emptyCatalogText(catalogRefreshing || !catalogLoaded, Boolean(normalizedQuery))}
                </p>
              )}
              {favoriteModels.length > 0 && (
                <section className="model-group model-group--favorites">
                  <h3 id={`${headingId}-favorites`}>{t('Favorites')}</h3>
                  {renderModelItems(favoriteModels, 'favorite:', `${headingId}-favorites`)}
                </section>
              )}
              {recentModels.length > 0 && (
                <section className="model-group model-group--recent">
                  <h3 id={`${headingId}-recent`}>{t('Recent')}</h3>
                  {renderModelItems(recentModels, 'recent:', `${headingId}-recent`)}
                </section>
              )}
              {visibleProviderEntries.map(([entryProvider, options]) => (
                <section className="model-group model-group--provider" key={entryProvider}>
                  <h3 id={`${headingId}-provider-${entryProvider}`}>
                    <span className="model-provider-heading">
                      <ProviderIcon provider={entryProvider} />
                      <span>{resolveProviderLabel(entryProvider)}</span>
                    </span>
                  </h3>
                  {renderModelItems(options, '', `${headingId}-provider-${entryProvider}`)}
                </section>
              ))}
            </div>
          </div>
        </PaneSurfaceGate>
      </div>
    </section>
  );
}
