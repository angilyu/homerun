import { memo, type ReactNode } from "react";
import { parseMarkdown, type Block, type Inline } from "@homerun/app-state";

/**
 * Model output as React elements from app-state's neutral tree (§9.8). No HTML strings, so
 * nothing is injected; images arrive as links and are never loaded (§13).
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return <div className="md">{parseMarkdown(text).map((b, i) => block(b, i))}</div>;
});

function block(b: Block, key: number): ReactNode {
  switch (b.t) {
    case "paragraph":
      return <p key={key}>{inlines(b.children)}</p>;
    case "heading": {
      const H = `h${Math.min(6, Math.max(3, b.level + 2))}` as "h3";
      return <H key={key}>{inlines(b.children)}</H>;
    }
    case "code":
      return (
        <pre key={key} className="code" data-lang={b.lang ?? undefined}>
          <code>{b.text}</code>
        </pre>
      );
    case "quote":
      return <blockquote key={key}>{b.children.map(block)}</blockquote>;
    case "list": {
      const items = b.items.map((it, i) => (
        <li key={i}>
          {it.checked !== null && <input type="checkbox" checked={it.checked} readOnly disabled aria-label={it.checked ? "done" : "not done"} />}
          {it.children.map(block)}
        </li>
      ));
      return b.ordered ? (
        <ol key={key} start={b.start}>
          {items}
        </ol>
      ) : (
        <ul key={key}>{items}</ul>
      );
    }
    case "table":
      return (
        <div key={key} className="table-wrap">
          <table>
            <thead>
              <tr>
                {b.header.map((c, i) => (
                  <th key={i} style={{ textAlign: b.align[i] ?? undefined }}>
                    {inlines(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, i) => (
                    <td key={i} style={{ textAlign: b.align[i] ?? undefined }}>
                      {inlines(c)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "hr":
      return <hr key={key} />;
  }
}

function inlines(xs: readonly Inline[]): ReactNode[] {
  return xs.map((x, i) => inline(x, i));
}

function inline(x: Inline, key: number): ReactNode {
  switch (x.t) {
    case "text":
      return x.text;
    case "strong":
      return <strong key={key}>{inlines(x.children)}</strong>;
    case "em":
      return <em key={key}>{inlines(x.children)}</em>;
    case "del":
      return <del key={key}>{inlines(x.children)}</del>;
    case "code":
      return <code key={key}>{x.text}</code>;
    case "br":
      return <br key={key} />;
    case "link": {
      const label = x.image ? ["Image: ", ...inlines(x.children)] : inlines(x.children);
      if (!x.href) return <span key={key}>{label}</span>;
      return (
        <a key={key} href={x.href} title={x.href} className={x.image ? "image-link" : undefined}>
          {label}
        </a>
      );
    }
  }
}
