/*
 * A DOM small enough to read and real enough to matter.
 *
 * It tracks parent links (so `contains()` reflects detachment) and dispatches
 * clicks through a genuine capture-then-bubble path. Both are load-bearing:
 * the panel bug this guards against only appears when a click handler detaches
 * its own button mid-dispatch.
 */

'use strict';

function mkNode(tag) {
  return {
    tagName: tag,
    children: [], parent: null,
    attrs: {}, style: {}, dataset: {},
    className: '', hidden: false, disabled: false, offsetWidth: 100,
    listeners: { capture: {}, bubble: {} },
    classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },

    setAttribute(k, v) { this.attrs[k] = v; if (k === 'hidden') this.hidden = true; },
    getAttribute(k) { return this.attrs[k] ?? null; },
    addEventListener(type, fn, capture) {
      const bucket = capture ? this.listeners.capture : this.listeners.bubble;
      (bucket[type] ||= []).push(fn);
    },
    appendChild(child) { child.parent = this; this.children.push(child); return child; },
    insertAdjacentElement(_where, node) { return node; },
    remove() {
      if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this);
      this.parent = null;
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    contains(other) { for (let n = other; n; n = n.parent) if (n === this) return true; return false; },

    get textContent() { return (this._text ?? '') + this.children.map(c => c.textContent).join(' '); },
    set textContent(v) {
      this._text = v;
      this.children.forEach(c => { c.parent = null; });
      this.children = [];
    },
  };
}

function pathTo(node) {
  const out = [];
  for (let n = node; n; n = n.parent) out.push(n);
  return out.reverse();
}

/** Fires a click with a real capture (root→target) then bubble (target→root) pass. */
function dispatchClick(target) {
  const event = { type: 'click', target };
  const path = pathTo(target);
  for (const n of path) (n.listeners.capture.click || []).forEach(fn => fn(event));
  for (const n of path.slice().reverse()) (n.listeners.bubble.click || []).forEach(fn => fn(event));
}

/** Depth-first search over the stub tree. */
function find(node, predicate) {
  if (predicate(node)) return node;
  for (const child of node.children) {
    const hit = find(child, predicate);
    if (hit) return hit;
  }
  return null;
}

/** Installs the globals the userscript expects. `xhr` fakes GM_xmlhttpRequest. */
function installGlobals({ xhr } = {}) {
  const document = mkNode('#document');
  Object.assign(document, {
    createElement: mkNode,
    createElementNS: (_ns, tag) => mkNode(tag),
    querySelector: () => null,
    querySelectorAll: () => [],
    readyState: 'complete',
    head: mkNode('head'),
    documentElement: mkNode('html'),
  });
  document.body = document.appendChild(mkNode('body'));

  global.document = document;
  global.getComputedStyle = () => ({ position: 'static' });
  global.MutationObserver = class { observe() {} };
  global.location = { pathname: '/store' };
  global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  global.GM_addStyle = () => {};
  global.GM_xmlhttpRequest = xhr
    || (opts => setTimeout(() => opts.onerror({ status: 0, readyState: 4 }), 0));

  return document;
}

module.exports = { mkNode, dispatchClick, find, installGlobals };
