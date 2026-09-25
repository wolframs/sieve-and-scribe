/**
 * Shared model-<select> wiring for the extension's plain-document surfaces
 * (popup, options), so they present the SAME choices as the chat header picker:
 * grouped favorites + live curated catalog, All-models search, catalog refresh,
 * and free-form custom entry. The chat panel keeps its own implementation only
 * because it lives in a shadow root, where native <datalist> doesn't work.
 *
 * The wired select never commits a special `__*` value: specials synchronously
 * revert the select before opening the inline editor, and every real model id
 * lands via onCommit with select.value already set to it.
 */
import { getModelChoicesFor, getFullModelListFor } from './model-choice';
import { modelCatalogStorage, favoriteModelsStorage, refreshModelCatalog } from './model-catalog';

export interface ModelSelectHandle {
  /** Re-read choices and rebuild the select (call after provider/settings changes). */
  refresh(): Promise<void>;
  destroy(): void;
}

let datalistSeq = 0;

export function wireModelSelect(
  select: HTMLSelectElement,
  getProviderId: () => string,
  onCommit: (model: string) => void | Promise<void>,
  inputClass = ''
): ModelSelectHandle {
  const populate = async () => {
    const providerId = getProviderId();
    // Opportunistic TTL-guarded staleness check; the catalog watch repopulates on change.
    void refreshModelCatalog(providerId);
    const { current, groups, hasCatalog } = await getModelChoicesFor(providerId);
    select.innerHTML = '';
    for (const g of groups) {
      const og = document.createElement('optgroup');
      og.label = g.label;
      for (const m of g.models) {
        const option = document.createElement('option');
        option.value = m;
        option.textContent = m;
        option.selected = m === current;
        og.appendChild(option);
      }
      select.appendChild(og);
    }
    const special = (value: string, text: string) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      select.appendChild(option);
    };
    if (hasCatalog) {
      special('__all__', 'All models… (search)');
      special('__refresh__', '↻ Refresh model list');
    }
    special('__custom__', 'Custom model…');
    select.dataset.lastModel = current;
  };

  /** Put a (possibly list-foreign) model id into the select and select it. */
  const showModel = (model: string) => {
    if (![...select.options].some((o) => o.value === model)) {
      const option = document.createElement('option');
      option.value = model;
      option.textContent = model;
      select.insertBefore(option, select.firstChild);
    }
    select.value = model;
    select.dataset.lastModel = model;
  };

  /** Swap the select for a text input; with search, a native <datalist> suggests. */
  const editInline = (withSearch: boolean) => {
    const input = document.createElement('input');
    input.type = 'text';
    if (inputClass) input.className = inputClass;
    input.placeholder = withSearch ? 'loading models…' : 'model id — Enter to set';
    let datalist: HTMLDataListElement | null = null;
    if (withSearch) {
      datalist = document.createElement('datalist');
      datalist.id = `cllp-model-list-${++datalistSeq}`;
      input.setAttribute('list', datalist.id);
      void getFullModelListFor(getProviderId()).then((ids) => {
        for (const id of ids) {
          const option = document.createElement('option');
          option.value = id;
          datalist!.appendChild(option);
        }
        input.placeholder = `search ${ids.length} models…`;
      });
    }
    select.style.display = 'none';
    select.after(input);
    if (datalist) input.after(datalist);
    input.focus();
    let finished = false;
    const done = (commit: boolean) => {
      if (finished) return;
      finished = true;
      const value = input.value.trim();
      input.remove();
      datalist?.remove();
      select.style.display = '';
      if (commit && value) {
        showModel(value); // select.value must be real before onCommit (options reads it)
        void Promise.resolve(onCommit(value)).then(() => populate());
      }
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        done(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        done(false);
      }
    });
    // Blur commits what's typed (incl. a datalist pick, which sets the value without Enter).
    input.addEventListener('blur', () => done(!!input.value.trim()));
  };

  select.addEventListener('change', () => {
    const v = select.value;
    if (!v.startsWith('__')) {
      select.dataset.lastModel = v;
      void onCommit(v);
      return;
    }
    // Specials never stay selected — revert synchronously so any other change
    // listener on this select (auto-save) sees a real model id.
    select.value = select.dataset.lastModel ?? '';
    if (v === '__refresh__') {
      void refreshModelCatalog(getProviderId(), true).then((changed) => (changed ? populate() : undefined));
    } else {
      editInline(v === '__all__');
    }
  });

  const unwatch = [
    modelCatalogStorage.watch(() => void populate()),
    favoriteModelsStorage.watch(() => void populate()),
  ];

  return {
    refresh: populate,
    destroy() {
      for (const u of unwatch) u();
    },
  };
}
