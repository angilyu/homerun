import { createHash } from "node:crypto";

/**
 * Just enough XML to read RSS and Atom feeds for rule checks (§8.3). Written here rather than
 * taken from a package: feeds use a small part of XML, and this keeps the runtime free of
 * another dependency. Feeds are untrusted input, so:
 * - it handles elements, attributes, CDATA, comments, processing instructions and a DOCTYPE,
 *   whose internal subset is skipped unread;
 * - it decodes only the five predefined entities and numeric character references. Declared
 *   entities, internal or external, are never expanded, so there is no XXE and no entity
 *   expansion bomb; an unknown `&name;` stays as literal text;
 * - input size, nesting depth and element count are bounded (`XML_LIMITS`);
 * - it ignores anything it does not understand rather than failing.
 */

export const XML_LIMITS = { maxChars: 5 * 1024 * 1024, maxDepth: 64, maxElements: 100_000 };

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

export function parseXml(xml: string, limits = XML_LIMITS): XmlElement {
  if (xml.length > limits.maxChars) throw new Error(`the document is larger than ${limits.maxChars} characters`);
  const root: XmlElement = { name: "#document", attrs: {}, children: [], text: "" };
  const stack: XmlElement[] = [root];
  let elements = 0;
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
      // A DOCTYPE may carry an internal subset in [...], whose declarations contain '>'.
      let end = xml.indexOf(">", lt + 2);
      const open = xml.indexOf("[", lt + 2);
      if (open >= 0 && (end < 0 || open < end)) {
        const close = xml.indexOf("]", open + 1);
        end = close < 0 ? -1 : xml.indexOf(">", close + 1);
      }
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
      if (++elements > limits.maxElements) throw new Error(`more than ${limits.maxElements} elements`);
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
      if (!selfClosing) {
        if (stack.length > limits.maxDepth) throw new Error(`elements nested more than ${limits.maxDepth} deep`);
        stack.push(el);
      }
    }
  }
  return root;
}

const local = (name: string) => name.slice(name.indexOf(":") + 1).toLowerCase();
const prefixed = (name: string) => name.includes(":");

/** The first child with this local name, preferring one in the default namespace. */
export function child(el: XmlElement, name: string): XmlElement | undefined {
  const all = children(el, name);
  return all.find((c) => !prefixed(c.name)) ?? all[0];
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

/** An id for an entry that has none: its title and date, hashed. */
function fallbackId(title: string, date: string): string {
  return `sha256:${createHash("sha256").update(`${title}\n${date}`).digest("hex").slice(0, 32)}`;
}

const firstText = (el: XmlElement, names: string[]) => names.map((n) => textOf(child(el, n))).find(Boolean) ?? "";

/** An Atom `link`'s target if it is the entry's page: `rel="alternate"`, or no rel. */
function alternateHref(links: XmlElement[]): string | null {
  return links.find((l) => (!l.attrs.rel || l.attrs.rel === "alternate") && l.attrs.href)?.attrs.href ?? null;
}

/**
 * Entries of an RSS 0.9x/2.0, RSS 1.0 (RDF) or Atom feed, as published. An entry's id is its
 * `guid`, `rdf:about` or Atom `id`; failing that its link; failing that a hash of its title and
 * date.
 */
export function parseFeed(xml: string, format: "rss" | "atom" | "auto"): FeedItem[] {
  const doc = parseXml(xml);
  const root = doc.children.find((c) => ["rss", "rdf", "feed"].includes(local(c.name)));
  if (!root) throw new Error("not an RSS or Atom feed");
  const isAtom = local(root.name) === "feed";
  if (format === "atom" && !isAtom) throw new Error("expected an Atom feed, got RSS");
  if (format === "rss" && isAtom) throw new Error("expected an RSS feed, got Atom");
  if (isAtom) {
    return children(root, "entry").map((e) => {
      const link = alternateHref(children(e, "link"));
      const title = textOf(child(e, "title"));
      const id = textOf(child(e, "id")) || link || fallbackId(title, firstText(e, ["updated", "published"]));
      return { id, title, link };
    });
  }
  const channel = child(root, "channel");
  const items = [...(channel ? children(channel, "item") : []), ...children(root, "item")];
  return items.map((it) => {
    // RSS's own <link> holds the URL as text; an atom:link inside an item holds it in href.
    const links = children(it, "link");
    const link = links.map((l) => (prefixed(l.name) ? "" : textOf(l))).find(Boolean) || alternateHref(links.filter((l) => prefixed(l.name)));
    const title = textOf(child(it, "title"));
    const id = textOf(child(it, "guid")) || it.attrs["rdf:about"] || link || fallbackId(title, firstText(it, ["pubdate", "date", "updated"]));
    return { id, title, link };
  });
}
