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
const settingsBtn = el<HTMLButtonElement>("#settings-btn");

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

type BindingName = "hotkey" | "scroll" | "links" | "settings";

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
};
const bindingNames: BindingName[] = ["hotkey", "scroll", "links", "settings"];

let pending = false;
let activeView: ViewName = "login";
let logoutArmed = false;
let logoutTimer: number | null = null;

let currentHotkey = "";
let scrollKeys = "CmdOrCtrl+Down";
let linkKeys = "CmdOrCtrl+Shift+Down";
let settingsKeys = "CmdOrCtrl+,";

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
}

async function renderSession(): Promise<SessionView> {
  const session = await invoke<SessionView>("get_session");
  applyBindings(session);
  if (session.role) {
    badge.textContent = session.role_label ?? session.role;
    showView("search");
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

function answerLinks(): HTMLAnchorElement[] {
  return Array.from(answerEl.querySelectorAll<HTMLAnchorElement>("a[data-href]"));
}

function decorateLinks() {
  const links = answerLinks();
  links.forEach((anchor, index) => {
    anchor.dataset.linknum = String(index);
    const prev = anchor.previousElementSibling;
    let badgeEl: HTMLElement;
    if (prev && prev.classList.contains("link-num")) {
      badgeEl = prev as HTMLElement;
    } else {
      badgeEl = document.createElement("span");
      badgeEl.className = "link-num";
      anchor.parentNode?.insertBefore(badgeEl, anchor);
    }
    badgeEl.textContent = String(index);
  });
  applyLinkFilter();
}

function applyLinkFilter() {
  for (const anchor of answerLinks()) {
    const num = anchor.dataset.linknum ?? "";
    const matches = linkBuffer === "" || num.startsWith(linkBuffer);
    anchor.classList.toggle("link-hide", !matches);
    const badgeEl = anchor.previousElementSibling;
    if (badgeEl && badgeEl.classList.contains("link-num")) {
      badgeEl.classList.toggle("link-hide", !matches);
      badgeEl.classList.toggle("active", linkBuffer !== "" && matches);
    }
  }
}

function enterLinkMode() {
  if (linkMode) return;
  linkMode = true;
  linkBuffer = "";
  linkPaged = false;
  decorateLinks();
}

function exitLinkMode() {
  if (!linkMode) return;
  linkMode = false;
  linkBuffer = "";
  linkPaged = false;
  answerEl.querySelectorAll(".link-num").forEach((node) => node.remove());
  for (const anchor of answerLinks()) {
    anchor.classList.remove("link-hide");
    delete anchor.dataset.linknum;
  }
}

function candidatesFor(buffer: string): number[] {
  const count = answerLinks().length;
  const result: number[] = [];
  for (let i = 0; i < count; i += 1) {
    if (String(i).startsWith(buffer)) result.push(i);
  }
  return result;
}

function openLinkByIndex(index: number) {
  const anchor = answerLinks().find(
    (item) => item.dataset.linknum === String(index),
  );
  const href = anchor?.getAttribute("data-href");
  exitLinkMode();
  if (href) void openUrl(href);
}

function pageToLinks(direction: 1 | -1) {
  enterLinkMode();
  const links = answerLinks();
  if (!links.length) {
    scrollAnswer(direction);
    return;
  }
  if (direction === 1 && !linkPaged) {
    scrollElementToTop(links[0]);
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

function maybeStartChordTimer(event: KeyboardEvent) {
  if (activeView !== "search" || recordingTarget) return;
  if (chordTimer !== null || linkPaged) return;
  if (!modsMatch(parseMods(linkKeys), event)) return;
  chordTimer = window.setTimeout(() => {
    chordTimer = null;
    if (activeView === "search" && !recordingTarget) pageToLinks(1);
  }, 300);
}

async function submit() {
  const question = input.value.trim();
  if (!question || pending) return;

  pushHistory(question);
  input.value = "";
  exitLinkMode();

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
  return settingsKeys;
}

function setRowDisplay(name: BindingName) {
  rows[name].record.textContent = formatHotkey(accelOf(name));
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

  if (event.key === "Escape") {
    void exitRecording();
    return;
  }

  const accelerator = toAccelerator(event);
  if (!accelerator || !recordingTarget) return;

  candidateAccel = accelerator;
  const row = rows[recordingTarget];
  row.record.classList.remove("recording");
  row.record.textContent = formatHotkey(accelerator);
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
    focusInput();
  } else {
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
    if (modsHeld(parseMods(linkKeys), event)) return;
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
