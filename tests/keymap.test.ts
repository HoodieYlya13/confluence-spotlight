import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AppHandle,
  baseSession,
  loadApp,
  press,
  typeChar,
  typeText,
} from "./harness";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  openUrl: vi.fn(),
  readText: vi.fn(),
  writeText: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: mocks.openUrl }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  readText: mocks.readText,
  writeText: mocks.writeText,
}));

let session: Record<string, unknown>;

beforeEach(() => {
  session = baseSession();
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async (cmd: string, args: any) => {
    switch (cmd) {
      case "get_session":
        return session;
      case "dev_login":
        session.role = args.role;
        session.role_label =
          args.role === "ATS_CORE_LEAD" ? "ATS Core Lead" : "Junior Operator";
        return session;
      case "set_nvim_mode":
        session.nvim_mode = args.enabled;
        return session;
      case "set_nvim_open_mode":
        session.nvim_open_mode = args.mode;
        return session;
      case "set_follow_mouse":
        session.follow_mouse = args.enabled;
        return session;
      case "set_binding":
        return session;
      case "set_hotkey":
        return args.hotkey;
      case "ask_question":
        return { answer: "Test answer body", role: "Junior Operator" };
      case "check_update":
        return { available: false, version: null, notes: null };
      default:
        return undefined;
    }
  });
  mocks.listen.mockReset();
  mocks.listen.mockResolvedValue(() => {});
  mocks.openUrl.mockReset();
  mocks.openUrl.mockResolvedValue(undefined);
  mocks.readText.mockReset();
  mocks.readText.mockResolvedValue("");
  mocks.writeText.mockReset();
  mocks.writeText.mockResolvedValue(undefined);
});

async function normalWith(text: string) {
  const app = await loadApp(session);
  typeText(app.input, text);
  press("Escape"); // enter Normal mode
  return app;
}

describe("nvim normal-mode commands", () => {
  it("jj from insert returns to Normal without leaving a stray j", async () => {
    const app = await loadApp(session);
    typeText(app.input, "hello");
    typeChar(app.input, "j"); // inserted natively -> "helloj"
    typeChar(app.input, "j"); // within 250ms -> deletes it, enters Normal -> "hello"
    expect(app.input.value).toBe("hello");
    expect(app.modeBadge.textContent).toBe("NORMAL");
  });

  it("x deletes the character under the cursor", async () => {
    const app = await normalWith("hello");
    press("KeyX");
    expect(app.input.value).toBe("hell");
  });

  it("dd deletes the whole line", async () => {
    const app = await normalWith("hello");
    press("KeyD");
    press("KeyD"); // within 250ms
    expect(app.input.value).toBe("");
  });
});

describe("nvim visual-mode delete/change (deleteVisualRange)", () => {
  // "hello" with the first three chars ("hel") selected in Visual mode.
  async function selectHel() {
    const app = await normalWith("hello");
    press("Digit0"); // caret to start
    press("KeyV"); // enter Visual at index 0
    press("KeyL"); // extend to index 1
    press("KeyL"); // extend to index 2 -> selection "hel"
    return app;
  }

  it("d removes the selection and returns to Normal", async () => {
    const app = await selectHel();
    press("KeyD");
    expect(app.input.value).toBe("lo");
    expect(app.modeBadge.textContent).toBe("NORMAL");
  });

  it("c removes the selection and enters Insert", async () => {
    const app = await selectHel();
    press("KeyC");
    expect(app.input.value).toBe("lo");
    expect(app.modeBadge.textContent).toBe("INSERT");
  });
});

describe("history navigation", () => {
  it("ArrowUp after a submit recalls the last question", async () => {
    const app = await loadApp(session);
    typeText(app.input, "first question");
    const formEl = app.doc.querySelector("#ask-form") as HTMLFormElement;
    formEl.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => {
      if (app.input.value !== "") throw new Error("input not cleared yet");
    });
    press("ArrowUp"); // Normal mode after submit -> history prev
    expect(app.input.value).toBe("first question");
  });
});

describe("link-mode letter activation (activateLinkKey)", () => {
  it("dev persona chord on the login screen triggers dev_login", async () => {
    session = baseSession({ role: null, role_label: null });
    const app = await loadApp(session);
    // Cmd+Shift+L with no link mode yet: full-chord login activation
    press("KeyL", { meta: true, shift: true });
    expect(mocks.invoke).toHaveBeenCalledWith("dev_login", {
      role: "ATS_CORE_LEAD",
    });
    void app;
  });
});

describe("dev Connect button", () => {
  it("in dev, Connect signs in as ATS_CORE_LEAD instead of opening the browser", async () => {
    session = baseSession({ role: null, role_label: null });
    const app = await loadApp(session);
    (app.doc.querySelector("#connect-btn") as HTMLButtonElement).click();
    expect(mocks.invoke).toHaveBeenCalledWith("dev_login", {
      role: "ATS_CORE_LEAD",
    });
    expect(mocks.invoke).not.toHaveBeenCalledWith("begin_login");
  });
});

