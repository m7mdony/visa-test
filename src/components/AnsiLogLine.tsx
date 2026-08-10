import type { CSSProperties, ReactNode } from "react";

const ANSI_FG: Record<string, string> = {
  "30": "#18181b",
  "31": "#dc2626",
  "32": "#16a34a",
  "33": "#ca8a04",
  "34": "#2563eb",
  "35": "#9333ea",
  "36": "#0891b2",
  "37": "#71717a",
  "90": "#52525b",
  "91": "#ef4444",
  "92": "#22c55e",
  "93": "#eab308",
  "94": "#3b82f6",
  "95": "#a855f7",
  "96": "#06b6d4",
  "97": "#fafafa",
};

const ANSI_RE = /(?:\u001b|\x1b)?\[([0-9;]*)m/g;

function applyCodes(style: CSSProperties, codes: string[]): CSSProperties {
  if (codes.length === 0 || codes.includes("0")) return {};
  const next = { ...style };
  for (const code of codes) {
    if (ANSI_FG[code]) next.color = ANSI_FG[code];
    if (code === "1") next.fontWeight = "bold";
    if (code === "22") delete next.fontWeight;
    if (code === "39") delete next.color;
  }
  return next;
}

export function ansiToReactNodes(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let style: CSSProperties = {};
  let lastIndex = 0;
  let key = 0;

  for (const match of text.matchAll(ANSI_RE)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      const chunk = text.slice(lastIndex, index);
      if (chunk) nodes.push(<span key={key++} style={style}>{chunk}</span>);
    }
    const codes = (match[1] ?? "").split(";").filter(Boolean);
    style = applyCodes(style, codes);
    lastIndex = index + match[0].length;
  }

  if (lastIndex < text.length) {
    nodes.push(<span key={key++} style={style}>{text.slice(lastIndex)}</span>);
  }

  return nodes.length > 0 ? nodes : [text];
}

type AnsiLogLineProps = {
  text: string;
  className?: string;
};

export default function AnsiLogLine({ text, className }: AnsiLogLineProps) {
  return <pre className={className}>{ansiToReactNodes(text)}</pre>;
}
