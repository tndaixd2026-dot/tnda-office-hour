import { cloneElement, isValidElement, type ButtonHTMLAttributes, type ComponentChildren, type VNode } from 'preact';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { renderSVG } from 'uqr';
import { useEngineStatus } from '../app/hooks';
import { APP_NAME, APP_SHORT_NAME } from '../config';
import { useApp } from '../app/session';
import { addDays, mdPad } from '../lib/time';
import { Icon, type IconName } from './icons';
import { toast } from './toast';

export function BrandMark({ code, sub }: { code?: string; sub?: string }) {
  return (
    <span class="brand">
      <span class="brand-mark" aria-hidden="true">
        OH
      </span>
      <span class="stack" style={{ gap: '0px', lineHeight: 1.2 }}>
        <span class="brand-name">
          {APP_SHORT_NAME}
          <span class="brand-tail">{APP_NAME.slice(APP_SHORT_NAME.length)}</span>
        </span>
        {(code || sub) && <span class="brand-code">{[code, sub].filter(Boolean).join(' · ')}</span>}
      </span>
    </span>
  );
}

export function LiveBadge() {
  const s = useEngineStatus();
  const { demo } = useApp();
  const text = demo ? '示範資料' : s === 'live' ? '即時同步' : s === 'offline' ? '重新連線中' : '連線中';
  return (
    <span class={`live ${s}`} title={demo ? '資料只存在這個分頁' : '資料會即時同步到每個人的畫面'}>
      <i aria-hidden="true" />
      <span class="live-text">{text}</span>
    </span>
  );
}

export function Spinner({ label = '載入中' }: { label?: string }) {
  return <span class="spin" role="status" aria-label={label} />;
}

export function Loading({ label = '載入中…' }: { label?: string }) {
  return (
    <div class="center-screen muted">
      <div class="stack" style={{ justifyItems: 'center' }}>
        <Spinner />
        <span class="small">{label}</span>
      </div>
    </div>
  );
}

export function Btn(
  props: ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: 'primary' | 'ghost' | 'danger' | 'accent';
    size?: 'sm' | 'lg';
    icon?: IconName;
    loading?: boolean;
    block?: boolean;
  },
) {
  const { variant, size, icon, loading, block, class: cls, children, disabled, type, ...rest } = props;
  return (
    <button
      type={type ?? 'button'}
      class={['btn', variant, size, block && 'block', !children && 'icon', cls].filter(Boolean).join(' ')}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <span class="spin" aria-hidden="true" /> : icon && <Icon name={icon} size={size === 'sm' ? 16 : 18} />}
      {children}
    </button>
  );
}

export function Field({
  label,
  help,
  error,
  optional,
  count,
  max,
  children,
}: {
  label: ComponentChildren;
  help?: ComponentChildren;
  error?: string | null;
  optional?: boolean;
  count?: number;
  max?: number;
  children: VNode<any>;
}) {
  const id = useId();
  const noteId = `${id}-note`;
  const note = error || help;
  const control = isValidElement(children)
    ? cloneElement(children, { id, 'aria-invalid': error ? true : undefined, 'aria-describedby': note ? noteId : undefined })
    : children;
  return (
    <div class={`field ${error ? 'bad' : ''}`}>
      <label class="label" for={id}>
        <span>
          {label}
          {optional && <span class="opt"> 選填</span>}
        </span>
        {max !== undefined && count !== undefined && (
          <span class="count" aria-hidden="true">
            {count}/{max}
          </span>
        )}
      </label>
      {control}
      {error ? (
        <span class="err" id={noteId} role="alert">
          {error}
        </span>
      ) : help ? (
        <span class="help" id={noteId}>
          {help}
        </span>
      ) : null}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
  name,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ComponentChildren;
  disabled?: boolean;
  /** accessible name when `label` is empty */
  name?: string;
}) {
  return (
    <label class="switch" style={disabled ? { opacity: 0.5 } : undefined}>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        aria-label={name}
        onChange={(e) => onChange((e.target as HTMLInputElement).checked)}
      />
      <span class="track" aria-hidden="true" />
      <span>{label}</span>
    </label>
  );
}

export function Seg<T extends string | number>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: Array<{ value: T; label: ComponentChildren; sub?: ComponentChildren }>;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div class="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button type="button" key={String(o.value)} aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
          {o.sub && <small>{o.sub}</small>}
        </button>
      ))}
    </div>
  );
}

