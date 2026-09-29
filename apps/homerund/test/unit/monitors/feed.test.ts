import { describe, expect, test } from "bun:test";
import { parseFeed, parseXml, XML_LIMITS } from "../../../src/monitors/feed";

/**
 * The feed parser reads untrusted input (§8.3). Hand-made fixtures in the shapes real feeds
 * take: a blog's RSS 2.0 with the usual namespaces, RSS 1.0 (RDF), a releases-style Atom feed,
 * a podcast-style feed with no guids, and hostile documents.
 */

const BLOG_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<?xml-stylesheet type="text/xsl" href="/feed.xsl"?>
<rss version="2.0"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>A Blog</title>
  <atom:link href="https://blog.example/feed/" rel="self" type="application/rss+xml" />
  <link>https://blog.example</link>
  <!-- generator: something -->
  <item>
    <title>We&#8217;re moving &#x2014; again</title>
    <link>https://blog.example/2026/09/moving/</link>
    <dc:creator><![CDATA[Sam]]></dc:creator>
    <pubDate>Mon, 28 Sep 2026 16:00:00 +0000</pubDate>
    <guid isPermaLink="false">https://blog.example/?p=412</guid>
    <description><![CDATA[<p>Short version &amp; more</p>]]></description>
    <content:encoded><![CDATA[<p>Long <b>version</b>, with a </content:encoded> lookalike and <![CDATA[ nested-looking text.</p>]]></content:encoded>
  </item>
  <item>
    <title>Tags: &lt;b&gt; &amp; &quot;quotes&quot; &apos;here&apos;</title>
    <link>https://blog.example/2026/09/tags/</link>
    <guid>https://blog.example/2026/09/tags/</guid>
    <dc:date>2026-09-27T10:00:00Z</dc:date>
  </item>
</channel>
</rss>`;

const RDF = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel rdf:about="https://news.example/">
    <title>News</title>
    <link>https://news.example/</link>
    <items><rdf:Seq><rdf:li rdf:resource="https://news.example/a"/><rdf:li rdf:resource="https://news.example/b"/></rdf:Seq></items>
  </channel>
  <item rdf:about="https://news.example/a">
    <title>Story A</title>
    <link>https://news.example/a?from=rss</link>
    <dc:date>2026-09-28T08:00:00+00:00</dc:date>
  </item>
  <item rdf:about="https://news.example/b">
    <title>Story B</title>
    <link>https://news.example/b?from=rss</link>
  </item>
</rdf:RDF>`;

const RELEASES_ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/" xml:lang="en-US">
  <id>tag:code.example,2008:/acme/tool/releases</id>
  <link type="text/html" rel="alternate" href="https://code.example/acme/tool/releases"/>
  <link type="application/atom+xml" rel="self" href="https://code.example/acme/tool/releases.atom"/>
  <title>Release notes from tool</title>
  <updated>2026-09-28T12:00:00Z</updated>
  <entry>
    <id>tag:code.example,2008:Repository/1/v2.1.0</id>
    <updated>2026-09-28T12:00:00Z</updated>
    <link rel="enclosure" href="https://code.example/acme/tool/archive/v2.1.0.zip"/>
    <link rel="alternate" type="text/html" href="https://code.example/acme/tool/releases/tag/v2.1.0"/>
    <title type="html">v2.1.0 &lt;b&gt;stable&lt;/b&gt;</title>
    <content type="html">&lt;p&gt;Fixes&lt;/p&gt;</content>
    <media:thumbnail height="30" width="30" url="https://img.example/a.png"/>
  </entry>
  <entry>
    <updated>2026-09-20T12:00:00Z</updated>
    <link rel="self" href="https://code.example/acme/tool/releases/v2.0.0.atom"/>
    <title>v2.0.0</title>
  </entry>
</feed>`;

const PODCAST = `<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
<channel><title>Cast</title>
  <item><title>Episode 1</title><link>https://cast.example/1</link><pubDate>Tue, 01 Sep 2026 00:00:00 GMT</pubDate><itunes:duration>31:02</itunes:duration></item>
  <item><title>Weekly update</title><pubDate>Tue, 08 Sep 2026 00:00:00 GMT</pubDate><enclosure url="https://cast.example/2.mp3" length="1" type="audio/mpeg"/></item>
  <item><title>Weekly update</title><pubDate>Tue, 15 Sep 2026 00:00:00 GMT</pubDate></item>
  <item><title>Linked by atom only</title><atom:link xmlns:atom="http://www.w3.org/2005/Atom" rel="alternate" href="https://cast.example/4"/></item>
</channel></rss>`;

describe("feed parser fixtures (§8.3)", () => {
  test("a blog's RSS 2.0: namespaced elements, CDATA, numeric entities, guid", () => {
    expect(parseFeed(BLOG_RSS, "rss")).toEqual([
      { id: "https://blog.example/?p=412", title: "We\u2019re moving \u2014 again", link: "https://blog.example/2026/09/moving/" },
      { id: "https://blog.example/2026/09/tags/", title: `Tags: <b> & "quotes" 'here'`, link: "https://blog.example/2026/09/tags/" },
    ]);
    const item = parseXml(BLOG_RSS).children[0]!.children[0]!.children.find((c) => c.name === "item")!;
    const encoded = item.children.find((c) => c.name === "content:encoded")!;
    expect(encoded.text).toBe("<p>Long <b>version</b>, with a </content:encoded> lookalike and <![CDATA[ nested-looking text.</p>");
    expect(item.children.find((c) => c.name === "description")!.text).toBe("<p>Short version &amp; more</p>");
  });

  test("RSS 1.0 (RDF): items beside the channel, ids from rdf:about", () => {
    expect(parseFeed(RDF, "auto")).toEqual([
      { id: "https://news.example/a", title: "Story A", link: "https://news.example/a?from=rss" },
      { id: "https://news.example/b", title: "Story B", link: "https://news.example/b?from=rss" },
    ]);
  });

  test("Atom: the alternate link, not self or enclosure; an entry with no id or page link is hashed", () => {
    const [a, b] = parseFeed(RELEASES_ATOM, "atom");
    expect(a).toEqual({ id: "tag:code.example,2008:Repository/1/v2.1.0", title: "v2.1.0 <b>stable</b>", link: "https://code.example/acme/tool/releases/tag/v2.1.0" });
    expect(b!.link).toBeNull();
    expect(b!.id).toMatch(/^sha256:[0-9a-f]{32}$/);
  });

  test("no guid: the link, then a hash of title and date that is stable and tells equal titles apart", () => {
    const items = parseFeed(PODCAST, "auto");
    expect(items.map((i) => i.link)).toEqual(["https://cast.example/1", null, null, "https://cast.example/4"]);
    expect(items[0]!.id).toBe("https://cast.example/1");
    expect(items[3]!.id).toBe("https://cast.example/4");
    expect(items[1]!.id).toMatch(/^sha256:/);
    expect(items[1]!.id).not.toBe(items[2]!.id);
    expect(parseFeed(PODCAST, "auto").map((i) => i.id)).toEqual(items.map((i) => i.id));
  });

  test("the five predefined entities and numeric references decode; nothing else does", () => {
    const [it] = parseFeed(`<rss><channel><item><guid>g</guid><title>&lt;&gt;&amp;&quot;&apos; &#65;&#x42; &nbsp; &#0; &#x110000; &amp;lt;</title></item></channel></rss>`, "rss");
    expect(it!.title).toBe(`<>&"' AB &nbsp; &#0; &#x110000; &lt;`);
  });
});

