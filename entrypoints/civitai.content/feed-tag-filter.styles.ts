/**
 * Stylesheet for the feed tag-filter widget (injected into its shadow root).
 *
 * Design notes
 * - Every colour derives from Mantine's theme variables so the editor reads as a native
 *   part of CivitAI's Filters popover in both colour schemes. Hard-coded hex values are
 *   fallbacks only.
 * - Hierarchy: section dividers (like the native "Time period ———" labels), one primary
 *   input, chips for tags, quiet secondary controls. Nothing below 11px.
 * - Desktop columns and narrow-screen stacked layouts share the same editor.
 */
export const FEED_TAG_FILTER_STYLES = `
:host {
  all: initial;
  --c-bg: var(--mantine-color-default, #25262b);
  --c-raised: var(--mantine-color-default-hover, #2c2e33);
  --c-input: var(--mantine-color-body, #1a1b1e);
  --c-text: var(--mantine-color-text, #c1c2c5);
  --c-dim: var(--mantine-color-dimmed, #8c8fa3);
  --c-faint: var(--mantine-color-placeholder, #5c5f66);
  --c-border: var(--mantine-color-default-border, #373a40);
  --c-accent: var(--mantine-primary-color-filled, #1971c2);
  --c-accent-text: var(--mantine-primary-color-light-color, #74c0fc);
  --c-accent-soft: color-mix(in srgb, var(--c-accent) 14%, transparent);
  --c-accent-line: color-mix(in srgb, var(--c-accent) 38%, transparent);
  --c-danger: var(--mantine-color-red-6, #fa5252);
  --c-warn: var(--mantine-color-yellow-6, #fab005);
  --c-tray: var(--mantine-color-orange-6, #fd7e14);
  --r-pill: 999px;
  --r-sm: 6px;
  --r-md: 8px;
  --r-lg: 12px;
  --control-h: 32px;
  color-scheme: light dark;
  font-family: var(--mantine-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
  font-size: 13px;
  line-height: 1.4;
}
*, *::before, *::after { box-sizing: border-box; }
button, input, select, textarea { font-family: inherit; font-size: inherit; color: inherit; }
button { cursor: pointer; }
button:disabled { cursor: default; }
:is(button, input, select, textarea, [tabindex]):focus-visible {
  outline: 2px solid var(--c-accent); outline-offset: 1px;
}
[hidden] { display: none !important; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden;
  clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }

/* ---------- panel frame ---------- */
.panel {
  display: none; position: relative; width: min(400px, calc(100vw - 24px)); padding: 14px;
  background: var(--c-bg); color: var(--c-text); border: 1px solid var(--c-border);
  border-radius: var(--r-lg); box-shadow: 0 12px 40px rgba(0, 0, 0, .45);
}
.head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.title { display: flex; flex: 1; align-items: center; gap: 10px; min-width: 0;
  font-size: 14px; font-weight: 700; color: var(--c-dim); white-space: nowrap; }
.title::after { content: ""; flex: 1; height: 1px; background: var(--c-border); }
.x { flex: 0 0 auto; width: 26px; height: 26px; padding: 0; border: 0; border-radius: var(--r-sm);
  background: none; color: var(--c-dim); font-size: 18px; line-height: 1; }
.x:hover { color: var(--c-text); background: var(--c-raised); }

/* section dividers, mirroring Mantine's labelled Divider used by the native popover */
.section { display: flex; align-items: center; gap: 10px; margin: 14px 0 8px;
  color: var(--c-dim); font-size: 12px; font-weight: 700; letter-spacing: .1px; white-space: nowrap; }
.section::after { content: ""; flex: 1; height: 1px; background: var(--c-border); }
.section .section-aside { margin-left: auto; font-weight: 500; }
.section + * { margin-top: 0; }

/* ---------- composer (search + mode) ---------- */
.composer { margin-bottom: 10px; }
.field { position: relative; }
.field-icon { position: absolute; left: 11px; top: 50%; width: 15px; height: 15px; margin-top: -8px;
  color: var(--c-dim); pointer-events: none; }
.in {
  width: 100%; height: 38px; padding: 0 12px 0 34px; border: 1px solid var(--c-border);
  border-radius: var(--r-md); background: var(--c-input); color: var(--c-text); font-size: 13.5px; outline: none;
  transition: border-color .12s, box-shadow .12s;
}
.in::placeholder { color: var(--c-faint); }
.in:focus { border-color: var(--c-accent); box-shadow: 0 0 0 3px var(--c-accent-soft); }
.mode { display: none; align-items: center; gap: 8px; margin-top: 10px; font-size: 12px; color: var(--c-dim); }
.mode.visible { display: flex; }
.mode-label { flex: 1; min-width: 0; }
.seg { display: inline-flex; gap: 4px; padding: 2px; border-radius: var(--r-pill); background: var(--c-raised); }
.seg-btn { height: 24px; padding: 0 11px; border: 0; border-radius: var(--r-pill); background: transparent;
  color: var(--c-dim); font-size: 12px; font-weight: 600; }
.seg-btn:hover { color: var(--c-text); }
.seg-btn.active { background: var(--c-accent); color: #fff; }
.explainer { display: none; margin-top: 8px; color: var(--c-dim); font-size: 12px; line-height: 1.4; }
.explainer:not(:empty) { display: block; }

/* ---------- suggestions dropdown ---------- */
.dropdown {
  display: none; position: absolute; left: 0; right: 0; top: calc(100% + 6px); z-index: 5; max-height: 280px;
  overflow-y: auto; padding: 4px; border: 1px solid var(--c-border); border-radius: var(--r-md);
  background: var(--c-bg); box-shadow: 0 14px 36px rgba(0, 0, 0, .45); scrollbar-width: thin;
}
.dd-status { padding: 9px 10px; color: var(--c-dim); font-size: 12px; }
.opt { display: grid; grid-template-columns: minmax(0, 1fr) auto auto auto; align-items: center; gap: 3px;
  padding: 2px; border-radius: var(--r-sm); }
.opt:hover, .opt.active { background: var(--c-raised); }
.opt.picked .opt-main { color: var(--c-accent-text); }
.opt.picked-neg .opt-main { color: var(--c-danger); text-decoration: line-through; }
.opt-main { display: flex; align-items: center; gap: 6px; min-width: 0; height: 32px; padding: 0 6px; border: 0;
  border-radius: var(--r-sm); background: none; text-align: left; font-size: 13px; }
.opt-main .name-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.opt .mark { flex: 0 0 auto; width: 16px; text-align: center; font-weight: 700; color: var(--c-accent-text); }
.opt.picked-neg .mark { color: var(--c-danger); }
.opt-act { height: 26px; padding: 0 8px; border: 1px solid transparent; border-radius: var(--r-pill);
  background: transparent; color: var(--c-dim); font-size: 11px; font-weight: 600; white-space: nowrap;
  opacity: .55; transition: opacity .1s, background .1s; }
.opt:hover .opt-act, .opt.active .opt-act, .opt-act:focus-visible { opacity: 1; background: var(--c-raised); }
.opt-act:hover:not(:disabled) { color: var(--c-text); border-color: var(--c-border); }
.opt-act:disabled { opacity: 0 !important; }
.opt-act.neg:hover:not(:disabled) { color: var(--c-danger); }

/* ---------- selected tags ---------- */
.chips { display: block; min-height: 4px; }
.empty { display: block; padding: 10px 2px; color: var(--c-faint); font-size: 12.5px; line-height: 1.45; }
.positive-groups { display: flex; flex-direction: column; align-items: stretch; }
.group { display: flex; flex-direction: column; align-items: stretch; gap: 6px; padding: 7px 8px;
  border: 1px solid var(--c-accent-line); border-radius: 10px;
  background: color-mix(in srgb, var(--c-accent) 7%, transparent);
  transition: border-color .14s, background .14s, box-shadow .14s; }
.group.single { padding: 0; border-color: transparent; background: transparent; }
.group.single:not(.has-issues) .group-head { display: none; }
.group-head { display: flex; align-items: center; gap: 6px; min-height: 22px; }
.group-rule { flex: 1; min-width: 0; color: var(--c-dim); font-size: 11.5px; font-weight: 600; }
.group-edit, .group-toggle { height: 22px; padding: 0 8px; border: 0; border-radius: var(--r-pill);
  background: transparent; color: var(--c-accent-text); font-size: 11.5px; font-weight: 600; }
.group-edit:hover, .group-toggle:hover { background: var(--c-accent-soft); }
.group-health { height: 22px; padding: 0 8px; border: 0; border-radius: var(--r-pill);
  background: color-mix(in srgb, var(--c-warn) 18%, transparent); color: var(--c-warn);
  font-size: 11px; font-weight: 700; }
.group-health:hover { background: color-mix(in srgb, var(--c-warn) 30%, transparent); }
.group-grip { flex: 0 0 auto; width: 14px; height: 20px; padding: 0; border: 0; border-radius: 4px;
  background: radial-gradient(circle, var(--c-dim) 1px, transparent 1.3px) 3px 3px / 4px 4px;
  opacity: .6; cursor: grab; }
.group-grip:hover, .group-grip:focus-visible { opacity: 1; background-color: var(--c-accent-soft); }
.group-grip:active { cursor: grabbing; }
.group-tags { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; }
.group-connector { display: flex; align-items: center; gap: 8px; height: 22px; padding: 0 10px;
  color: var(--c-faint); font-size: 11px; font-weight: 700; letter-spacing: .6px; text-transform: lowercase; }
.group-connector::before, .group-connector::after { content: ""; flex: 1; height: 1px; background: var(--c-border); }
.group-connector::first-letter { text-transform: lowercase; }

.chip { display: inline-flex; align-items: center; max-width: 100%; height: 27px; padding: 0 2px 0 0;
  border: 1px solid transparent; border-radius: var(--r-pill); background: var(--c-raised);
  transition: border-color .12s, background .12s, box-shadow .12s, opacity .12s; }
.chip[data-kind="pos"] { cursor: grab; }
.chip[data-kind="pos"]:active { cursor: grabbing; }
.chip:hover { border-color: var(--c-border); }
.drag-grip { flex: 0 0 auto; width: 0; height: 14px; margin-left: 0; opacity: 0; overflow: hidden;
  background: radial-gradient(circle, var(--c-dim) 1px, transparent 1.3px) 0 0 / 4px 4px;
  transition: width .12s, margin .12s, opacity .12s; }
.chip:hover .drag-grip { width: 6px; margin-left: 8px; opacity: .8; }
.chip .name { min-width: 0; max-width: 190px; padding: 0 5px 0 10px; border: 0; border-radius: var(--r-pill);
  background: none; color: var(--c-text); font-size: 12.5px; font-weight: 500; line-height: 25px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chip .name:hover { color: var(--c-accent-text); }
.chip .rm { flex: 0 0 auto; width: 22px; height: 22px; padding: 0; border: 0; border-radius: 50%;
  background: none; color: var(--c-dim); font-size: 15px; line-height: 1; }
.chip .rm:hover { color: var(--c-danger); background: color-mix(in srgb, var(--c-danger) 14%, transparent); }
.chip.neg { background: color-mix(in srgb, var(--c-danger) 10%, var(--c-raised)); }
.chip.neg .name::before { content: "not\\00a0"; color: var(--c-danger); font-weight: 700; }
.chip.dragging, .group.dragging { opacity: .4; }
.chips.drag-active .group:not(.single), .chips.group-drag-active .group:not(.dragging) { border-color: var(--c-accent); }
.chips.drag-active .group.single, .chips.group-drag-active .group.single:not(.dragging) { border-color: transparent; }
.group.drop-target, .chip.drop-target { border-color: var(--c-accent-text);
  background: color-mix(in srgb, var(--c-accent) 24%, transparent);
  box-shadow: 0 0 0 3px var(--c-accent-soft); }
.and-dropzone { display: none; align-items: center; justify-content: center; min-height: 32px; margin-top: 6px;
  padding: 4px 10px; border: 1px dashed var(--c-accent-line); border-radius: var(--r-md);
  color: var(--c-accent-text); font-size: 12px; font-weight: 600; }
.chips.drag-active.can-split .and-dropzone { display: flex; }
.and-dropzone.drop-target { border-style: solid; }
.negative-tags { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; margin-top: 10px; }
.neg-label { flex: 0 0 100%; color: var(--c-dim); font-size: 11.5px; font-weight: 600; }

/* similarity bundles: one summary chip that expands into its variants */
.tag-bundle { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 5px; max-width: 100%;
  padding: 2px; border: 1px dashed var(--c-accent-line); border-radius: 16px; }
.bundle-summary { height: 25px; padding: 0 10px; border: 0; border-radius: var(--r-pill);
  background: var(--c-accent-soft); color: var(--c-accent-text); font-size: 12px; font-weight: 600; }
.bundle-summary:hover { background: color-mix(in srgb, var(--c-accent) 28%, transparent); }
.bundle-count { margin-left: 6px; opacity: .8; font-size: 11px; font-weight: 500; }
.bundle-members { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; }

/* ---------- tray (tags picked up on image pages) ---------- */
.tray { display: none; }
.tray-head { display: flex; align-items: center; gap: 10px; margin: 4px 0 8px; color: var(--c-tray);
  font-size: 12px; font-weight: 700; white-space: nowrap; }
.tray-head .line { flex: 1; height: 1px; background: color-mix(in srgb, var(--c-tray) 35%, transparent); }
.tray-chips { display: flex; flex-direction: column; gap: 5px; margin-bottom: 12px; }
.tray-item { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; min-height: 36px;
  padding: 2px 3px 2px 12px; border: 1px solid color-mix(in srgb, var(--c-tray) 35%, transparent);
  border-radius: var(--r-md); background: color-mix(in srgb, var(--c-tray) 8%, transparent); }
.tray-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; font-weight: 600; }
.tray-actions { display: flex; gap: 2px; margin-left: 8px; }
.tray-action { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px;
  padding: 0; border: 1px solid transparent; border-radius: var(--r-sm); background: transparent; color: var(--c-dim); }
.tray-action svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2;
  stroke-linecap: round; stroke-linejoin: round; }
.tray-action:hover { color: var(--c-text); background: var(--c-raised); }
.tray-action.and:hover { color: var(--c-accent-text); background: var(--c-accent-soft); }
.tray-action.exclude:hover { color: var(--c-danger); background: color-mix(in srgb, var(--c-danger) 14%, transparent); }

/* ---------- generic quiet controls ---------- */
.btn-quiet, .preset-btn, .group-preset-btn, .history-btn, .group-editor-tool, .group-editor-action, .group-editor-back {
  height: var(--control-h); padding: 0 11px; border: 1px solid var(--c-border); border-radius: var(--r-md);
  background: var(--c-bg); color: var(--c-text); font-size: 12px; font-weight: 600; white-space: nowrap; }
:is(.btn-quiet, .preset-btn, .group-preset-btn, .history-btn, .group-editor-tool, .group-editor-action, .group-editor-back):hover:not(:disabled) {
  border-color: var(--c-accent); background: var(--c-accent-soft); }
:is(.btn-quiet, .preset-btn, .group-preset-btn, .history-btn, .group-editor-tool, .group-editor-action):disabled { opacity: .4; }
.preset-delete:hover:not(:disabled), .group-preset-delete:hover:not(:disabled),
.group-editor-action.remove:hover:not(:disabled), .group-editor-action.exclude:hover:not(:disabled) {
  border-color: var(--c-danger); background: color-mix(in srgb, var(--c-danger) 12%, transparent); color: var(--c-danger); }
.select { height: var(--control-h); min-width: 0; padding: 0 28px 0 10px; border: 1px solid var(--c-border);
  border-radius: var(--r-md); background: var(--c-input) no-repeat right 9px center / 10px
    url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 6'><path d='M1 1l4 4 4-4' fill='none' stroke='%238c8fa3' stroke-width='1.6' stroke-linecap='round'/></svg>");
  color: var(--c-text); font-size: 12px; appearance: none; -webkit-appearance: none;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.select:disabled { opacity: .5; }
.select:hover:not(:disabled) { border-color: var(--c-accent); }
.link-btn { display: inline-flex; align-items: center; gap: 4px; height: 28px; padding: 0 4px; border: 0;
  background: none; color: var(--c-accent-text); font-size: 12px; font-weight: 600; }
.link-btn:hover { text-decoration: underline; }

/* ---------- library: saved filters, reusable groups, text expression ---------- */
.presets { margin-top: 4px; }
.preset-row { display: grid; grid-template-columns: minmax(0, 1fr) auto auto auto; gap: 5px; }
.preset-row.empty-library { grid-template-columns: 1fr; }
.preset-row.empty-library :is(.preset-select, .preset-load, .preset-delete) { display: none; }
.group-library { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 5px; margin-top: 6px; }
.group-library.editor { grid-template-columns: minmax(0, 1fr) auto auto auto auto; }
.group-library.no-presets:not(.editor) { display: none; }
.library-foot { display: flex; justify-content: flex-end; margin-top: 2px; }

/* ---------- "More filters" row ---------- */
.more-filters { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 40px; margin-top: 14px;
  padding: 6px 12px; border: 1px solid var(--c-border); border-radius: var(--r-md); background: var(--c-bg);
  color: var(--c-text); text-align: left; }
.more-filters:hover { border-color: var(--c-accent); background: var(--c-accent-soft); }
.more-label { flex: 0 0 auto; font-size: 13px; font-weight: 600; }
.facet-summary { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--c-dim); font-size: 12px; }
.facet-badge { display: none; min-width: 20px; height: 20px; padding: 0 6px; border-radius: var(--r-pill);
  background: var(--c-accent); color: #fff; font-size: 11px; font-weight: 700; align-items: center; justify-content: center; }
.more-chevron { flex: 0 0 auto; width: 14px; height: 14px; color: var(--c-dim); }

/* ---------- footer: history + actions ---------- */
.history { display: grid; grid-template-columns: minmax(0, 1fr) auto auto auto; gap: 4px; align-items: center; margin-top: 14px; }
.history-summary { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--c-dim); font-size: 12px; }
.history-summary.dirty { color: var(--c-accent-text); }
.history-btn { height: 28px; padding: 0 9px; border-color: transparent; background: transparent; color: var(--c-dim); font-size: 12px; }
.history-btn:hover:not(:disabled) { color: var(--c-text); background: var(--c-raised); border-color: transparent; }
.actions { display: grid; grid-template-columns: 1fr auto; gap: 8px; margin-top: 8px; }
.btn { height: 38px; padding: 0 16px; border: 0; border-radius: var(--r-md); font-size: 13.5px; font-weight: 600; }
.apply { background: var(--c-accent); color: #fff; }
.apply:hover:not(:disabled) { filter: brightness(1.08); }
.apply:disabled { background: var(--c-raised); color: var(--c-faint); }
.clear { background: transparent; color: var(--c-text); border: 1px solid var(--c-border); }
.clear:hover { background: var(--c-raised); }
.hint { display: none; margin-top: 8px; color: var(--c-dim); font-size: 12px; }
.hint:not(:empty) { display: block; }
.hint.warn { color: var(--c-warn); }

/* ---------- chip / group action menu ---------- */
.menu { display: none; position: absolute; z-index: 6; min-width: 190px; max-width: 250px; padding: 4px;
  border: 1px solid var(--c-border); border-radius: var(--r-md); background: var(--c-bg);
  box-shadow: 0 12px 32px rgba(0, 0, 0, .45); }
.menu button { display: block; width: 100%; padding: 7px 10px; border: 0; border-radius: var(--r-sm); background: none;
  color: var(--c-text); font-size: 12.5px; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.menu button:hover { background: var(--c-raised); }
.menu button.danger { color: var(--c-danger); }
.menu button.danger:hover { background: color-mix(in srgb, var(--c-danger) 14%, transparent); }
.menu .menu-title { padding: 6px 10px 4px; color: var(--c-dim); font-size: 11px; font-weight: 700;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ---------- sub-views: shared header ---------- */
.group-view, .facet-view, .expression-view { display: none; }
.subhead { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
.back, .group-editor-back { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto;
  width: 32px; height: 32px; padding: 0; border: 1px solid var(--c-border); border-radius: var(--r-md);
  background: var(--c-bg); color: var(--c-text); font-size: 18px; line-height: 1; }
.back:hover, .group-editor-back:hover { border-color: var(--c-accent); background: var(--c-accent-soft); }
.back svg, .group-editor-back svg { width: 14px; height: 14px; }
.subtitle, .facet-title, .group-editor-title { flex: 1; min-width: 0; font-size: 14px; font-weight: 700;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.group-editor-count { flex: 0 0 auto; color: var(--c-dim); font-size: 12px; }

/* ---------- group editor ---------- */
.group-editor-search { width: 100%; height: 34px; padding: 0 10px; border: 1px solid var(--c-border); border-radius: var(--r-md);
  background: var(--c-input); color: var(--c-text); font-size: 13px; outline: none; }
.group-editor-search:focus { border-color: var(--c-accent); }
.group-editor-tools { display: flex; flex-wrap: wrap; gap: 5px; margin: 8px 0; }
.group-editor-tool { height: 28px; padding: 0 9px; border-radius: var(--r-pill); font-size: 11.5px; }
.group-editor-list { max-height: 360px; overflow: auto; border: 1px solid var(--c-border); border-radius: var(--r-md);
  background: var(--c-input); scrollbar-width: thin; }
.group-editor-row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 10px; align-items: center;
  min-height: 36px; padding: 5px 10px; border-bottom: 1px solid var(--c-border); font-size: 12.5px; cursor: pointer; }
.group-editor-row:last-child { border-bottom: 0; }
.group-editor-row:hover { background: var(--c-accent-soft); }
.group-editor-row input { margin: 0; accent-color: var(--c-accent); }
.group-editor-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.group-editor-id { color: var(--c-dim); font-size: 11px; font-variant-numeric: tabular-nums; }
.group-editor-issue { display: block; margin-top: 1px; color: var(--c-warn); font-size: 11px; }
.group-editor-empty { padding: 14px; color: var(--c-dim); font-size: 12px; text-align: center; }
.group-editor-bulk { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 5px; margin-top: 8px; }
.group-editor-secondary { display: grid; grid-template-columns: repeat(3, 1fr); gap: 5px; margin-top: 5px; }
.group-editor-target { min-width: 0; }
.group-view .section { margin-top: 16px; }

/* ---------- expression view ---------- */
.expression-input { display: block; width: 100%; min-height: 180px; padding: 10px; border: 1px solid var(--c-border);
  border-radius: var(--r-md); background: var(--c-input); color: var(--c-text); resize: vertical; outline: none;
  font: 12px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.expression-input:focus { border-color: var(--c-accent); }
.expression-status { min-height: 18px; padding: 6px 2px; color: var(--c-dim); font-size: 12px; }
.expression-status.error { color: var(--c-danger); }
.expression-actions { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; }
.expression-help { margin-top: 12px; color: var(--c-dim); font-size: 12px; line-height: 1.5; }
.expression-help code { padding: 1px 5px; border-radius: 4px; background: var(--c-raised); font-size: 11.5px; }

/* ---------- more-filters (facet) view ---------- */
.facet-section { margin-bottom: 4px; }
.facet-label { display: block; margin: 0 0 5px; font-size: 12px; font-weight: 600; }
.facet-note { margin-top: 5px; color: var(--c-dim); font-size: 11.5px; line-height: 1.4; }
.facet-input { width: 100%; height: 34px; padding: 0 10px; border: 1px solid var(--c-border); border-radius: var(--r-md);
  background: var(--c-input); color: var(--c-text); font-size: 13px; outline: none; }
.facet-input::placeholder { color: var(--c-faint); }
.facet-input:focus { border-color: var(--c-accent); }
.facet-pills { display: flex; flex-wrap: wrap; gap: 6px; }
.orientation-btn, .facet-check { display: inline-flex; align-items: center; gap: 7px; height: 30px; padding: 0 14px;
  border: 1px solid transparent; border-radius: var(--r-pill); background: var(--c-raised); color: var(--c-text);
  font-size: 12.5px; font-weight: 600; cursor: pointer; user-select: none; }
.orientation-btn:hover, .facet-check:hover { border-color: var(--c-border); }
.orientation-btn.active, .facet-check:has(input:checked) { background: var(--c-accent); color: #fff; }
.facet-check input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
.facet-check::before { content: ""; width: 12px; height: 12px; border-radius: 50%; border: 2px solid currentColor; opacity: .55; }
.facet-check:has(input:checked)::before { background: #fff; opacity: 1; box-shadow: inset 0 0 0 2px var(--c-accent); }
.facet-metrics { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.facet-metrics label { display: block; }
.facet-metrics .facet-label { font-weight: 500; color: var(--c-dim); }

/* resources */
.resource-selections { display: grid; gap: 6px; margin-bottom: 8px; }
.resource-row { display: grid; grid-template-columns: 62px minmax(0, 1fr); gap: 6px; align-items: start; }
.resource-kind { padding-top: 5px; color: var(--c-dim); font-size: 11px; font-weight: 700; letter-spacing: .3px; text-transform: uppercase; }
.resource-chips { display: flex; flex-wrap: wrap; gap: 4px; min-height: 26px; }
.resource-chips .empty { padding: 4px 0; font-size: 12px; }
.resource-chip { display: inline-flex; align-items: center; min-width: 0; max-width: 100%; height: 26px; padding-left: 9px;
  border: 1px solid var(--c-border); border-radius: var(--r-pill); background: var(--c-raised); font-size: 12px; }
.resource-chip.primary { border-color: var(--c-accent-line); background: var(--c-accent-soft); }
.resource-chip.negative { border-color: color-mix(in srgb, var(--c-danger) 40%, transparent);
  background: color-mix(in srgb, var(--c-danger) 10%, var(--c-raised)); }
.resource-chip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.resource-chip button { flex: 0 0 auto; width: 24px; height: 24px; border: 0; background: none; color: var(--c-dim); font-size: 14px; }
.resource-chip button:hover { color: var(--c-danger); }
.resource-results { display: none; max-height: 190px; margin-top: 5px; overflow: auto; border: 1px solid var(--c-border);
  border-radius: var(--r-md); background: var(--c-input); scrollbar-width: thin; }
.resource-result { display: grid; grid-template-columns: minmax(0, 1fr) auto auto auto; gap: 3px; align-items: center;
  padding: 4px 4px 4px 8px; border-bottom: 1px solid var(--c-border); }
.resource-result:last-child { border-bottom: 0; }
.resource-result-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.resource-result button { height: 26px; padding: 0 8px; border: 1px solid transparent; border-radius: var(--r-pill);
  background: var(--c-raised); color: var(--c-dim); font-size: 11px; font-weight: 600; }
.resource-result button:hover { color: var(--c-text); border-color: var(--c-border); }
.resource-status { padding: 9px; color: var(--c-dim); font-size: 12px; }

/* ---------- docked inside CivitAI's Filters popover ---------- */
:host([data-placement="docked"]) .panel {
  display: flex; flex-direction: column; width: 100%; height: 100%; min-height: 0; padding: 16px;
  border: 0; border-right: 1px solid var(--c-border); border-radius: 12px 0 0 12px; box-shadow: none;
}
:host([data-dock-layout="stacked"]) .panel {
  height: auto; border-right: 0; border-bottom: 1px solid var(--c-border); border-radius: 12px 12px 0 0;
}
:host([data-placement="docked"]) .head { flex: 0 0 auto; margin-bottom: 14px; }
:host([data-placement="docked"]) .x { display: none; }
:host([data-placement="docked"]) :is(.tag-view, .group-view, .facet-view, .expression-view) {
  flex: 1 1 auto; min-height: 0; overflow-y: auto; scrollbar-width: thin; padding: 2px 4px 2px 2px; margin: -2px -4px -2px -2px;
}
:host([data-placement="docked"]) .dropdown { max-height: min(300px, 34vh); }
:host([data-placement="docked"]) :is(.history, .actions, .hint) { flex: 0 0 auto; }
`;
