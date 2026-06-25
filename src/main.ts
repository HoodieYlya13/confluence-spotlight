import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  readText as readClipboard,
  writeText as writeClipboard,
} from "@tauri-apps/plugin-clipboard-manager";
import { renderMarkdown } from "./markdown";

type SessionView = {
  role: string | null;
  role_label: string | null;
  username: string | null;
  given_name: string | null;
  account_url: string | null;
  hotkey: string;
  scroll_keys: string;
  link_keys: string;
  settings_keys: string;
  nvim_mode: boolean;
  nvim_open_mode: string;
  nvim_leader: string;
  follow_mouse: boolean;
  app_version: string;
};
type AnswerPayload = { answer: string; role: string };
type AuthEvent = {
  ok: boolean;
  role_label: string | null;
  error: string | null;
};
type UpdateAvailable = {
  version: string;
  current_version: string;
  notes: string | null;
};
type UpdateCheck = {
  available: boolean;
  version: string | null;
  notes: string | null;
};

function el<T extends Element>(selector: string): T {
  return document.querySelector<T>(selector)!;
}

const views = {
  login: el<HTMLElement>("#login-view"),
  search: el<HTMLElement>("#search-view"),
  settings: el<HTMLElement>("#settings-view"),
};
type ViewName = keyof typeof views;

const form = el<HTMLFormElement>("#ask-form");
const input = el<HTMLInputElement>("#question");
const panel = el<HTMLDivElement>("#panel");
const statusEl = el<HTMLDivElement>("#status");
const statusText = el<HTMLSpanElement>("#status-text");
const statusHint = el<HTMLSpanElement>("#status-hint");
const answerEl = el<HTMLDivElement>("#answer");
const modeBadge = el<HTMLSpanElement>("#mode-badge");
const nvimCursor = el<HTMLSpanElement>("#nvim-cursor");
const manageAccountBtn = el<HTMLButtonElement>("#manage-account-btn");
const settingsBtn = el<HTMLButtonElement>("#settings-btn");

const followMouseToggle = el<HTMLButtonElement>("#follow-mouse-toggle");
const nvimToggle = el<HTMLButtonElement>("#nvim-toggle");
const nvimOptions = el<HTMLDivElement>("#nvim-options");
const nvimOpenInsert = el<HTMLButtonElement>("#nvim-open-insert");
const nvimOpenNormal = el<HTMLButtonElement>("#nvim-open-normal");

const connectBtn = el<HTMLButtonElement>("#connect-btn");
const loginWaiting = el<HTMLDivElement>("#login-waiting");
const loginError = el<HTMLDivElement>("#login-error");
const devLogin = el<HTMLDivElement>("#dev-login");

const updateBanner = el<HTMLDivElement>("#update-banner");
const updateText = el<HTMLSpanElement>("#update-text");
const updateInstall = el<HTMLButtonElement>("#update-install");
const updateDismiss = el<HTMLButtonElement>("#update-dismiss");

const settingsBack = el<HTMLButtonElement>("#settings-back");
const settingsBody = el<HTMLDivElement>(".settings-body");
const settingsRole = el<HTMLDivElement>("#settings-role");
const logoutBtn = el<HTMLButtonElement>("#logout-btn");
const DEFAULT_PLACEHOLDER = "Ask the accelerator operations assistant…";
let identityName = "—";
let accountUrl: string | null = null;
const checkUpdateBtn = el<HTMLButtonElement>("#check-update");
const updateStatus = el<HTMLDivElement>("#update-status");
const appVersion = el<HTMLSpanElement>("#app-version");

type BindingName =
  | "hotkey"
  | "scroll"
  | "links"
  | "settings"
  | "leader";

const rows: Record<
  BindingName,
  {
    record: HTMLButtonElement;
    save: HTMLButtonElement;
    cancel: HTMLButtonElement;
    error: HTMLDivElement;
  }
> = {
  hotkey: {
    record: el<HTMLButtonElement>("#hotkey-record"),
    save: el<HTMLButtonElement>("#hotkey-save"),
    cancel: el<HTMLButtonElement>("#hotkey-cancel"),
    error: el<HTMLDivElement>("#hotkey-error"),
  },
  scroll: {
    record: el<HTMLButtonElement>("#scroll-record"),
    save: el<HTMLButtonElement>("#scroll-save"),
    cancel: el<HTMLButtonElement>("#scroll-cancel"),
    error: el<HTMLDivElement>("#scroll-error"),
  },
  links: {
    record: el<HTMLButtonElement>("#links-record"),
    save: el<HTMLButtonElement>("#links-save"),
    cancel: el<HTMLButtonElement>("#links-cancel"),
    error: el<HTMLDivElement>("#links-error"),
  },
  settings: {
    record: el<HTMLButtonElement>("#settingskey-record"),
    save: el<HTMLButtonElement>("#settingskey-save"),
    cancel: el<HTMLButtonElement>("#settingskey-cancel"),
    error: el<HTMLDivElement>("#settingskey-error"),
  },
  leader: {
    record: el<HTMLButtonElement>("#leader-record"),
    save: el<HTMLButtonElement>("#leader-save"),
    cancel: el<HTMLButtonElement>("#leader-cancel"),
    error: el<HTMLDivElement>("#leader-error"),
  },
};
const bindingNames: BindingName[] = [
  "hotkey",
  "scroll",
  "links",
  "settings",
  "leader",
];
const singleKeyBindings = new Set<BindingName>(["leader"]);

let pending = false;
let activeView: ViewName = "login";


let currentHotkey = "";
let scrollKeys = "CmdOrCtrl+Down";
let linkKeys = "CmdOrCtrl+Shift+Down";
let settingsKeys = "CmdOrCtrl+,";

let followMouse = true;
let nvimEnabled = false;
let nvimOpenMode = "insert";
let leaderCode = "Space";
let mode: "insert" | "normal" | "visual" = "insert";
let spaceHeld = false;
let lastJ = 0;
let lastQ = 0;
let lastD = 0;
let lastY = 0;
let lastEscapeTime = 0;
let visualAnchor = 0;
let visualCursor = 0;
let vimRegister = "";
let lastSetSelection: { start: number; end: number } | null = null;
let lastSelValue = "";
const undoStack: { value: string; cursor: number }[] = [];
const redoStack: { value: string; cursor: number }[] = [];

let recordingTarget: BindingName | null = null;
let candidateAccel: string | null = null;
document.querySelectorAll("button").forEach((btn) => {
  btn.setAttribute("tabindex", "-1");
});

document.addEventListener("focus", (event) => {
  if ((event.target as HTMLElement).tagName === "BUTTON") {
    (event.target as HTMLElement).blur();
  }
}, true);
async function silentCheckForUpdates() {
  try {
    const result = await invoke<UpdateCheck>("check_update");
    if (result.available) {
      showUpdate({
        version: result.version ?? "",
        current_version: "",
        notes: result.notes,
      });
    }
  } catch (error) {
    console.error("Silent update check failed:", error);
  }
}

