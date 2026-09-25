/** Attach our shadow host without moving or replacing React-owned filter controls. */
export type FilterPlacement = 'unavailable' | 'native-closed' | 'docked';

const DOCK_ATTRIBUTE = 'data-cllp-filter-dock';
const GUTTER = 16;
const COLUMN_WIDTH = 400;
const MIN_COLUMN_WIDTH = 320;

export class NativeFilterDock {
  private observer: MutationObserver;
  private frame = 0;
  private dead = false;
  private popup?: HTMLElement;
  private stackedNativeWidth?: number;
  private trigger?: HTMLButtonElement;
  private placement?: FilterPlacement;
  private styles: HTMLStyleElement;

  constructor(private host: HTMLElement, private onChange: (placement: FilterPlacement) => void) {
    this.styles = document.createElement('style');
    this.styles.textContent = `
      [${DOCK_ATTRIBUTE}] {
        box-sizing: border-box !important;
        width: var(--cllp-dock-width) !important;
        max-width: var(--cllp-dock-width) !important;
        padding-left: var(--cllp-dock-column) !important;
      }
      [${DOCK_ATTRIBUTE}] > #cllp-tagfilter-host {
        position: absolute !important; top: 0 !important; left: 0 !important;
        width: var(--cllp-dock-column) !important; height: 100% !important;
        z-index: auto !important;
      }
      [${DOCK_ATTRIBUTE}="stacked"] {
        max-height: calc(100dvh - 32px) !important; overflow-y: auto !important;
      }
      [${DOCK_ATTRIBUTE}="stacked"] > #cllp-tagfilter-host {
        position: relative !important; width: 100% !important; height: auto !important;
      }
    `;
    document.head.append(this.styles);
    this.observer = new MutationObserver(() => this.schedule());
    this.observer.observe(document.body, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ['aria-expanded', 'style', 'hidden'],
    });
    window.addEventListener('resize', this.schedule);
    this.refresh();
  }

  /** Open the native popup for editor actions when it is available. */
  open(): boolean {
    if (this.placement === 'unavailable' || !this.trigger?.isConnected) return false;
    if (this.placement === 'native-closed') this.trigger.click();
    return true;
  }

  close(): boolean {
    if (this.placement !== 'docked' || !this.trigger?.isConnected) return false;
    this.trigger.click();
    return true;
  }

  private schedule = () => {
    if (this.dead || this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.refresh();
    });
  };

  private detach() {
    if (!this.popup) return;
    // Reuse this exact host and its listeners/draft on the next opening.
    document.body.append(this.host);
    this.popup.removeAttribute(DOCK_ATTRIBUTE);
    delete this.host.dataset.dockLayout;
    this.popup.style.removeProperty('--cllp-dock-width');
    this.popup.style.removeProperty('--cllp-dock-column');
    this.popup = undefined;
    this.stackedNativeWidth = undefined;
  }

  private setPlacement(next: FilterPlacement) {
    if (next === this.placement) return;
    this.placement = next;
    this.onChange(next);
  }

  private refresh() {
    if (this.dead) return;
    const trigger = [...document.querySelectorAll('.tabler-icon-filter')]
        .map((icon) => icon.closest('button'))
        .find((button): button is HTMLButtonElement => !!button &&
          button.textContent?.trim() === 'Filters' && button.getBoundingClientRect().width > 0);
    this.trigger = trigger;
    const target = trigger?.closest('[aria-controls]');
    const controlled = target?.getAttribute('aria-controls');
    const popup = controlled ? document.getElementById(controlled) : null;
    // Match both the actual trigger relationship and filter-specific contents. Never
    // attach to unrelated Mantine popovers (sort, navigation, model suggestions…).
    const nativePopup = popup?.matches('.mantine-Popover-dropdown[role="dialog"]') &&
      [...popup.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Clear all filters')
      ? popup : undefined;
    if (this.popup && this.popup !== nativePopup) this.detach();

    // CivitAI uses 29.25rem for the desktop filter popup. Once open, use its actual
    // measured content width, including the user's font scale/zoom. React re-writes the
    // popup's inline `style` wholesale, which wipes our custom properties — an unparseable
    // dock column then means the measured width is already the bare native width.
    const dockedColumn = this.popup
      ? parseFloat(this.popup.style.getPropertyValue('--cllp-dock-column')) || 0
      : 0;
    const nativeWidth = this.popup?.getAttribute(DOCK_ATTRIBUTE) === 'stacked'
      ? this.stackedNativeWidth!
      : this.popup
      ? this.popup.getBoundingClientRect().width - dockedColumn
      : nativePopup?.getBoundingClientRect().width || 29.25 * parseFloat(getComputedStyle(document.documentElement).fontSize || '16');
    const column = Math.min(COLUMN_WIDTH, window.innerWidth - GUTTER * 2 - nativeWidth);
    if (!trigger || !target || !Number.isFinite(column) ||
        (popup && !nativePopup && target.getAttribute('aria-expanded') === 'true')) {
      this.detach();
      this.setPlacement('unavailable');
      return;
    }
    if (!nativePopup || target?.getAttribute('aria-expanded') === 'false') {
      this.detach();
      this.setPlacement('native-closed');
      return;
    }

    this.popup = nativePopup;
    const stacked = column < MIN_COLUMN_WIDTH;
    this.stackedNativeWidth = stacked ? nativeWidth : undefined;
    const widthValue = `${stacked ? Math.min(nativeWidth, window.innerWidth - GUTTER * 2) : nativeWidth + column}px`;
    const columnValue = `${stacked ? 0 : column}px`;
    const layout = stacked ? 'stacked' : 'columns';
    if (this.host.dataset.dockLayout !== layout) this.host.dataset.dockLayout = layout;
    if (nativePopup.style.getPropertyValue('--cllp-dock-width') !== widthValue)
      nativePopup.style.setProperty('--cllp-dock-width', widthValue);
    if (nativePopup.style.getPropertyValue('--cllp-dock-column') !== columnValue)
      nativePopup.style.setProperty('--cllp-dock-column', columnValue);
    if (nativePopup.getAttribute(DOCK_ATTRIBUTE) !== layout) nativePopup.setAttribute(DOCK_ATTRIBUTE, layout);
    if (this.host.parentElement !== nativePopup) nativePopup.prepend(this.host);
    this.setPlacement('docked');
  }

  destroy() {
    this.dead = true;
    this.observer.disconnect();
    cancelAnimationFrame(this.frame);
    window.removeEventListener('resize', this.schedule);
    this.detach();
    this.styles.remove();
  }
}
