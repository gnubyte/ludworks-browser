// Image/video saver popup (toolbar "images" button, page context menu). Rendered by overlay.js;
// actions go to the media feature (src/main/media/media.js). The list, thumbnails (data: URLs, in
// batches) and save progress arrive as popup-data while the popup is open.
import { icon, h, clear } from './icons.js';

// Popup styles live next to this module (the overlay's CSP allows same-origin stylesheets only).
if (!document.querySelector('link[data-media]')) {
  document.head.append(h('link', { rel: 'stylesheet', href: 'overlay-media.css', 'data-media': '1' }));
}

const SMALL = 48;
const REASONS = {
  mse: 'Streamed in pieces (MediaSource): there is no single file to save',
  drm: 'DRM-protected video: cannot be saved',
  hls: 'HLS streaming playlist: not a single file',
  dash: 'DASH streaming manifest: not a single file',
  live: 'Live camera or call stream: cannot be saved',
  big: 'Too large to save here (over 500 MB for a video, 100 MB for a picture)',
};

function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
}

const plural = (n, one, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const dimsOf = (it) => (it.w && it.h ? `${it.w}×${it.h}` : it.w ? `${it.w} px wide` : '');
const typeKey = (it) => it.label || (it.video ? 'Video' : 'Other');
const isSmall = (it) => {
  const w = it.w || it.dw;
  const hh = it.h || it.dh;
  return !!(w || hh) && Math.max(w, hh) < SMALL;
};

export const POPUPS = {
  media(data, ctx, { act }) {
    const st = {
      sid: data.sid,
      items: [],
      byId: new Map(),
      tiles: new Map(),
      selected: new Set(),
      off: new Set(),
      small: false,
      collecting: false,
      picking: false,
      job: null,
      notice: '',
      lastIndex: -1,
      maxHeight: data.maxHeight || 600,
    };
    const box = h('div', { class: 'popup md' });
    const sub = h('div', { class: 'sub ellipsis' });
    const head = h(
      'div',
      { class: 'head' },
      h('span', { class: 'md-ic' }, icon('images', { size: 18 })),
      h('div', { class: 'grow' }, h('h2', {}, 'Save pictures and videos'), sub),
      h('button', { class: 'icon-btn small', title: 'Look again (after scrolling loads more)', 'aria-label': 'Look again', onclick: () => act('rescan', { sid: st.sid, ui: uiState() }) }, icon('reload', { size: 15 })),
    );
    const bar = h('div', { class: 'md-bar' });
    const grid = h('div', { class: 'md-grid', role: 'listbox', 'aria-multiselectable': 'true', 'aria-label': 'Pictures and videos' });
    grid.style.maxHeight = `${Math.max(200, Math.min(460, st.maxHeight - 200))}px`;
    const empty = h('div', { class: 'pad muted md-empty', hidden: true });
    const foot = h('div', { class: 'md-foot' });
    box.append(head, bar, grid, empty, foot);

    const visible = (it) => (st.small || !isSmall(it)) && !st.off.has(typeKey(it));
    const chosen = () => st.items.filter((it) => it.saveable && st.selected.has(it.id) && visible(it));
    const uiState = () => ({ selected: [...st.selected], off: [...st.off], small: st.small });
    const busy = () => st.picking || !!(st.job && !st.job.finished);

    // ------------------------------------------------------------------------ tiles
    const metaOf = (it) => [dimsOf(it), fmtBytes(it.bytes)].filter(Boolean).join(' · ');
    const tileFor = (it) => {
      const check = h('input', { type: 'checkbox', class: 'md-check', tabindex: '-1', 'aria-hidden': 'true', disabled: !it.saveable });
      const pic = h('div', { class: 'md-pic' }, icon(it.video ? 'film' : 'images', { size: 26, cls: 'md-ph' }));
      const meta = h('span', { class: 'md-dim' }, metaOf(it));
      const type = h('span', { class: `md-type ${it.video ? 'video' : ''}` }, typeKey(it));
      const tip = [it.alt, it.href, it.reason ? REASONS[it.reason] : ''].filter(Boolean).join('\n');
      const el = h(
        'div',
        { class: `md-tile ${it.saveable ? '' : 'off'}`, role: 'option', tabindex: '0', title: tip, 'aria-selected': 'false', 'aria-disabled': it.saveable ? null : 'true', dataset: { id: it.id } },
        pic,
        check,
        h('div', { class: 'md-meta' }, type, meta),
        it.reason ? h('div', { class: 'md-reason' }, REASONS[it.reason] || 'Cannot be saved') : h('div', { class: 'md-name' }, it.name || ''),
      );
      const t = { el, check, pic, meta, type, it };
      el.addEventListener('click', (e) => {
        if (!it.saveable) return;
        const order = st.items.filter(visible);
        const i = order.indexOf(it);
        if (e.shiftKey && st.lastIndex >= 0) {
          const [a, b] = [Math.min(st.lastIndex, i), Math.max(st.lastIndex, i)];
          const on = !st.selected.has(it.id);
          for (const x of order.slice(a, b + 1)) if (x.saveable) on ? st.selected.add(x.id) : st.selected.delete(x.id);
        } else if (st.selected.has(it.id)) st.selected.delete(it.id);
        else st.selected.add(it.id);
        st.lastIndex = i;
        syncSelection();
      });
      el.addEventListener('dblclick', () => it.href && /^https?:/i.test(it.href) && act('open', { sid: st.sid, id: it.id }));
      el.addEventListener('keydown', (e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          el.click();
        }
      });
      return t;
    };

    const applyThumb = (th) => {
      const t = st.tiles.get(th.id);
      const it = st.byId.get(th.id);
      if (!t || !it) return;
      if (th.exact || th.shape) {
        if (th.w && th.h) {
          it.w = th.w;
          it.h = th.h;
        }
        if (th.exact && th.bytes) it.bytes = th.bytes;
      }
      if (th.label && (th.exact || !it.label)) {
        it.label = th.label;
        t.type.textContent = th.label;
      }
      if (th.reason && it.saveable) {
        // over the size limit: listed, not selectable
        it.saveable = false;
        it.reason = th.reason;
        st.selected.delete(it.id);
        t.el.classList.add('off');
        t.el.setAttribute('aria-disabled', 'true');
        t.check.disabled = true;
        const why = th.reason === 'big' ? `Too large to save here (over ${th.limitMB} MB)` : REASONS[th.reason] || 'Cannot be saved';
        const line = t.el.querySelector('.md-name');
        if (line) line.replaceWith(h('div', { class: 'md-reason' }, why));
        t.el.title = `${t.el.title}\n${why}`;
      }
      if (th.src && /^data:image\//.test(th.src)) {
        const img = h('img', { alt: '', draggable: 'false', decoding: 'async', loading: 'lazy' });
        img.addEventListener('load', () => {
          // original bytes (formats the browser process cannot decode): their size is the picture's
          if (th.raw && th.exact && !it.w && img.naturalWidth) {
            it.w = img.naturalWidth;
            it.h = img.naturalHeight;
            t.meta.textContent = metaOf(it);
            refreshVisibility();
          }
        });
        img.src = th.src;
        clear(t.pic).append(img);
      }
      t.meta.textContent = metaOf(it);
    };

    const syncSelection = () => {
      for (const [id, t] of st.tiles) {
        const on = st.selected.has(id);
        t.el.classList.toggle('sel', on);
        t.el.setAttribute('aria-selected', on ? 'true' : 'false');
        t.check.checked = on;
      }
      renderFoot();
    };

    // -------------------------------------------------------------- items, chips, visibility
    const setItems = (items) => {
      const same = items.length === st.items.length && items.every((x, i) => st.items[i] && st.items[i].id === x.id);
      if (same) return;
      st.items = items.map((x) => ({ ...x }));
      st.byId = new Map(st.items.map((x) => [x.id, x]));
      st.tiles.clear();
      clear(grid);
      for (const it of st.items) {
        const t = tileFor(it);
        st.tiles.set(it.id, t);
        grid.append(t.el);
      }
      for (const id of [...st.selected]) if (!st.byId.has(id) || !st.byId.get(id).saveable) st.selected.delete(id);
    };

    const refreshVisibility = () => {
      let shown = 0;
      for (const it of st.items) {
        const v = visible(it);
        st.tiles.get(it.id).el.hidden = !v;
        if (v) shown++;
      }
      const smallCount = st.items.filter(isSmall).length;
      sub.textContent = !data.web ? 'No website in this tab' : st.collecting && !st.items.length ? `Looking on ${data.host}…` : `${plural(shown, 'item')} on ${data.host}${data.private ? ' (private window)' : ''}`;
      empty.hidden = shown > 0 || st.collecting;
      empty.textContent = !data.web ? 'Open a website to save its pictures and videos.' : st.items.length ? (smallCount ? `Only small pictures here: tick "Small" to see ${plural(smallCount, 'one')}.` : 'Nothing matches the selected types.') : 'No pictures or videos found on this page.';
      renderBar();
      renderFoot();
    };

    const renderBar = () => {
      clear(bar);
      if (!st.items.length) return;
      const counts = new Map();
      for (const it of st.items) if (st.small || !isSmall(it)) counts.set(typeKey(it), (counts.get(typeKey(it)) || 0) + 1);
      const chips = h('div', { class: 'md-chips' });
      for (const [k, n] of [...counts].sort((a, b) => b[1] - a[1])) {
        const on = !st.off.has(k);
        chips.append(
          h(
            'button',
            {
              class: `md-chip ${on ? 'on' : ''}`,
              'aria-pressed': on ? 'true' : 'false',
              title: on ? `Hide ${k}` : `Show ${k}`,
              onclick: () => {
                if (st.off.has(k)) st.off.delete(k);
                else st.off.add(k);
                refreshVisibility();
              },
            },
            k,
            h('span', { class: 'n' }, String(n)),
          ),
        );
      }
      const smallCount = st.items.filter(isSmall).length;
      const smallBox = h('input', { type: 'checkbox', checked: st.small });
      smallBox.addEventListener('change', () => {
        st.small = smallBox.checked;
        refreshVisibility();
      });
      bar.append(
        h('button', { class: 'btn small', onclick: () => (st.items.filter((it) => it.saveable && visible(it)).forEach((it) => st.selected.add(it.id)), syncSelection()) }, 'Select all'),
        h('button', { class: 'btn small', onclick: () => (st.selected.clear(), syncSelection()) }, 'None'),
        chips,
        smallCount ? h('label', { class: 'check md-small', title: `Pictures under ${SMALL} px (icons, spacers)` }, smallBox, `Small (${smallCount})`) : null,
      );
    };

    // ------------------------------------------------------------------------- footer
    const renderFoot = () => {
      clear(foot);
      const n = chosen().length;
      const job = st.job;
      const status = h('div', { class: 'md-status grow' });
      if (st.notice) status.append(h('div', { class: 'notice warn' }, st.notice));
      else if (st.picking) status.append(h('span', { class: 'muted' }, 'Choose a folder…'));
      else if (job && !job.finished) {
        const done = job.saved + job.failedCount;
        const share = job.expected ? Math.min(1, job.bytes / job.expected) : done / Math.max(1, job.total);
        status.append(
          h('div', { class: 'md-progress' }, h('i', { style: { width: `${Math.max(3, Math.round(share * 100))}%` } })),
          h('span', { class: 'muted' }, `Saving ${done} of ${job.total}${job.bytes ? ` · ${fmtBytes(job.bytes)}${job.expected ? ` of ${fmtBytes(job.expected)}` : ''}` : ''}…`),
        );
      } else if (job && job.finished) {
        const line = job.cancelled ? `Cancelled: saved ${job.saved} of ${job.total}` : `Saved ${plural(job.saved, 'file')} to ${job.dirName}`;
        status.append(h('div', { class: `md-result ${job.failedCount ? 'warn' : 'ok'}`, title: job.dir }, icon(job.failedCount ? 'warn' : 'check', { size: 15 }), h('span', {}, `${line}${job.failedCount && !job.cancelled ? ` · ${job.failedCount} failed` : ''}`)));
        if (job.failed.length && !job.cancelled) {
          const list = h('div', { class: 'md-failed' });
          for (const f of job.failed.slice(0, 6)) list.append(h('div', { class: 'ellipsis', title: `${f.name}: ${f.error}` }, `${f.name}: ${f.error}`));
          if (job.failedCount > 6) list.append(h('div', { class: 'muted' }, `and ${job.failedCount - 6} more`));
          status.append(list);
        }
      } else if (st.collecting) status.append(h('span', { class: 'muted md-busy' }, 'Looking for pictures and videos…'));
      else if (st.items.length) status.append(h('span', { class: 'muted' }, n ? `${plural(n, 'item')} selected` : 'Click pictures to select them · double-click opens one'));
      const actions = h('div', { class: 'row' });
      if (job && !job.finished) actions.append(h('button', { class: 'btn', onclick: async () => applyJob(await act('cancel', {})) }, 'Cancel'));
      else if (job && job.finished) {
        actions.append(h('button', { class: 'btn', onclick: () => act('open-folder', {}) }, icon('folder', { size: 15 }), 'Open folder'));
        actions.append(
          h(
            'button',
            {
              class: 'btn',
              onclick: () => {
                st.job = null;
                act('dismiss', {});
                renderFoot();
              },
            },
            'Done',
          ),
        );
      }
      if (!(job && job.finished) || n) {
        actions.append(
          h(
            'button',
            {
              class: 'btn primary',
              disabled: !n || busy(),
              onclick: async () => {
                // picking until main says otherwise: its progress can arrive before this call's answer
                st.notice = '';
                st.picking = true;
                renderFoot();
                const r = await act('save', { sid: st.sid, ids: chosen().map((it) => it.id), ui: uiState() });
                if (!r || r.error) {
                  st.picking = false;
                  st.notice = (r && r.error) || 'Could not start saving.';
                }
                renderFoot();
              },
            },
            n ? `Save ${n} to folder…` : 'Save to folder…',
          ),
        );
      }
      foot.append(status, actions);
    };

    const applyJob = (job) => {
      if (job !== undefined) st.job = job;
      renderFoot();
    };

    // ------------------------------------------------------------------ data from main
    const onData = (d) => {
      if (!d || d.sid !== st.sid) return;
      if (Array.isArray(d.items)) setItems(d.items);
      if (d.ui) {
        st.off = new Set(d.ui.off || []);
        st.small = !!d.ui.small;
        if (Array.isArray(d.ui.selected) && d.ui.selected.length) st.selected = new Set(d.ui.selected.filter((id) => st.byId.has(id) && st.byId.get(id).saveable));
      }
      if (Array.isArray(d.thumbs)) for (const th of d.thumbs) applyThumb(th);
      if (Array.isArray(d.remove) && d.remove.length) {
        for (const id of d.remove) {
          const t = st.tiles.get(id);
          if (t) t.el.remove();
          st.tiles.delete(id);
          st.byId.delete(id);
          st.selected.delete(id);
        }
        st.items = st.items.filter((x) => st.byId.has(x.id));
      }
      if ('collecting' in d) st.collecting = !!d.collecting;
      if ('picking' in d) st.picking = !!d.picking;
      if ('job' in d) st.job = d.job;
      if (d.job && !d.job.finished) st.notice = '';
      syncSelection();
      refreshVisibility();
    };
    ctx.onData = onData;
    onData(data);
    box.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && e.target.tagName !== 'INPUT') {
        e.preventDefault();
        st.items.filter((it) => it.saveable && visible(it)).forEach((it) => st.selected.add(it.id));
        syncSelection();
      }
    });
    return box;
  },
};