function showView(name: ViewName) {
  activeView = name;
  for (const [key, node] of Object.entries(views)) {
    node.hidden = key !== name;
  }
  updateDismiss.hidden = (name === "login");
  if (name === "settings" || name === "login") {
    input.blur();
    if (nvimEnabled) {
      setMode("normal");
    }
    if (name === "login") {
      void silentCheckForUpdates();
    }
  }
}

function asMessage(error: unknown): string {
  return typeof error === "string" ? error : "Something went wrong.";
}

function focusInput() {
  window.requestAnimationFrame(() => {
    input.focus();
    if (nvimEnabled && mode === "normal") {
      setCaret(input.selectionStart ?? input.value.length);
    } else {
      const end = input.value.length;
      setSelectionSilently(end, end);
    }
  });
}

function applyOpenMode() {
  setMode(nvimEnabled && nvimOpenMode === "normal" ? "normal" : "insert");
}

function setStatus(message: string) {
  statusText.textContent = message;
  statusEl.hidden = message === "";
}

function applyBindings(session: SessionView) {
  currentHotkey = session.hotkey;
  scrollKeys = session.scroll_keys;
  linkKeys = session.link_keys;
  settingsKeys = session.settings_keys;
  followMouse = session.follow_mouse;
  nvimEnabled = session.nvim_mode;
  nvimOpenMode = session.nvim_open_mode;
  leaderCode = session.nvim_leader;
  appVersion.textContent = `v${session.app_version}`;

  identityName =
    session.username ?? session.role_label ?? session.role ?? "—";
  accountUrl = session.account_url;
  if (!accountUrl && import.meta.env.DEV) {
    accountUrl = "https://auth.hy13dev.com/en/account";
  }
  manageAccountBtn.hidden = !accountUrl;
  const greetName =
    session.given_name ?? session.username ?? session.role_label ?? session.role;
  input.placeholder = greetName
    ? `Hello ${greetName}! ${DEFAULT_PLACEHOLDER}`
    : DEFAULT_PLACEHOLDER;
}

async function renderSession(): Promise<SessionView> {
  const session = await invoke<SessionView>("get_session");
  applyBindings(session);
  if (session.role) {
    showView("search");
    updateModeBadge();
  } else {
    resetLogin();
    showView("login");
  }
  return session;
}

function resetLogin() {
  connectBtn.hidden = false;
  connectBtn.disabled = false;
  connectBtn.textContent = "Connect with HY13 Passkey SSO";
  loginWaiting.hidden = true;
  loginError.hidden = true;
}

async function beginLogin() {
  connectBtn.disabled = true;
  connectBtn.textContent = "Opening browser…";
  loginError.hidden = true;
  try {
    await invoke("begin_login");
    connectBtn.hidden = true;
    loginWaiting.hidden = false;
    void invoke("hide_window");
  } catch (error) {
    resetLogin();
    loginError.textContent = asMessage(error);
    loginError.hidden = false;
  }
}

async function devConnect(role: string) {
  loginError.hidden = true;
  try {
    await invoke("dev_login", { role });
    loginWaiting.hidden = true;
    await renderSession();
    applyOpenMode();
    focusInput();
  } catch (error) {
    loginError.textContent = asMessage(error);
    loginError.hidden = false;
  }
}

function onAuthEvent(event: AuthEvent) {
  if (event.ok) {
    loginError.hidden = true;
    loginWaiting.hidden = true;
    void renderSession().then(() => {
      applyOpenMode();
      focusInput();
    });
  } else {
    resetLogin();
    loginError.textContent = event.error ?? "Sign-in failed.";
    loginError.hidden = false;
  }
}

let updating = false;

function showUpdate(info: UpdateAvailable) {
  updateText.textContent = `Version ${info.version} is available.`;
  updateBanner.hidden = false;
}

async function installUpdate() {
  if (updating) return;
  updating = true;
  updateInstall.disabled = true;
  updateInstall.textContent = "Downloading…";
  try {
    await invoke("install_update");
  } catch (error) {
    updating = false;
    updateInstall.disabled = false;
    updateInstall.textContent = "Update & restart";
    updateText.textContent = asMessage(error);
  }
}

let checkingUpdate = false;

