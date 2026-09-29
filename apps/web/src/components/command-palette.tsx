"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flatNavItems } from "./sidebar-nav";

export function CommandPalette({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const items = useMemo(() => flatNavItems(projectId), [projectId]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
        setQ("");
      }
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const filtered = items.filter((i) => {
    const hay = `${i.label} ${i.group} ${i.href}`.toLowerCase();
    return hay.includes(q.trim().toLowerCase());
  });

  const go = useCallback(
    (href: string) => {
      setOpen(false);
      router.push(href);
    },
    [router],
  );

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="geo-chip"
        style={{ cursor: "pointer", marginLeft: "auto" }}
        title="Search (Ctrl+K)"
      >
        Search
        <kbd style={{ fontSize: 10, color: "var(--muted)" }}>⌘K</kbd>
      </button>
    );
  }

  return (
    <div className="geo-command-layer">
      <button
        type="button"
        className="geo-command-dismiss"
        onClick={() => setOpen(false)}
        aria-label="Close page search"
      />
      <section
        className="geo-panel geo-command-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Search pages"
        style={{ width: "min(520px, 92vw)", overflow: "hidden", boxShadow: "var(--shadow-md)" }}
      >
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Jump to a page…"
          aria-label="Search pages"
          className="geo-input"
          style={{
            border: 0,
            borderBottom: "1px solid var(--line)",
            borderRadius: 0,
            boxShadow: "none",
            fontSize: 15,
            padding: "0.95rem 1rem",
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && filtered[0]) go(filtered[0].href);
          }}
        />
        <ul style={{ listStyle: "none", margin: 0, padding: 8, maxHeight: 340, overflow: "auto" }}>
          {filtered.slice(0, 12).map((item) => (
            <li key={item.href}>
              <button
                type="button"
                onClick={() => go(item.href)}
                className="geo-command-result"
              >
                <span style={{ fontWeight: 500 }}>{item.label}</span>
                <span style={{ color: "var(--muted)", fontSize: 12 }}>{item.group}</span>
              </button>
            </li>
          ))}
          {filtered.length === 0 && (
            <li style={{ padding: 16, color: "var(--muted)", fontSize: 14 }}>No matches</li>
          )}
        </ul>
      </section>
    </div>
  );
}
