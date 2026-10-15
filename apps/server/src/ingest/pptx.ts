import { XMLParser } from "fast-xml-parser";
import { collectText, openZip, readZipText } from "./docx";
import { cleanText, ExtractError, type ExtractedPage, type ExtractResult } from "./types";

type Node = Record<string, unknown>;
const ordered = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", preserveOrder: true, trimValues: false });
const plain = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@" });

/** Slides in presentation order; the slide number is kept as the locator. Macros are never executed. */
export async function extractPptx(data: Buffer): Promise<ExtractResult> {
  const zip = await openZip(data);
  const presXml = await readZipText(zip, "ppt/presentation.xml");
  const relsXml = await readZipText(zip, "ppt/_rels/presentation.xml.rels");
  if (!presXml || !relsXml) throw new ExtractError("corrupted", "presentation.xml missing");
  const pres = plain.parse(presXml) as Record<string, any>;
  const rels = plain.parse(relsXml) as Record<string, any>;
  const relList: { "@Id": string; "@Target": string }[] = [].concat(rels?.Relationships?.Relationship ?? []);
  const relMap = new Map(relList.map((r) => [r["@Id"], r["@Target"]]));
  const sldIds: Record<string, string>[] = [].concat(pres?.["p:presentation"]?.["p:sldIdLst"]?.["p:sldId"] ?? []);
  const slidePaths = sldIds
    .map((s) => relMap.get(s["@r:id"] ?? ""))
    .filter((t): t is string => !!t)
    .map((t) => "ppt/" + t.replace(/^\/?ppt\//, "").replace(/^\.\.\//, ""));

  const pages: ExtractedPage[] = [];
  let idx = 0;
  for (const p of slidePaths) {
    idx++;
    const xml = await readZipText(zip, p);
    if (!xml) continue;
    const tree = ordered.parse(xml) as Node[];
    // Title = text of a shape whose placeholder type is title/ctrTitle.
    let heading: string | null = null;
    const paragraphs: string[] = [];
    const walkShapes = (nodes: Node[]) => {
      for (const n of nodes) {
        if ("p:sp" in n) {
          const sp = n["p:sp"] as Node[];
          const isTitle = JSON.stringify(sp).match(/"@type":"(title|ctrTitle)"/);
          const txBody = sp.find((c) => "p:txBody" in c);
          const paras = ((txBody?.["p:txBody"] as Node[]) ?? []).filter((c) => "a:p" in c);
          const texts = paras.map((pp) => cleanText(collectText(pp["a:p"] as Node[], "a:t").join(""))).filter(Boolean);
          if (isTitle && texts.length && !heading) heading = texts.join(" ");
          paragraphs.push(...texts);
        } else {
          for (const [k, v] of Object.entries(n)) if (k !== ":@" && Array.isArray(v)) walkShapes(v as Node[]);
        }
      }
    };
    walkShapes(tree);
    // Slides built from plain text boxes have no title placeholder: use the first short line.
    if (!heading && paragraphs[0] && paragraphs[0].length <= 120) heading = paragraphs[0];
    const text = paragraphs.join("\n");
    pages.push({ pageIndex: idx, kind: "slide", heading, text, method: "text", status: text ? "ok" : "empty" });
  }
  if (!pages.length) throw new ExtractError("empty");
  const core = await readZipText(zip, "docProps/core.xml");
  const title = core ? /<dc:title>([^<]+)<\/dc:title>/.exec(core)?.[1]?.trim() ?? null : null;
  const author = core ? /<dc:creator>([^<]+)<\/dc:creator>/.exec(core)?.[1]?.trim() ?? null : null;
  return {
    pages,
    sections: pages.filter((p) => p.heading).map((p) => ({ title: p.heading!, level: 1, startPage: p.pageIndex, endPage: p.pageIndex })),
    pageCount: pages.length,
    metadata: { hasMacros: !!zip.file("ppt/vbaProject.bin"), macrosExecuted: false },
    title,
    author,
  };
}