async function checkForUpdates() {
  if (checkingUpdate) return;
  checkingUpdate = true;
  checkUpdateBtn.disabled = true;
  updateStatus.hidden = false;
  updateStatus.textContent = "Checking…";
  try {
    const result = await invoke<UpdateCheck>("check_update");
    if (result.available) {
      updateStatus.textContent = `Version ${result.version} is available.`;
      showUpdate({
        version: result.version ?? "",
        current_version: "",
        notes: result.notes,
      });
    } else {
      updateStatus.textContent = "You're on the latest version.";
    }
  } catch (error) {
    updateStatus.textContent = asMessage(error);
  } finally {
    checkingUpdate = false;
    checkUpdateBtn.disabled = false;
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;
type HistoryEntry = { question: string; at: number };
let history: HistoryEntry[] = [];
let bottomDraft = "";
let erasedDraft: string | null = null;
let forks: string[] = [];
let navCursor = 0;

function pruneHistory() {
  const cutoff = Date.now() - DAY_MS;
  history = history.filter((entry) => entry.at >= cutoff);
}

function resetNavigation() {
  bottomDraft = "";
  erasedDraft = null;
  forks = [];
  navCursor = 0;
}

function pushHistory(question: string) {
  pruneHistory();
  const last = history[history.length - 1];
  if (last && last.question === question) {
    last.at = Date.now();
  } else {
    history.push({ question, at: Date.now() });
  }
  resetNavigation();
}

function moveCursorEnd() {
  window.requestAnimationFrame(() => {
    setCaret(input.value.length);
  });
}

function navMax() {
  return forks.length + history.length;
}

function historyTextAt(cursor: number): string {
  return history[history.length - cursor + forks.length]?.question ?? "";
}

function valueAt(cursor: number): string {
  if (cursor <= 0) return bottomDraft;
  if (cursor <= forks.length) return forks[cursor - 1];
  return historyTextAt(cursor);
}

function setNav(cursor: number) {
  navCursor = cursor;
  input.value = valueAt(cursor);
  moveCursorEnd();
}

function navigate(delta: number) {
  if (navCursor === 0 && delta < 0) {
    if (input.value !== "") {
      erasedDraft = input.value;
      bottomDraft = "";
      setNav(0);
    }
    return;
  }
  if (navCursor === 0 && delta > 0) {
    if (erasedDraft !== null) {
      bottomDraft = erasedDraft;
      erasedDraft = null;
      setNav(0);
      return;
    }
    pruneHistory();
  }
  if (navCursor >= 1 && navCursor <= forks.length && forks[navCursor - 1].trim() === "") {
    forks.splice(navCursor - 1, 1);
    if (delta > 0) {
      setNav(Math.min(navCursor, navMax()));
    } else {
      setNav(Math.max(0, navCursor - 1));
    }
    return;
  }
  const target = navCursor + delta;
  if (target < 0 || target > navMax()) return;
  setNav(target);
}

function historyPrev() {
  navigate(1);
}

function historyNext() {
  navigate(-1);
}

function recordCurrentEdit() {
  const value = input.value;
  if (navCursor <= 0) {
    bottomDraft = value;
    erasedDraft = null;
    return;
  }
  if (navCursor <= forks.length) {
    forks[navCursor - 1] = value;
    return;
  }
  if (value === historyTextAt(navCursor) || value.trim() === "") return;
  forks.unshift(value);
  navCursor = 1;
}

input.addEventListener("input", recordCurrentEdit);

document.addEventListener("selectionchange", () => {
  if (!nvimEnabled || document.activeElement !== input) return;
  const valueChanged = input.value !== lastSelValue;
  lastSelValue = input.value;
  const start = input.selectionStart ?? 0;
  const end = input.selectionEnd ?? 0;
  if (
    lastSetSelection &&
    lastSetSelection.start === start &&
    lastSetSelection.end === end
  ) {
    return;
  }
  if (valueChanged) return;
  if (end > start) {
    visualAnchor = start;
    visualCursor = end - 1;
    if (mode !== "visual") setMode("visual");
    paintVisual();
  } else if (mode !== "insert") {
    setMode("normal");
    setCaret(start);
  }
});

const MOD_TOKENS = new Set([
  "CmdOrCtrl",
  "CommandOrControl",
  "Cmd",
  "Command",
  "Super",
  "Meta",
  "Ctrl",
  "Control",
  "Alt",
  "Option",
  "Shift",
]);

type Mods = {
  cmdOrCtrl: boolean;
  cmd: boolean;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
};

function parseMods(accel: string): Mods {
  const parts = accel.split("+");
  const has = (token: string) => parts.includes(token);
  return {
    cmdOrCtrl: has("CmdOrCtrl") || has("CommandOrControl"),
    cmd: has("Cmd") || has("Command") || has("Super") || has("Meta"),
    ctrl: has("Ctrl") || has("Control"),
    shift: has("Shift"),
    alt: has("Alt") || has("Option"),
  };
}

function accelKey(accel: string): string {
  const keys = accel.split("+").filter((part) => part && !MOD_TOKENS.has(part));
  return keys.length ? keys[keys.length - 1] : "";
}

function modsMatch(mods: Mods, event: KeyboardEvent): boolean {
  if (mods.cmdOrCtrl) {
    if (!(event.metaKey || event.ctrlKey)) return false;
  } else {
    if (mods.cmd !== event.metaKey) return false;
    if (mods.ctrl !== event.ctrlKey) return false;
  }
  if (mods.shift !== event.shiftKey) return false;
  if (mods.alt !== event.altKey) return false;
  return true;
}

function baseModsHeld(mods: Mods, event: KeyboardEvent): boolean {
  if (!(mods.cmdOrCtrl || mods.cmd || mods.ctrl || mods.alt)) return false;
  if (mods.cmdOrCtrl && !(event.metaKey || event.ctrlKey)) return false;
  if (mods.cmd && !event.metaKey) return false;
  if (mods.ctrl && !event.ctrlKey) return false;
  if (mods.alt && !event.altKey) return false;
  return true;
}

function keyToken(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F[1-9][0-9]?$/.test(code)) return code;
  if (code === "Space") return "Space";
  if (code === "Comma") return ",";
  const arrows: Record<string, string> = {
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
  };
  return arrows[code] ?? null;
}

function digitOf(event: KeyboardEvent): string | null {
  const match = /^(?:Digit|Numpad)([0-9])$/.exec(event.code);
  return match ? match[1] : null;
}

function scrollContainer(container: HTMLElement, direction: 1 | -1) {
  const step = Math.round(container.clientHeight * 0.85);
  container.scrollBy({ top: direction * step, behavior: "smooth" });
}

function scrollAnswer(direction: 1 | -1) {
  scrollContainer(panel, direction);
}

function scrollElementToTop(element: HTMLElement) {
  const top =
    element.getBoundingClientRect().top -
    panel.getBoundingClientRect().top +
    panel.scrollTop;
  panel.scrollTo({ top: Math.max(0, top - 8), behavior: "smooth" });
}

let linkMode = false;
let linkBuffer = "";
let linkPaged = false;
let numbered: HTMLElement[] = [];

function computeTargets(): HTMLElement[] {
  if (activeView === "settings") {
    return Array.from(
      views.settings.querySelectorAll<HTMLElement>("button"),
    ).filter((b) => b.id !== "settings-back" && b.offsetParent !== null);
  }
  return Array.from(answerEl.querySelectorAll<HTMLElement>("a[data-href]"));
}

function badgeIsNumeric(node: HTMLElement): boolean {
  return /^[0-9]+$/.test(node.dataset.linknum ?? "");
}

function nodeEligible(node: HTMLElement): boolean {
  if (!badgeIsNumeric(node)) return true;
  return linkBuffer === "" || (node.dataset.linknum ?? "").startsWith(linkBuffer);
}

function hideScopeFor(node: HTMLElement): HTMLElement {
  if (activeView === "settings") {
    const row = node.closest<HTMLElement>(".setting-row");
    if (row) return row;
  }
  return node;
}

function applyLinkFilter() {
  const scopeEligible = new Map<HTMLElement, boolean>();
  numbered.forEach((node) => {
    const numeric = badgeIsNumeric(node);
    const eligible = nodeEligible(node);
    node.classList.toggle("num-active", numeric && linkBuffer !== "" && eligible);
    node.classList.toggle("link-hide", numeric && !eligible);
    const scope = hideScopeFor(node);
    scopeEligible.set(scope, (scopeEligible.get(scope) ?? false) || eligible);
  });
  scopeEligible.forEach((eligible, scope) => {
    scope.classList.toggle("link-hide", !eligible);
  });
}

function enterLinkMode() {
  if (linkMode) return;
  linkMode = true;
  linkBuffer = "";
  linkPaged = false;
  if (activeView === "login") {
    connectBtn.dataset.linknum = "⏎";
    if (import.meta.env.DEV) {
      const juniorBtn = devLogin.querySelector<HTMLButtonElement>('button[data-role="JUNIOR_OP"]');
      const leadBtn = devLogin.querySelector<HTMLButtonElement>('button[data-role="ATS_CORE_LEAD"]');
      if (juniorBtn) juniorBtn.dataset.linknum = "J";
      if (leadBtn) leadBtn.dataset.linknum = "L";
    }
  } else {
    numbered = computeTargets();
    numbered.forEach((node, index) => {
      node.dataset.linknum = String(index);
    });
  }
  if (!updateBanner.hidden) {
    updateInstall.dataset.linknum = "U";
  }
  applyLinkFilter();
}

function exitLinkMode() {
  if (!linkMode) return;
  linkMode = false;
  linkBuffer = "";
  linkPaged = false;
  numbered.forEach((node) => {
    node.classList.remove("link-hide", "num-active");
    delete node.dataset.linknum;
  });
  numbered = [];
  views.settings
    .querySelectorAll<HTMLElement>(".setting-row.link-hide")
    .forEach((row) => row.classList.remove("link-hide"));
  delete connectBtn.dataset.linknum;
  connectBtn.classList.remove("num-active");
  if (import.meta.env.DEV) {
    const juniorBtn = devLogin.querySelector<HTMLButtonElement>('button[data-role="JUNIOR_OP"]');
    const leadBtn = devLogin.querySelector<HTMLButtonElement>('button[data-role="ATS_CORE_LEAD"]');
    if (juniorBtn) {
      delete juniorBtn.dataset.linknum;
      juniorBtn.classList.remove("num-active");
    }
    if (leadBtn) {
      delete leadBtn.dataset.linknum;
      leadBtn.classList.remove("num-active");
    }
  }
  delete updateInstall.dataset.linknum;
  updateInstall.classList.remove("num-active");
}

function activateLinkKey(event: KeyboardEvent): boolean {
  if (!updateBanner.hidden && event.code === "KeyU") {
    exitLinkMode();
    void installUpdate();
    return true;
  }
  if (activeView !== "login") return false;
  if (event.code === "Enter" || event.code === "NumpadEnter") {
    exitLinkMode();
    connectBtn.click();
    return true;
  }
  if (import.meta.env.DEV) {
    if (event.code === "KeyJ") {
      exitLinkMode();
      const juniorBtn = devLogin.querySelector<HTMLButtonElement>('button[data-role="JUNIOR_OP"]');
      if (juniorBtn) juniorBtn.click();
      return true;
    }
    if (event.code === "KeyL") {
      exitLinkMode();
      const leadBtn = devLogin.querySelector<HTMLButtonElement>('button[data-role="ATS_CORE_LEAD"]');
      if (leadBtn) leadBtn.click();
      return true;
    }
  } else if (event.code === "KeyL") {
    exitLinkMode();
    connectBtn.click();
    return true;
  }
  return false;
}

function candidatesFor(buffer: string): number[] {
  const result: number[] = [];
  for (let i = 0; i < numbered.length; i += 1) {
    if (String(i).startsWith(buffer)) result.push(i);
  }
  return result;
}

function activateTarget(node: HTMLElement) {
  const href = node.getAttribute("data-href");
  if (href) void openUrl(href);
  else node.click();
}

function openLinkByIndex(index: number) {
  const node = numbered[index];
  exitLinkMode();
  if (!node) return;
  activateTarget(node);
  node.scrollIntoView({ block: "center", behavior: "smooth" });
}

function pageToLinks(direction: 1 | -1) {
  enterLinkMode();
  if (activeView === "settings") {
    scrollContainer(settingsBody, direction);
    return;
  }
  if (!numbered.length) {
    scrollAnswer(direction);
    return;
  }
  if (direction === 1 && !linkPaged) {
    scrollElementToTop(numbered[0]);
    linkPaged = true;
  } else {
    scrollAnswer(direction);
  }
}

function pressLinkDigit(digit: string) {
  enterLinkMode();
  const next = linkBuffer + digit;
  const candidates = candidatesFor(next);
  if (candidates.length === 0) {
    linkBuffer = "";
    applyLinkFilter();
    return;
  }
  const exact = Number(next);
  const hasExact = candidates.includes(exact) && String(exact) === next;
  const hasExtension = candidates.some((i) => String(i).length > next.length);
  if (hasExact && !hasExtension) {
    openLinkByIndex(exact);
    return;
  }
  linkBuffer = next;
  applyLinkFilter();
}

function commitLinkBuffer() {
  if (!linkMode || linkBuffer === "") return;
  const exact = Number(linkBuffer);
  const candidates = candidatesFor(linkBuffer);
  if (candidates.includes(exact) && String(exact) === linkBuffer) {
    openLinkByIndex(exact);
  } else {
    linkBuffer = "";
    applyLinkFilter();
  }
}

let chordTimer: number | null = null;

function clearChordTimer() {
  if (chordTimer !== null) {
    clearTimeout(chordTimer);
    chordTimer = null;
  }
}

function isModifierCode(code: string): boolean {
  return /^(Shift|Meta|Control|Alt)(Left|Right)$/.test(code);
}

function linkChordEngaged(event: KeyboardEvent): boolean {
  if (modsMatch(parseMods(linkKeys), event)) return true;
  return nvimEnabled && mode === "normal" && spaceHeld && event.shiftKey;
}

function linkChordHeldNow(event: KeyboardEvent): boolean {
  if (baseModsHeld(parseMods(linkKeys), event)) return true;
  return nvimEnabled && mode === "normal" && spaceHeld;
}

function maybeStartChordTimer(event: KeyboardEvent) {
  if (recordingTarget) return;
  if (chordTimer !== null || linkMode) return;
  if (!linkChordEngaged(event)) return;
  chordTimer = window.setTimeout(() => {
    chordTimer = null;
    if (recordingTarget) return;
    if (activeView === "settings" || activeView === "login") enterLinkMode();
    else pageToLinks(1);
  }, 300);
}

function setMode(next: "insert" | "normal" | "visual") {
  mode = next;
  const active = nvimEnabled && (next === "normal" || next === "visual");
  input.classList.toggle("nvim-active", active);
  if (next !== "visual") input.classList.remove("nvim-visual");
  updateModeBadge();
  if (next === "normal") {
    renderCursorAt(input.selectionStart ?? input.value.length);
  } else {
    input.classList.remove("nvim-block");
    if (next !== "visual") showEmptyCursor(false);
  }
}

function updateModeBadge() {
  if (!nvimEnabled) {
    modeBadge.hidden = true;
    modeBadge.classList.remove("normal", "insert", "visual");
    return;
  }
  modeBadge.hidden = false;
  modeBadge.textContent =
    mode === "normal" ? "NORMAL" : mode === "visual" ? "VISUAL" : "INSERT";
  modeBadge.classList.toggle("normal", mode === "normal");
  modeBadge.classList.toggle("insert", mode === "insert");
  modeBadge.classList.toggle("visual", mode === "visual");
}

function setSelectionSilently(start: number, end: number) {
  lastSetSelection = { start, end };
  input.setSelectionRange(start, end);
}

function showEmptyCursor(show: boolean) {
  if (!show) {
    nvimCursor.hidden = true;
    return;
  }
  nvimCursor.style.left = `${input.offsetLeft}px`;
  nvimCursor.style.top = `${input.offsetTop}px`;
  nvimCursor.style.height = `${input.offsetHeight}px`;
  nvimCursor.hidden = false;
}

function renderCursorAt(pos: number) {
  const len = input.value.length;
  if (nvimEnabled && mode === "normal") {
    if (len === 0) {
      input.classList.remove("nvim-block");
      setSelectionSilently(0, 0);
      showEmptyCursor(true);
      return;
    }
    const c = Math.max(0, Math.min(pos, len - 1));
    input.classList.add("nvim-block");
    showEmptyCursor(false);
    setSelectionSilently(c, c + 1);
  } else {
    input.classList.remove("nvim-block");
    showEmptyCursor(false);
    const c = Math.max(0, Math.min(pos, len));
    setSelectionSilently(c, c);
  }
}

function setCaret(pos: number) {
  input.focus();
  renderCursorAt(pos);
}

function paintVisual() {
  const len = input.value.length;
  if (len === 0) {
    setMode("normal");
    setCaret(0);
    return;
  }
  input.focus();
  visualAnchor = Math.max(0, Math.min(visualAnchor, len - 1));
  visualCursor = Math.max(0, Math.min(visualCursor, len - 1));
  const lo = Math.min(visualAnchor, visualCursor);
  const hi = Math.max(visualAnchor, visualCursor);
  input.classList.remove("nvim-block");
  input.classList.add("nvim-visual");
  showEmptyCursor(false);
  setSelectionSilently(lo, hi + 1);
}

function enterVisual(anchor: number) {
  if (input.value.length === 0) return;
  visualAnchor = anchor;
  visualCursor = anchor;
  setMode("visual");
  paintVisual();
}

function recordUndo() {
  undoStack.push({ value: input.value, cursor: input.selectionStart ?? 0 });
  if (undoStack.length > 100) undoStack.shift();
  redoStack.length = 0;
}

function vimUndo() {
  const prev = undoStack.pop();
  if (!prev) return;
  redoStack.push({ value: input.value, cursor: input.selectionStart ?? 0 });
  input.value = prev.value;
  setCaret(prev.cursor);
  recordCurrentEdit();
}

function vimRedo() {
  const next = redoStack.pop();
  if (!next) return;
  undoStack.push({ value: input.value, cursor: input.selectionStart ?? 0 });
  input.value = next.value;
  setCaret(next.cursor);
  recordCurrentEdit();
}

function yankText(text: string) {
  vimRegister = text;
  void writeClipboard(text).catch(() => {});
}

async function pasteRegister(after: boolean) {
  let text = vimRegister;
  try {
    const clip = await readClipboard();
    if (clip) text = clip;
  } catch {
    // clipboard read may be unavailable; the internal register still works
  }
  if (!text) return;
  recordUndo();
  const len = input.value.length;
  let at = input.selectionStart ?? 0;
  if (after && len > 0) at = Math.min(at + 1, len);
  input.value = input.value.slice(0, at) + text + input.value.slice(at);
  setCaret(at + text.length - 1);
  recordCurrentEdit();
}

function deleteLine() {
  recordUndo();
  yankText(input.value);
  input.value = "";
  setCaret(0);
  recordCurrentEdit();
}

function deleteVisualRange(lo: number, hi: number, next: "insert" | "normal") {
  recordUndo();
  yankText(input.value.slice(lo, hi + 1));
  input.value = input.value.slice(0, lo) + input.value.slice(hi + 1);
  setMode(next);
  setCaret(lo);
  recordCurrentEdit();
}

function enterInsert(pos: number) {
  recordUndo();
  setMode("insert");
  setCaret(pos);
}

function enterNormal() {
  const pos = input.selectionStart ?? input.value.length;
  setMode("normal");
  setCaret(pos - 1);
}

function deleteCharBeforeCaret() {
  const p = input.selectionStart ?? 0;
  if (p > 0) {
    input.value = input.value.slice(0, p - 1) + input.value.slice(p);
    input.setSelectionRange(p - 1, p - 1);
    recordCurrentEdit();
  }
}

function deleteCharAtCaret() {
  const p = input.selectionStart ?? 0;
  if (p < input.value.length) {
    recordUndo();
    input.value = input.value.slice(0, p) + input.value.slice(p + 1);
    setCaret(p);
    recordCurrentEdit();
  }
}

function backToConversation() {
  disarmLogout();
  showView("search");
  focusInput();
  lastEscapeTime = Date.now();
}

function toggleSettings() {
  if (activeView === "settings") backToConversation();
  else openSettings();
}

function isEnterNormalKey(event: KeyboardEvent): boolean {
  if (event.ctrlKey && (event.code === "BracketLeft" || event.code === "KeyC")) {
    return true;
  }
  if (!event.metaKey && !event.ctrlKey && !event.altKey) {
    return event.code === "Escape";
  }
  return false;
}

function handleNvimInsert(event: KeyboardEvent): boolean {
  if (isEnterNormalKey(event)) {
    event.preventDefault();
    enterNormal();
    if (event.code === "Escape") {
      lastEscapeTime = Date.now();
    }
    return true;
  }
  if (
    event.code === "KeyJ" &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey
  ) {
    const now = Date.now();
    if (now - lastJ < 250) {
      event.preventDefault();
      deleteCharBeforeCaret();
      lastJ = 0;
      enterNormal();
      return true;
    }
    lastJ = now;
    return false;
  }
  return false;
}

function handleLeaderChord(event: KeyboardEvent): boolean {
  event.preventDefault();
  if (linkMode) {
    const digit = digitOf(event);
    if (digit !== null) {
      pressLinkDigit(digit);
      return true;
    }
    if (activateLinkKey(event)) return true;
  }
  if (event.shiftKey) {
    if (activateLinkKey(event)) return true;
    const digit = digitOf(event);
    if (digit !== null) {
      pressLinkDigit(digit);
      return true;
    }
    if (event.code === "KeyJ" || event.code === "ArrowDown") {
      pageToLinks(1);
      return true;
    }
    if (event.code === "KeyK" || event.code === "ArrowUp") {
      pageToLinks(-1);
      return true;
    }
    maybeStartChordTimer(event);
    return true;
  }
  if (event.code === "Comma") {
    event.preventDefault();
    toggleSettings();
    return true;
  }
  if (activeView === "settings") {
    if (event.code === "KeyJ") {
      event.preventDefault();
      scrollContainer(settingsBody, 1);
      return true;
    }
    if (event.code === "KeyK") {
      event.preventDefault();
      scrollContainer(settingsBody, -1);
      return true;
    }
  } else {
    if (event.code === "KeyJ") {
      event.preventDefault();
      scrollAnswer(1);
      return true;
    }
    if (event.code === "KeyK") {
      event.preventDefault();
      scrollAnswer(-1);
      return true;
    }
    if (event.code === "KeyQ") {
      event.preventDefault();
      void invoke("hide_window");
      return true;
    }
  }
  event.preventDefault();
  return true;
}

function handleNormalSettings(event: KeyboardEvent): boolean {
  if (
    event.code === "KeyH" ||
    event.code === "ArrowLeft" ||
    event.code === "Escape" ||
    event.code === "Backspace"
  ) {
    event.preventDefault();
    backToConversation();
    return true;
  }
  if (event.code === "KeyJ" || event.code === "ArrowDown") {
    event.preventDefault();
    scrollContainer(settingsBody, 1);
    return true;
  }
  if (event.code === "KeyK" || event.code === "ArrowUp") {
    event.preventDefault();
    scrollContainer(settingsBody, -1);
    return true;
  }
  event.preventDefault();
  return true;
}

function handleNormalMotion(event: KeyboardEvent): boolean {
  const caret = input.selectionStart ?? input.value.length;
  switch (event.code) {
    case "KeyI":
      event.preventDefault();
      enterInsert(event.shiftKey ? 0 : caret);
      return true;
    case "KeyA":
      event.preventDefault();
      enterInsert(event.shiftKey ? input.value.length : caret + 1);
      return true;
    case "KeyH":
    case "ArrowLeft":
    case "Backspace":
      event.preventDefault();
      setCaret(caret - 1);
      return true;
    case "KeyL":
    case "ArrowRight":
      event.preventDefault();
      setCaret(caret + 1);
      return true;
    case "KeyK":
    case "ArrowUp":
      event.preventDefault();
      historyPrev();
      return true;
    case "KeyJ":
    case "ArrowDown":
      event.preventDefault();
      historyNext();
      return true;
    case "Digit0":
      event.preventDefault();
      setCaret(0);
      return true;
    case "Digit4":
      if (event.shiftKey) {
        event.preventDefault();
        setCaret(input.value.length);
        return true;
      }
      event.preventDefault();
      return true;
    case "KeyX":
      event.preventDefault();
      deleteCharAtCaret();
      return true;
    case "KeyV":
      event.preventDefault();
      enterVisual(caret);
      return true;
    case "KeyY":
      event.preventDefault();
      if (event.shiftKey || Date.now() - lastY < 250) {
        lastY = 0;
        yankText(input.value);
      } else {
        lastY = Date.now();
      }
      return true;
    case "KeyP":
      event.preventDefault();
      void pasteRegister(!event.shiftKey);
      return true;
    case "KeyD":
      event.preventDefault();
      if (event.shiftKey) {
        recordUndo();
        yankText(input.value.slice(caret));
        input.value = input.value.slice(0, caret);
        setCaret(caret);
        recordCurrentEdit();
      } else if (Date.now() - lastD < 250) {
        lastD = 0;
        deleteLine();
      } else {
        lastD = Date.now();
      }
      return true;
    case "KeyU":
      event.preventDefault();
      vimUndo();
      return true;
    case "KeyQ":
      event.preventDefault();
      if (Date.now() - lastQ < 250) {
        lastQ = 0;
        void invoke("hide_window");
      } else {
        lastQ = Date.now();
      }
      return true;
    case "Escape": {
      event.preventDefault();
      if (linkMode) {
        exitLinkMode();
        return true;
      }
      const now = Date.now();
      if (now - lastEscapeTime < 300) {
        lastEscapeTime = 0;
        void invoke("hide_window");
      } else {
        lastEscapeTime = now;
      }
      return true;
    }
    case "Enter":
    case "NumpadEnter":
      return false;
    default:
      if (event.key.length === 1) {
        event.preventDefault();
        return true;
      }
      return false;
  }
}

function handleNvimNormal(event: KeyboardEvent): boolean {
  if (event.code === "Space") {
    event.preventDefault();
    spaceHeld = true;
    if (event.shiftKey) maybeStartChordTimer(event);
    return true;
  }

  if (spaceHeld) return handleLeaderChord(event);

  if (
    event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    event.code === "KeyR"
  ) {
    event.preventDefault();
    vimRedo();
    return true;
  }

  if (event.metaKey || event.ctrlKey || event.altKey) return false;

  if (activeView === "settings") return handleNormalSettings(event);

  return handleNormalMotion(event);
}

function handleNvim(event: KeyboardEvent): boolean {
  if (!nvimEnabled) return false;
  if (mode === "insert") return handleNvimInsert(event);
  if (mode === "visual") return handleNvimVisual(event);
  return handleNvimNormal(event);
}

function handleNvimVisual(event: KeyboardEvent): boolean {
  if (event.metaKey || event.altKey) return false;
  if (event.ctrlKey) {
    if (event.code === "BracketLeft" || event.code === "KeyC") {
      event.preventDefault();
      setMode("normal");
      setCaret(visualCursor);
      return true;
    }
    return false;
  }
  const len = input.value.length;
  const lo = Math.min(visualAnchor, visualCursor);
  const hi = Math.max(visualAnchor, visualCursor);
  switch (event.code) {
    case "Escape":
      event.preventDefault();
      setMode("normal");
      setCaret(visualCursor);
      lastEscapeTime = Date.now();
      return true;
    case "KeyV":
      event.preventDefault();
      setMode("normal");
      setCaret(visualCursor);
      return true;
    case "KeyH":
    case "ArrowLeft":
    case "Backspace":
      event.preventDefault();
      visualCursor = Math.max(0, visualCursor - 1);
      paintVisual();
      return true;
    case "KeyL":
    case "ArrowRight":
      event.preventDefault();
      visualCursor = Math.min(len - 1, visualCursor + 1);
      paintVisual();
      return true;
    case "Digit0":
      event.preventDefault();
      visualCursor = 0;
      paintVisual();
      return true;
    case "Digit4":
      event.preventDefault();
      if (event.shiftKey) {
        visualCursor = len - 1;
        paintVisual();
      }
      return true;
    case "KeyY":
      event.preventDefault();
      yankText(input.value.slice(lo, hi + 1));
      setMode("normal");
      setCaret(lo);
      return true;
    case "KeyD":
    case "KeyX":
      event.preventDefault();
      deleteVisualRange(lo, hi, "normal");
      return true;
    case "KeyC":
      event.preventDefault();
      deleteVisualRange(lo, hi, "insert");
      return true;
    default:
      event.preventDefault();
      return true;
  }
}

function refreshNvimUi() {
  nvimToggle.textContent = nvimEnabled ? "On" : "Off";
  nvimToggle.classList.toggle("active", nvimEnabled);
  nvimOptions.hidden = !nvimEnabled;
  nvimOpenInsert.classList.toggle("active", nvimOpenMode === "insert");
  nvimOpenNormal.classList.toggle("active", nvimOpenMode === "normal");
  setRowDisplay("leader");
  updateModeBadge();
}

function refreshFollowMouseUi() {
  followMouseToggle.textContent = followMouse ? "On" : "Off";
  followMouseToggle.classList.toggle("active", followMouse);
}

async function toggleFollowMouse() {
  try {
    const session = await invoke<SessionView>("set_follow_mouse", {
      enabled: !followMouse,
    });
    applyBindings(session);
    refreshFollowMouseUi();
  } catch (error) {
    console.error("Failed to toggle follow-mouse:", error);
  }
}

async function toggleNvim() {
  try {
    const session = await invoke<SessionView>("set_nvim_mode", {
      enabled: !nvimEnabled,
    });
    applyBindings(session);
    applyOpenMode();
    refreshNvimUi();
  } catch (error) {
    console.error("Failed to toggle Neovim mode:", error);
  }
}

async function setOpenMode(value: string) {
  try {
    const session = await invoke<SessionView>("set_nvim_open_mode", {
      mode: value,
    });
    applyBindings(session);
    refreshNvimUi();
  } catch (error) {
    console.error("Failed to set open mode:", error);
  }
}

async function submit() {
  const question = input.value.trim();
  if (!question || pending) return;

  pushHistory(question);
  input.value = "";
  exitLinkMode();
  if (nvimEnabled) setMode("normal");

  pending = true;
  form.classList.add("pending");
  panel.hidden = false;
  answerEl.innerHTML = "";
  panel.scrollTop = 0;
  setStatus("Asking the operations assistant…");
  statusHint.hidden = false;

  try {
    const result = await invoke<AnswerPayload>("ask_question", { question });
    setStatus("");
    answerEl.innerHTML = renderMarkdown(result.answer);
    panel.scrollTop = 0;
  } catch (error) {
    const message = asMessage(error);
    setStatus(message === "__cancelled__" ? "Request cancelled." : message);
  } finally {
    pending = false;
    form.classList.remove("pending");
    statusHint.hidden = true;
  }
}

function formatHotkey(accelerator: string): string {
  const symbols: Record<string, string> = {
    CmdOrCtrl: "⌘",
    CommandOrControl: "⌘",
    Cmd: "⌘",
    Command: "⌘",
    Super: "⌘",
    Meta: "⌘",
    Ctrl: "⌃",
    Control: "⌃",
    Alt: "⌥",
    Option: "⌥",
    Shift: "⇧",
    Up: "↑",
    Down: "↓",
    Left: "←",
    Right: "→",
  };
  return accelerator
    .split("+")
    .map((part) => symbols[part] ?? part)
    .join(" ");
}

function accelOf(name: BindingName): string {
  if (name === "hotkey") return currentHotkey;
  if (name === "scroll") return scrollKeys;
  if (name === "links") return linkKeys;
  if (name === "settings") return settingsKeys;
  return leaderCode;
}

function codeLabel(code: string): string {
  if (code === "Space") return "Space";
  if (code === "Escape") return "Esc";
  if (code === "Comma") return ",";
  if (code === "Enter") return "Enter";
  if (code === "Tab") return "Tab";
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1].toLowerCase();
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1];
  const arrows: Record<string, string> = {
    ArrowUp: "↑",
    ArrowDown: "↓",
    ArrowLeft: "←",
    ArrowRight: "→",
  };
  return arrows[code] ?? code;
}

