import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { renderMarkdown } from "./markdown";

type SessionView = {
  role: string | null;
  role_label: string | null;
  hotkey: string;
  scroll_keys: string;
  link_keys: string;
  settings_keys: string;
  nvim_mode: boolean;
  nvim_open_mode: string;
  nvim_leader: string;
  nvim_normal: string;
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
const badge = el<HTMLSpanElement>("#role-badge");
const modeBadge = el<HTMLSpanElement>("#mode-badge");
const settingsBtn = el<HTMLButtonElement>("#settings-btn");

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
const checkUpdateBtn = el<HTMLButtonElement>("#check-update");
const updateStatus = el<HTMLDivElement>("#update-status");

type BindingName =
  | "hotkey"
  | "scroll"
  | "links"
  | "settings"
  | "leader"
  | "normal";

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
  normal: {
    record: el<HTMLButtonElement>("#normal-record"),
    save: el<HTMLButtonElement>("#normal-save"),
    cancel: el<HTMLButtonElement>("#normal-cancel"),
    error: el<HTMLDivElement>("#normal-error"),
  },
};
const bindingNames: BindingName[] = [
  "hotkey",
  "scroll",
  "links",
  "settings",
  "leader",
  "normal",
];
const singleKeyBindings = new Set<BindingName>(["leader", "normal"]);

let pending = false;
let activeView: ViewName = "login";
let logoutArmed = false;
let logoutTimer: number | null = null;

let currentHotkey = "";
let scrollKeys = "CmdOrCtrl+Down";
let linkKeys = "CmdOrCtrl+Shift+Down";
let settingsKeys = "CmdOrCtrl+,";

let nvimEnabled = false;
let nvimOpenMode = "insert";
let leaderCode = "Space";
let normalCode = "Escape";
let mode: "insert" | "normal" = "insert";
let spaceHeld = false;
let lastJ = 0;
let lastQ = 0;

let recordingTarget: BindingName | null = null;
let candidateAccel: string | null = null;

function showView(name: ViewName) {
  activeView = name;
  for (const [key, node] of Object.entries(views)) {
    node.hidden = key !== name;
  }
}

function asMessage(error: unknown): string {
  return typeof error === "string" ? error : "Something went wrong.";
}

function focusInput() {
  window.requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
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
  nvimEnabled = session.nvim_mode;
  nvimOpenMode = session.nvim_open_mode;
  leaderCode = session.nvim_leader;
  normalCode = session.nvim_normal;
}

