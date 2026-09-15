import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";
import { demosHtml } from "./report-demos.ts";

const opened: JSDOM[] = [];
afterEach(() => {
  for (const dom of opened.splice(0)) dom.window.close();
});

/**
 * The report page's reel with its own script running, and its clock in the test's hands: timers are queued and never
 * fire on their own, so a test says when a scene's time is up and reads what a button did to the queue. With
 * `observer`, the reel waits to be scrolled into view, as in a browser; without one it plays at once.
 */
function page(opts: { observer?: boolean } = {}) {
  const pending = new Map<number, () => void>();
  const observers: Array<(entries: Array<{ isIntersecting: boolean }>) => void> = [];
  let nextId = 1;
  const dom = new JSDOM(`<!doctype html><html><body>${demosHtml}</body></html>`, {
    runScripts: "dangerously",
    beforeParse(window) {
      window.setTimeout = ((fn: () => void) => {
        const id = nextId++;
        pending.set(id, fn);
        return id;
      }) as never;
      window.clearTimeout = ((id: number) => void pending.delete(id)) as never;
      window.requestAnimationFrame = () => 0;
      window.cancelAnimationFrame = () => {};
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
  return {
    pending,
    scenes,
    toggle: button("toggle"),
    restart: button("restart"),
    click: (el: Element) => el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })),
    /** The scene on screen, the counter above it, and whether the scene is animating. */
    showing: () => {
      const scene = scenes.findIndex((s) => s.classList.contains("on"));
      return { scene, counter: doc.querySelector("#reel .reel-head .n")?.textContent, animating: scenes[scene]?.hasAttribute("data-step") ?? false };
    },
    /** Every queued timer runs out, in the order it was set, as the scene's clock would have it. */
    elapse: () => {
      for (const [id, fn] of [...pending]) if (pending.delete(id)) fn();
    },
    scrolledIntoView: () => observers.forEach((cb) => cb([{ isIntersecting: true }])),
  };
}

describe("the reel on the report page", () => {
  it("plays from the first scene, and moves on when a scene's time is up", () => {
    const p = page();
    expect(p.scenes).toHaveLength(13);
    expect(p.showing()).toEqual({ scene: 0, counter: "1 / 13", animating: true });
    expect(p.toggle.textContent).toBe("Pause");
    p.elapse();
    expect(p.showing()).toEqual({ scene: 1, counter: "2 / 13", animating: true });
  });

  it("Pause stops the clock and leaves the scene finished; Play goes on from that scene", () => {
    const p = page();
    p.elapse();
    p.click(p.toggle);
    expect(p.toggle.textContent).toBe("Play");
    expect(p.pending.size).toBe(0);
    expect(p.showing()).toEqual({ scene: 1, counter: "2 / 13", animating: false });

    // guard: Play is not a restart, and the clock runs again
    p.click(p.toggle);
    expect(p.toggle.textContent).toBe("Pause");
    expect(p.showing()).toEqual({ scene: 1, counter: "2 / 13", animating: true });
    p.elapse();
    expect(p.showing().scene).toBe(2);
  });

  it("Restart plays from the first scene, whether the reel is playing or paused", () => {
    const p = page();
    p.elapse();
    p.elapse();
    expect(p.showing().scene).toBe(2);
    p.click(p.restart);
    expect(p.showing()).toEqual({ scene: 0, counter: "1 / 13", animating: true });
    expect(p.toggle.textContent).toBe("Pause");

    p.elapse();
    p.click(p.toggle);
    expect(p.pending.size).toBe(0);
    p.click(p.restart);
    expect(p.toggle.textContent).toBe("Pause");
    expect(p.pending.size).toBeGreaterThan(0);
    expect(p.showing()).toEqual({ scene: 0, counter: "1 / 13", animating: true });
  });

  it("before the reel is in view it offers Play, and a pause chosen with the buttons holds when it scrolls into view", () => {
    const p = page({ observer: true });
    expect([p.toggle.textContent, p.pending.size, p.showing().animating]).toEqual(["Play", 0, false]);
    p.click(p.toggle);
    expect([p.toggle.textContent, p.showing().animating]).toEqual(["Pause", true]);
    p.click(p.toggle);
    p.scrolledIntoView();
    expect([p.toggle.textContent, p.pending.size, p.showing().animating]).toEqual(["Play", 0, false]);
  });

  it("guard: left alone, the reel starts playing when it scrolls into view", () => {
    const p = page({ observer: true });
    p.scrolledIntoView();
    expect([p.toggle.textContent, p.showing()]).toEqual(["Pause", { scene: 0, counter: "1 / 13", animating: true }]);
    expect(p.pending.size).toBeGreaterThan(0);
  });
});