function setRowDisplay(name: BindingName) {
  rows[name].record.textContent = singleKeyBindings.has(name)
    ? codeLabel(accelOf(name))
    : formatHotkey(accelOf(name));
}

async function enterRecording(name: BindingName) {
  recordingTarget = name;
  candidateAccel = null;
  const row = rows[name];
  row.record.classList.add("recording");
  row.record.textContent = "Press a shortcut…";
  row.save.hidden = true;
  row.cancel.hidden = false;
  row.error.hidden = true;
  if (name === "hotkey") {
    try {
      await invoke("unregister_current_hotkey");
    } catch (err) {
      console.error("Failed to unregister hotkey:", err);
    }
  }
}

async function exitRecording() {
  const name = recordingTarget;
  recordingTarget = null;
  candidateAccel = null;
  if (!name) return;
  const row = rows[name];
  row.record.classList.remove("recording");
  row.save.hidden = true;
  row.cancel.hidden = true;
  setRowDisplay(name);
  if (name === "hotkey") {
    try {
      await invoke("register_current_hotkey");
    } catch (err) {
      console.error("Failed to register hotkey:", err);
    }
  }
}

function toAccelerator(event: KeyboardEvent): string | null {
  const mods: string[] = [];
  if (event.metaKey) mods.push("Cmd");
  if (event.ctrlKey) mods.push("Ctrl");
  if (event.altKey) mods.push("Alt");
  if (event.shiftKey) mods.push("Shift");

  const key = keyToken(event.code);
  if (!key) return null;
  if (!mods.some((mod) => mod !== "Shift")) return null;

  return [...mods, key].join("+");
}

