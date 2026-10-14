#!/usr/bin/env node

// src/connector.ts
import { defineConnector } from "@vornrun/connector-sdk";

// src/text.ts
var LATIN1 = "Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml";
var ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\xA0",
  rsquo: "\u2019",
  lsquo: "\u2018",
  rdquo: "\u201D",
  ldquo: "\u201C",
  hellip: "\u2026",
  mdash: "\u2014",
  ndash: "\u2013",
  copy: "\xA9",
  reg: "\xAE",
  trade: "\u2122",
  laquo: "\xAB",
  raquo: "\xBB",
  bull: "\u2022",
  middot: "\xB7",
  ...Object.fromEntries(LATIN1.split(" ").map((name, i) => [name, String.fromCodePoint(192 + i)]))
};
function codePoint(code) {
  const valid = Number.isInteger(code) && code > 0 && code <= 1114111 && (code < 55296 || code > 57343);
  return valid ? String.fromCodePoint(code) : void 0;
}
function decodeEntities(value) {
  return value.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[A-Za-z][A-Za-z0-9]*);/g, (whole, name) => {
    if (name.startsWith("#")) {
      const hex = name[1] === "x" || name[1] === "X";
      return codePoint(hex ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)) ?? whole;
    }
    return ENTITIES[name] ?? ENTITIES[name.toLowerCase()] ?? whole;
  });
}
function tidy(value) {
  return value.split(/\r?\n|\r/).map((line) => line.replace(/[ \t ]+/g, " ").trim()).filter((line) => line !== "").join("\n");
}
function plainText(html) {
  return tidy(
    decodeEntities(
      html.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, "").replace(/\s+/g, " ").replace(/<(br|hr)\b[^>]*>/gi, "\n").replace(/<\/?(p|h[1-6]|li|blockquote|pre|div|ul|ol|figure|figcaption|table|tr)\b[^>]*>/gi, "\n").replace(/<[^>]+>/g, "")
    )
  );
}
function inlineText(html) {
  return plainText(html).replace(/\n/g, " ");
}
function oneLine(value) {
  return tidy(value).replace(/\n/g, " ");
}
function escapeHtml(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
var SUMMARY_LENGTH = 2e3;
function cut(value, max = SUMMARY_LENGTH) {
  const chars = Array.from(value);
  return chars.length <= max ? value : `${chars.slice(0, max - 1).join("")}\u2026`;
}

// src/xml.ts
var NS = {
  rss1: "http://purl.org/rss/1.0/",
  rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
  content: "http://purl.org/rss/1.0/modules/content/",
  dc: "http://purl.org/dc/elements/1.1/",
  atom: "http://www.w3.org/2005/Atom",
  media: "http://search.yahoo.com/mrss/",
  xml: "http://www.w3.org/XML/1998/namespace"
};
var CONVENTIONAL = /* @__PURE__ */ new Map([
  ["rdf", NS.rdf],
  ["content", NS.content],
  ["dc", NS.dc],
  ["atom", NS.atom],
  ["media", NS.media],
  ["xml", NS.xml]
]);
var START_TAG = /<([A-Za-z_][\w.:-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>/y;
var END_TAG = /<\/\s*([^\s<>]+)\s*>/y;
var ATTRIBUTE = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
function resolveUrl(href, base) {
  const trimmed = href.trim();
  if (trimmed === "") return "";
  try {
    return new URL(trimmed, base || void 0).href;
  } catch {
    return trimmed;
  }
}
function rebase(value, parent) {
  try {
    return new URL(value.trim(), parent || void 0).href;
  } catch {
    return parent;
  }
}
function qualify(name, scope, attribute) {
  const colon = name.indexOf(":");
  if (colon === -1) return { ns: attribute ? "" : scope.get("") ?? "", local: name };
  const prefix = name.slice(0, colon);
  return {
    ns: scope.get(prefix) ?? CONVENTIONAL.get(prefix) ?? `urn:undeclared:${prefix}`,
    local: name.slice(colon + 1)
  };
}
function after(source, close, from) {
  const at = source.indexOf(close, from);
  return at === -1 ? source.length : at + close.length;
}
function skipDeclaration(source, from) {
  let depth = 0;
  let quote = "";
  for (let j = from + 2; j < source.length; j++) {
    const c = source[j];
    if (quote) {
      if (c === quote) quote = "";
    } else if (source.startsWith("<!--", j)) {
      j = after(source, "-->", j + 4) - 1;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "[") {
      depth++;
    } else if (c === "]") {
      depth = Math.max(0, depth - 1);
    } else if (c === ">" && depth === 0) {
      return j + 1;
    }
  }
  return source.length;
}
function attributes(raw) {
  return [...raw.matchAll(ATTRIBUTE)].map((m) => [m[1], decodeEntities(m[2] ?? m[3] ?? m[4] ?? "")]);
}
function parseXml(source, baseUrl = "") {
  const stack = [];
  let root;
  let i = 0;
  const n = source.length;
  const addText = (text, cdata) => {
    stack.at(-1)?.el.children.push({ text, cdata });
  };
  const close = (name, at) => {
    const lower = name.toLowerCase();
    let k = stack.length - 1;
    while (k >= 0 && stack[k].el.name.toLowerCase() !== lower) k--;
    if (k >= 0) for (const open of stack.splice(k)) open.el.end = at;
  };
  while (i < n) {
    const lt = source.indexOf("<", i);
    const stop = lt === -1 ? n : lt;
    if (stop > i) addText(decodeEntities(source.slice(i, stop)), false);
    if (lt === -1) break;
    i = lt;
    if (source.startsWith("<!--", i)) {
      i = after(source, "-->", i + 4);
    } else if (source.startsWith("<![CDATA[", i)) {
      const end = source.indexOf("]]>", i + 9);
      addText(source.slice(i + 9, end === -1 ? n : end), true);
      i = end === -1 ? n : end + 3;
    } else if (source.startsWith("<?", i)) {
      i = after(source, "?>", i + 2);
    } else if (source.startsWith("<!", i)) {
      i = skipDeclaration(source, i);
    } else {
      const tag = source[i + 1] === "/" ? END_TAG : START_TAG;
      tag.lastIndex = i;
      const m = tag.exec(source);
      if (!m) {
        addText("<", false);
        i++;
        continue;
      }
      i = tag.lastIndex;
      if (tag === END_TAG) {
        close(m[1], lt);
        continue;
      }
      if (root !== void 0 && stack.length === 0) continue;
      const parent = stack.at(-1);
      const raw = attributes(m[2] ?? "");
      let scope = parent?.scope ?? /* @__PURE__ */ new Map();
      const declared = raw.filter(([name]) => name === "xmlns" || name.startsWith("xmlns:"));
      if (declared.length > 0) {
        scope = new Map(scope);
        for (const [name, value] of declared) scope.set(name === "xmlns" ? "" : name.slice(6), value);
      }
      const attrs = raw.filter(([name]) => name !== "xmlns" && !name.startsWith("xmlns:")).map(([name, value]) => ({ ...qualify(name, scope, true), value }));
      const parentBase = parent?.el.base ?? baseUrl;
      const xmlBase = attrs.find((a) => a.ns === NS.xml && a.local === "base");
      const el = {
        name: m[1],
        ...qualify(m[1], scope, false),
        attrs,
        children: [],
        base: xmlBase ? rebase(xmlBase.value, parentBase) : parentBase,
        start: i,
        end: i,
        truncated: false,
        source
      };
      if (parent) parent.el.children.push(el);
      else root = el;
      if (m[3] !== "/") stack.push({ el, scope });
    }
  }
  for (const open of stack) {
    open.el.end = n;
    open.el.truncated = true;
  }
  return root;
}
function isElement(node) {
  return "local" in node;
}
function elements(el, local, ns) {
  return (el?.children ?? []).filter((c) => isElement(c) && c.local === local && c.ns === ns);
}
function child(el, local, ns) {
  return elements(el, local, ns)[0];
}
function attr(el, local, ns = "") {
  return el?.attrs.find((a) => a.local === local && a.ns === ns)?.value ?? "";
}
function innerXml(el) {
  return el.source.slice(el.start, el.end).trim();
}
function textOf(el) {
  if (!el) return "";
  if (el.children.some(isElement)) return innerXml(el);
  return el.children.map((node) => {
    const { text, cdata } = node;
    return cdata && text.includes("&lt;") && !text.includes("<") ? decodeEntities(text) : text;
  }).join("").trim();
}

// src/discover.ts
var FEED_TYPES = {
  "application/rss+xml": "rss2",
  "application/atom+xml": "atom",
  "application/feed+json": "json",
  "application/json": "json"
};
var TYPE_OF_FORMAT = {
  rss2: "application/rss+xml",
  rss1: "application/rss+xml",
  atom: "application/atom+xml",
  json: "application/feed+json"
};
var ATTRIBUTE2 = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
function attributesOf(tag) {
  const found = /* @__PURE__ */ new Map();
  for (const m of tag.matchAll(ATTRIBUTE2)) {
    const name = m[1].toLowerCase();
    if (!found.has(name)) found.set(name, decodeEntities(m[2] ?? m[3] ?? m[4] ?? "").trim());
  }
  return found;
}
function discoverFeeds(html, pageUrl) {
  const page = html.replace(/<!--[\s\S]*?-->/g, "");
  const baseHref = attributesOf(/<base\b([^>]*)>/i.exec(page)?.[1] ?? "").get("href") ?? "";
  const base = resolveUrl(baseHref, pageUrl) || pageUrl;
  const links = [];
  for (const m of page.matchAll(/<link\b([^>]*)>/gi)) {
    const attrs = attributesOf(m[1]);
    const rel = (attrs.get("rel") ?? "").toLowerCase().split(/\s+/);
    const type = (attrs.get("type") ?? "").split(";")[0].trim().toLowerCase();
    const href = attrs.get("href") ?? "";
    const format = FEED_TYPES[type];
    if (!rel.includes("alternate") || format === void 0 || href === "") continue;
    links.push({ url: resolveUrl(href, base), title: attrs.get("title") ?? "", type, format });
  }
  const preferred = links.some((link) => link.type === "application/feed+json");
  const seen = /* @__PURE__ */ new Set();
  return links.filter((link) => {
    if (preferred && link.type === "application/json") return false;
    if (seen.has(link.url)) return false;
    seen.add(link.url);
    return true;
  });
}

// src/feed.ts
import { createHash } from "crypto";

// src/dates.ts
var MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
var ZONES = {
  UT: 0,
  GMT: 0,
  Z: 0,
  EST: -5,
  EDT: -4,
  CST: -6,
  CDT: -5,
  MST: -7,
  MDT: -6,
  PST: -8,
  PDT: -7
};
var RFC822 = /^(?:[A-Za-z]{2,},?\s*)?(\d{1,2})[\s-]+([A-Za-z]{3,})\.?[\s-]+(\d{4}|\d{2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([A-Za-z]+|[+-]\d{4}|[+-]\d{2}:\d{2}))?/;
var RFC3339 = /^(\d{4})-(\d{2})-(\d{2})(?:[Tt\s](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?\s*([Zz]|[+-]\d{2}:?\d{2})?)?$/;
function offsetMinutes(zone) {
  if (zone === void 0) return 0;
  const numeric = /^([+-])(\d{2}):?(\d{2})$/.exec(zone);
  if (numeric) return (numeric[1] === "-" ? -1 : 1) * (Number(numeric[2]) * 60 + Number(numeric[3]));
  const upper = zone.toUpperCase();
  if (upper in ZONES) return ZONES[upper] * 60;
  if (/^[A-IK-M]$/.test(upper)) return -(upper.charCodeAt(0) - 64 - (upper > "J" ? 1 : 0)) * 60;
  if (/^[N-Y]$/.test(upper)) return (upper.charCodeAt(0) - 77) * 60;
  return 0;
}
function utc(year, month, day, hour, minute, second, ms, offset) {
  if (month < 0 || month > 11 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60) return "";
  if (new Date(Date.UTC(year, month, day)).getUTCMonth() !== month) return "";
  return new Date(Date.UTC(year, month, day, hour, minute, second, ms) - offset * 6e4).toISOString();
}
function fromRfc3339(value) {
  const m = RFC3339.exec(value);
  if (!m) return void 0;
  const ms = m[7] === void 0 ? 0 : Number(m[7].slice(0, 3).padEnd(3, "0"));
  const zone = m[8] === void 0 || /^z$/i.test(m[8]) ? void 0 : m[8];
  return utc(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4] ?? 0),
    Number(m[5] ?? 0),
    Number(m[6] ?? 0),
    ms,
    offsetMinutes(zone)
  );
}
function fromRfc822(value) {
  const m = RFC822.exec(value);
  if (!m) return void 0;
  const month = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
  if (month === -1) return "";
  const short = m[3].length === 2 ? Number(m[3]) : void 0;
  const year = short === void 0 ? Number(m[3]) : short < 50 ? 2e3 + short : 1900 + short;
  return utc(year, month, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0), 0, offsetMinutes(m[7]));
}
function parseDate(value) {
  const trimmed = (value ?? "").trim();
  if (trimmed === "") return "";
  return fromRfc3339(trimmed) ?? fromRfc822(trimmed) ?? "";
}

// src/feed.ts
function hashId(title, publishedAt) {
  return `sha256:${createHash("sha256").update(`${title}
${publishedAt}`).digest("hex").slice(0, 16)}`;
}
function authorName(value) {
  const text = inlineText(value);
  return /^\S+@\S+\s*\((.+)\)$/.exec(text)?.[1]?.trim() ?? text;
}
function unique(values) {
  return [...new Set(values.map(oneLine).filter((value) => value !== ""))];
}
function finish(draft, feedTitle, feedUrl) {
  return {
    ...draft,
    id: draft.id || draft.url || hashId(draft.title, draft.publishedAt),
    summary: cut(draft.summary),
    categories: unique(draft.categories),
    feedTitle,
    feedUrl
  };
}
function texts(el, local, ns) {
  return elements(el, local, ns).map(textOf);
}
function alternate(el, ns) {
  const links = elements(el, "link", ns).filter((link) => {
    const rel = attr(link, "rel").trim().toLowerCase() || "alternate";
    return rel === "alternate" || rel === "http://www.iana.org/assignments/relation/alternate";
  });
  const best = links.find((link) => attr(link, "type").toLowerCase().startsWith("text/html")) ?? links[0];
  return best ? resolveUrl(attr(best, "href"), best.base) : "";
}
function linkText(el) {
  return el ? resolveUrl(oneLine(textOf(el)), el.base) : "";
}
function rssItem(item, core) {
  const guid = child(item, "guid", core);
  const guidText = oneLine(textOf(guid));
  const permalink = attr(guid, "isPermaLink").trim().toLowerCase() !== "false" && /^https?:\/\//i.test(guidText) ? resolveUrl(guidText, guid.base) : "";
  const description = textOf(child(item, "description", core));
  const group = child(item, "group", NS.media);
  const media = textOf(child(item, "description", NS.media) ?? child(group, "description", NS.media));
  const encoded = textOf(child(item, "encoded", NS.content));
  return {
    id: guidText,
    title: inlineText(textOf(child(item, "title", core))) || inlineText(textOf(child(item, "title", NS.media) ?? child(group, "title", NS.media))),
    url: linkText(child(item, "link", core)) || permalink || alternate(item, NS.atom),
    author: authorName(textOf(child(item, "author", core))) || inlineText(textOf(child(item, "creator", NS.dc))),
    publishedAt: parseDate(textOf(child(item, "pubDate", core))) || parseDate(textOf(child(item, "date", NS.dc))),
    updatedAt: parseDate(textOf(child(item, "updated", NS.atom))),
    summary: plainText(description || media || encoded),
    html: encoded || description,
    categories: [...texts(item, "category", core), ...texts(item, "subject", NS.dc)].map(inlineText)
  };
}
function rss2(root, source) {
  const core = root.ns;
  const channel = child(root, "channel", core);
  const title = inlineText(textOf(child(channel, "title", core)));
  const items = [...elements(channel, "item", core), ...elements(root, "item", core)];
  return {
    feed: {
      title,
      url: source.finalUrl,
      siteUrl: linkText(child(channel, "link", core)) || (channel ? alternate(channel, NS.atom) : ""),
      format: "rss2"
    },
    items: items.filter((item) => !item.truncated).map((item) => finish(rssItem(item, core), title, source.feedUrl))
  };
}
function rss1(root, source) {
  const channel = root.children.find((node) => isElement(node) && node.local === "channel");
  const core = channel?.ns ?? NS.rss1;
  const title = inlineText(textOf(child(channel, "title", core)));
  const items = elements(root, "item", core).filter((item) => !item.truncated);
  return {
    feed: { title, url: source.finalUrl, siteUrl: linkText(child(channel, "link", core)), format: "rss1" },
    items: items.map((item) => {
      const description = textOf(child(item, "description", core) ?? child(item, "description", NS.dc));
      const encoded = textOf(child(item, "encoded", NS.content));
      const draft = {
        id: attr(item, "about", NS.rdf).trim(),
        title: inlineText(textOf(child(item, "title", core))),
        url: linkText(child(item, "link", core)),
        author: inlineText(textOf(child(item, "creator", NS.dc))),
        publishedAt: parseDate(textOf(child(item, "date", NS.dc))),
        updatedAt: "",
        summary: plainText(description || encoded),
        html: encoded || description,
        categories: texts(item, "subject", NS.dc).map(inlineText)
      };
      return finish(draft, title, source.feedUrl);
    })
  };
}
function atomText(el) {
  if (!el || attr(el, "src") !== "") return { text: "", html: "" };
  const type = attr(el, "type").trim().toLowerCase() || "text";
  if (type === "xhtml" || type === "application/xhtml+xml") {
    const div = el.children.find(isElement);
    const markup = div ? innerXml(div) : textOf(el);
    return { text: plainText(markup), html: markup };
  }
  const value = textOf(el);
  if (type === "html" || type === "text/html") return { text: plainText(value), html: value };
  return { text: tidy(value), html: escapeHtml(value) };
}
function atomAuthors(el, core) {
  return elements(el, "author", core).map((author) => oneLine(textOf(child(author, "name", core)))).filter((name) => name !== "").join(", ");
}
function atom(root, source) {
  const core = root.ns;
  const title = atomText(child(root, "title", core)).text.replace(/\n/g, " ");
  const feedAuthor = atomAuthors(root, core);
  const entries = elements(root, "entry", core).filter((entry) => !entry.truncated);
  return {
    feed: { title, url: source.finalUrl, siteUrl: alternate(root, core), format: "atom" },
    items: entries.map((entry) => {
      const summary = atomText(child(entry, "summary", core));
      const content = atomText(child(entry, "content", core));
      const updated = parseDate(textOf(child(entry, "updated", core)));
      const draft = {
        id: oneLine(textOf(child(entry, "id", core))),
        title: atomText(child(entry, "title", core)).text.replace(/\n/g, " "),
        url: alternate(entry, core),
        author: atomAuthors(entry, core) || feedAuthor,
        publishedAt: parseDate(textOf(child(entry, "published", core))) || updated,
        updatedAt: updated,
        summary: summary.text || content.text,
        html: content.html || summary.html,
        categories: elements(entry, "category", core).map((category) => attr(category, "term"))
      };
      return finish(draft, title, source.feedUrl);
    })
  };
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function str(value) {
  return typeof value === "string" ? value.trim() : "";
}
function jsonAuthors(value) {
  const list = Array.isArray(value.authors) ? value.authors : [value.author];
  return list.filter(isRecord).map((author) => oneLine(str(author.name))).filter((name) => name !== "").join(", ");
}
function jsonFeed(body, source) {
  let data;
  try {
    data = JSON.parse(body);
  } catch (error) {
    throw new Error(`unparseable: ${error.message}`);
  }
  const title = oneLine(str(data.title));
  const feedAuthor = jsonAuthors(data);
  const items = (Array.isArray(data.items) ? data.items : []).filter(isRecord);
  return {
    feed: {
      title,
      url: source.finalUrl,
      siteUrl: resolveUrl(str(data.home_page_url), source.finalUrl),
      format: "json"
    },
    items: items.map((item) => {
      const html = str(item.content_html);
      const contentText = str(item.content_text);
      const draft = {
        id: typeof item.id === "string" || typeof item.id === "number" ? String(item.id).trim() : "",
        title: oneLine(str(item.title)),
        url: resolveUrl(str(item.url) || str(item.external_url), source.finalUrl),
        author: jsonAuthors(item) || feedAuthor,
        publishedAt: parseDate(str(item.date_published)),
        updatedAt: parseDate(str(item.date_modified)),
        summary: tidy(str(item.summary)) || tidy(contentText) || plainText(html),
        html: html || contentText && escapeHtml(contentText),
        categories: Array.isArray(item.tags) ? item.tags.filter((tag) => typeof tag === "string") : []
      };
      return finish(draft, title, source.feedUrl);
    })
  };
}
function isJsonFeed(body) {
  try {
    const data = JSON.parse(body);
    return isRecord(data) && (typeof data.version === "string" || Array.isArray(data.items));
  } catch {
    return false;
  }
}
function parseFeed(body, source) {
  const text = body.replace(/^﻿/, "").trimStart();
  if (text.startsWith("{")) return jsonFeed(text, source);
  const root = parseXml(text, source.finalUrl);
  if (!root) throw new Error("unparseable: no root element");
  const local = root.local.toLowerCase();
  if (local === "rss") return rss2(root, source);
  if (local === "rdf") return rss1(root, source);
  if (local === "feed") return atom(root, source);
  if (local === "html") {
    throw new Error(`not a feed (the body starts with "${/^[^\s>]{1,15}/.exec(text)[0]}"); try find feeds`);
  }
  throw new Error(`unparseable: root <${root.name}> is not rss, RDF or feed`);
}
function itemTime(item) {
  return item.publishedAt || item.updatedAt;
}
function newestFirst(items) {
  return [...items].sort((a, b) => {
    const at = itemTime(a);
    const bt = itemTime(b);
    if (at === bt) return 0;
    if (at === "") return 1;
    if (bt === "") return -1;
    return at < bt ? 1 : -1;
  });
}
function withinHours(items, hours, nowMs) {
  const floor = nowMs - hours * 36e5;
  return items.filter((item) => itemTime(item) !== "" && Date.parse(itemTime(item)) >= floor);
}

// src/http.ts
var FEED_ACCEPT = "application/rss+xml, application/atom+xml, application/feed+json, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5";
var PAGE_ACCEPT = `text/html, application/xhtml+xml, ${FEED_ACCEPT}`;
var TIMEOUT_MS = 2e4;
var MAX_BYTES = 5 * 1024 * 1024;
var MAX_IN_FLIGHT = 6;
var FeedError = class extends Error {
  constructor(url, reason) {
    super(`${url}: ${reason}`);
    this.url = url;
    this.reason = reason;
    this.name = "FeedError";
  }
  url;
  reason;
};
var SCHEME = /^[a-z][a-z0-9+.-]*:/i;
var HOST_PORT = /^[^:/?#]+:\d+(?:[/?#]|$)/;
function feedAddress(raw) {
  const trimmed = raw.trim();
  const withScheme = SCHEME.test(trimmed) && !HOST_PORT.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw new FeedError(trimmed, "not a valid address");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new FeedError(trimmed, "refused, only http and https feeds are read");
  }
  return url.href;
}
function feedList(value) {
  const parts = String(value ?? "").split(/[\r\n,]+/).map((part) => part.trim());
  return [...new Set(parts.filter((part) => part !== ""))];
}
function uniqueFeeds(raws) {
  const urls = /* @__PURE__ */ new Set();
  const invalid = [];
  for (const raw of raws) {
    try {
      urls.add(feedAddress(raw));
    } catch (error) {
      invalid.push(error);
    }
  }
  return { urls: [...urls], invalid };
}
function discard(res) {
  res.body?.cancel().catch(() => void 0);
}
async function readCapped(res, url) {
  if (Number(res.headers.get("content-length")) > MAX_BYTES) {
    discard(res);
    throw new FeedError(url, "larger than 5 MB");
  }
  const chunks = [];
  let total = 0;
  const reader = res.body?.getReader();
  for (; ; ) {
    const next = await reader?.read();
    if (!next || next.done) break;
    total += next.value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel().catch(() => void 0);
      throw new FeedError(url, "larger than 5 MB");
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}
function charset(bytes, contentType) {
  if (bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191) return "utf-8";
  if (bytes[0] === 255 && bytes[1] === 254) return "utf-16le";
  if (bytes[0] === 254 && bytes[1] === 255) return "utf-16be";
  const declared = /charset\s*=\s*["']?([^"';\s]+)/i.exec(contentType)?.[1];
  if (declared) return declared;
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  return /^\s*<\?xml[^>]*?\bencoding\s*=\s*["']([^"']+)["']/.exec(head)?.[1] ?? "utf-8";
}
function decoderFor(label) {
  try {
    return new TextDecoder(label);
  } catch {
    return new TextDecoder("utf-8");
  }
}
function decodeBody(bytes, contentType) {
  return decoderFor(charset(bytes, contentType)).decode(bytes).replace(/^﻿/, "");
}
function reasonOf(error, timeoutMs) {
  if (!(error instanceof Error)) return String(error);
  if (error.name === "TimeoutError" || error.name === "AbortError") return `timed out after ${timeoutMs / 1e3} s`;
  const cause = error.cause instanceof Error ? error.cause.message : "";
  return cause && cause !== error.message ? `${error.message} (${cause})` : error.message;
}
async function send(fetchImpl, url, options) {
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const conditional = Boolean(options.etag || options.lastModified);
  const headers = {
    accept: options.accept ?? FEED_ACCEPT,
    "user-agent": options.userAgent,
    ...options.etag && { "if-none-match": options.etag },
    ...options.lastModified && { "if-modified-since": options.lastModified }
  };
  try {
    const res = await fetchImpl(url, { headers, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 304 && conditional) {
      discard(res);
      return void 0;
    }
    if (!res.ok) {
      discard(res);
      throw new FeedError(url, `HTTP ${res.status}`);
    }
    const bytes = await readCapped(res, url);
    return {
      body: decodeBody(bytes, res.headers.get("content-type") ?? ""),
      url: res.url || url,
      etag: res.headers.get("etag") ?? "",
      lastModified: res.headers.get("last-modified") ?? ""
    };
  } catch (error) {
    if (error instanceof FeedError) throw error;
    throw new FeedError(url, reasonOf(error, timeoutMs));
  }
}
async function fetchBody(fetchImpl, url, options) {
  return await send(fetchImpl, url, options);
}
function fetchIfChanged(fetchImpl, url, options) {
  return send(fetchImpl, url, options);
}
function parseFetched(url, got) {
  try {
    return parseFeed(got.body, { feedUrl: url, finalUrl: got.url });
  } catch (error) {
    throw new FeedError(url, error.message);
  }
}
async function readFeedAt(fetchImpl, raw, options) {
  const url = feedAddress(raw);
  return parseFetched(url, await fetchBody(fetchImpl, url, options));
}
async function mapLimit(values, limit, fn) {
  const results = new Array(values.length);
  let next = 0;
  const worker = async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await fn(values[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return results;
}

// src/poll.ts
import { createHash as createHash2 } from "crypto";

// package.json
var package_default = {
  name: "@vornrun/connector-rss",
  version: "0.1.3",
  description: "Trigger workflows from new items in RSS, Atom and JSON Feed feeds, and read feeds or find the feeds a web page declares from a step.",
  type: "module",
  license: "MIT",
  author: "Javier Canizalez <javier-canizalez@outlook.com>",
  repository: {
    type: "git",
    url: "git+https://github.com/vorn-run/connectors.git",
    directory: "packages/rss"
  },
  keywords: [
    "vorn",
    "connector",
    "rss",
    "atom",
    "json-feed"
  ],
  bin: {
    "vorn-connector-rss": "dist/index.js"
  },
  main: "./dist/index.js",
  types: "./dist/index.d.ts",
  exports: {
    ".": {
      types: "./dist/index.d.ts",
      default: "./dist/index.js"
    }
  },
  files: [
    "dist",
    "README.md",
    "CHANGELOG.md"
  ],
  scripts: {
    build: "tsup",
    typecheck: "tsc --noEmit",
    test: "vitest run"
  },
  dependencies: {
    "@vornrun/connector-sdk": "^0.7.2"
  },
  devDependencies: {
    "@types/node": "^22.10.2",
    "@vitest/coverage-v8": "^4.1.10",
    tsup: "^8.5.1",
    typescript: "^6.0.3",
    vitest: "^4.1.10"
  },
  vorn: {
    category: "Social",
    keywords: [
      "rss",
      "atom",
      "json feed",
      "feeds",
      "news",
      "blogs",
      "syndication"
    ],
    auth: "Nothing to sign in to: feeds are public, so installing the connector is the whole setup.",
    packs: true
  }
};

// src/settings.ts
var DEFAULT_USER_AGENT = `vorn-connector-rss/${package_default.version} (+https://vorn.run)`;
var DEFAULT_LOOKBACK_HOURS = 24;
var MAX_LOOKBACK_HOURS = 8760;
function blank(value) {
  return value === void 0 || value === null || String(value).trim() === "";
}
function wholeNumber(value, name, min, max, fallback) {
  if (blank(value)) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be a whole number from ${min}${max === Infinity ? " up" : ` to ${max}`}`);
  }
  return parsed;
}
function optionalHours(value, name) {
  if (blank(value)) return void 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a number of hours above 0`);
  return parsed;
}
function lookbackHours(config) {
  return wholeNumber(config.lookbackHours, "lookbackHours", 1, MAX_LOOKBACK_HOURS, DEFAULT_LOOKBACK_HOURS);
}
function userAgentOf(config) {
  return config.userAgent?.trim() || DEFAULT_USER_AGENT;
}

// src/poll.ts
var SEEN_CAP = 1e3;
var HOUR_MS = 36e5;
function seenKey(id) {
  return createHash2("sha256").update(id).digest("hex").slice(0, 12);
}
function strings(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}
function readCursor(raw) {
  const states = /* @__PURE__ */ new Map();
  let parsed;
  try {
    parsed = JSON.parse(raw ?? "");
  } catch {
    return states;
  }
  if (parsed?.v !== 1 || typeof parsed.feeds !== "object" || parsed.feeds === null) return states;
  for (const [url, state] of Object.entries(parsed.feeds)) {
    if (typeof state !== "object" || state === null) continue;
    states.set(url, {
      t: typeof state.t === "string" ? state.t : "",
      ...typeof state.etag === "string" && { etag: state.etag },
      ...typeof state.lm === "string" && { lm: state.lm },
      seen: strings(state.seen)
    });
  }
  return states;
}
function writeCursor(states) {
  return JSON.stringify({ v: 1, feeds: Object.fromEntries(states) });
}
function selectNew(items, previous, floorMs) {
  const seen = new Set(previous?.seen);
  const t = previous?.t ?? "";
  const fired = /* @__PURE__ */ new Set();
  const fire = [];
  let newest = t;
  for (const item of items) {
    const at = itemTime(item);
    const key = seenKey(item.id);
    if (at > newest) newest = at;
    const fresh = previous === void 0 ? at !== "" && Date.parse(at) >= floorMs : at === "" ? !seen.has(key) : at > t || at === t && !seen.has(key);
    if (fresh && !fired.has(key)) {
      fired.add(key);
      fire.push(item);
    }
  }
  const keys = items.filter((item) => {
    const at = itemTime(item);
    return at === "" || at === newest;
  }).map((item) => seenKey(item.id));
  const carried = newest === t ? previous?.seen ?? [] : [];
  return { fire, state: { t: newest, seen: [.../* @__PURE__ */ new Set([...keys, ...carried])].slice(0, SEEN_CAP) } };
}
function oldestFirst(items) {
  return [...items].sort((a, b) => {
    const at = itemTime(a);
    const bt = itemTime(b);
    if (at === bt) return 0;
    if (at === "") return 1;
    if (bt === "") return -1;
    return at < bt ? -1 : 1;
  });
}
function toConnectorItem(item) {
  const at = itemTime(item);
  return {
    externalId: `${item.feedUrl} ${item.id}`,
    title: item.title || item.url || "Untitled item",
    ...item.url && { url: item.url },
    ...item.summary && { description: item.summary },
    ...item.author && { assignee: item.author },
    labels: item.categories,
    ...at && { updatedAt: at },
    data: { ...item }
  };
}
async function pollFeeds(ctx) {
  const raws = feedList(ctx.config.feeds);
  if (raws.length === 0) throw new Error("Add feed URLs to the connection's feeds");
  const hours = lookbackHours(ctx.config);
  const userAgent = userAgentOf(ctx.config);
  const previous = readCursor(ctx.cursor);
  const sinceMs = ctx.since === void 0 ? NaN : Date.parse(ctx.since);
  const floorMs = Number.isNaN(sinceMs) ? Date.parse(ctx.now()) - hours * HOUR_MS : sinceMs;
  const { urls, invalid } = uniqueFeeds(raws);
  const polled = await mapLimit(urls, MAX_IN_FLIGHT, async (url) => {
    const before = previous.get(url);
    try {
      const got = await fetchIfChanged(ctx.fetch, url, { userAgent, etag: before?.etag, lastModified: before?.lm });
      if (got === void 0) return { url, state: before, fire: [] };
      const { fire, state } = selectNew(parseFetched(url, got).items, before, floorMs);
      return {
        url,
        state: {
          t: state.t,
          ...got.etag && { etag: got.etag },
          ...got.lastModified && { lm: got.lastModified },
          seen: state.seen
        },
        fire
      };
    } catch (error) {
      return { url, state: before, fire: [], failure: error };
    }
  });
  const failures = [...invalid, ...polled.flatMap((result) => result.failure ? [result.failure] : [])];
  for (const failure of failures) process.stderr.write(`rss: ${failure.url}: ${failure.reason}
`);
  if (failures.length === urls.length + invalid.length) {
    throw new Error(`Every feed failed: ${failures.map((failure) => failure.message).join("; ")}`);
  }
  const next = /* @__PURE__ */ new Map();
  for (const result of polled) if (result.state) next.set(result.url, result.state);
  return {
    items: oldestFirst(polled.flatMap((result) => result.fire)).map(toConnectorItem),
    nextCursor: writeCursor(next),
    hasMore: false
  };
}

// src/save.ts
import { mkdir, rename, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { ActionArgumentError } from "@vornrun/connector-sdk";
function filePath(value) {
  const raw = String(value ?? "").trim();
  if (raw === "") throw new ActionArgumentError("path", "path is required");
  if (raw.startsWith("~/")) return path.join(os.homedir(), raw.slice(2));
  if (raw.startsWith("~") || !path.isAbsolute(raw)) {
    throw new ActionArgumentError("path", "path must be an absolute path or start with ~/");
  }
  return path.resolve(raw);
}
async function writeJsonAtomically(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}
`);
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

// src/connector.ts
var MAX_ITEMS = 100;
var DEFAULT_ITEMS = 20;
function keywordFilter(value) {
  const words = String(value ?? "").split(",").map((word) => word.trim()).filter((word) => word !== "");
  if (words.length === 0) return () => true;
  const patterns = words.map(
    (word) => new RegExp(`(?<![\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "iu")
  );
  return (item) => patterns.some((pattern) => pattern.test(item.title) || pattern.test(item.summary));
}
function dedupeByUrl(items) {
  const kept = /* @__PURE__ */ new Map();
  for (const item of items) {
    const key = item.url || `${item.feedUrl} ${item.id}`;
    const held = kept.get(key);
    if (!held || itemTime(item) > itemTime(held)) kept.set(key, item);
  }
  return [...kept.values()];
}
function asFeed(url, got) {
  if (got.body.trimStart().startsWith("{") && !isJsonFeed(got.body.trim())) return void 0;
  try {
    return parseFetched(url, got);
  } catch {
    return void 0;
  }
}
var SAMPLE_ITEM = {
  id: "tag:rssboard.org,2006:weblog.221",
  title: "How to Read an RSS Feed with Java Using XOM",
  url: "https://www.rssboard.org/news/221/read-rss-feed-java-using-xom",
  author: "Rogers Cadenhead",
  publishedAt: "2023-08-02T03:25:57.000Z",
  updatedAt: "",
  summary: "There are a lot of libraries for processing XML data with Java that can be used to read RSS feeds. One of the best is the open source library XOM created by the computer book author Elliotte Rusty Harold.",
  html: "<p>There are a lot of libraries for processing XML data with Java that can be used to read RSS feeds.</p>",
  categories: ["announcements,"],
  feedTitle: "RSS Advisory Board",
  feedUrl: "http://feeds.rssboard.org/rssboard"
};
var SINCE_HOURS_INPUT = {
  key: "sinceHours",
  label: "Within hours",
  type: "number",
  description: "Only items published within this many hours; items with no date are left out when set.",
  builderHint: "Match it to how often the workflow runs, such as 24 for a daily digest."
};
var ITEM_OUTPUT = {
  key: "items",
  description: "Items as { id, title, url, author, publishedAt, updatedAt, summary, html, categories, feedTitle, feedUrl }"
};
var READ_FEEDS_INPUTS = [
  {
    key: "urls",
    label: "Feed URLs",
    description: "Feed addresses, one per line or comma separated; the connection's feeds when empty.",
    builderHint: "Leave it empty to read the feeds the connection already polls."
  },
  SINCE_HOURS_INPUT,
  {
    key: "perFeed",
    label: "Items per feed",
    type: "number",
    description: `The newest items kept from each feed, a whole number from 1 to ${MAX_ITEMS}; ${DEFAULT_ITEMS} when empty.`
  },
  {
    key: "keywords",
    label: "Keywords",
    description: "Comma separated; an item passes when any one matches its title or summary as a whole word or phrase, ignoring case. Empty keeps everything.",
    builderHint: 'Whole words only: "AI" matches "AI agents" but not "said".'
  },
  {
    key: "minFeedsOk",
    label: "Feeds that must answer",
    type: "number",
    description: "The action fails, naming every failed feed, when fewer feeds than this answer; 1 when empty.",
    builderHint: "Set it to the number of feeds when every one of them has to be read."
  }
];
var FEEDS_ANSWERED_OUTPUTS = [
  { key: "count", type: "number", description: "How many items came back, in `items`" },
  { key: "feedsOk", type: "number", description: "How many feeds answered" },
  { key: "feedsFailed", description: "The feeds that did not answer, as [{ url, error }]" }
];
async function readMany(args, ctx) {
  const perFeed = wholeNumber(args.perFeed, "perFeed", 1, MAX_ITEMS, DEFAULT_ITEMS);
  const minFeedsOk = wholeNumber(args.minFeedsOk, "minFeedsOk", 0, Infinity, 1);
  const hours = optionalHours(args.sinceHours, "sinceHours");
  const matches = keywordFilter(args.keywords);
  const given = feedList(args.urls);
  const raws = given.length > 0 ? given : feedList(ctx.config.feeds);
  if (raws.length === 0) throw new Error("Give feed URLs in urls, or add them to the connection's feeds");
  const userAgent = userAgentOf(ctx.config);
  const nowMs = Date.parse(ctx.now());
  const { urls, invalid } = uniqueFeeds(raws);
  const read = await mapLimit(urls, MAX_IN_FLIGHT, async (url) => {
    try {
      return { items: (await readFeedAt(ctx.fetch, url, { userAgent })).items };
    } catch (error) {
      return { failure: error };
    }
  });
  const failures = [...invalid, ...read.flatMap((result) => result.failure ? [result.failure] : [])];
  const feedsFailed = failures.map((failure) => ({ url: failure.url, error: failure.reason }));
  const total = urls.length + invalid.length;
  const feedsOk = total - failures.length;
  if (feedsOk < minFeedsOk) {
    throw new Error(
      `${feedsOk} of ${total} feeds answered, fewer than minFeedsOk ${minFeedsOk}: ${failures.map((f) => f.message).join("; ")}`
    );
  }
  const picked = read.flatMap(({ items: items2 = [] }) => {
    const recent = hours === void 0 ? items2 : withinHours(items2, hours, nowMs);
    return newestFirst(recent.filter(matches)).slice(0, perFeed);
  });
  const items = newestFirst(dedupeByUrl(picked));
  return { items, count: items.length, feedsOk, feedsFailed };
}
var connector = defineConnector({
  id: "rss",
  name: "RSS",
  version: package_default.version,
  description: "Trigger workflows from new items in RSS, Atom and JSON Feed feeds, and read feeds or find the feeds a web page declares from a step.",
  icon: {
    viewBox: "0 0 24 24",
    paths: [
      "M5.5 16a2.5 2.5 0 1 1 0 5a2.5 2.5 0 1 1 0-5z",
      "M3 13a8 8 0 0 1 8 8h3A11 11 0 0 0 3 10z",
      "M3 6a15 15 0 0 1 15 15h3A18 18 0 0 0 3 3z"
    ]
  },
  auth: { rung: "none" },
  config: [
    {
      key: "feeds",
      label: "Feeds",
      env: "RSS_FEEDS",
      description: "Feed addresses, one per line or comma separated. The new-item trigger polls them, and Read feeds uses them when it is given none.",
      builderHint: "RSS, Atom or JSON Feed addresses rather than the site's page; Find feeds turns a page into its feed addresses. https:// is assumed when there is no scheme."
    },
    {
      key: "lookbackHours",
      label: "First poll looks back (hours)",
      env: "RSS_LOOKBACK_HOURS",
      default: String(DEFAULT_LOOKBACK_HOURS),
      description: "How far back the first poll of a feed reaches, a whole number of hours from 1 to 8760, so a new connection does not fire for the whole backlog.",
      builderHint: "Only the first poll of each feed reads it; later polls fire on whatever is newer than the last one."
    },
    {
      key: "userAgent",
      label: "User-Agent",
      env: "RSS_USER_AGENT",
      default: DEFAULT_USER_AGENT,
      description: "Sent with every request; some hosts refuse requests without one.",
      builderHint: "Leave the default unless a host asks for a contact address in it."
    }
  ],
  triggers: [
    {
      type: "newItem",
      label: "New item",
      description: "An item appears in any of the connection's feeds. The first poll of a feed fires only for items inside the look-back, an item with no date fires once, and an item dated before the newest one already seen never fires.",
      poll: pollFeeds,
      sample: [toConnectorItem(SAMPLE_ITEM)]
    }
  ],
  actions: [
    {
      type: "readFeed",
      label: "Read a feed",
      description: `The newest items of one RSS, Atom or JSON Feed feed, up to ${MAX_ITEMS}, newest first with dateless items last.`,
      idempotent: true,
      inputs: [
        {
          key: "url",
          label: "Feed URL",
          required: true,
          description: "The feed's address; https:// is assumed when there is no scheme.",
          builderHint: "A feed, not a web page; run Find feeds on a page to get its feed."
        },
        {
          key: "limit",
          label: "Items",
          type: "number",
          description: `How many of the newest items, a whole number from 1 to ${MAX_ITEMS}; ${DEFAULT_ITEMS} when empty.`
        },
        SINCE_HOURS_INPUT
      ],
      outputs: [
        { key: "feed", description: "The feed as { title, url, siteUrl, format }, format one of rss2, rss1, atom, json" },
        ITEM_OUTPUT,
        { key: "count", type: "number", description: "How many items came back, in `items`" }
      ],
      sample: { url: "https://www.rssboard.org/files/sample-rss-2.xml" },
      run: async (args, ctx) => {
        const limit = wholeNumber(args.limit, "limit", 1, MAX_ITEMS, DEFAULT_ITEMS);
        const hours = optionalHours(args.sinceHours, "sinceHours");
        const { feed, items } = await readFeedAt(ctx.fetch, String(args.url ?? ""), {
          userAgent: userAgentOf(ctx.config)
        });
        const recent = hours === void 0 ? items : withinHours(items, hours, Date.parse(ctx.now()));
        const kept = newestFirst(recent).slice(0, limit);
        return { feed, items: kept, count: kept.length };
      }
    },
    {
      type: "readFeeds",
      label: "Read feeds",
      description: "Items from several feeds at once, filtered by age and keywords, one copy per address, newest first. A feed that fails is listed with its reason and never loses the others' items.",
      idempotent: true,
      inputs: READ_FEEDS_INPUTS,
      outputs: [ITEM_OUTPUT, ...FEEDS_ANSWERED_OUTPUTS],
      sample: {
        urls: "https://www.rssboard.org/files/sample-rss-2.xml\nhttps://github.com/nodejs/node/releases.atom"
      },
      run: (args, ctx) => readMany(args, ctx)
    },
    {
      type: "saveFeeds",
      label: "Save feeds to a file",
      description: "Read feeds exactly as Read feeds does, then write the items to a JSON file instead of returning them, so a large read never has to pass through a template.",
      // Writing the same file again with a fresh read is safe to repeat.
      idempotent: true,
      inputs: [
        {
          key: "path",
          label: "File",
          required: true,
          description: "Where to write, as an absolute path or one starting with ~/; its folder is created when missing.",
          builderHint: "For example ~/digests/items.json; a relative path is refused, and an existing file is replaced."
        },
        ...READ_FEEDS_INPUTS
      ],
      outputs: [
        { key: "path", type: "string", description: "The absolute path written, holding { generatedAt, feedsOk, feedsFailed, count, items }" },
        ...FEEDS_ANSWERED_OUTPUTS
      ],
      run: async (args, ctx) => {
        const target = filePath(args.path);
        const { items, count, feedsOk, feedsFailed } = await readMany(args, ctx);
        await writeJsonAtomically(target, { generatedAt: ctx.now(), feedsOk, feedsFailed, count, items });
        return { path: target, count, feedsOk, feedsFailed };
      }
    },
    {
      type: "findFeeds",
      label: "Find feeds",
      description: 'The RSS, Atom and JSON Feed feeds a web page declares in its link rel="alternate" tags, as absolute addresses with their titles; the address itself when it already is a feed.',
      idempotent: true,
      inputs: [
        {
          key: "url",
          label: "Page URL",
          required: true,
          description: "A web page's address, or a feed's; https:// is assumed when there is no scheme.",
          builderHint: "A site's home page usually declares its feeds; a page that declares none returns an empty list."
        }
      ],
      outputs: [
        { key: "feeds", description: "The feeds found, as [{ url, title, type, format }]" },
        { key: "count", type: "number", description: "How many feeds were found" },
        { key: "isFeed", type: "boolean", description: "Whether the address given is itself a feed" }
      ],
      sample: { url: "https://www.rssboard.org/" },
      run: async (args, ctx) => {
        const url = feedAddress(String(args.url ?? ""));
        const got = await fetchBody(ctx.fetch, url, { userAgent: userAgentOf(ctx.config), accept: PAGE_ACCEPT });
        const parsed = asFeed(url, got);
        if (parsed) {
          const { title, format } = parsed.feed;
          return { feeds: [{ url, title, type: TYPE_OF_FORMAT[format], format }], count: 1, isFeed: true };
        }
        const feeds = discoverFeeds(got.body, got.url);
        return { feeds, count: feeds.length, isFeed: false };
      }
    }
  ]
});

// src/entry.ts
import { realpathSync } from "fs";
import { fileURLToPath } from "url";
import { serveConnector } from "@vornrun/connector-sdk";
function isEntryPoint(moduleUrl, argv = process.argv) {
  const invoked = argv[1];
  if (invoked === void 0) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(invoked);
  } catch {
    return false;
  }
}
async function serveIfEntryPoint(moduleUrl, serve = serveConnector) {
  if (!isEntryPoint(moduleUrl)) return false;
  await serve(connector);
  return true;
}

// src/index.ts
var index_default = connector;
await serveIfEntryPoint(import.meta.url);
export {
  connector,
  index_default as default
};