async function renderSession(): Promise<SessionView> {
  const session = await invoke<SessionView>("get_session");
  applyBindings(session);
  if (session.role) {
    badge.textContent = session.role_label ?? session.role;
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
  connectBtn.textContent = "Connect with CERN SSO";
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
    void renderSession().then(() => focusInput());
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
let historyIndex = -1;
let historyDraft = "";

function pruneHistory() {
  const cutoff = Date.now() - DAY_MS;
  history = history.filter((entry) => entry.at >= cutoff);
}

function pushHistory(question: string) {
  pruneHistory();
  const last = history[history.length - 1];
  if (last && last.question === question) {
    last.at = Date.now();
  } else {
    history.push({ question, at: Date.now() });
  }
  historyIndex = -1;
  historyDraft = "";
}

function moveCursorEnd() {
  window.requestAnimationFrame(() => {
    const end = input.value.length;
    input.focus();
    input.setSelectionRange(end, end);
  });
}

function historyPrev() {
  pruneHistory();
  if (!history.length) return;
  if (historyIndex === -1) {
    historyDraft = input.value;
    historyIndex = history.length - 1;
  } else if (historyIndex > 0) {
    historyIndex -= 1;
  }
  input.value = history[historyIndex].question;
  moveCursorEnd();
}

function historyNext() {
  if (historyIndex === -1) return;
  if (historyIndex < history.length - 1) {
    historyIndex += 1;
    input.value = history[historyIndex].question;
  } else {
    historyIndex = -1;
    input.value = historyDraft;
  }
  moveCursorEnd();
}

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

function modsHeld(mods: Mods, event: KeyboardEvent): boolean {
  if (mods.cmdOrCtrl && !(event.metaKey || event.ctrlKey)) return false;
  if (mods.cmd && !event.metaKey) return false;
  if (mods.ctrl && !event.ctrlKey) return false;
  if (mods.shift && !event.shiftKey) return false;
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

function applyLinkFilter() {
  numbered.forEach((node) => {
    const num = node.dataset.linknum ?? "";
    const matches = linkBuffer === "" || num.startsWith(linkBuffer);
    node.classList.toggle("link-hide", !matches);
    node.classList.toggle("num-active", linkBuffer !== "" && matches);
  });
}

function enterLinkMode() {
  if (linkMode) return;
  linkMode = true;
  linkBuffer = "";
  linkPaged = false;
  numbered = computeTargets();
  numbered.forEach((node, index) => {
    node.dataset.linknum = String(index);
  });
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
  if (node) activateTarget(node);
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
  if (modsHeld(parseMods(linkKeys), event)) return true;
  return nvimEnabled && mode === "normal" && spaceHeld && event.shiftKey;
}

function maybeStartChordTimer(event: KeyboardEvent) {
  if (activeView === "login" || recordingTarget) return;
  if (chordTimer !== null || linkMode) return;
  if (!linkChordEngaged(event)) return;
  chordTimer = window.setTimeout(() => {
    chordTimer = null;
    if (activeView === "login" || recordingTarget) return;
    if (activeView === "settings") enterLinkMode();
    else pageToLinks(1);
  }, 300);
}

function setMode(next: "insert" | "normal") {
  mode = next;
  updateModeBadge();
}

function updateModeBadge() {
  if (!nvimEnabled) {
    modeBadge.hidden = true;
    modeBadge.classList.remove("normal", "insert");
    return;
  }
  modeBadge.hidden = false;
  modeBadge.textContent = mode === "normal" ? "NORMAL" : "INSERT";
  modeBadge.classList.toggle("normal", mode === "normal");
  modeBadge.classList.toggle("insert", mode === "insert");
}

function setCaret(pos: number) {
  const clamped = Math.max(0, Math.min(pos, input.value.length));
  input.focus();
  input.setSelectionRange(clamped, clamped);
}

function enterInsert(pos: number) {
  setMode("insert");
  setCaret(pos);
}

function enterNormal() {
  setMode("normal");
  input.focus();
}

function deleteCharBeforeCaret() {
  const p = input.selectionStart ?? 0;
  if (p > 0) {
    input.value = input.value.slice(0, p - 1) + input.value.slice(p);
    input.setSelectionRange(p - 1, p - 1);
  }
}

function deleteCharAtCaret() {
  const p = input.selectionStart ?? 0;
  if (p < input.value.length) {
    input.value = input.value.slice(0, p) + input.value.slice(p + 1);
    input.setSelectionRange(p, p);
  }
}

function backToConversation() {
  disarmLogout();
  showView("search");
  focusInput();
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
    return event.code === "Escape" || event.code === normalCode;
  }
  return false;
}

function handleNvimInsert(event: KeyboardEvent): boolean {
  if (isEnterNormalKey(event)) {
    event.preventDefault();
    enterNormal();
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

function handleNvimNormal(event: KeyboardEvent): boolean {
  if (event.code === "Space") {
    event.preventDefault();
    spaceHeld = true;
    if (event.shiftKey) maybeStartChordTimer(event);
    return true;
  }

  if (spaceHeld) {
    if (event.shiftKey) {
      if (activeView === "settings" && event.code === "KeyQ") {
        if (logoutArmed) {
          disarmLogout();
          void doLogout();
        } else {
          armLogout();
        }
        return true;
      }
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

  if (event.metaKey || event.ctrlKey || event.altKey) return false;

  if (activeView === "settings") {
    if (event.code === "KeyH" || event.code === "Escape") {
      event.preventDefault();
      backToConversation();
      return true;
    }
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
    event.preventDefault();
    return true;
  }

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
      event.preventDefault();
      setCaret(caret - 1);
      return true;
    case "KeyL":
      event.preventDefault();
      setCaret(caret + 1);
      return true;
    case "KeyK":
      event.preventDefault();
      historyPrev();
      return true;
    case "KeyJ":
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
    case "KeyQ":
      event.preventDefault();
      if (Date.now() - lastQ < 250) {
        lastQ = 0;
        void invoke("hide_window");
      } else {
        lastQ = Date.now();
      }
      return true;
    case "Escape":
      event.preventDefault();
      if (linkMode) exitLinkMode();
      return true;
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

function handleNvim(event: KeyboardEvent): boolean {
  if (!nvimEnabled || activeView === "login") return false;
  if (mode === "insert") return handleNvimInsert(event);
  return handleNvimNormal(event);
}

function refreshNvimUi() {
  nvimToggle.textContent = nvimEnabled ? "On" : "Off";
  nvimToggle.classList.toggle("active", nvimEnabled);
  nvimOptions.hidden = !nvimEnabled;
  nvimOpenInsert.classList.toggle("active", nvimOpenMode === "insert");
  nvimOpenNormal.classList.toggle("active", nvimOpenMode === "normal");
  setRowDisplay("leader");
  setRowDisplay("normal");
  updateModeBadge();
}

async function toggleNvim() {
  try {
    const session = await invoke<SessionView>("set_nvim_mode", {
      enabled: !nvimEnabled,
    });
    applyBindings(session);
    setMode(nvimEnabled && nvimOpenMode === "normal" ? "normal" : "insert");
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
    badge.textContent = result.role;
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
  if (name === "leader") return leaderCode;
  return normalCode;
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

  if (!single && event.key === "Escape") {
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
  settingsRole.textContent = badge.textContent || "—";
  disarmLogout();
  void exitRecording();
  for (const name of bindingNames) {
    setRowDisplay(name);
    rows[name].error.hidden = true;
    rows[name].save.hidden = true;
    rows[name].cancel.hidden = true;
  }
  updateStatus.hidden = true;
  refreshNvimUi();
  showView("settings");
}

function armLogout() {
  logoutArmed = true;
  logoutBtn.textContent = "Press ⇧Q again to log out";
  if (logoutTimer !== null) clearTimeout(logoutTimer);
  logoutTimer = window.setTimeout(disarmLogout, 2500);
}

function disarmLogout() {
  logoutArmed = false;
  if (logoutTimer !== null) {
    clearTimeout(logoutTimer);
    logoutTimer = null;
  }
  logoutBtn.textContent = "Log out";
}

async function doLogout() {
  disarmLogout();
  await invoke("logout");
  await renderSession();
}

async function onOpen() {
  void exitRecording();
  const session = await renderSession();
  if (session.role) {
    setMode(nvimEnabled && nvimOpenMode === "normal" ? "normal" : "insert");
    focusInput();
  } else {
    updateModeBadge();
    window.requestAnimationFrame(() => connectBtn.focus());
  }
}

function handleInAppShortcut(event: KeyboardEvent): boolean {
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
    if (
      event.code === "KeyQ" &&
      event.shiftKey &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey
    ) {
      if (logoutArmed) {
        disarmLogout();
        void doLogout();
      } else {
        armLogout();
      }
      return true;
    }
    if (modsMatch(parseMods(linkKeys), event)) {
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
        scrollContainer(settingsBody, 1);
        return true;
      }
      if (token === "Up") {
        scrollContainer(settingsBody, -1);
        return true;
      }
    }
    return false;
  }

  if (activeView !== "search") return false;

  const settingsMods = parseMods(settingsKeys);
  if (modsMatch(settingsMods, event) && keyToken(event.code) === accelKey(settingsKeys)) {
    openSettings();
    return true;
  }

  const linkMods = parseMods(linkKeys);
  if (modsMatch(linkMods, event)) {
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

  const scrollMods = parseMods(scrollKeys);
  if (modsMatch(scrollMods, event)) {
    const token = keyToken(event.code);
    if (token === "Down") {
      scrollAnswer(1);
      return true;
    }
    if (token === "Up") {
      scrollAnswer(-1);
      return true;
    }
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

connectBtn.addEventListener("click", () => void beginLogin());

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
checkUpdateBtn.addEventListener("click", () => void checkForUpdates());
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