describe("open mode honored after login (applyOpenMode)", () => {
  async function loginAndReachSearch(openMode: "insert" | "normal") {
    session = baseSession({
      role: null,
      role_label: null,
      nvim_mode: true,
      nvim_open_mode: openMode,
    });
    const app = await loadApp(session);
    (app.doc.querySelector("#connect-btn") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      const search = app.doc.querySelector("#search-view") as HTMLElement;
      if (search.hidden) throw new Error("still on login view");
    });
    return app;
  }

  it("first entry into search after login opens in Insert when that is the choice", async () => {
    const app = await loginAndReachSearch("insert");
    expect(app.modeBadge.textContent).toBe("INSERT");
  });

  it("first entry into search after login opens in Normal when that is the choice", async () => {
    const app = await loginAndReachSearch("normal");
    expect(app.modeBadge.textContent).toBe("NORMAL");
  });

  it("returning from Settings stays in Normal even when the open-mode choice is Insert", async () => {
    session = baseSession({ nvim_mode: true, nvim_open_mode: "insert" });
    const app = await loadApp(session);
    (app.doc.querySelector("#settings-btn") as HTMLButtonElement).click();
    press("KeyH"); // settings-view Normal nav -> back to conversation
    expect(app.modeBadge.textContent).toBe("NORMAL");
  });
});

describe("leader chord (the spaceHeld branch)", () => {
  it("Space then , opens Settings", async () => {
    const app = await loadApp(session);
    press("Escape"); // Normal
    press("Space"); // leader held
    press("Comma");
    const settingsView = app.doc.querySelector("#settings-view") as HTMLElement;
    expect(settingsView.hidden).toBe(false);
  });

  it("Space then q hides the window", async () => {
    await loadApp(session);
    press("Escape");
    press("Space");
    press("KeyQ");
    expect(mocks.invoke).toHaveBeenCalledWith("hide_window");
  });
});

describe("settings-view Normal nav (the settings branch)", () => {
  it("h returns to the conversation", async () => {
    const app = await loadApp(session);
    (app.doc.querySelector("#settings-btn") as HTMLButtonElement).click();
    const settingsView = app.doc.querySelector("#settings-view") as HTMLElement;
    expect(settingsView.hidden).toBe(false);
    press("KeyH"); // back
    const searchView = app.doc.querySelector("#search-view") as HTMLElement;
    expect(searchView.hidden).toBe(false);
    expect(settingsView.hidden).toBe(true);
  });
});

describe("leader-key recorder (captureHotkey)", () => {
  it("Escape cancels recording instead of being captured as the leader", async () => {
    const app = await loadApp(session);
    (app.doc.querySelector("#settings-btn") as HTMLButtonElement).click();
    const record = app.doc.querySelector("#leader-record") as HTMLButtonElement;
    record.click(); // enter recording
    expect(record.classList.contains("recording")).toBe(true);

    press("Escape", { key: "Escape" });

    expect(record.classList.contains("recording")).toBe(false);
    expect(
      (app.doc.querySelector("#leader-save") as HTMLElement).hidden,
    ).toBe(true);
    expect(mocks.invoke).not.toHaveBeenCalledWith(
      "set_binding",
      expect.objectContaining({ accelerator: "Escape" }),
    );
  });
});

describe("normal-mode motions and edits (the command switch)", () => {
  it("i enters Insert mode", async () => {
    const app = await loadApp(session);
    press("Escape");
    press("KeyI");
    expect(app.modeBadge.textContent).toBe("INSERT");
  });

  it("0 and $ move the caret to start and end", async () => {
    const app = await normalWith("hello");
    press("Digit0");
    expect(app.input.selectionStart).toBe(0);
    press("Digit4", { shift: true });
    expect(app.input.selectionStart).toBe(4); // block cursor clamps to last char
  });

  it("u undoes an x deletion", async () => {
    const app = await normalWith("hello");
    press("KeyX"); // delete char under cursor -> "hell"
    expect(app.input.value).toBe("hell");
    press("KeyU"); // undo
    expect(app.input.value).toBe("hello");
  });

  it("yy then p pastes the yanked register", async () => {
    const app = await normalWith("ab");
    press("KeyY");
    press("KeyY"); // yy -> register "ab"
    press("KeyP"); // paste after the caret
    await vi.waitFor(() => {
      if (app.input.value !== "abab") throw new Error(app.input.value);
    });
  });

  it("two Escapes hide the window", async () => {
    await loadApp(session);
    press("Escape"); // Insert -> Normal, primes the double-Esc
    press("Escape"); // Normal -> hide
    expect(mocks.invoke).toHaveBeenCalledWith("hide_window");
  });
});
