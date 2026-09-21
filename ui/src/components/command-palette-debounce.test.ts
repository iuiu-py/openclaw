/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import {
  createContext,
  createGateway,
  createSessionResult,
  enterQuery,
  findPaletteOption,
  mountPalette,
} from "./command-palette.test-support.ts";
import type { CommandPalette } from "./command-palette.ts";
import "./command-palette.ts";

async function typeQuery(palette: CommandPalette, value: string) {
  const input = palette.querySelector<HTMLTextAreaElement>(".cmd-palette__input")!;
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await palette.updateComplete;
  return input;
}

describe("CommandPalette input debounce", () => {
  let restoreDialog: () => void;
  beforeEach(() => {
    vi.useFakeTimers();
    restoreDialog = installDialogPolyfill();
  });
  afterEach(() => {
    document.body.replaceChildren();
    restoreDialog();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps text immediate and results stable until 200 ms after the last key", async () => {
    const request = vi.fn(async (_method: string) => ({ sessions: [], results: [], models: [] }));
    const { gateway } = createGateway(true, { methods: ["sessions.search"], request });
    const list = vi.fn(async () => null);
    const { palette } = await mountPalette(createContext(gateway, list));
    await enterQuery(palette, "");
    const original = palette.querySelector(".cmd-palette__search")!.textContent;
    for (const query of ["p", "pl", "plu", "plug", "plugi", "plugin", "plugins"]) {
      const input = await typeQuery(palette, query);
      expect(input.value).toBe(query);
      expect(palette.querySelector(".cmd-palette__search")!.textContent).toBe(original);
      await vi.advanceTimersByTimeAsync(100);
      expect(list).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
    }
    await vi.advanceTimersByTimeAsync(99);
    expect(list).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await palette.updateComplete;
    expect(list).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ search: "plugins" }));
    expect(request.mock.calls.filter(([method]) => method === "sessions.search")).toHaveLength(1);
    expect(request).toHaveBeenCalledWith(
      "sessions.search",
      expect.objectContaining({ query: "plugins" }),
    );
    expect(findPaletteOption(palette, "Plugins", true)).toBeDefined();
  });

  it("keeps local filtering usable if the connection drops during typing", async () => {
    const { gateway, setConnected } = createGateway(true);
    const list = vi.fn(async () => null);
    const { palette } = await mountPalette(createContext(gateway, list));
    await enterQuery(palette, "plugins");
    await vi.advanceTimersByTimeAsync(100);
    setConnected(false);
    await palette.updateComplete;
    await vi.advanceTimersByTimeAsync(200);
    await palette.updateComplete;
    expect(list).not.toHaveBeenCalled();
    findPaletteOption(palette, "Plugins", true)!.click();
    expect(palette.onNavigate).toHaveBeenCalledWith("plugins");
  });

  it("retains settled rows but blocks stale clicks and Enter during the debounce", async () => {
    const { gateway } = createGateway(true);
    const list = vi.fn(async () => createSessionResult("agent:main:plan", "Planning notes"));
    const { palette } = await mountPalette(createContext(gateway, list));
    await enterQuery(palette, "plan");
    await vi.advanceTimersByTimeAsync(200);
    await palette.updateComplete;
    const input = await typeQuery(palette, "plugins");
    const row = findPaletteOption(palette, "Planning notes")!;
    expect(row).toBeDefined();
    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(input.hasAttribute("aria-activedescendant")).toBe(false);
    row.click();
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    expect(palette.onSelectSession).not.toHaveBeenCalled();
    expect(palette.onNavigate).not.toHaveBeenCalled();
    expect(palette.isOpen).toBe(true);
    await vi.advanceTimersByTimeAsync(200);
    await palette.updateComplete;
    findPaletteOption(palette, "Plugins", true)!.click();
    expect(palette.onNavigate).toHaveBeenCalledWith("plugins");
  });

  it.each(["x".repeat(60), "plugins\nwrite a plan"])(
    "preserves native caret movement in prompt %j",
    async (prompt) => {
      const { gateway } = createGateway(true);
      const { palette } = await mountPalette(createContext(gateway, async () => null));
      await enterQuery(palette, prompt);
      const input = palette.querySelector<HTMLTextAreaElement>(".cmd-palette__input")!;
      for (const key of ["ArrowUp", "ArrowDown"]) {
        const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
        input.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(false);
      }
      expect(palette.onNavigate).not.toHaveBeenCalled();
      expect(palette.onSelectSession).not.toHaveBeenCalled();
    },
  );

  it.each(["clear", "close", "detach", "composition"])(
    "cancels a pending search on %s",
    async (action) => {
      const { gateway } = createGateway(true);
      const list = vi.fn(async () => null);
      const { palette } = await mountPalette(createContext(gateway, list));
      await enterQuery(palette, "");
      const original = palette.querySelector(".cmd-palette__results")!.textContent;
      const input = await typeQuery(palette, "plugins");
      await vi.advanceTimersByTimeAsync(100);
      if (action === "clear") {
        await typeQuery(palette, "");
        expect(palette.querySelector(".cmd-palette__results")!.textContent).toBe(original);
      } else if (action === "close") {
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      } else if (action === "detach") {
        palette.remove();
      } else {
        input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
        await typeQuery(palette, "plugin");
      }
      await vi.advanceTimersByTimeAsync(200);
      expect(list).not.toHaveBeenCalled();
      if (action === "composition") {
        input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
        await vi.advanceTimersByTimeAsync(200);
        expect(list).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ search: "plugin" }));
      }
    },
  );
});
