import type { CSSProperties, ReactNode } from "react";
import type { LaidOutElement, LaidOutSlide } from "@talaba/shared";
import { BULLET_INDENT_PT, SLIDE_W_IN } from "./types";

/**
 * Draws one laid-out slide exactly where the server's layout engine put each
 * element (the same model the PPTX/PDF export uses). Positions are inches on a
 * 13.333-inch-wide slide; `cqw` units scale them to the frame's width, so the
 * preview is sharp at any screen size without measuring in JavaScript.
 */

const u = (inches: number) => `${((inches / SLIDE_W_IN) * 100).toFixed(4)}cqw`;
const pt = (points: number) => u(points / 72);
const hex = (c: string) => `#${c}`;

function family(face: string) {
  return face === "Times New Roman" ? '"Times New Roman", "Liberation Serif", Tinos, Times, serif' : 'Arial, "Liberation Sans", Arimo, Helvetica, sans-serif';
}

type TextEl = Extract<LaidOutElement, { kind: "text" }>;
type TableEl = Extract<LaidOutElement, { kind: "table" }>;
type ChartEl = Extract<LaidOutElement, { kind: "chart" }>;

function Text({ e }: { e: TextEl }) {
  const style: CSSProperties = {
    left: u(e.x), top: u(e.y), width: u(e.w), height: u(e.h),
    color: hex(e.color), fontFamily: family(e.fontFace), fontSize: pt(e.fontSizePt), fontWeight: e.bold ? 700 : 400,
    textAlign: e.align, lineHeight: 1.17 * e.lineSpacing,
    justifyContent: e.valign === "middle" ? "center" : e.valign === "bottom" ? "flex-end" : "flex-start",
  };
  return (
    <div className={`slide-el deck-text deck-role-${e.role}`} style={style}>
      {e.paragraphs.map((p, i) => {
        const level = p.level ?? 0;
        return (
          <p key={i} style={{ marginTop: i && p.spaceBeforePt ? pt(p.spaceBeforePt) : 0, paddingLeft: p.bullet ? pt(BULLET_INDENT_PT * (level + 1)) : 0 }}>
            {p.bullet && (
              <span className="deck-dot" aria-hidden style={{ left: pt(BULLET_INDENT_PT * level), color: hex(e.bulletColor ?? e.color) }}>
                •
              </span>
            )}
            {p.runs.map((r, j) => (
              <span key={j} style={{ fontWeight: r.bold === undefined ? undefined : r.bold ? 700 : 400, color: r.color ? hex(r.color) : undefined, fontStyle: r.italic ? "italic" : undefined }}>
                {r.text}
              </span>
            ))}
          </p>
        );
      })}
    </div>
  );
}

