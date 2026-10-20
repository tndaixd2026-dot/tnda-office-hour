import type { ComponentChildren, VNode } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { store } from '../app/store';

interface Entry {
  id: number;
  wide?: 'wide' | 'xwide';
  label: string;
  render: (close: (v?: any) => void) => VNode;
  resolve: (v: any) => void;
  opener: Element | null;
}

const dialogs = store<Entry[]>([]);
let seq = 0;
/** Where focus goes back to once the dialog that held it has closed (Dialogs). */
let restore: HTMLElement | null = null;

export function openDialog<T>(
  label: string,
  render: (close: (v?: T) => void) => VNode,
  opts: { wide?: 'wide' | 'xwide' } = {},
): Promise<T | undefined> {
  return new Promise((resolve) => {
    const id = ++seq;
    dialogs.set((l) => [...l, { id, label, render, resolve, wide: opts.wide, opener: document.activeElement }]);
  });
}

function closeDialog(id: number, value?: unknown) {
  const e = dialogs.get().find((d) => d.id === id);
  dialogs.set((l) => l.filter((d) => d.id !== id));
  if (e) {
    e.resolve(value);
    if (e.opener instanceof HTMLElement) restore = e.opener;
  }
}

export function confirm(opts: {
  title: string;
  body?: ComponentChildren;
  ok?: string;
  cancel?: string;
  danger?: boolean;
}): Promise<boolean> {
  return openDialog<boolean>(opts.title, (close) => (
    <>
      <h2>{opts.title}</h2>
      {opts.body && <div class="stack tight muted">{opts.body}</div>}
      <div class="actions">
        <button type="button" class="btn" onClick={() => close(false)}>
          {opts.cancel ?? '取消'}
        </button>
        <button type="button" class={`btn ${opts.danger ? 'danger' : 'primary'}`} data-autofocus onClick={() => close(true)}>
          {opts.ok ?? '確定'}
        </button>
      </div>
    </>
  )).then((v) => v === true);
}

export function ask(opts: {
  title: string;
  body?: ComponentChildren;
  label: string;
  placeholder?: string;
  ok?: string;
  initial?: string;
  maxLength?: number;
  optional?: boolean;
  multiline?: boolean;
}): Promise<string | null> {
  return openDialog<string>(opts.title, (close) => <AskForm opts={opts} close={close} />).then((v) => (v === undefined ? null : v));
}

function AskForm({ opts, close }: { opts: Parameters<typeof ask>[0]; close: (v?: string) => void }) {
  const [v, setV] = useState(opts.initial ?? '');
  const ok = opts.optional || v.trim().length > 0;
  const Tag = opts.multiline ? 'textarea' : 'input';
  return (
    <form
      class="stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (ok) close(v.trim());
      }}
    >
      <h2>{opts.title}</h2>
      {opts.body && <div class="muted small">{opts.body}</div>}
      <label class="field">
        <span class="label">
          {opts.label}
          {opts.optional && <span class="opt">選填</span>}
        </span>
        <Tag
          class={opts.multiline ? 'textarea' : 'input'}
          value={v}
          maxLength={opts.maxLength}
          placeholder={opts.placeholder}
          onInput={(e) => setV((e.target as HTMLInputElement).value)}
          data-autofocus
        />
      </label>
      <div class="actions">
        <button type="button" class="btn" onClick={() => close()}>
          取消
        </button>
        <button type="submit" class="btn primary" disabled={!ok}>
          {opts.ok ?? '確定'}
        </button>
      </div>
    </form>
  );
}

function DialogFrame({ entry, top }: { entry: Entry; top: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  // focus before the first paint, so it can never steal focus from
  // whatever the person (or a test) starts typing into right away
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || el.contains(document.activeElement)) return;
    const target = el.querySelector<HTMLElement>('[data-autofocus]') ?? el.querySelector<HTMLElement>('button, input, textarea, select, a[href]');
    target?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    if (!top) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeDialog(entry.id);
      }
      if (e.key === 'Tab' && ref.current) {
        const items = [...ref.current.querySelectorAll<HTMLElement>('button:not(:disabled), input, textarea, select, a[href], [tabindex="0"]')];
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [top]);
  return (
    <div
      class="scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closeDialog(entry.id);
      }}
    >
      <div ref={ref} class={`dialog ${entry.wide ?? ''}`} role="dialog" aria-modal="true" aria-label={entry.label}>
        {entry.render((v) => closeDialog(entry.id, v))}
      </div>
    </div>
  );
}

export function Dialogs() {
  const list = dialogs.use();
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    document.body.style.overflow = list.length ? 'hidden' : '';
    // Everything behind the top dialog is out of reach, for the keyboard
    // and screen readers alike, until it closes. Toasts still speak.
    const box = ref.current;
    if (!box) return;
    for (const el of box.parentElement?.children ?? []) {
      if (el !== box && el instanceof HTMLElement && !el.classList.contains('toasts')) el.inert = list.length > 0;
    }
    const scrims = [...box.children] as HTMLElement[];
    scrims.forEach((el, i) => (el.inert = i < scrims.length - 1));
    // only now can focus go back to what opened the dialog
    if (restore && document.contains(restore) && !restore.closest('[inert]')) restore.focus({ preventScroll: true });
    restore = null;
  }, [list]);
  return (
    <div ref={ref}>
      {list.map((e, i) => (
        <DialogFrame key={e.id} entry={e} top={i === list.length - 1} />
      ))}
    </div>
  );
}
