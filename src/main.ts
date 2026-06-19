import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { renderMarkdown } from "./markdown";

type AnswerPayload = { answer: string; role: string };

const form = document.querySelector<HTMLFormElement>("#ask-form")!;
const input = document.querySelector<HTMLInputElement>("#question")!;
const panel = document.querySelector<HTMLDivElement>("#panel")!;
const statusEl = document.querySelector<HTMLDivElement>("#status")!;
const answerEl = document.querySelector<HTMLDivElement>("#answer")!;
const badge = document.querySelector<HTMLSpanElement>("#role-badge")!;

let pending = false;

function setStatus(message: string) {
  statusEl.textContent = message;
  statusEl.hidden = message === "";
}

async function loadRole() {
  try {
    badge.textContent = await invoke<string>("role_label");
  } catch {
    badge.textContent = "";
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
    setStatus(typeof error === "string" ? error : "Something went wrong.");
  } finally {
    pending = false;
    form.classList.remove("pending");
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void submit();
});

answerEl.addEventListener("click", (event) => {
  const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>("a[data-href]");
  if (!anchor) return;
  event.preventDefault();
  const href = anchor.getAttribute("data-href");
  if (href) void openUrl(href);
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") void invoke("hide_window");
});

void listen("spotlight-open", () => {
  input.focus();
  input.select();
});

void loadRole();
input.focus();
