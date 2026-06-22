import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { renderMarkdown } from "./markdown";

type SessionView = {
  role: string | null;
  role_label: string | null;
  hotkey: string;
};
type AnswerPayload = { answer: string; role: string };
type AuthEvent = {
  ok: boolean;
  role_label: string | null;
  error: string | null;
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
const answerEl = el<HTMLDivElement>("#answer");
const badge = el<HTMLSpanElement>("#role-badge");
const settingsBtn = el<HTMLButtonElement>("#settings-btn");

const connectBtn = el<HTMLButtonElement>("#connect-btn");
const loginWaiting = el<HTMLDivElement>("#login-waiting");
const loginError = el<HTMLDivElement>("#login-error");
const devLogin = el<HTMLDivElement>("#dev-login");

const settingsBack = el<HTMLButtonElement>("#settings-back");
const settingsRole = el<HTMLDivElement>("#settings-role");
const logoutBtn = el<HTMLButtonElement>("#logout-btn");
const hotkeyRecord = el<HTMLButtonElement>("#hotkey-record");
const hotkeySave = el<HTMLButtonElement>("#hotkey-save");
const hotkeyCancel = el<HTMLButtonElement>("#hotkey-cancel");
const hotkeyError = el<HTMLDivElement>("#hotkey-error");

let pending = false;
let recording = false;
let currentHotkey = "";
let candidateHotkey: string | null = null;
let activeView: ViewName = "login";

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
  statusEl.textContent = message;
  statusEl.hidden = message === "";
}

async function renderSession(): Promise<SessionView> {
  const session = await invoke<SessionView>("get_session");
  currentHotkey = session.hotkey;
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

async function submit() {
  const question = input.value.trim();
  if (!question || pending) return;

  pending = true;
  form.classList.add("pending");
  panel.hidden = false;
  answerEl.innerHTML = "";
  setStatus("Asking the operations assistant…");

  try {
    const result = await invoke<AnswerPayload>("ask_question", { question });
    badge.textContent = result.role;
    setStatus("");
    answerEl.innerHTML = renderMarkdown(result.answer);
  } catch (error) {
    setStatus(asMessage(error));
  } finally {
    pending = false;
    form.classList.remove("pending");
  }
}

function openSettings() {
  settingsRole.textContent = badge.textContent || "—";
  exitRecording();
  hotkeyError.hidden = true;
  showView("settings");
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
  };
  return accelerator
    .split("+")
    .map((part) => symbols[part] ?? part)
    .join(" ");
}

function setHotkeyDisplay(accelerator: string) {
  hotkeyRecord.textContent = formatHotkey(accelerator);
}

async function enterRecording() {
  recording = true;
  candidateHotkey = null;
  hotkeyRecord.classList.add("recording");
  hotkeyRecord.textContent = "Press a shortcut…";
  hotkeySave.hidden = true;
  hotkeyCancel.hidden = false;
  hotkeyError.hidden = true;
  try {
    await invoke("unregister_current_hotkey");
  } catch (err) {
    console.error("Failed to unregister hotkey:", err);
  }
}

async function exitRecording() {
  recording = false;
  candidateHotkey = null;
  hotkeyRecord.classList.remove("recording");
  hotkeySave.hidden = true;
  hotkeyCancel.hidden = true;
  setHotkeyDisplay(currentHotkey);
  try {
    await invoke("register_current_hotkey");
  } catch (err) {
    console.error("Failed to register hotkey:", err);
  }
}

function keyToken(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F[1-9][0-9]?$/.test(code)) return code;
  if (code === "Space") return "Space";
  const arrows: Record<string, string> = {
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
  };
  return arrows[code] ?? null;
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
    exitRecording();
    return;
  }

  const accelerator = toAccelerator(event);
  if (!accelerator) return;

  candidateHotkey = accelerator;
  recording = false;
  hotkeyRecord.classList.remove("recording");
  setHotkeyDisplay(accelerator);
  hotkeySave.hidden = false;
  hotkeyCancel.hidden = false;
}

async function saveHotkey() {
  if (!candidateHotkey) return;
  try {
    const saved = await invoke<string>("set_hotkey", {
      hotkey: candidateHotkey,
    });
    currentHotkey = saved;
    candidateHotkey = null;
    hotkeySave.hidden = true;
    hotkeyCancel.hidden = true;
    hotkeyError.hidden = true;
    setHotkeyDisplay(saved);
  } catch (error) {
    hotkeyError.textContent = asMessage(error);
    hotkeyError.hidden = false;
  }
}

async function doLogout() {
  await invoke("logout");
  await renderSession();
}

async function onOpen() {
  exitRecording();
  const session = await renderSession();
  if (session.role) {
    focusInput();
  } else {
    window.requestAnimationFrame(() => connectBtn.focus());
  }
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
  showView("search");
  focusInput();
});
logoutBtn.addEventListener("click", () => void doLogout());
hotkeyRecord.addEventListener("click", () => {
  if (!recording) enterRecording();
});
hotkeySave.addEventListener("click", () => void saveHotkey());
hotkeyCancel.addEventListener("click", () => exitRecording());

window.addEventListener(
  "keydown",
  (event) => {
    if (recording) {
      captureHotkey(event);
      return;
    }
    if (event.key === "Escape") {
      if (activeView === "settings") {
        showView("search");
        focusInput();
        return;
      }
      void invoke("hide_window");
    }
  },
  true,
);

document.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const spotlight = document.getElementById("spotlight");
  if (spotlight && !spotlight.contains(target)) {
    void invoke("hide_window");
  }
});

void listen("spotlight-open", () => void onOpen());
void listen<AuthEvent>("spotlight-auth", (event) => onAuthEvent(event.payload));

void onOpen();
