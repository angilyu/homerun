/**
 * Just enough XML to read RSS and Atom feeds for rule checks (§8.3). Written here rather than
 * taken from a package: feeds use a small part of XML, and this keeps the runtime free of
 * another dependency. It handles elements, attributes, CDATA, comments, processing
 * instructions, a DOCTYPE without an internal subset, and the predefined and numeric entities.
 * It never resolves external entities, and ignores anything it does not understand.
 */

export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  text: string;
}

const NAME = /[^\s/>=]+/y;
const ATTR = /\s*([^\s/>=]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/y;

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|amp|quot|apos);/g, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" } as Record<string, string>)[e]!;
  });
}

export function parseXml(xml: string): XmlElement {
  const root: XmlElement = { name: "#document", attrs: {}, children: [], text: "" };
  const stack: XmlElement[] = [root];
  let i = 0;
  const top = () => stack[stack.length - 1]!;
  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) {
      top().text += decodeEntities(xml.slice(i));
      break;
    }
    if (lt > i) top().text += decodeEntities(xml.slice(i, lt));
    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      i = end < 0 ? xml.length : end + 3;
    } else if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      top().text += xml.slice(lt + 9, end < 0 ? xml.length : end);
      i = end < 0 ? xml.length : end + 3;
    } else if (xml.startsWith("<?", lt)) {
      const end = xml.indexOf("?>", lt + 2);
      i = end < 0 ? xml.length : end + 2;
    } else if (xml.startsWith("<!", lt)) {
      const end = xml.indexOf(">", lt + 2);
      i = end < 0 ? xml.length : end + 1;
    } else if (xml[lt + 1] === "/") {
      const end = xml.indexOf(">", lt + 2);
      const name = xml.slice(lt + 2, end < 0 ? xml.length : end).trim();
      i = end < 0 ? xml.length : end + 1;
      const at = stack.map((e) => e.name).lastIndexOf(name);
      if (at > 0) stack.length = at;
    } else {
      NAME.lastIndex = lt + 1;
      const m = NAME.exec(xml);
      if (!m) {
        top().text += "<";
        i = lt + 1;
        continue;
      }
      const el: XmlElement = { name: m[0], attrs: {}, children: [], text: "" };
      let j = NAME.lastIndex;
      for (;;) {
        ATTR.lastIndex = j;
        const a = ATTR.exec(xml);
        if (!a || a[0].length === 0) break;
        el.attrs[a[1]!] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? "");
        j = ATTR.lastIndex;
      }
      const end = xml.indexOf(">", j);
      const selfClosing = end > 0 && xml[end - 1] === "/";
      i = end < 0 ? xml.length : end + 1;
      top().children.push(el);
      if (!selfClosing) stack.push(el);
    }
  }
  return root;
}

const local = (name: string) => name.slice(name.indexOf(":") + 1).toLowerCase();

export function child(el: XmlElement, name: string): XmlElement | undefined {
  return el.children.find((c) => local(c.name) === name);
}

export function children(el: XmlElement, name: string): XmlElement[] {
  return el.children.filter((c) => local(c.name) === name);
}

/** All text inside an element, markup removed. */
export function textOf(el: XmlElement | undefined): string {
  if (!el) return "";
  return (el.text + el.children.map(textOf).join("")).trim();
}

export interface FeedItem {
  id: string;
  title: string;
  link: string | null;
}

/** Entries of an RSS 0.9x/2.0, RSS 1.0 (RDF) or Atom feed, newest first as published. */
export function parseFeed(xml: string, format: "rss" | "atom" | "auto"): FeedItem[] {
  const doc = parseXml(xml);
  const root = doc.children.find((c) => ["rss", "rdf", "feed"].includes(local(c.name)));
  if (!root) throw new Error("not an RSS or Atom feed");
  const isAtom = local(root.name) === "feed";
  if (format === "atom" && !isAtom) throw new Error("expected an Atom feed, got RSS");
  if (format === "rss" && isAtom) throw new Error("expected an RSS feed, got Atom");
  if (isAtom) {
    return children(root, "entry").map((e) => {
      const links = children(e, "link");
      const alt = links.find((l) => !l.attrs.rel || l.attrs.rel === "alternate") ?? links[0];
      const link = alt?.attrs.href ?? null;
      const title = textOf(child(e, "title"));
      return { id: textOf(child(e, "id")) || link || title, title, link };
    });
  }
  const channel = child(root, "channel");
  const items = [...(channel ? children(channel, "item") : []), ...children(root, "item")];
  return items.map((it) => {
    const link = textOf(child(it, "link")) || null;
    const title = textOf(child(it, "title"));
    return { id: textOf(child(it, "guid")) || it.attrs["rdf:about"] || link || title, title, link };
  });
}
