// Small DOM helpers: element builder, modal, toasts, feed.

type Child = Node | string | null | undefined | false;
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, any> = {}, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v; // only ever used with static strings from this codebase
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const kid of kids) if (kid) el.append(kid);
  return el;
}
export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** Text with one emphasised part, built without innerHTML so user text can never become markup. */
export function rich(parts: (string | { b: string } | { em: string } | { small: string })[]): DocumentFragment {
  const f = document.createDocumentFragment();
  for (const p of parts) {
    if (typeof p === 'string') f.append(p);
    else if ('b' in p) f.append(h('b', {}, p.b));
    else if ('em' in p) f.append(h('em', {}, p.em));
    else f.append(h('small', {}, p.small));
  }
  return f;
}

// ───────── modal ─────────
let openModal: { close: () => void } | null = null;
export function modal(build: (close: () => void) => HTMLElement, opts: { label: string }): { close: () => void } {
  openModal?.close();
  const root = $('modal-root');
  const prevFocus = document.activeElement as HTMLElement | null;
  const scrim = h('div', { class: 'scrim' });
  const close = () => {
    if (!scrim.isConnected) return;
    scrim.remove();
    document.removeEventListener('keydown', onKey, true);
    openModal = null;
    prevFocus?.focus?.();
  };
  const box = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.label });
  box.append(h('button', { class: 'card-close', 'aria-label': 'Close', onclick: close }, '×'), build(close));
  scrim.append(box);
  scrim.addEventListener('pointerdown', (e) => { if (e.target === scrim) close(); });
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    if (e.key === 'Tab') {
      const f = [...box.querySelectorAll<HTMLElement>('button, [href], input, textarea, [tabindex]:not([tabindex="-1"])')].filter((x) => !x.hasAttribute('disabled'));
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };
  document.addEventListener('keydown', onKey, true);
  root.append(scrim);
  const auto = box.querySelector<HTMLElement>('[data-autofocus]') ?? box.querySelector<HTMLElement>('button.btn') ?? box;
  setTimeout(() => auto.focus(), 30);
  openModal = { close };
  return openModal;
}
export const isModalOpen = () => openModal !== null;

// ───────── toasts ─────────
export interface ToastAction { label: string; run: () => void; quiet?: boolean }
export function toast(content: Node, opts: { ms?: number; plain?: boolean; sticky?: boolean; action?: ToastAction; actions?: ToastAction[] } = {}): () => void {
  const box = $('toasts');
  const el = h('div', { class: 'toast' + (opts.plain ? ' plain' : '') + (opts.sticky ? ' sticky' : ''), role: 'status' }, h('p', {}, content));
  let gone = false;
  const dismiss = () => {
    if (gone) return; gone = true;
    el.classList.add('out');
    setTimeout(() => el.remove(), 500);
  };
  const acts = opts.actions ?? (opts.action ? [opts.action] : []);
  if (acts.length) {
    const row = h('span', { class: 'toast-actions' });
    for (const a of acts) row.append(h('button', { class: `btn small ${a.quiet ? 'ghost' : 'primary'}`, onclick: () => { a.run(); dismiss(); } }, a.label));
    el.append(row);
  }
  // a sticky toast stays until it is answered or closed
  if (opts.sticky) el.append(h('button', { class: 'toast-close', 'aria-label': 'Dismiss', onclick: dismiss }, '×'));
  box.prepend(el);
  // make room by dropping the oldest toast that is not waiting for an answer
  while (box.children.length > 3) {
    const old = [...box.children].reverse().find((c) => !c.classList.contains('sticky')) ?? box.lastElementChild!;
    old.remove();
  }
  if (!opts.sticky) setTimeout(dismiss, opts.ms ?? 6000);
  return dismiss;
}

// ───────── feed ─────────
/** One line of news. With `go`, the line is a button that takes the visitor there. */
export function feed(content: Node, cool = false, go?: () => void) {
  const list = $('feed');
  const li = h('li', { class: (cool ? 'cool' : '') + (go ? ' go' : '') }, content);
  if (go) {
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    li.addEventListener('click', go);
    li.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  }
  list.append(li);
  while (list.children.length > 4) list.firstElementChild!.remove();
  setTimeout(() => li.remove(), go ? 16000 : 10500);
}

/** Count a number up or down to a new value. */
export function countTo(el: HTMLElement, to: number, fmt: (n: number) => string = (n) => Math.round(n).toLocaleString('en-US')) {
  const from = Number(el.dataset.v ?? 0);
  el.dataset.v = String(to);
  if (from === to || matchMedia('(prefers-reduced-motion: reduce)').matches) { el.textContent = fmt(to); return; }
  const t0 = performance.now(), ms = 1100;
  const step = (now: number) => {
    const k = Math.min(1, (now - t0) / ms);
    const e = 1 - Math.pow(1 - k, 3);
    el.textContent = fmt(from + (to - from) * e);
    if (k < 1 && el.dataset.v === String(to)) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
