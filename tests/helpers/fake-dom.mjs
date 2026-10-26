// A deliberately tiny DOM imitation: just the surface lib/field-detect.js relies on.

export class FakeEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.bubbles = !!init.bubbles;
    this.composed = !!init.composed;
    this.isTrusted = false;
  }
}

let nativeSets = 0;
export function nativeSetCount() {
  return nativeSets;
}

export class FakeElement {
  constructor(doc, tag, attrs = {}) {
    this.ownerDocument = doc;
    this.tagName = tag.toUpperCase();
    this.nodeType = 1;
    this.attrs = new Map(Object.entries(attrs).map(([k, v]) => [k, String(v)]));
    this.children = [];
    this.parentElement = null;
    this.isConnected = true;
    this.disabled = attrs.disabled !== undefined;
    this.readOnly = attrs.readonly !== undefined;
    this.hidden = attrs.hidden !== undefined;
    this._value = attrs.value !== undefined ? String(attrs.value) : '';
    this.style = {};
    this.rect = { left: 10, top: 10, width: 200, height: 30 };
    this.events = [];
    this.focused = false;
    this.labels = [];
    this.contentDocument = null;
  }
  get value() {
    return this._value;
  }
  set value(v) {
    nativeSets += 1;
    this._value = String(v);
  }
  get type() {
    return (this.attrs.get('type') || 'text').toLowerCase();
  }
  get form() {
    let p = this.parentElement;
    while (p) {
      if (p.tagName === 'FORM') return p;
      p = p.parentElement;
    }
    return null;
  }
  getAttribute(n) {
    return this.attrs.has(n) ? this.attrs.get(n) : null;
  }
  setAttribute(n, v) {
    this.attrs.set(n, String(v));
  }
  append(...kids) {
    for (const k of kids) {
      k.parentElement = this;
      this.children.push(k);
    }
    return this;
  }
  displayed() {
    for (let n = this; n; n = n.parentElement) if (n.style.display === 'none') return false;
    return true;
  }
  getClientRects() {
    return this.displayed() && this.rect.width > 0 && this.rect.height > 0 ? [this.rect] : [];
  }
  getBoundingClientRect() {
    const r = this.rect;
    return { left: r.left, top: r.top, width: r.width, height: r.height, right: r.left + r.width, bottom: r.top + r.height };
  }
  focus() {
    this.focused = true;
  }
  dispatchEvent(e) {
    this.events.push(e.type);
    return true;
  }
  *walk() {
    for (const c of this.children) {
      yield c;
      yield* c.walk();
    }
  }
}

class FakeWindow {
  constructor(doc) {
    this.document = doc;
    this.scrollX = 0;
    this.scrollY = 0;
    this.Event = FakeEvent;
    this.HTMLInputElement = FakeElement;
  }
  getComputedStyle(el) {
    let visibility = 'visible';
    for (let n = el; n; n = n.parentElement) {
      if (n.style.visibility) {
        visibility = n.style.visibility;
        break;
      }
    }
    return {
      display: el.style.display || 'block',
      visibility,
      opacity: el.style.opacity !== undefined ? String(el.style.opacity) : '1',
      contentVisibility: el.style.contentVisibility || 'visible',
    };
  }
}

export class FakeDocument {
  constructor({ origin = 'https://example.com', path = '/login' } = {}) {
    this.location = { origin, href: `${origin}${path}`, protocol: new URL(origin).protocol };
    this.defaultView = new FakeWindow(this);
    this.body = new FakeElement(this, 'body');
  }
  el(tag, attrs = {}, ...kids) {
    const e = new FakeElement(this, tag, attrs);
    e.append(...kids);
    return e;
  }
  querySelectorAll(sel) {
    const tags = sel.split(',').map((s) => s.trim().toUpperCase());
    return [...this.body.walk()].filter((n) => tags.includes(n.tagName));
  }
}