function captureHotkey(event: KeyboardEvent) {
  event.preventDefault();
  event.stopPropagation();

  if (!recordingTarget) return;
  const single = singleKeyBindings.has(recordingTarget);

  if (event.key === "Escape") {
    void exitRecording();
    return;
  }

  let accelerator: string | null;
  if (single) {
    if (isModifierCode(event.code)) return;
    accelerator = event.code;
  } else {
    accelerator = toAccelerator(event);
  }
  if (!accelerator) return;

  candidateAccel = accelerator;
  const row = rows[recordingTarget];
  row.record.classList.remove("recording");
  row.record.textContent = single
    ? codeLabel(accelerator)
    : formatHotkey(accelerator);
  row.save.hidden = false;
  row.cancel.hidden = false;
}

async function saveBinding() {
  const name = recordingTarget;
  if (!name || !candidateAccel) return;
  const row = rows[name];
  try {
    if (name === "hotkey") {
      const saved = await invoke<string>("set_hotkey", { hotkey: candidateAccel });
      currentHotkey = saved;
    } else {
      const session = await invoke<SessionView>("set_binding", {
        name,
        accelerator: candidateAccel,
      });
      applyBindings(session);
    }
    recordingTarget = null;
    candidateAccel = null;
    row.save.hidden = true;
    row.cancel.hidden = true;
    row.error.hidden = true;
    setRowDisplay(name);
  } catch (error) {
    row.error.textContent = asMessage(error);
    row.error.hidden = false;
  }
}