function Table({ e }: { e: TableEl }) {
  const heights = e.rowHeights ?? [e.rowH, ...e.rows.map(() => e.rowH)];
  const cell: CSSProperties = { padding: `${u(0.08)} ${u(0.12)}`, border: `${u(0.75 / 72)} solid ${hex(e.border)}` };
  return (
    <div className="slide-el" style={{ left: u(e.x), top: u(e.y), width: u(e.w), height: u(e.h) }}>
      <table className="deck-table" style={{ fontSize: pt(e.fontSizePt), fontFamily: family(e.fontFace), color: hex(e.color), width: u(e.w) }}>
        <colgroup>
          {e.colW.map((w, i) => (
            <col key={i} style={{ width: u(w) }} />
          ))}
        </colgroup>
        <thead>
          <tr style={{ height: u(heights[0] ?? e.rowH) }}>
            {e.columns.map((c, i) => (
              <th key={i} scope="col" style={{ ...cell, background: hex(e.headerFill), color: hex(e.headerColor) }}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {e.rows.map((r, ri) => (
            <tr key={ri} style={{ height: u(heights[ri + 1] ?? e.rowH) }}>
              {r.map((c, ci) => (
                <td key={ci} style={{ ...cell, background: e.zebra && ri % 2 === 1 ? hex(e.zebra) : "#ffffff" }}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A tidy upper bound for the value axis (1, 2, 2.5, 5 × 10ⁿ). */
function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}
const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1)).replace(/\.0$/, "");

/** Simplified drawing of the native chart: same numbers, categories and colours as the exported file. */
function Chart({ e }: { e: ChartEl }) {
  const W = e.w * 100;
  const H = e.h * 100;
  const fs = (e.fontSizePt / 72) * 100;
  const axis = "#475569";
  const color = (i: number) => hex(e.colors[i % e.colors.length] ?? "4f46e5");
  const summary = e.series.map((s) => `${s.name}: ${e.categories.map((c, i) => `${c} ${fmt(s.values[i] ?? 0)}`).join(", ")}`).join("; ");
  const legendH = e.showLegend ? fs * 2.2 : 0;
  let body: ReactNode;
  if (e.chartKind === "pie") {
    const values = e.series[0]?.values ?? [];
    const total = values.reduce((a, b) => a + Math.max(0, b), 0) || 1;
    const r = Math.min(W, H - legendH) / 2 - fs * 2;
    const cx = W / 2;
    const cy = (H - legendH) / 2;
    let a0 = -Math.PI / 2;
    body = values.map((v, i) => {
      const a1 = a0 + (Math.max(0, v) / total) * Math.PI * 2;
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const path = `M${cx},${cy} L${cx + r * Math.cos(a0)},${cy + r * Math.sin(a0)} A${r},${r} 0 ${large} 1 ${cx + r * Math.cos(a1)},${cy + r * Math.sin(a1)} Z`;
      const mid = (a0 + a1) / 2;
      a0 = a1;
      return (
        <g key={i}>
          <path d={path} fill={color(i)} stroke="#fff" strokeWidth={fs * 0.1} />
          <text x={cx + r * 0.65 * Math.cos(mid)} y={cy + r * 0.65 * Math.sin(mid)} fontSize={fs} fill="#fff" textAnchor="middle" dominantBaseline="middle">
            {fmt(v)}
          </text>
        </g>
      );
    });
  } else {
    const all = e.series.flatMap((s) => s.values);
    const top = niceMax(Math.max(0, ...all) * 1.08);
    const bottom = Math.min(0, ...all);
    const left = fs * 3.2;
    const plotTop = fs * 1.6;
    const plotBottom = H - fs * 2.2 - legendH;
    const plotRight = W - fs * 0.8;
    const n = Math.max(1, e.categories.length);
    const span = top - bottom || 1;
    const y = (v: number) => plotBottom - ((v - bottom) / span) * (plotBottom - plotTop);
    const step = (plotRight - left) / n;
    const ticks = Array.from({ length: 6 }, (_, i) => bottom + (span * i) / 5);
    const grid = ticks.map((tv, i) => (
      <g key={i}>
        <line x1={left} x2={plotRight} y1={y(tv)} y2={y(tv)} stroke="#e2e8f0" strokeWidth={fs * 0.06} />
        <text x={left - fs * 0.4} y={y(tv)} fontSize={fs} fill={axis} textAnchor="end" dominantBaseline="middle">
          {fmt(tv)}
        </text>
      </g>
    ));
    const cats = e.categories.map((c, i) => (
      <text key={i} x={left + step * (i + 0.5)} y={plotBottom + fs * 1.3} fontSize={fs} fill={axis} textAnchor="middle">
        {c.length > 14 ? `${c.slice(0, 13)}…` : c}
      </text>
    ));
    let marks: ReactNode;
    if (e.chartKind === "line") {
      marks = e.series.map((s, si) => {
        const pts = s.values.map((v, i) => [left + step * (i + 0.5), y(v)] as const);
        return (
          <g key={si}>
            <polyline points={pts.map((p) => p.join(",")).join(" ")} fill="none" stroke={color(si)} strokeWidth={fs * 0.22} strokeLinejoin="round" />
            {pts.map(([px, py], i) => (
              <g key={i}>
                <circle cx={px} cy={py} r={fs * 0.32} fill={color(si)} />
                <text x={px} y={py - fs * 0.7} fontSize={fs} fill="#0f172a" textAnchor="middle">
                  {fmt(s.values[i] ?? 0)}
                </text>
              </g>
            ))}
          </g>
        );
      });
    } else {
      const k = e.series.length;
      const bw = (step * 0.62) / k;
      marks = e.series.map((s, si) =>
        s.values.map((v, i) => {
          const x = left + step * i + step * 0.19 + bw * si;
          return (
            <g key={`${si}-${i}`}>
              <rect x={x} y={Math.min(y(v), y(0))} width={bw} height={Math.abs(y(v) - y(0))} fill={color(si)} />
              <text x={x + bw / 2} y={y(v) - fs * 0.4} fontSize={fs} fill="#0f172a" textAnchor="middle">
                {fmt(v)}
              </text>
            </g>
          );
        }),
      );
    }
    body = (
      <>
        {grid}
        <line x1={left} x2={plotRight} y1={y(Math.max(0, bottom))} y2={y(Math.max(0, bottom))} stroke={axis} strokeWidth={fs * 0.07} />
        {marks}
        {cats}
      </>
    );
  }
  const legend = e.showLegend ? (
    <g>
      {(e.chartKind === "pie" ? e.categories : e.series.map((s) => s.name)).map((name, i, arr) => {
        const slot = W / Math.max(1, arr.length);
        const x = slot * i + slot / 2;
        return (
          <g key={i}>
            <rect x={x - fs * 2.6} y={H - legendH + fs * 0.6} width={fs * 0.8} height={fs * 0.8} fill={color(i)} />
            <text x={x - fs * 1.5} y={H - legendH + fs * 1.3} fontSize={fs} fill={axis}>
              {name.length > 24 ? `${name.slice(0, 23)}…` : name}
            </text>
          </g>
        );
      })}
    </g>
  ) : null;
  return (
    <div className="slide-el" style={{ left: u(e.x), top: u(e.y), width: u(e.w), height: u(e.h) }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="100%" role="img" aria-label={summary} style={{ fontFamily: family(e.fontFace), display: "block" }}>
        {body}
        {legend}
      </svg>
    </div>
  );
}

export function SlidePreview({ slide, label }: { slide: LaidOutSlide; label?: string }) {
  return (
    <div className="slide-frame deck-slide" style={{ background: hex(slide.background) }} role="group" aria-label={label}>
      {slide.elements.map((e, i) =>
        e.kind === "rect" ? (
          <div
            key={i}
            className="slide-el"
            aria-hidden
            style={{
              left: u(e.x), top: u(e.y), width: u(e.w), height: u(e.h), background: hex(e.fill),
              borderRadius: e.radius ? u(e.radius) : undefined, border: e.line ? `max(1px, ${u(0.75 / 72)}) solid ${hex(e.line)}` : undefined,
            }}
          />
        ) : e.kind === "text" ? (
          <Text key={i} e={e} />
        ) : e.kind === "table" ? (
          <Table key={i} e={e} />
        ) : (
          <Chart key={i} e={e} />
        ),
      )}
    </div>
  );
}
