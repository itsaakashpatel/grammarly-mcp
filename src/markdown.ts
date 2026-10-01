/**
 * Markdown support for the optimizer.
 *
 * Grammarly scores prose, so the scorer receives plain text. The rewriter
 * receives markdown in which every structural part is a placeholder, so a
 * rewrite can change sentences but never headings, images, tables, code,
 * raw HTML, reference definitions or link targets. The caller rejects a
 * rewrite that loses, repeats, invents, reorders or moves a placeholder.
 */

const FRONT_MATTER = /^﻿?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;
const PROTECTED_LINE = /^(#{1,6}\s|!\[|\||<|\[[^\]]+\]:\s)/;
const FENCE_OPEN = /^(`{3,}|~{3,})/;
// [text](target "title"): one level of parentheses inside the target, or <target>.
const LINK_TARGET =
  /\]\((<[^>\n]*>|(?:[^()\s]|\([^()\s]*\))+)((?:\s+(?:"[^"]*"|'[^']*'))?)\)/g;
const AUTOLINK = /<https?:\/\/[^>\s]+>/g;
const BARE_URL = /https?:\/\/[^\s<>()]+(?:\([^\s<>()]*\)[^\s<>()]*)*/g;
const TOKEN = /⟦(KEEP|LINK):\d+⟧/g;

export interface SplitDocument {
  frontMatter: string;
  body: string;
}

/** Separates YAML front matter from the body. The rewriter never sees the front matter. */
export function splitFrontMatter(text: string): SplitDocument {
  const match = FRONT_MATTER.exec(text);
  if (!match) {
    return { frontMatter: "", body: text };
  }
  return { frontMatter: match[0], body: text.slice(match[0].length) };
}

interface KeepContext {
  blankBefore: boolean;
  blankAfter: boolean;
}

export interface ProtectedMarkdown {
  /** Markdown with placeholders, for the rewriter. */
  text: string;
  /** The original value of each placeholder, in document order. */
  values: Map<string, string>;
  /** Whether a blank line (or the edge of the text) surrounds each KEEP token. */
  keepContext: Map<string, KeepContext>;
  /** The whitespace at the end of the original body. */
  trailing: string;
}

export interface RestoreResult {
  text: string;
  /** Every reason the rewrite cannot be accepted. Empty when it is safe. */
  problems: string[];
}

/** Returns the closing test for a fence line, or null when the line opens no fence. */
function fenceCloser(line: string): ((candidate: string) => boolean) | null {
  const open = FENCE_OPEN.exec(line.trim());
  if (!open?.[1]) {
    return null;
  }
  const marker = open[1];
  const char = marker[0] === "`" ? "`" : "~";
  const close = new RegExp(`^\\${char}{${marker.length},}\\s*$`);
  return (candidate) => close.test(candidate.trim());
}

/** Replaces structural lines and link targets with placeholders. */
export function protectMarkdown(input: string): ProtectedMarkdown {
  const body = input.replace(/\r\n/g, "\n");
  const trailing = /\s*$/.exec(body)?.[0] ?? "";
  const lines = body.slice(0, body.length - trailing.length).split("\n");
  const values = new Map<string, string>();
  const out: string[] = [];
  // Consecutive protected lines become one token, so a table stays one block.
  let pending: string[] = [];

  const flush = () => {
    if (pending.length > 0) {
      const token = `⟦KEEP:${values.size}⟧`;
      values.set(token, pending.join("\n"));
      out.push(token);
      pending = [];
    }
  };
  const link = (value: string): string => {
    const token = `⟦LINK:${values.size}⟧`;
    values.set(token, value);
    return token;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const trimmed = line.trimStart();

    const closes = fenceCloser(line);
    if (closes) {
      pending.push(line);
      for (i += 1; i < lines.length; i += 1) {
        const inner = lines[i] ?? "";
        pending.push(inner);
        if (closes(inner)) {
          break;
        }
      }
      continue;
    }
    if (trimmed.startsWith("<!--") && !trimmed.includes("-->")) {
      pending.push(line);
      for (i += 1; i < lines.length; i += 1) {
        const inner = lines[i] ?? "";
        pending.push(inner);
        if (inner.includes("-->")) {
          break;
        }
      }
      continue;
    }
    if (PROTECTED_LINE.test(trimmed)) {
      pending.push(line);
      continue;
    }

    flush();
    out.push(
      line
        .replace(
          LINK_TARGET,
          (_, target: string, title: string) => `](${link(target + title)})`,
        )
        .replace(AUTOLINK, (value) => link(value))
        .replace(BARE_URL, (value) => link(value)),
    );
  }
  flush();

  const keepContext = new Map<string, KeepContext>();
  out.forEach((line, index) => {
    if (line.startsWith("⟦KEEP:")) {
      keepContext.set(line, {
        blankBefore: index === 0 || out[index - 1]?.trim() === "",
        blankAfter: index === out.length - 1 || out[index + 1]?.trim() === "",
      });
    }
  });

  return { text: out.join("\n"), values, keepContext, trailing };
}

/**
 * Puts the original values back. The rewrite is safe only when every token
 * occurs exactly once, in the original order, and every KEEP token stands on
 * its own line with the same blank lines around it.
 */
export function restoreMarkdown(
  rewritten: string,
  locked: ProtectedMarkdown,
): RestoreResult {
  const { values, keepContext, trailing } = locked;
  const problems: string[] = [];
  const text = rewritten.replace(/\r\n/g, "\n").replace(/\s*$/, "");

  const found = text.match(TOKEN) ?? [];
  const unknown = found.filter((token) => !values.has(token));
  if (unknown.length > 0) {
    problems.push(`unknown placeholders: ${unknown.join(", ")}`);
  }
  for (const token of values.keys()) {
    const count = found.filter((item) => item === token).length;
    if (count !== 1) {
      problems.push(`${token} occurs ${count} times`);
    }
  }
  if (problems.length === 0) {
    const expected = [...values.keys()];
    if (found.join() !== expected.join()) {
      problems.push("placeholders are out of order");
    }
  }

  const lines = text.split("\n");
  for (const [token, context] of keepContext) {
    const index = lines.indexOf(token);
    if (index === -1) {
      if (text.includes(token)) {
        problems.push(`${token} is not on its own line`);
      }
      continue;
    }
    const blankBefore = index === 0 || lines[index - 1]?.trim() === "";
    const blankAfter =
      index === lines.length - 1 || lines[index + 1]?.trim() === "";
    if (
      blankBefore !== context.blankBefore ||
      blankAfter !== context.blankAfter
    ) {
      problems.push(`${token} lost or gained a blank line around it`);
    }
  }

  if (problems.length > 0) {
    return { text: rewritten, problems };
  }

  const restored = text.replace(TOKEN, (token) => values.get(token) ?? token);
  return { text: `${restored}${trailing}`, problems };
}

const stripInline = (text: string): string =>
  text
    .replace(/<[^>]+>/g, "")
    .replace(/!\[[^\]]*\]\((?:[^()]|\([^()]*\))*\)/g, "")
    .replace(/\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/(?<!\w)_(.+?)_(?!\w)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

/** Converts a markdown body to the prose that Grammarly should score. */
export function markdownToPlainText(input: string): string {
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  // Each block is one paragraph, list item, quote or heading, joined before
  // the markup goes, so wrapped emphasis and links are removed whole.
  const blocks: string[] = [];
  let current: { kind: "para" | "quote" | "heading"; parts: string[] } | null =
    null;

  const end = () => {
    if (current) {
      blocks.push(stripInline(current.parts.join(" ")));
      current = null;
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? "";
    const line = raw.trim();

    const closes = fenceCloser(raw);
    if (closes) {
      end();
      // Skip the code block up to and including its closing fence.
      i += 1;
      while (i < lines.length && !closes(lines[i] ?? "")) {
        i += 1;
      }
      continue;
    }
    if (line === "") {
      end();
      if (blocks.at(-1) !== "") {
        blocks.push("");
      }
      continue;
    }
    if (/^(!\[|\||\[[^\]]+\]:\s|<!--)/.test(line)) {
      end();
      continue;
    }

    if (/^#{1,6}\s/.test(line)) {
      end();
      blocks.push(stripInline(line.replace(/^#{1,6}\s+/, "")));
      continue;
    }
    if (line.startsWith(">")) {
      const text = line.replace(/^>\s?/, "");
      if (current?.kind === "quote") {
        current.parts.push(text);
      } else {
        end();
        current = { kind: "quote", parts: [text] };
      }
      continue;
    }
    if (/^([-*+]|\d+\.)\s/.test(line)) {
      end();
      current = {
        kind: "para",
        parts: [line.replace(/^([-*+]|\d+\.)\s+/, "")],
      };
      continue;
    }
    if (current) {
      current.parts.push(line);
    } else {
      current = { kind: "para", parts: [line] };
    }
  }
  end();

  return blocks
    .filter((block, index) => block !== "" || blocks[index - 1] !== "")
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Instruction appended to the rewrite prompt when placeholders are present. */
export const PLACEHOLDER_INSTRUCTIONS =
  "The text is markdown. Tokens such as ⟦KEEP:3⟧ stand for headings, images, tables and code, " +
  "and tokens such as ⟦LINK:7⟧ stand for link targets and URLs. Copy every token exactly once, " +
  "unchanged, in the same order and in the same place relative to the text around it. Keep each " +
  "⟦KEEP:n⟧ token alone on its own line, with the same blank lines before and after it. Keep the " +
  "markdown link syntax [anchor text](⟦LINK:n⟧), list markers, bold and italics. A rewrite that " +
  "drops, changes, repeats, reorders or moves a token is rejected.";
