import { JSDOM } from "jsdom";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { demosHtml } from "./report-demos.ts";

const opened: JSDOM[] = [];
afterEach(() => {
  for (const dom of opened.splice(0)) dom.window.close();
});

// the markup as written, with no script run to empty the code blocks
const markup = new JSDOM(`<!doctype html><html><body>${demosHtml}</body></html>`);
afterAll(() => markup.window.close());

/** Scene `i`'s timeline as the page lays it out: its code, how long that takes to type, the wait between steps, its length. */
function timing(i: number) {
  const scene = markup.window.document.querySelectorAll("#reel .scene")[i]!;
  const text = scene.querySelector("pre.code")?.textContent ?? "";
  const [steps, delay, hold] = ["data-steps", "data-delay", "data-hold"].map((a) => Number(scene.getAttribute(a))) as [number, number, number];
  const typing = text ? Math.max(650, Math.min(1600, text.length * 8)) : 250;
  return { text, typing, delay, length: typing + steps * delay + hold };
}

const typed = (text: string, share: number) => text.slice(0, Math.ceil(share * text.length));

/**
 * The report page's reel with its own script running and its clock in the test's hands: timers, animation frames and
 * `performance.now()` move only when a test calls `advance`. With `observer`, the reel waits to be scrolled into view,
 * as in a browser; without one it plays at once.
 */
function page(opts: { observer?: boolean } = {}) {
  let clock = 0;
  let nextId = 1;
  let hidden = false;
  const timers = new Map<number, { due: number; fn: () => void }>();
  let frames: Array<() => void> = [];
  const observers: Array<(entries: Array<{ isIntersecting: boolean }>) => void> = [];
  const dom = new JSDOM(`<!doctype html><html><body>${demosHtml}</body></html>`, {
    runScripts: "dangerously",
    beforeParse(window) {
      window.setTimeout = ((fn: () => void, ms = 0) => {
        const id = nextId++;
        timers.set(id, { due: clock + ms, fn });
        return id;
      }) as never;
      window.clearTimeout = ((id: number) => void timers.delete(id)) as never;
      window.requestAnimationFrame = ((fn: () => void) => frames.push(fn)) as never;
      window.cancelAnimationFrame = (() => void (frames = [])) as never;
      Object.defineProperty(window.performance, "now", { value: () => clock });
      Object.defineProperty(window.document, "hidden", { get: () => hidden });
      if (opts.observer) {
        class Observer {
          constructor(cb: (entries: Array<{ isIntersecting: boolean }>) => void) {
            observers.push(cb);
          }
          observe() {}
          disconnect() {}
        }
        Object.assign(window, { IntersectionObserver: Observer });
      }
    },
  });
  opened.push(dom);
  const doc = dom.window.document;
  const scenes = [...doc.querySelectorAll("#reel .scene")];
  const button = (name: string) => doc.querySelector(`#demos .controls .${name}`) as HTMLButtonElement;
  const showing = () => {
    const scene = scenes.findIndex((s) => s.classList.contains("on"));
    return { scene, counter: doc.querySelector("#reel .reel-head .n")?.textContent, step: scenes[scene]?.getAttribute("data-step") ?? null };
  };
  return {
    timers,
    scenes,
    toggle: button("toggle"),
    restart: button("restart"),
    chapter: (i: number) => doc.querySelectorAll("#reel .chapters .chapter")[i]!,
    click: (el: Element) => el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })),
    /** The scene on screen, the counter above it, and its step while it animates (null when it stands finished). */
    showing,
    code: (i: number) => scenes[i]?.querySelector("pre.code")?.textContent,
    /** Everything a pause must hold still: the scene and its step, the code typed so far, and the progress bar. */
    frame: () => ({ ...showing(), code: scenes[showing().scene]?.querySelector("pre.code")?.textContent, bar: (doc.querySelector("#reel .reel-bar i") as HTMLElement).style.width }),
    /** Moves the clock on by `ms`: timers fire in the order they fall due, then the page paints one frame. */
    advance: (ms: number) => {
      const target = clock + ms;
      for (;;) {
        let next: [number, { due: number; fn: () => void }] | undefined;
        for (const entry of timers) if (entry[1].due <= target && (!next || entry[1].due < next[1].due)) next = entry;
        if (!next) break;
        timers.delete(next[0]);
        clock = next[1].due;
        next[1].fn();
      }
      clock = target;
      const due = frames;
      frames = [];
      for (const fn of due) fn();
    },
    setHidden: (h: boolean) => {
      hidden = h;
      doc.dispatchEvent(new dom.window.Event("visibilitychange"));
    },
    scrolledIntoView: () => observers.forEach((cb) => cb([{ isIntersecting: true }])),
  };
}

