#!/usr/bin/env node
/**
 * E2E smoke suite for the live browser rig.
 *
 * Drives the chrome-devtools CLI against the persistent test profile (Chrome for
 * Testing + the unpacked extension), so it exercises the REAL extension: content
 * scripts on civitai.red, the side panel document, popup, and options.
 *
 * Prereqs (prepared by pnpm browser:smoke:setup — see docs/browser-smoke.md):
 *   - the session-scoped chrome-devtools daemon is running with the project profile
 *   - the built extension is installed and its ID recorded under .browser-smoke/
 *
 * Usage: node tests/e2e/smoke.mjs        (exit 0 = all green)
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SESSION_ID = process.env.CLLP_E2E_SESSION_ID ?? 'sieve-and-scribe-smoke';
function projectExtensionId() {
  if (process.env.CLLP_E2E_EXTENSION_ID) return process.env.CLLP_E2E_EXTENSION_ID;
  try {
    return readFileSync(resolve(process.cwd(), '.browser-smoke/extension-id'), 'utf8').trim();
  } catch {
    return 'npldecadijijccgiipfnbkhbhfnkjecj';
  }
}
const EXT_ID = projectExtensionId();
const results = [];
const opened = []; // page indices we created, closed in reverse on exit

function cli(...args) {
  return execFileSync('chrome-devtools', ['--sessionId', SESSION_ID, ...args], {
    encoding: 'utf8', timeout: 60_000,
  });
}

/** evaluate_script with JSON extraction (CLI wraps results in markdown fences). */
function evalJson(fn) {
  const out = cli('evaluate_script', fn, '--output-format', 'json');
  const msg = JSON.parse(out).message ?? out;
  const fenced = msg.match(/```json\n([\s\S]*?)\n?```/);
  if (!fenced) throw new Error(`no JSON in evaluate output: ${msg.slice(0, 200)}`);
  let data = JSON.parse(fenced[1]);
  if (typeof data === 'string') data = JSON.parse(data); // double-encoded returns
  return data;
}

function newPage(url) {
  cli('new_page', url);
  const pages = cli('list_pages');
  const m = [...pages.matchAll(/^(\d+): .*\[selected\]/gm)].at(-1);
  if (m) opened.push(Number(m[1]));
  return sleep(1500);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until the tag-filter widget is mounted on the current page (after a navigation). */
async function waitForWidget(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const mounted = evalJson(`() => JSON.stringify({ ok: !!document.getElementById('cllp-tagfilter-host')?.shadowRoot?.querySelector('.resource-search') })`);
    if (mounted.ok) return true;
    await sleep(500);
  }
  return false;
}

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

