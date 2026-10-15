import { parse, type HTMLElement } from "node-html-parser";
import { groupIntoSections } from "./docx";
import { cleanText, ExtractError, type ExtractResult } from "./types";

/**
 * Extracts readable text from an HTML page as heading-delimited units with
 * paragraph numbers. Scripts/styles/navigation are dropped; nothing from the
 * page is ever rendered as HTML back to users.
 */
export function extractHtml(html: string, url: string): ExtractResult {
  const root = parse(html, { blockTextElements: { script: false, style: false, noscript: false, pre: true } });
  root.querySelectorAll("script,style,noscript,nav,footer,header,aside,form,iframe,svg").forEach((n) => n.remove());
  const meta = (name: string) =>
    root.querySelector(`meta[property="${name}"]`)?.getAttribute("content") ?? root.querySelector(`meta[name="${name}"]`)?.getAttribute("content") ?? null;
  const title = meta("og:title") ?? root.querySelector("title")?.text.trim() ?? null;
  const author = meta("author") ?? meta("article:author");
  const published = meta("article:published_time") ?? meta("date") ?? meta("dc.date");
  const container: HTMLElement = root.querySelector("article") ?? root.querySelector("main") ?? root.querySelector("body") ?? root;
  const paras: { text: string; level: number | null; n: number }[] = [];
  let n = 0;
  container.querySelectorAll("h1,h2,h3,h4,p,li,pre,blockquote,td,th").forEach((el) => {
    const text = cleanText(el.text);
    if (!text || text.length < 2) return;
    const tag = el.tagName.toLowerCase();
    n++;
    paras.push({ text, level: /^h[1-4]$/.test(tag) ? Number(tag[1]) : null, n });
  });
  if (!paras.length) {
    const t = cleanText(container.text);
    if (!t) throw new ExtractError("empty");
    paras.push({ text: t, level: null, n: 1 });
  }
  const res = groupIntoSections(paras, "web", { url, published }, title ? cleanText(title).slice(0, 300) : null, author);
  res.publishedInfo = published;
  return res;
}
