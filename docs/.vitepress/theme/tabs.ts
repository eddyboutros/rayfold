/**
 * Code groups remember the stack you picked. Choose Kotlin in one group and every group on every page that has a
 * Kotlin tab shows Kotlin, now and on your next visit.
 */
import { inBrowser, onContentUpdated } from "vitepress";

const KEY = "rayfold.stack";

const labelOf = (input: HTMLInputElement) => document.querySelector<HTMLLabelElement>(`label[for="${input.id}"]`)?.textContent?.trim() ?? null;

function select(label: string, except?: string) {
  for (const tab of document.querySelectorAll<HTMLLabelElement>(".vp-code-group .tabs label")) {
    if (tab.htmlFor === except || tab.textContent?.trim() !== label) continue;
    const input = document.getElementById(tab.htmlFor);
    if (input instanceof HTMLInputElement && !input.checked) input.click();
  }
}

export function rememberCodeTabs(): void {
  if (!inBrowser) return;

  window.addEventListener("click", (e) => {
    // clicks this module makes itself are not trusted, which keeps them from echoing back here
    const input = e.target instanceof HTMLInputElement && e.target.closest(".vp-code-group") ? e.target : null;
    if (!input || !e.isTrusted) return;
    const label = labelOf(input);
    if (!label) return;
    try {
      localStorage.setItem(KEY, label);
    } catch {
      // private windows may refuse storage; syncing this page still works
    }
    select(label, input.id);
  });

  onContentUpdated(() => {
    let label: string | null = null;
    try {
      label = localStorage.getItem(KEY);
    } catch {
      return;
    }
    if (label) select(label);
  });
}
