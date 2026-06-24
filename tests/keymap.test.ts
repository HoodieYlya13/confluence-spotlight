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
    const app = await loadApp(session);
    typeText(app.input, "hello");
    press("Escape"); // Normal, caret on last char
    press("KeyX");
    expect(app.input.value).toBe("hell");
  });

  it("dd deletes the whole line", async () => {
    const app = await loadApp(session);
    typeText(app.input, "hello");
    press("Escape");
    press("KeyD");
    press("KeyD"); // within 250ms
    expect(app.input.value).toBe("");
  });
});

describe("nvim visual-mode delete/change (deleteVisualRange)", () => {
  // "hello" with the first three chars ("hel") selected in Visual mode.
  async function selectHel() {
    const app = await loadApp(session);
    typeText(app.input, "hello");
    press("Escape");
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
