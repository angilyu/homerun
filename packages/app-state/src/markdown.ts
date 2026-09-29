import { Lexer, type Token, type Tokens } from "marked";

/**
 * Markdown from the model as a neutral tree (§9.8): React DOM and React Native render the same
 * nodes with their own elements. No HTML string is ever produced, so nothing is injected:
 * - raw HTML shows as text;
 * - only http(s) and mailto links keep their target, and a client opens them outside the app;
 * - images become links, because loading a remote image would send data to its host (§13).
 */

export type Inline =
  | { t: "text"; text: string }
  | { t: "strong" | "em" | "del"; children: Inline[] }
  | { t: "code"; text: string }
  /** `href` null: not a safe link, show the text only. `image`: it was an image. */
  | { t: "link"; href: string | null; image: boolean; children: Inline[] }
  | { t: "br" };

export type Block =
  | { t: "paragraph"; children: Inline[] }
  | { t: "heading"; level: number; children: Inline[] }
  | { t: "code"; lang: string | null; text: string }
  | { t: "quote"; children: Block[] }
  | { t: "list"; ordered: boolean; start: number; items: { checked: boolean | null; children: Block[] }[] }
  | { t: "table"; align: ("left" | "center" | "right" | null)[]; header: Inline[][]; rows: Inline[][][] }
  | { t: "hr" };

const SAFE_SCHEMES = /^(https?:|mailto:)/i;

/** A link target a client may open, or null. */
export function safeHref(href: string): string | null {
  const h = href.trim();
  if (!SAFE_SCHEMES.test(h)) return null;
  // Control characters and whitespace inside a scheme are a classic filter bypass.
  if (/[\u0000-\u001f\u007f]/.test(h)) return null;
  return h;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: "\u00a0" };

function decode(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_, k: string) => ENTITIES[k] ?? _);
}

export function parseMarkdown(src: string): Block[] {
  let tokens: Token[];
  try {
    tokens = new Lexer({ gfm: true, breaks: false }).lex(src);
  } catch {
    return [{ t: "paragraph", children: [{ t: "text", text: src }] }];
  }
  return blocks(tokens);
}

function blocks(tokens: readonly Token[]): Block[] {
  const out: Block[] = [];
  for (const tok of tokens) {
    const b = block(tok);
    if (b) out.push(b);
  }
  return out;
}

function block(tok: Token): Block | null {
  switch (tok.type) {
    case "space":
    case "def":
      return null;
    case "paragraph":
      return { t: "paragraph", children: inlines((tok as Tokens.Paragraph).tokens) };
    case "text": {
      const t = tok as Tokens.Text;
      return { t: "paragraph", children: t.tokens ? inlines(t.tokens) : [{ t: "text", text: decode(t.text) }] };
    }
    case "heading": {
      const t = tok as Tokens.Heading;
      return { t: "heading", level: Math.min(6, Math.max(1, t.depth)), children: inlines(t.tokens) };
    }
    case "code": {
      const t = tok as Tokens.Code;
      return { t: "code", lang: t.lang?.trim() || null, text: t.text };
    }
    case "blockquote":
      return { t: "quote", children: blocks((tok as Tokens.Blockquote).tokens) };
    case "list": {
      const t = tok as Tokens.List;
      return {
        t: "list",
        ordered: t.ordered,
        start: typeof t.start === "number" ? t.start : 1,
        items: t.items.map((i) => ({ checked: i.task ? (i.checked ?? false) : null, children: blocks(i.tokens.filter((x) => x.type !== "checkbox")) })),
      };
    }
    case "table": {
      const t = tok as Tokens.Table;
      return { t: "table", align: t.align, header: t.header.map((c) => inlines(c.tokens)), rows: t.rows.map((r) => r.map((c) => inlines(c.tokens))) };
    }
    case "hr":
      return { t: "hr" };
    case "html":
      return { t: "paragraph", children: [{ t: "text", text: (tok as Tokens.HTML).text }] };
    default:
      return typeof tok.raw === "string" && tok.raw.trim() ? { t: "paragraph", children: [{ t: "text", text: tok.raw }] } : null;
  }
}

function inlines(tokens: readonly Token[] | undefined): Inline[] {
  const out: Inline[] = [];
  for (const tok of tokens ?? []) {
    for (const i of inline(tok)) {
      const last = out.at(-1);
      if (i.t === "text" && last?.t === "text") out[out.length - 1] = { t: "text", text: last.text + i.text };
      else out.push(i);
    }
  }
  return out;
}

function inline(tok: Token): Inline[] {
  switch (tok.type) {
    case "text": {
      const t = tok as Tokens.Text;
      // A text token with children (inside list items) is only a container.
      return t.tokens && t.tokens.length ? inlines(t.tokens) : [{ t: "text", text: decode(t.text) }];
    }
    case "escape":
      return [{ t: "text", text: decode((tok as Tokens.Escape).text) }];
    case "strong":
    case "em":
    case "del":
      return [{ t: tok.type, children: inlines((tok as Tokens.Strong).tokens) }];
    case "codespan":
      return [{ t: "code", text: decode((tok as Tokens.Codespan).text) }];
    case "br":
      return [{ t: "br" }];
    case "link": {
      const t = tok as Tokens.Link;
      return [{ t: "link", href: safeHref(decode(t.href)), image: false, children: inlines(t.tokens) }];
    }
    case "image": {
      const t = tok as Tokens.Image;
      return [{ t: "link", href: safeHref(decode(t.href)), image: true, children: [{ t: "text", text: t.text || t.href }] }];
    }
    case "html":
      return [{ t: "text", text: (tok as Tokens.Tag).text }];
    case "checkbox":
      return [];
    default:
      return typeof tok.raw === "string" ? [{ t: "text", text: tok.raw }] : [];
  }
}

/** The plain text of a tree, for previews and copying. */
export function plainText(bs: readonly Block[]): string {
  const inl = (xs: readonly Inline[]): string =>
    xs.map((x) => (x.t === "text" || x.t === "code" ? x.text : x.t === "br" ? "\n" : inl(x.children))).join("");
  const blk = (b: Block): string => {
    switch (b.t) {
      case "paragraph":
      case "heading":
        return inl(b.children);
      case "code":
        return b.text;
      case "quote":
        return b.children.map(blk).join("\n");
      case "list":
        return b.items.map((i) => i.children.map(blk).join("\n")).join("\n");
      case "table":
        return [b.header, ...b.rows].map((r) => r.map(inl).join("\t")).join("\n");
      case "hr":
        return "";
    }
  };
  return bs.map(blk).join("\n\n");
}
