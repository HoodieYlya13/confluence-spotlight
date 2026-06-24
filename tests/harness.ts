import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { vi } from "vitest";

const html = readFileSync(
  fileURLToPath(new URL("../index.html", import.meta.url)),
  "utf8",
);
const BODY = html.replace(/[\s\S]*<body>/, "").replace(/<\/body>[\s\S]*/, "");

export function baseSession(overrides: Record<string, unknown> = {}) {
  return {
    role: "JUNIOR_OP",
    role_label: "Junior Operator",
    username: "junior",
    given_name: "Junior",
    account_url: null,
    hotkey: "CmdOrCtrl+Shift+Space",
    scroll_keys: "CmdOrCtrl+Down",
    link_keys: "CmdOrCtrl+Shift+Down",
    settings_keys: "CmdOrCtrl+,",
    nvim_mode: true,
    nvim_open_mode: "insert",
    nvim_leader: "Space",
    follow_mouse: true,
    app_version: "0.0.0-test",
    ...overrides,
  };
}

function installGlobals(dom: JSDOM) {
  const w = dom.window as unknown as Record<string, unknown> & Window;
  (w as unknown as Record<string, unknown>).requestAnimationFrame = (
    cb: FrameRequestCallback,
  ) => w.setTimeout(() => cb(Date.now()), 0) as unknown as number;
  (w as unknown as Record<string, unknown>).cancelAnimationFrame = (
    id: number,
  ) => w.clearTimeout(id);

  const g = globalThis as unknown as Record<string, unknown>;
  g.window = w;
  g.document = w.document;
  g.KeyboardEvent = w.KeyboardEvent;
  g.Event = w.Event;
  g.CustomEvent = w.CustomEvent;
  g.HTMLElement = w.HTMLElement;
  g.Node = w.Node;
  g.requestAnimationFrame = (w as unknown as Record<string, unknown>)
    .requestAnimationFrame;
  g.cancelAnimationFrame = (w as unknown as Record<string, unknown>)
    .cancelAnimationFrame;
  g.getComputedStyle = w.getComputedStyle.bind(w);
}

export type AppHandle = {
  input: HTMLInputElement;
  modeBadge: HTMLElement;
  answer: HTMLElement;
  doc: Document;
};

export async function loadApp(session: Record<string, unknown>): Promise<AppHandle> {
  const dom = new JSDOM(
    `<!doctype html><html><head></head><body>${BODY}</body></html>`,
    { url: "http://localhost/", pretendToBeVisual: true },
  );
  installGlobals(dom);

  vi.resetModules();
  await import("../src/main.ts");

  const wantSearch = session.role != null;
  await vi.waitFor(() => {
    const view = document.querySelector(
      wantSearch ? "#search-view" : "#login-view",
    ) as HTMLElement | null;
    if (!view || view.hidden) throw new Error("view not ready");
  });

  return {
    input: document.querySelector("#question") as HTMLInputElement,
    modeBadge: document.querySelector("#mode-badge") as HTMLElement,
    answer: document.querySelector("#answer") as HTMLElement,
    doc: document,
  };
}

export function press(
  code: string,
  opts: {
    key?: string;
    meta?: boolean;
    ctrl?: boolean;
    shift?: boolean;
    alt?: boolean;
  } = {},
): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", {
    code,
    key: opts.key ?? "",
    bubbles: true,
    cancelable: true,
    metaKey: !!opts.meta,
    ctrlKey: !!opts.ctrl,
    shiftKey: !!opts.shift,
    altKey: !!opts.alt,
  });
  window.dispatchEvent(ev);
  return ev;
}

export function typeChar(input: HTMLInputElement, ch: string) {
  const code = /^[a-z]$/i.test(ch) ? "Key" + ch.toUpperCase() : ch;
  const ev = new KeyboardEvent("keydown", {
    code,
    key: ch,
    bubbles: true,
    cancelable: true,
  });
  window.dispatchEvent(ev);
  if (!ev.defaultPrevented) {
    const s = input.selectionStart ?? input.value.length;
    const e = input.selectionEnd ?? s;
    input.value = input.value.slice(0, s) + ch + input.value.slice(e);
    const pos = s + ch.length;
    input.setSelectionRange(pos, pos);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

export function typeText(input: HTMLInputElement, text: string) {
  for (const ch of text) typeChar(input, ch);
}