function openSettings() {
  settingsRole.textContent = identityName;
  disarmLogout();
  void exitRecording();
  for (const name of bindingNames) {
    setRowDisplay(name);
    rows[name].error.hidden = true;
    rows[name].save.hidden = true;
    rows[name].cancel.hidden = true;
  }
  updateStatus.hidden = true;
  refreshFollowMouseUi();
  refreshNvimUi();
  showView("settings");
}

function disarmLogout() {
  logoutBtn.textContent = "Log out";
}

async function doLogout() {
  disarmLogout();
  history = [];
  resetNavigation();
  input.value = "";
  answerEl.innerHTML = "";
  panel.hidden = true;
  await invoke("logout");
  await renderSession();
}

async function onOpen() {
  void exitRecording();
  const session = await renderSession();
  if (session.role) {
    applyOpenMode();
    focusInput();
  } else {
    updateModeBadge();
    if (nvimEnabled) {
      setMode("normal");
    }
  }
}

function handleChordLinkScroll(
  event: KeyboardEvent,
  scroll: (direction: 1 | -1) => void,
): boolean {
  if (linkMode && linkChordHeldNow(event)) {
    const digit = digitOf(event);
    if (digit !== null) {
      pressLinkDigit(digit);
      return true;
    }
    if (activateLinkKey(event)) return true;
  }
  if (modsMatch(parseMods(linkKeys), event)) {
    if (!updateBanner.hidden && event.code === "KeyU") {
      exitLinkMode();
      void installUpdate();
      return true;
    }
    const digit = digitOf(event);
    if (digit !== null) {
      pressLinkDigit(digit);
      return true;
    }
    const token = keyToken(event.code);
    if (token === "Down") {
      pageToLinks(1);
      return true;
    }
    if (token === "Up") {
      pageToLinks(-1);
      return true;
    }
  }
  if (modsMatch(parseMods(scrollKeys), event)) {
    const token = keyToken(event.code);
    if (token === "Down") {
      scroll(1);
      return true;
    }
    if (token === "Up") {
      scroll(-1);
      return true;
    }
  }
  return false;
}

