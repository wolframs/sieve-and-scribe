/**
 * Site-contract watchdog: user-visible feedback when CivitAI changes under us.
 *
 * Every structural dependency on the site (DOM shapes, API envelopes, URL params) can
 * silently rot when CivitAI ships a redesign — the extension then half-works with no
 * signal (see: the 2026 generator redesign that killed every #input_* selector, and the
 * Year-period feed silently falling back to OR). This module gives failures a voice:
 * `reportSiteIssue` logs a console.warn AND shows a bottom-right toast, deduped per
 * issue key per page load so a broken contract nags once, not per scroll page.
 *
 * The MAIN-world AND interceptor can't import this (isolated-world module), so it
 * dispatches `cllp:sitehealth` CustomEvents with a JSON-STRING detail (plain objects
 * don't reliably cross Chrome's world boundary; strings do) — initSiteHealth() bridges
 * those into reports.
 */

const HEALTH_EVENT = 'cllp:sitehealth';
const TOAST_LIFETIME_MS = 12000;
const reported = new Set<string>();

let toastList: HTMLElement | null = null;

function ensureToastHost(): HTMLElement {
  if (toastList?.isConnected) return toastList;
  const host = document.createElement('cllp-toast-host');
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    .list {
      /* Max z + host appended after <body>: paints above the chat panel, which also
         lives bottom-right and would otherwise cover notifications entirely. */
      position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
      display: flex; flex-direction: column; gap: 8px; align-items: flex-end;
      font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    .toast {
      max-width: 340px; padding: 10px 12px; border-radius: 8px;
      background: #1a1b1e; color: #e9ecef;
      border: 1px solid #373a40; border-left: 3px solid #e8590c;
      box-shadow: 0 4px 14px rgba(0,0,0,.45);
      display: flex; gap: 8px; align-items: flex-start;
      animation: cllp-in .18s ease-out;
    }
    @keyframes cllp-in { from { opacity: 0; transform: translateY(6px); } }
    .toast .body { flex: 1; }
    .toast .title { font-weight: 600; color: #ffa94d; margin-bottom: 2px; font-size: 12px; }
    .toast .close {
      background: none; border: none; color: #868e96; cursor: pointer;
      font-size: 14px; line-height: 1; padding: 0 2px;
    }
    .toast .close:hover { color: #e9ecef; }
  `;
  const list = document.createElement('div');
  list.className = 'list';
  shadow.append(style, list);
  document.documentElement.appendChild(host);
  toastList = list;
  return list;
}

function showToast(message: string): void {
  try {
    const list = ensureToastHost();
    const toast = document.createElement('div');
    toast.className = 'toast';
    const body = document.createElement('div');
    body.className = 'body';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = 'Sieve & Scribe — site check';
    const text = document.createElement('div');
    text.textContent = message;
    body.append(title, text);
    const close = document.createElement('button');
    close.className = 'close';
    close.textContent = '✕';
    close.title = 'Dismiss';
    close.addEventListener('click', () => toast.remove());
    toast.append(body, close);
    list.appendChild(toast);
    setTimeout(() => toast.remove(), TOAST_LIFETIME_MS);
  } catch {
    /* toasts are best-effort — never let feedback break the feature it reports on */
  }
}

/**
 * Report a broken/changed site dependency: console.warn + one toast per key per page load.
 * Use stable keys ("gen-form-missing", "and-or-fallback") so repeats collapse.
 */
export function reportSiteIssue(key: string, message: string): void {
  if (reported.has(key)) return;
  reported.add(key);
  console.warn(`[CLLP site check] ${message} (${key})`);
  showToast(message);
}

/** Bridge MAIN-world health events (JSON-string detail) into reports. Call once at init. */
export function initSiteHealth(): void {
  window.addEventListener(HEALTH_EVENT, (e) => {
    try {
      const detail = (e as CustomEvent).detail;
      const parsed = typeof detail === 'string' ? JSON.parse(detail) : detail;
      if (parsed && typeof parsed.key === 'string' && typeof parsed.message === 'string') {
        reportSiteIssue(parsed.key, parsed.message);
      }
    } catch {
      /* malformed event — ignore */
    }
  });
}
