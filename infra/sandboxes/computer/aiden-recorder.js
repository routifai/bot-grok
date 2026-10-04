// Injected into every page and frame of the Computer's Chromium by `aiden-recorder` while a
// person teaches a task. It reports what they do as semantic actions (never coordinates) through
// the CDP binding `__aidenRecord`. Secret fields are redacted here, in the page: their value is
// never read, so it cannot leave the browser.
(() => {
  const BINDING = "__aidenRecord";
  if (window.__aidenRecInstalled) return;
  Object.defineProperty(window, "__aidenRecInstalled", { value: true });

  const SECRET_HINT =
    /pass(word|code|wd)|\botp\b|one.?time|2fa|mfa|\bcvv\b|\bcvc\b|card.?num|\bssn\b|secret|token|\bpin\b/i;
  const SECRET_AUTOCOMPLETE = /(^|\s)(one-time-code|current-password|new-password|cc-[a-z-]+)(\s|$)/;
  const TEXT_INPUT_TYPES = new Set([
    "", "text", "search", "email", "tel", "url", "number", "date", "datetime-local", "month",
    "time", "week", "color", "password",
  ]);
  const BUTTON_INPUT_TYPES = new Set(["button", "submit", "reset", "image"]);
  const INTERACTIVE =
    'a,button,input,select,textarea,summary,label,[role=button],[role=link],[role=menuitem],' +
    '[role=tab],[role=checkbox],[role=radio],[role=option],[role=switch],[onclick],[tabindex]';
  const MAX_TEXT = 80;
  const MAX_VALUE = 300;
  const IDLE_FLUSH_MS = 1200;
  const DEDUPE_MS = 80;

  const clip = (text, max) => String(text == null ? "" : text).replace(/\s+/g, " ").trim().slice(0, max);

  function isSecret(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName;
    const editable = tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
    if (!editable) return false;
    if ((el.getAttribute("type") || "").toLowerCase() === "password") return true;
    if (SECRET_AUTOCOMPLETE.test((el.getAttribute("autocomplete") || "").toLowerCase())) return true;
    if (el.closest("[data-secret],[data-aiden-secret],[data-sensitive]")) return true;
    const hint = [el.name, el.id, el.getAttribute("aria-label"), el.getAttribute("placeholder")];
    return SECRET_HINT.test(hint.join(" "));
  }

  function roleOf(el) {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.split(/\s+/)[0];
    const tag = el.tagName;
    if (tag === "A") return el.hasAttribute("href") ? "link" : "generic";
    if (tag === "BUTTON" || tag === "SUMMARY") return "button";
    if (tag === "SELECT") return el.multiple ? "listbox" : "combobox";
    if (tag === "TEXTAREA") return "textbox";
    if (tag === "IMG") return "img";
    if (/^H[1-6]$/.test(tag)) return "heading";
    if (tag === "INPUT") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (BUTTON_INPUT_TYPES.has(type)) return "button";
      if (type === "checkbox" || type === "radio") return type;
      if (type === "range") return "slider";
      if (type === "search") return "searchbox";
      if (type === "number") return "spinbutton";
      return "textbox";
    }
    if (el.isContentEditable) return "textbox";
    return tag.toLowerCase();
  }

  function labelsOf(el) {
    try {
      if (el.labels && el.labels.length) {
        return clip(Array.from(el.labels).map((l) => l.innerText || l.textContent).join(" "), MAX_TEXT);
      }
    } catch (_e) {}
    return "";
  }

  function nameOf(el) {
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const text = by
        .split(/\s+/)
        .map((id) => {
          const ref = document.getElementById(id);
          return ref ? ref.innerText || ref.textContent : "";
        })
        .join(" ");
      if (clip(text, MAX_TEXT)) return clip(text, MAX_TEXT);
    }
    const aria = el.getAttribute("aria-label");
    if (aria && clip(aria, MAX_TEXT)) return clip(aria, MAX_TEXT);
    const label = labelsOf(el);
    if (label) return label;
    const alt = el.getAttribute("alt") || el.getAttribute("title");
    if (alt && clip(alt, MAX_TEXT)) return clip(alt, MAX_TEXT);
    if (el.tagName === "INPUT") {
      const type = (el.getAttribute("type") || "").toLowerCase();
      if (BUTTON_INPUT_TYPES.has(type) && el.value) return clip(el.value, MAX_TEXT);
      return clip(el.getAttribute("placeholder"), MAX_TEXT);
    }
    if (el.tagName === "TEXTAREA" || el.tagName === "SELECT") {
      return clip(el.getAttribute("placeholder"), MAX_TEXT);
    }
    return clip(el.innerText || el.textContent, MAX_TEXT);
  }

  function selectorHint(el) {
    const unique = (sel) => {
      try {
        return document.querySelectorAll(sel).length === 1;
      } catch (_e) {
        return false;
      }
    };
    const tag = el.tagName.toLowerCase();
    const attr = (name) => el.getAttribute(name);
    const esc = (v) => String(v).replace(/(["\\])/g, "\\$1");
    for (const name of ["data-testid", "data-test", "data-qa"]) {
      if (attr(name) && unique(`[${name}="${esc(attr(name))}"]`)) return `[${name}="${esc(attr(name))}"]`;
    }
    const stableId = el.id && !/\d{4,}|[0-9a-f]{8,}/i.test(el.id) && unique("#" + CSS.escape(el.id));
    if (stableId) return "#" + CSS.escape(el.id);
    for (const name of ["name", "aria-label", "placeholder"]) {
      const sel = `${tag}[${name}="${esc(attr(name) || "")}"]`;
      if (attr(name) && attr(name).length < 60 && unique(sel)) return sel;
    }
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 4 && node !== document.body) {
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(" > ");
  }

  function safeHref(el) {
    try {
      const href = el.getAttribute("href");
      if (!href || href.startsWith("javascript:")) return "";
      const url = new URL(href, location.href);
      return url.origin + url.pathname;
    } catch (_e) {
      return "";
    }
  }

  // Never reads `.value` or text of a secret field.
  function describe(el) {
    const secret = isSecret(el);
    const out = {
      role: roleOf(el),
      name: nameOf(el),
      label: labelsOf(el),
      placeholder: clip(el.getAttribute("placeholder"), MAX_TEXT),
      selector: selectorHint(el),
      tag: el.tagName.toLowerCase(),
      frameUrl: location.href,
      topFrame: window === window.top,
    };
    const isField = el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
    if (!isField && !secret) out.text = clip(el.innerText || el.textContent, MAX_TEXT);
    if (el.tagName === "A") out.href = safeHref(el);
    return out;
  }

  function visiblePasswordField() {
    const field = document.querySelector("input[type=password]");
    return Boolean(field && (field.offsetParent !== null || field.getClientRects().length));
  }

  function noFrame() {
    return visiblePasswordField() || isSecret(document.activeElement);
  }

  Object.defineProperty(window, "__aidenRecState", {
    value: () => ({ noFrame: noFrame() }),
  });

  const queue = [];
  function send(action) {
    action.t = Date.now();
    action.noFrame = noFrame();
    queue.push(JSON.stringify(action));
    drain();
  }
  function drain() {
    const bind = window[BINDING];
    if (typeof bind !== "function") {
      setTimeout(drain, 200);
      return;
    }
    while (queue.length) bind(queue.shift());
  }

  let last = { el: null, kind: "", t: 0 };
  function remember(kind, el) {
    last = { el, kind, t: Date.now() };
  }
  function repeated(kind, el) {
    return last.kind === kind && last.el === el && Date.now() - last.t < DEDUPE_MS;
  }

  let pending = null;
  let idleTimer = 0;
  function flushPending() {
    clearTimeout(idleTimer);
    if (!pending) return;
    const el = pending;
    pending = null;
    if (!el.isConnected) return;
    if (isSecret(el)) {
      send({ kind: "secret", ...describe(el) });
    } else {
      const raw = el.isContentEditable && el.tagName !== "INPUT" ? el.innerText : el.value;
      send({ kind: "type", value: clip(raw, MAX_VALUE), ...describe(el) });
    }
    remember("type", el);
  }

  function target(event) {
    const path = event.composedPath ? event.composedPath() : [];
    const raw = path.length ? path[0] : event.target;
    return raw && raw.nodeType === 1 ? raw : raw && raw.parentElement;
  }

  function isTextLike(el) {
    if (el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
    if (el.isContentEditable) return true;
    return el.tagName === "INPUT" && TEXT_INPUT_TYPES.has((el.getAttribute("type") || "").toLowerCase());
  }

  const options = { capture: true, passive: true };

  document.addEventListener(
    "click",
    (event) => {
      if (!event.isTrusted) return;
      let el = target(event);
      if (!el) return;
      el = el.closest(INTERACTIVE) || el;
      if (el.tagName === "LABEL" && el.control) el = el.control;
      const type = (el.getAttribute("type") || "").toLowerCase();
      // Focus clicks and checkbox/radio toggles are reported by input/change instead.
      if (isTextLike(el) || type === "checkbox" || type === "radio" || type === "file") return;
      if (repeated("click", el)) return;
      // Pressing Enter in a field makes the browser click the form's submit button.
      if (event.detail === 0 && last.kind === "key" && Date.now() - last.t < 300) return;
      flushPending();
      send({ kind: "click", ...describe(el) });
      remember("click", el);
    },
    options,
  );

  document.addEventListener(
    "input",
    (event) => {
      if (!event.isTrusted) return;
      const el = target(event);
      if (!el || !isTextLike(el) || el.tagName === "SELECT") return;
      if (pending && pending !== el) flushPending();
      pending = el;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(flushPending, IDLE_FLUSH_MS);
    },
    options,
  );

  document.addEventListener(
    "change",
    (event) => {
      if (!event.isTrusted) return;
      const el = target(event);
      if (!el) return;
      const type = (el.getAttribute("type") || "").toLowerCase();
      if (el.tagName === "SELECT") {
        flushPending();
        const chosen = Array.from(el.selectedOptions || []).map((o) => clip(o.text, MAX_TEXT));
        send({ kind: "select", value: chosen.join(", "), ...describe(el) });
        remember("select", el);
      } else if (type === "checkbox" || type === "radio") {
        flushPending();
        send({ kind: "check", checked: Boolean(el.checked), ...describe(el) });
        remember("check", el);
      } else if (type === "file") {
        flushPending();
        send({ kind: "file", ...describe(el) });
        remember("file", el);
      } else if (pending === el) {
        flushPending();
      }
    },
    options,
  );

  document.addEventListener("focusout", () => flushPending(), options);
  window.addEventListener("pagehide", () => flushPending(), options);

  document.addEventListener(
    "keydown",
    (event) => {
      if (!event.isTrusted || event.key !== "Enter" || event.isComposing) return;
      const el = target(event);
      if (!el || !isTextLike(el) || el.tagName === "SELECT") return;
      if (el.tagName === "TEXTAREA" && !(event.ctrlKey || event.metaKey)) return;
      flushPending();
      send({ kind: "key", key: "Enter", ...describe(el) });
      remember("key", el);
    },
    options,
  );

  document.addEventListener(
    "submit",
    (event) => {
      // A click or Enter just reported is the cause; only a bare submit adds information.
      if (Date.now() - last.t < 800) return;
      const form = event.target;
      if (!form || form.nodeType !== 1) return;
      flushPending();
      send({
        kind: "submit",
        role: "form",
        name: clip(form.getAttribute("aria-label") || form.getAttribute("name") || form.id, MAX_TEXT),
        selector: selectorHint(form),
        tag: "form",
        frameUrl: location.href,
        topFrame: window === window.top,
      });
    },
    options,
  );
})();