describe("hostile feeds", () => {
  test("declared entities, internal or external, are never expanded (no XXE)", () => {
    const xxe = `<?xml version="1.0"?>
<!DOCTYPE rss [
  <!ENTITY xxe SYSTEM "file:///etc/passwd">
  <!ENTITY remote SYSTEM "http://127.0.0.1:1/x">
  <!ENTITY % param SYSTEM "http://127.0.0.1:1/p.dtd"> %param;
  <!ENTITY inner "expanded">
]>
<rss><channel><item><guid>g</guid><title>&xxe;&remote;&inner;</title></item></channel></rss>`;
    expect(parseFeed(xxe, "rss")).toEqual([{ id: "g", title: "&xxe;&remote;&inner;", link: null }]);
  });

  test("an entity expansion bomb stays literal and fast", () => {
    const lols = Array.from({ length: 9 }, (_, n) => `<!ENTITY lol${n + 1} "${`&lol${n};`.repeat(10)}">`).join("\n");
    const bomb = `<!DOCTYPE rss [<!ENTITY lol0 "lol">\n${lols}]><rss><channel><item><guid>g</guid><title>&lol9;</title></item></channel></rss>`;
    const t = performance.now();
    expect(parseFeed(bomb, "rss")[0]!.title).toBe("&lol9;");
    expect(performance.now() - t).toBeLessThan(100);
  });

  test("nesting deeper than the limit is refused", () => {
    const deep = `<rss><channel><item><guid>g</guid><title>${"<b>".repeat(XML_LIMITS.maxDepth)}x</title></item></channel></rss>`;
    expect(() => parseFeed(deep, "rss")).toThrow(/nested more than/);
    const ok = `<rss><channel><item><guid>g</guid><title>${"<b>".repeat(10)}x</title></item></channel></rss>`;
    expect(parseFeed(ok, "rss")[0]!.title).toBe("x");
  });

  test("too many elements, or too much input, is refused", () => {
    const many = `<rss><channel>${"<item/>".repeat(50)}</channel></rss>`;
    expect(() => parseXml(many, { ...XML_LIMITS, maxElements: 20 })).toThrow(/more than 20 elements/);
    expect(() => parseXml(many, { ...XML_LIMITS, maxChars: 100 })).toThrow(/larger than 100/);
    expect(() => parseFeed("<rss>" + " ".repeat(XML_LIMITS.maxChars) + "</rss>", "rss")).toThrow(/larger than/);
  });

  test("truncated or malformed documents parse as far as they go, without hanging", () => {
    const cut = BLOG_RSS.slice(0, BLOG_RSS.indexOf("<content:encoded>") + 30);
    expect(parseFeed(cut, "rss").map((i) => i.id)).toEqual(["https://blog.example/?p=412"]);
    for (const junk of ["<rss><channel><item><title>a<![CDATA[never closed", "<rss><!-- never closed", "<rss><!DOCTYPE [ never closed", "<rss><item <<>>></rss>", "<rss></channel></item></rss>"]) {
      expect(() => parseFeed(junk, "auto")).not.toThrow();
    }
  });
});
