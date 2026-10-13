import type { ProcessingClientRow } from "@/lib/processingClientsLastWeek";

type ScriptClientTarget = {
  clientId: string;
  notes: string;
  passports: string[];
  names: string[];
};

function uniqueNonEmpty(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const t = v.trim();
    if (!t) continue;
    const key = t.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

function namesForApplicant(ap: ProcessingClientRow["applicants"][number]): string[] {
  const names: string[] = [];
  if (ap.displayName.trim()) names.push(ap.displayName.trim());
  const joined = [ap.firstName, ap.lastName].filter(Boolean).join(" ").trim();
  if (joined) names.push(joined);
  if (ap.firstName.trim()) names.push(ap.firstName.trim());
  if (ap.lastName.trim()) names.push(ap.lastName.trim());
  return uniqueNonEmpty(names);
}

function buildTargets(rows: ProcessingClientRow[]): ScriptClientTarget[] {
  return rows.map((row) => {
    const passports: string[] = [];
    const names: string[] = [];
    for (const ap of row.applicants) {
      if (ap.passportNumber.trim()) passports.push(ap.passportNumber.trim());
      names.push(...namesForApplicant(ap));
    }
    return {
      clientId: row.clientId,
      notes: row.notes.trim(),
      passports: uniqueNonEmpty(passports),
      names: uniqueNonEmpty(names),
    };
  });
}

/** One-shot browser-console script for Visaflow clients table (`tr[data-client-row-index]`). */
export function buildDashboardClientCheckboxScript(rows: ProcessingClientRow[]): string {
  const clients = buildTargets(rows);

  return `(async () => {
  const CLIENTS = ${JSON.stringify(clients, null, 2)};
  const norm = (s) => (s || "").replace(/\\s+/g, " ").trim().toUpperCase();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  if (!document.querySelector('tr[data-client-row-index]')) {
    console.warn("[visaflow-select] No tr[data-client-row-index] — open the Visaflow clients list first.");
    return;
  }

  function nameMatches(textNorm, name) {
    const n = norm(name);
    if (!n) return false;
    if (n.length >= 6 && textNorm.includes(n)) return true;
    const tokens = n.split(/\\s+/).filter((t) => t.length >= 3);
    if (tokens.length === 0) return false;
    if (tokens.length === 1) return textNorm.includes(tokens[0]);
    return tokens.every((t) => textNorm.includes(t));
  }

  function clientMatchesRow(target, textNorm) {
    const id = norm(target.clientId);
    if (id && textNorm.includes(id)) return "clientId";
    for (const p of target.passports) {
      const n = norm(p);
      if (n.length >= 4 && textNorm.includes(n)) return "passport";
    }
    for (const name of target.names) {
      if (nameMatches(textNorm, name)) return "applicantName";
    }
    const note = norm(target.notes);
    if (note.length >= 4 && textNorm.includes(note)) return "notes";
    return null;
  }

  const reasonScore = { clientId: 4, passport: 3, applicantName: 2, notes: 1 };

  function findScrollRoot() {
    const row = document.querySelector("tr[data-client-row-index]");
    let el = row && row.parentElement;
    while (el) {
      const st = getComputedStyle(el);
      if (/(auto|scroll|overlay)/.test(st.overflowY) && el.scrollHeight > el.clientHeight + 8) return el;
      el = el.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  const pending = new Map(CLIENTS.map((c) => [c.clientId, c]));
  const seenRowIndices = new Set();
  let checked = 0;
  let already = 0;
  const hits = [];

  function matchVisibleRows() {
    for (const tr of document.querySelectorAll("tr[data-client-row-index]")) {
      const idx = tr.getAttribute("data-client-row-index");
      if (idx != null) seenRowIndices.add(idx);
      const textNorm = norm(tr.innerText);
      let best = null;
      for (const [clientId, target] of pending) {
        const reason = clientMatchesRow(target, textNorm);
        if (!reason) continue;
        const score = reasonScore[reason] || 0;
        if (!best || score > best.score) best = { clientId, reason, score };
      }
      if (!best) continue;
      const cb = tr.querySelector('input[type="checkbox"]');
      if (!cb) continue;
      pending.delete(best.clientId);
      hits.push({
        index: idx,
        clientId: best.clientId,
        reason: best.reason,
      });
      if (cb.checked) already += 1;
      else {
        cb.click();
        checked += 1;
      }
    }
  }

  const root = findScrollRoot();
  console.log("[visaflow-select] scrolling to load lazy rows (only checks your " + CLIENTS.length + " search clients, not every dashboard row)…");
  root.scrollTop = 0;
  await sleep(400);
  matchVisibleRows();

  let stable = 0;
  let lastSeen = 0;
  for (let step = 0; step < 120 && pending.size > 0; step += 1) {
    const before = seenRowIndices.size;
    root.scrollTop = Math.min(root.scrollTop + Math.max(200, root.clientHeight * 0.75), root.scrollHeight);
    window.scrollBy(0, Math.max(150, window.innerHeight * 0.4));
    await sleep(350);
    matchVisibleRows();
    const atBottom = root.scrollTop + root.clientHeight >= root.scrollHeight - 6;
    if (seenRowIndices.size === before && atBottom) stable += 1;
    else stable = 0;
    if (seenRowIndices.size === lastSeen && stable >= 3) break;
    lastSeen = seenRowIndices.size;
  }

  root.scrollTop = 0;
  await sleep(350);
  matchVisibleRows();

  const notOnPage = [...pending.values()].map((t) => ({
    clientId: t.clientId,
    label: t.names[0] || t.passports[0] || t.notes || t.clientId.slice(0, 8),
  }));

  console.log(
    "[visaflow-select] search list: " +
      CLIENTS.length +
      " clients · unique DOM row indices seen while scrolling: " +
      seenRowIndices.size +
      " · matched: " +
      hits.length +
      " (" +
      checked +
      " newly checked, " +
      already +
      " already checked) · not found: " +
      notOnPage.length,
  );
  if (hits.length) console.log("[visaflow-select] matched:", hits);
  if (notOnPage.length) {
    console.warn(
      "[visaflow-select] still missing — filter the dashboard (status/route) to include them, or they are not in this view:",
      notOnPage,
    );
  }
})();`;
}