export function Empty({ icon = 'calendar', title, children }: { icon?: IconName; title: ComponentChildren; children?: ComponentChildren }) {
  return (
    <div class="empty">
      <Icon name={icon} size={22} />
      <div class="title-s">{title}</div>
      {children && <div class="small">{children}</div>}
    </div>
  );
}

export function Menu({
  label,
  trigger,
  children,
  iconOnly = true,
}: {
  label: string;
  trigger: ComponentChildren;
  children: (close: () => void) => ComponentChildren;
  /** the trigger shows only an icon, so it needs `label` as its name */
  iconOnly?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div class="menu-wrap" ref={ref}>
      <button
        type="button"
        class="btn ghost sm"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={iconOnly ? label : undefined}
        title={label}
        onClick={() => setOpen(!open)}
      >
        {trigger}
      </button>
      {open && (
        <div class="menu" role="menu">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export async function copyText(text: string, done = '已複製') {
  try {
    await navigator.clipboard.writeText(text);
    toast(done);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    toast(ok ? done : '無法自動複製，請手動選取文字', { kind: ok ? 'info' : 'error' });
  }
}

export function CopyBtn({ text, label = '複製', done, size = 'sm' }: { text: string; label?: string; done?: string; size?: 'sm' | 'lg' }) {
  return (
    <Btn size={size} icon="copy" onClick={() => copyText(text, done)}>
      {label}
    </Btn>
  );
}

export function QR({ text, label }: { text: string; label: string }) {
  const svg = useMemo(() => renderSVG(text, { border: 1, pixelSize: 8, blackColor: '#161514', whiteColor: '#ffffff' }), [text]);
  return <div class="qr" role="img" aria-label={label} dangerouslySetInnerHTML={{ __html: svg }} />;
}

export interface WeekItem {
  id: number;
  start: string;
  label: string;
  status?: ComponentChildren;
  on?: boolean;
  pip?: boolean;
  past?: boolean;
  disabled?: boolean;
}

export function WeekStrip({ items, value, onPick, label = '選擇週次' }: { items: WeekItem[]; value: number | null; onPick: (id: number) => void; label?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const box = ref.current;
    const el = box?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!box || !el) return;
    const b = box.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (r.left < b.left || r.right > b.right) box.scrollLeft += r.left - b.left - 12;
  }, [value, items.length]);
  return (
    <div class="weeks" ref={ref} role="group" aria-label={label}>
      {items.map((w) => (
        <button
          type="button"
          key={w.id}
          class={`wk ${w.past ? 'past' : ''}`}
          aria-pressed={w.id === value}
          disabled={w.disabled}
          onClick={() => onPick(w.id)}
        >
          <span class="w">{w.label || '—'}</span>
          <span class="d">
            {mdPad(w.start)}–{mdPad(addDays(w.start, 4))}
          </span>
          {w.status !== undefined && <span class={`s ${w.on ? 'on' : ''}`}>{w.status}</span>}
          {w.pip && <span class="pip" aria-hidden="true" />}
        </button>
      ))}
    </div>
  );
}

export function GroupTag({ no, name, soft }: { no: number; name?: string; soft?: boolean }) {
  return (
    <span class="row" style={{ gap: '8px' }}>
      <span class={`gno ${soft ? 'soft' : ''}`}>{no}</span>
      {name !== undefined && <span class="nowrap" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{name || `第 ${no} 組`}</span>}
    </span>
  );
}

export function groupLabel(no: number, name?: string) {
  return name ? `第 ${no} 組「${name}」` : `第 ${no} 組`;
}

export function safeHref(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  return /^https?:\/\//i.test(url) ? url : undefined;
}

/** Where sessions happen: a link when it is a URL (e.g. a Google Meet room), plain text otherwise. */
/** A meeting place; a link opens it. `full` shows the address (admins tell the rooms apart). */
export function Place({ value, full }: { value: string; full?: boolean }) {
  const href = safeHref(value.trim());
  if (!href) return <>{value || '線上'}</>;
  let host = '';
  try {
    host = new URL(href).hostname;
  } catch {
    return <>{value}</>;
  }
  const label = !full && /(^|\.)meet\.google\.com$/i.test(host) ? 'Google Meet 會議室' : href.replace(/^https?:\/\//i, '');
  return (
    <a class="place" href={href} target="_blank" rel="noopener noreferrer">
      {label}
    </a>
  );
}