describe("the reel on the report page", () => {
  it("plays from the first scene: the code types in, the steps follow, and the next scene starts when this one's time is up", () => {
    const p = page();
    const t = timing(0);
    expect(p.scenes).toHaveLength(13);
    expect(t.text).not.toBe("");
    expect(p.showing()).toEqual({ scene: 0, counter: "1 / 13", step: "0" });
    expect(p.toggle.textContent).toBe("Pause");
    p.advance(t.typing / 2);
    expect(p.code(0)).toBe(typed(t.text, 0.5));
    p.advance(t.typing / 2 + t.delay);
    expect([p.code(0), p.showing().step]).toEqual([t.text, "1"]);
    p.advance(t.length - t.typing - t.delay - 1);
    expect(p.showing().scene).toBe(0);
    p.advance(1);
    expect(p.showing()).toEqual({ scene: 1, counter: "2 / 13", step: "0" });
  });

  it("Pause holds the scene where it stands, mid-step, with its bar; Play goes on from that moment instead of starting over", () => {
    const p = page();
    const t = timing(0);
    const into = t.typing + t.delay + 500; // step 1 taken, step 2 still 1000 ms away
    p.advance(into);
    p.click(p.toggle);
    expect(p.toggle.textContent).toBe("Play");
    expect(p.timers.size).toBe(0);
    const held = p.frame();
    expect(held).toEqual({ scene: 0, counter: "1 / 13", step: "1", code: t.text, bar: `${Math.round((1000 * into) / t.length) / 10}%` });
    p.advance(60_000);
    expect(p.frame()).toEqual(held);

    // guard: Play is not a restart, and step 2 comes once the rest of its wait has passed
    p.click(p.toggle);
    expect([p.toggle.textContent, p.showing().step]).toEqual(["Pause", "1"]);
    p.advance(t.delay - 500 - 1);
    expect(p.showing().step).toBe("1");
    p.advance(1);
    expect(p.showing().step).toBe("2");
  });

  it("Pause while the code is typing keeps it half typed, and Play types the rest", () => {
    const p = page();
    const t = timing(0);
    p.advance(t.typing / 4);
    p.click(p.toggle);
    expect(p.code(0)).toBe(typed(t.text, 0.25));
    p.advance(5_000);
    expect(p.code(0)).toBe(typed(t.text, 0.25));
    p.click(p.toggle);
    expect(p.code(0)).toBe(typed(t.text, 0.25));
    p.advance(t.typing / 2);
    expect(p.code(0)).toBe(typed(t.text, 0.75));
    p.advance(t.typing / 4 + 40);
    expect(p.code(0)).toBe(t.text);
  });

  it("Restart plays from the first scene, whether the reel is on a later scene or paused", () => {
    const p = page();
    p.advance(timing(0).length + timing(1).length);
    expect(p.showing().scene).toBe(2);
    p.click(p.restart);
    expect(p.showing()).toEqual({ scene: 0, counter: "1 / 13", step: "0" });
    expect(p.toggle.textContent).toBe("Pause");

    p.advance(timing(0).typing + timing(0).delay);
    p.click(p.toggle);
    expect(p.timers.size).toBe(0);
    p.click(p.restart);
    expect([p.toggle.textContent, p.showing(), p.code(0)]).toEqual(["Pause", { scene: 0, counter: "1 / 13", step: "0" }, ""]);
    expect(p.timers.size).toBeGreaterThan(0);
  });

  it("a chapter chosen while paused is shown finished, and Play plays that chapter from its start", () => {
    const p = page();
    p.advance(1000);
    p.click(p.toggle);
    p.click(p.chapter(4));
    expect([p.showing(), p.timers.size]).toEqual([{ scene: 4, counter: "5 / 13", step: null }, 0]);
    p.click(p.toggle);
    expect(p.showing()).toEqual({ scene: 4, counter: "5 / 13", step: "0" });
  });

  it("a hidden tab holds the reel where it is, and showing the tab again goes on from there", () => {
    const p = page();
    const t = timing(0);
    p.advance(t.typing + 200);
    p.setHidden(true);
    expect([p.toggle.textContent, p.timers.size, p.showing().step]).toEqual(["Play", 0, "0"]);
    p.advance(30_000);
    p.setHidden(false);
    expect(p.toggle.textContent).toBe("Pause");
    p.advance(t.delay - 200 - 1);
    expect(p.showing().step).toBe("0");
    p.advance(1);
    expect(p.showing().step).toBe("1");
  });

  it("before the reel is in view it offers Play, and a pause chosen with the buttons holds when it scrolls into view", () => {
    const p = page({ observer: true });
    expect([p.toggle.textContent, p.timers.size, p.showing().step]).toEqual(["Play", 0, null]);
    p.click(p.toggle);
    expect([p.toggle.textContent, p.showing().step]).toEqual(["Pause", "0"]);
    p.click(p.toggle);
    p.scrolledIntoView();
    expect([p.toggle.textContent, p.timers.size]).toEqual(["Play", 0]);
  });

  it("guard: left alone, the reel starts playing when it scrolls into view", () => {
    const p = page({ observer: true });
    p.scrolledIntoView();
    expect([p.toggle.textContent, p.showing()]).toEqual(["Pause", { scene: 0, counter: "1 / 13", step: "0" }]);
    expect(p.timers.size).toBeGreaterThan(0);
  });
});