try {
  // 1. Rig + extension present
  const extensions = cli('list_extensions');
  check('rig up & extension installed', extensions.includes(EXT_ID));

  // 2. Content scripts on a real feed page
  await newPage('https://civitai.red/images');
  await sleep(4000); // widget mounts after feed hydration
  const feed = evalJson(`() => JSON.stringify({
    widget: !!document.getElementById('cllp-tagfilter-host'),
    launcher: !!document.getElementById('cllp-tagfilter-host')?.shadowRoot?.querySelector('.launcher'),
    detailPath: [...document.querySelectorAll('a[href]')]
      .map(a => a.getAttribute('href'))
      .find(href => /^\\/(images|videos)\\/\\d+/.test(href ?? '')) ?? '',
  })`);
  check('tag-filter widget mounted', feed.widget === true);
  check('standalone tag-filter launcher removed', feed.launcher === false);

  // The desktop native popup gains a left column, preserving native control geometry.
  evalJson(`() => {
    [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Filters')?.click();
    return true;
  }`);
  await sleep(500);
  const dock = evalJson(`() => {
    const host = document.getElementById('cllp-tagfilter-host');
    const popup = host?.closest('[data-cllp-filter-dock]');
    if (!popup) return { placement: host?.dataset.placement };
    const rect = popup.getBoundingClientRect();
    const nativeContent = [...popup.children].find(e => e !== host);
    const nativeWidth = nativeContent.getBoundingClientRect().width;
    const layout = popup.getAttribute('data-cllp-filter-dock');
    host.style.display = 'none';
    popup.removeAttribute('data-cllp-filter-dock');
    const original = popup.getBoundingClientRect();
    const originalNativeWidth = nativeContent.getBoundingClientRect().width;
    popup.setAttribute('data-cllp-filter-dock', layout);
    host.style.display = '';
    return {
      placement: host.dataset.placement,
      addedWidth: rect.width - original.width,
      heightDifference: Math.abs(rect.height - original.height),
      nativeWidthDifference: Math.abs(nativeWidth - originalNativeWidth),
      insideViewport: rect.left >= 0 && rect.right <= innerWidth,
    };
  }`);
  check('native filter popup gains width without height',
    dock.placement === 'docked' && dock.addedWidth >= 320 &&
    dock.heightDifference < 2 && dock.nativeWidthDifference < 2 && dock.insideViewport,
    JSON.stringify(dock));

  evalJson(`() => {
    const root = document.getElementById('cllp-tagfilter-host').shadowRoot;
    root.querySelector('.expression-open').click();
    root.querySelector('.expression-input').value = 'draft preserved on close';
    [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Filters').click();
    return true;
  }`);
  await sleep(300);
  const closed = evalJson(`() => {
    const host = document.getElementById('cllp-tagfilter-host');
    return { hidden: host.style.display === 'none', placement: host.dataset.placement };
  }`);
  evalJson(`() => {
    [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Filters').click();
    return true;
  }`);
  await sleep(300);
  const reopened = evalJson(`() => {
    const host = document.getElementById('cllp-tagfilter-host');
    const root = host.shadowRoot;
    const draft = root.querySelector('.expression-input').value;
    root.querySelector('.expression-back').click();
    return { draft, placement: host.dataset.placement };
  }`);
  check('native close/reopen preserves editor draft',
    closed.hidden && closed.placement === 'native-closed' &&
    reopened.placement === 'docked' && reopened.draft === 'draft preserved on close');

  // Compact metadata editor: stays behind one row, summarizes selections, and applies URL state.
  const facets = evalJson(`() => {
    const root = document.getElementById('cllp-tagfilter-host')?.shadowRoot;

    root?.querySelector('.more-filters')?.click();
    const orientation = root?.querySelector('[data-orientation="portrait"]');
    orientation?.click();
    const reactions = root?.querySelector('[data-facet-number="minReactions"]');
    if (reactions) {
      reactions.value = '10';
      reactions.dispatchEvent(new Event('input', { bubbles: true }));
    }
    root?.querySelector('.back')?.click();
    const result = {
      facetViewHidden: root?.querySelector('.facet-view')?.style.display === 'none',
      tagViewShown: root?.querySelector('.tag-view')?.style.display === 'block',
      summary: root?.querySelector('.facet-summary')?.textContent ?? '',
      badge: root?.querySelector('.facet-badge')?.textContent ?? '',
      controls: root?.querySelectorAll('[data-facet], [data-facet-number], [data-facet-check], [data-orientation]').length ?? 0,
      panelOverflow: getComputedStyle(root?.querySelector('.panel')).overflowY,
      panelMaxHeight: getComputedStyle(root?.querySelector('.panel')).maxHeight,
    };
    root?.querySelector('.apply')?.click();
    return JSON.stringify(result);
  }`);
  await sleep(2500);
  await waitForWidget(); // Apply navigates; the widget remounts on the new document
  const facetUrl = evalJson(`() => JSON.stringify({ search: location.search })`);
  check(
    'compact metadata filter editor',
    facets.facetViewHidden && facets.tagViewShown && facets.controls === 11 &&
      facets.summary.includes('Portrait') && facets.summary.includes('≥10 reactions') && facets.badge === '2' &&
      facets.panelOverflow === 'visible' && facets.panelMaxHeight === 'none',
    `${facets.controls} controls; ${facets.summary}; panel ${facets.panelOverflow}/${facets.panelMaxHeight}`
  );
  check(
    'metadata filter URL applied',
    new URLSearchParams(facetUrl.search).get('fforientation') === 'portrait' &&
      new URLSearchParams(facetUrl.search).get('ffminreactions') === '10',
    facetUrl.search
  );
  const resourcePicker = evalJson(`async () => {
    const trigger = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Filters');
    if (trigger?.closest('[aria-controls]')?.getAttribute('aria-expanded') !== 'true') trigger?.click();
    await new Promise(resolve => setTimeout(resolve, 100));
    const root = document.getElementById('cllp-tagfilter-host')?.shadowRoot;

    root?.querySelector('.more-filters')?.click();
    const input = root?.querySelector('.resource-search');
    if (input) {
      input.value = 'flux';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    await new Promise(resolve => setTimeout(resolve, 5000));
    const results = root?.querySelectorAll('.resource-result').length ?? 0;
    root?.querySelector('[data-resource-action="primary"]')?.click();
    return JSON.stringify({
      results,
      selected: root?.querySelector('.resource-chip.primary')?.textContent?.trim() ?? '',
    });
  }`);
  check(
    'selection-time model/resource lookup',
    resourcePicker.results > 0 && resourcePicker.selected.length > 3,
    `${resourcePicker.results} versions; ${resourcePicker.selected}`
  );

  // 3. Current CivitAI detail-tag contract + reversible pickup behavior
  let pickedTagId = 0;
  if (feed.detailPath) {
    await newPage(new URL(feed.detailPath, 'https://civitai.red').href);
    await sleep(4000);
    const pickup = evalJson(`async () => {
      const buttons = [...document.querySelectorAll('.cllp-tag-pickup')];
      const button = buttons.find(candidate => candidate.textContent?.trim() === '+');
      if (!button) return JSON.stringify({ count: buttons.length, reversible: false });
      button.click();
      await new Promise(resolve => setTimeout(resolve, 200));
      const afterAdd = button.textContent?.trim();
      button.click();
      await new Promise(resolve => setTimeout(resolve, 200));
      const afterRemove = button.textContent?.trim();
      button.click();
      await new Promise(resolve => setTimeout(resolve, 200));
      return JSON.stringify({
        count: buttons.length,
        tagId: Number(button.dataset.tagId),
        afterAdd,
        afterRemove,
        leftInTray: button.textContent?.trim() === '✓',
      });
    }`);
    pickedTagId = pickup.leftInTray ? pickup.tagId : 0;
    check('detail-page tag controls detected', pickup.count > 0, `${pickup.count} controls`);
    check(
      'detail-page tag pickup is reversible',
      pickup.afterAdd === '✓' && pickup.afterRemove === '+',
      `${pickup.afterAdd ?? '?'} → ${pickup.afterRemove ?? '?'}`
    );
  } else {
    check('detail-page link detected', false, 'no public media link on feed');
  }

  // 4. Site-health toast pipeline (isolated-world listener hears main-world events)
  const toast = evalJson(`async () => {
    window.dispatchEvent(new CustomEvent('cllp:sitehealth', {
      detail: JSON.stringify({ key: 'e2e-smoke-' + Math.random(), message: 'e2e smoke toast' }),
    }));
    await new Promise((r) => setTimeout(r, 500));
    const host = document.querySelector('cllp-toast-host');
    return JSON.stringify({ toast: !!host?.shadowRoot?.textContent?.includes('e2e smoke toast') });
  }`);
  check('site-health toast pipeline', toast.toast === true);

  // 5. Tray assignment controls: common actions are direct 32px buttons.
  if (pickedTagId) {
    await newPage('https://civitai.red/images');
    await sleep(3500);
    const trayActions = evalJson(`async () => {
      const root = document.getElementById('cllp-tagfilter-host')?.shadowRoot;
      if (!root) return JSON.stringify({ rendered: false, actionCount: 0, assigned: false });
      [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Filters')?.click();
      await new Promise(resolve => setTimeout(resolve, 100));
      const item = root.querySelector('.tray-item[data-id="${pickedTagId}"]');
      const actions = item ? [...item.querySelectorAll('.tray-action')] : [];
      const sizes = actions.map(button => getComputedStyle(button).width + 'x' + getComputedStyle(button).height);
      const directAnd = item?.querySelector('[data-tray-action="and"]');
      directAnd?.click();
      await new Promise(resolve => setTimeout(resolve, 150));
      const assigned = !!root.querySelector('.chip[data-kind="pos"][data-id="${pickedTagId}"]');
      root.querySelector('.chip[data-kind="pos"][data-id="${pickedTagId}"] .rm')?.click();
      return JSON.stringify({
        rendered: !!item,
        actionCount: actions.length,
        sizes,
        assigned,
      });
    }`);
    check(
      'tray direct action rail',
      trayActions.rendered && trayActions.actionCount === 3 &&
        trayActions.sizes.every(size => size === '32pxx32px') && trayActions.assigned,
      `${trayActions.actionCount} controls; ${trayActions.sizes?.join(', ') ?? 'no sizes'}`
    );
  } else {
    check('tray direct action rail', false, 'no detail tag available to stage');
  }

  // 6. Side panel document: chat UI + live model picker
  await newPage(`chrome-extension://${EXT_ID}/sidepanel.html`);
  await sleep(2500);
  const panel = evalJson(`() => {
    const sel = document.querySelector('.cllp-model-select');
    return JSON.stringify({
      chat: !!document.querySelector('.cllp-messages'),
      composer: !!document.querySelector('.cllp-input'),
      models: sel ? sel.options.length : 0,
      specials: sel ? [...sel.options].filter(o => o.value.startsWith('__')).length : 0,
    });
  }`);
  check('side panel chat UI', panel.chat && panel.composer);
  check('side panel model picker populated', panel.models > 3, `${panel.models} options`);
  check('side panel picker specials', panel.specials >= 1);

  // 7. Popup document: status + selects
  await newPage(`chrome-extension://${EXT_ID}/popup.html`);
  await sleep(2000);
  const popup = evalJson(`() => JSON.stringify({
    provider: document.getElementById('providerName')?.textContent,
    key: document.getElementById('keyStatusText')?.textContent,
    models: document.getElementById('modelSelect')?.options.length ?? 0,
  })`);
  check('popup provider status', !!popup.provider && popup.provider !== '-', popup.provider);
  check('popup key status resolved', popup.key === 'Configured' || popup.key === 'Missing', popup.key);
  check('popup model select populated', popup.models > 1, `${popup.models} options`);

  // 8. Options document: provider cards + prompt + persisted diagnostic capture
  await newPage(`chrome-extension://${EXT_ID}/options.html`);
  await sleep(2000);
  const options = evalJson(`() => JSON.stringify({
    xaiModels: document.getElementById('xaiModel')?.options.length ?? 0,
    orModels: document.getElementById('openrouterModel')?.options.length ?? 0,
    prompt: (document.getElementById('systemPrompt')?.value ?? '').length,
    diagnosticCount: document.getElementById('diagnosticCount')?.textContent ?? '',
    openLogs: !!document.getElementById('openLogDirectoryBtn'),
    exportLogs: !!document.getElementById('exportLogsBtn'),
  })`);
  check('options xAI model select populated', options.xaiModels > 1, `${options.xaiModels} options`);
  check('options OpenRouter model select populated', options.orModels > 1, `${options.orModels} options`);
  check('options system prompt loaded', options.prompt > 1000, `${options.prompt} chars`);
  check(
    'options diagnostic controls rendered',
    options.openLogs && options.exportLogs && Number.parseInt(options.diagnosticCount, 10) >= 1,
    options.diagnosticCount
  );
} catch (err) {
  check('suite aborted', false, err instanceof Error ? err.message.slice(0, 200) : String(err));
} finally {
  for (const idx of opened.reverse()) {
    try { cli('close_page', String(idx)); } catch { /* page already gone */ }
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
