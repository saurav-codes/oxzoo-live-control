export interface HistEntry {
  at: number;
  ok: boolean;
  ms: number;
  level: number;
}

export type History = Record<string, HistEntry[]>;

const HIST_KEY = "zoo-control:history";
const CHAIN_KEY = "zoo-control:chains";
export const HIST_CAP = 50;

export function appendHistory(h: History, name: string, e: HistEntry, cap = HIST_CAP): History {
  return { ...h, [name]: [...(h[name] ?? []), e].slice(-cap) };
}

function read<T>(key: string, empty: T): T {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "null");
    return v && typeof v === "object" ? (v as T) : empty;
  } catch {
    return empty;
  }
}

export const loadHistory = () => read<History>(HIST_KEY, {});
export const saveHistory = (h: History) => localStorage.setItem(HIST_KEY, JSON.stringify(h));

// Last time each chain passed end to end (drives P4).
export const loadChainPasses = () => read<Record<string, number>>(CHAIN_KEY, {});
export function recordChainPass(id: string) {
  localStorage.setItem(CHAIN_KEY, JSON.stringify({ ...loadChainPasses(), [id]: Date.now() }));
}