function handleInAppShortcut(event: KeyboardEvent): boolean {
  if (activeView === "login") {
    if (linkMode && linkChordHeldNow(event) && activateLinkKey(event)) return true;
    if (modsMatch(parseMods(linkKeys), event) && activateLinkKey(event)) return true;
    return false;
  }

  if (activeView === "settings") {
    const backByShortcut =
      modsMatch(parseMods(settingsKeys), event) &&
      keyToken(event.code) === accelKey(settingsKeys);
    const backByArrow =
      event.code === "ArrowLeft" &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey;
    if (backByShortcut || backByArrow) {
      disarmLogout();
      showView("search");
      focusInput();
      return true;
    }

    if (handleChordLinkScroll(event, (dir) => scrollContainer(settingsBody, dir))) {
      return true;
    }
    return false;
  }

  if (activeView !== "search") return false;

  const settingsMods = parseMods(settingsKeys);
  if (modsMatch(settingsMods, event) && keyToken(event.code) === accelKey(settingsKeys)) {
    openSettings();
    return true;
  }

  if (handleChordLinkScroll(event, scrollAnswer)) {
    return true;
  }

  if (!event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
    if (event.code === "ArrowUp") {
      historyPrev();
      return true;
    }
    if (event.code === "ArrowDown") {
      historyNext();
      return true;
    }
  }

  return false;
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void submit();
});

