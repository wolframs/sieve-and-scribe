import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const HEALTH_EVENT = 'cllp:sitehealth';

/** Fresh module instance per test: the module keeps a dedupe Set + host ref as
 * closed-over state, so each test needs its own copy. */
async function loadSiteHealth() {
  vi.resetModules();
  return import('@/entrypoints/civitai.content/site-health');
}

function getToasts(host: Element): NodeListOf<Element> {
  return host.shadowRoot!.querySelectorAll('.toast');
}

beforeEach(() => {
  document.querySelector('cllp-toast-host')?.remove();
});

afterEach(() => {
  document.querySelector('cllp-toast-host')?.remove();
  vi.restoreAllMocks();
});

describe('reportSiteIssue', () => {
  it('creates a cllp-toast-host with an open shadow root, adds a toast, and warns', async () => {
    const { reportSiteIssue } = await loadSiteHealth();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    reportSiteIssue('key-a', 'Something broke');

    const host = document.querySelector('cllp-toast-host');
    expect(host).not.toBeNull();
    expect(host!.shadowRoot).not.toBeNull(); // non-null shadowRoot access proves mode: 'open'
    const toasts = getToasts(host!);
    expect(toasts.length).toBe(1);
    expect(toasts[0].textContent).toContain('Something broke');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('Something broke');
  });

  it('dedupes a second report with the same key: no second toast, no second warn', async () => {
    const { reportSiteIssue } = await loadSiteHealth();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    reportSiteIssue('key-b', 'First message');
    reportSiteIssue('key-b', 'Second message for same key');

    const host = document.querySelector('cllp-toast-host')!;
    expect(getToasts(host).length).toBe(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('adds a new toast for a different key', async () => {
    const { reportSiteIssue } = await loadSiteHealth();
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    reportSiteIssue('key-c', 'Message C');
    reportSiteIssue('key-d', 'Message D');

    const host = document.querySelector('cllp-toast-host')!;
    const toasts = getToasts(host);
    expect(toasts.length).toBe(2);
    expect(toasts[1].textContent).toContain('Message D');
  });
});

describe('initSiteHealth', () => {
  it('bridges a valid cllp:sitehealth window event into a toast', async () => {
    const { initSiteHealth } = await loadSiteHealth();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const addSpy = vi.spyOn(window, 'addEventListener');

    initSiteHealth();
    const listener = addSpy.mock.calls.find((c) => c[0] === HEALTH_EVENT)?.[1] as EventListener;
    expect(listener).toBeTruthy();

    try {
      window.dispatchEvent(
        new CustomEvent(HEALTH_EVENT, { detail: JSON.stringify({ key: 'ev-key', message: 'Event message' }) })
      );
      const host = document.querySelector('cllp-toast-host');
      expect(host).not.toBeNull();
      const toasts = getToasts(host!);
      expect(toasts.length).toBe(1);
      expect(toasts[0].textContent).toContain('Event message');
    } finally {
      window.removeEventListener(HEALTH_EVENT, listener);
    }
  });

  it('does not throw on malformed (non-JSON) event detail, and adds no toast', async () => {
    const { initSiteHealth } = await loadSiteHealth();
    const addSpy = vi.spyOn(window, 'addEventListener');

    initSiteHealth();
    const listener = addSpy.mock.calls.find((c) => c[0] === HEALTH_EVENT)?.[1] as EventListener;
    expect(listener).toBeTruthy();

    try {
      expect(() => {
        window.dispatchEvent(new CustomEvent(HEALTH_EVENT, { detail: '{not valid json' }));
      }).not.toThrow();
      expect(document.querySelector('cllp-toast-host')).toBeNull();
    } finally {
      window.removeEventListener(HEALTH_EVENT, listener);
    }
  });
});