answerEl.addEventListener("click", (event) => {
  const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>(
    "a[data-href]",
  );
  if (!anchor) return;
  event.preventDefault();
  const href = anchor.getAttribute("data-href");
  if (href) void openUrl(href);
});

connectBtn.addEventListener("click", () => {
  if (import.meta.env.DEV) void devConnect("ATS_CORE_LEAD");
  else void beginLogin();
});

updateInstall.addEventListener("click", () => void installUpdate());
updateDismiss.addEventListener("click", () => {
  updateBanner.hidden = true;
});

if (import.meta.env.DEV) {
  devLogin.hidden = false;
  devLogin
    .querySelectorAll<HTMLButtonElement>("button[data-role]")
    .forEach((button) => {
      button.addEventListener(
        "click",
        () => void devConnect(button.dataset.role!),
      );
    });
}
settingsBtn.addEventListener("click", () => openSettings());
settingsBack.addEventListener("click", () => {
  disarmLogout();
  showView("search");
  focusInput();
});
logoutBtn.addEventListener("click", () => void doLogout());
manageAccountBtn.addEventListener("click", () => {
  if (accountUrl) void openUrl(accountUrl);
});
checkUpdateBtn.addEventListener("click", () => void checkForUpdates());
followMouseToggle.addEventListener("click", () => void toggleFollowMouse());
nvimToggle.addEventListener("click", () => void toggleNvim());
nvimOpenInsert.addEventListener("click", () => void setOpenMode("insert"));
nvimOpenNormal.addEventListener("click", () => void setOpenMode("normal"));

for (const name of bindingNames) {
  const row = rows[name];
  row.record.addEventListener("click", () => {
    if (!recordingTarget) void enterRecording(name);
  });
  row.save.addEventListener("click", () => void saveBinding());
  row.cancel.addEventListener("click", () => void exitRecording());
}

window.addEventListener(
  "keydown",
  (event) => {
    if (recordingTarget) {
      captureHotkey(event);
      return;
    }

    if (activeView === "login" && event.key === "Enter" && !connectBtn.hidden && !connectBtn.disabled) {
      event.preventDefault();
      connectBtn.click();
      return;
    }

    if (pending && event.ctrlKey && event.code === "KeyC") {
      event.preventDefault();
      void invoke("cancel_ask");
      return;
    }

    if (handleNvim(event)) {
      return;
    }

    if (event.key === "Escape") {
      clearChordTimer();
      if (linkMode) {
        exitLinkMode();
        return;
      }
      if (activeView === "settings") {
        disarmLogout();
        showView("search");
        focusInput();
        lastEscapeTime = Date.now();
        return;
      }
      if (nvimEnabled) {
        const now = Date.now();
        if (now - lastEscapeTime < 300) {
          lastEscapeTime = 0;
          void invoke("hide_window");
        } else {
          lastEscapeTime = now;
        }
        return;
      }
      void invoke("hide_window");
      return;
    }

    if (isModifierCode(event.code)) {
      maybeStartChordTimer(event);
    } else {
      clearChordTimer();
    }

    if (handleInAppShortcut(event)) {
      event.preventDefault();
    }
  },
  true,
);

window.addEventListener(
  "keyup",
  (event) => {
    if (event.code === "Space") spaceHeld = false;
    if (linkChordHeldNow(event)) return;
    clearChordTimer();
    if (linkMode) {
      commitLinkBuffer();
      exitLinkMode();
    }
  },
  true,
);

const spotlightEl = document.getElementById("spotlight")!;

spotlightEl.addEventListener("mousedown", (event) => {
  if (activeView !== "search") return;
  const target = event.target as HTMLElement;
  if (target === input || panel.contains(target)) return;
  event.preventDefault();
});

spotlightEl.addEventListener("click", () => {
  if (activeView !== "search") return;
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed) return;
  input.focus();
});

document.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  if (!spotlightEl.contains(target)) {
    void invoke("hide_window");
  }
});

void listen("spotlight-open", () => void onOpen());
void listen<AuthEvent>("spotlight-auth", (event) => onAuthEvent(event.payload));
void listen<UpdateAvailable>(
  "spotlight-update-available",
  (event) => showUpdate(event.payload),
);

void onOpen();
void invoke("show_window_command");
