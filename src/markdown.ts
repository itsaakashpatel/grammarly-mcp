/**
 * Markdown support for the optimizer.
 *
 * Grammarly scores prose, so the scorer receives plain text. The rewriter
 * receives markdown in which every structural part is a placeholder, so a
 * rewrite can change sentences but never headings, images, tables, code,
 * raw HTML or link targets. A rewrite that loses or repeats a placeholder
 * is rejected by the caller.
 */

const FRONT_MATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n/;
const PROTECTED_LINE = /^(#{1,6}\s|!\[|\||<)/;
const FENCE = /^(```|~~~)/;
const LINK_TARGET = /\]\(([^)\s]+(?:\s+"[^"]*")?)\)/g;

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

export interface ProtectedMarkdown {
  /** Markdown with placeholders, for the rewriter. */
  text: string;
  /** The original value of each placeholder. */
  values: Map<string, string>;
}

export interface RestoreResult {
  text: string;
  /** Placeholders that are missing or that occur more than once. */
  problems: string[];
}

/** Replaces structural lines and link targets with placeholders. */
export function protectMarkdown(body: string): ProtectedMarkdown {
  const values = new Map<string, string>();
  const out: string[] = [];
  const lines = body.split("\n");
  let fence: string[] | null = null;

  const keep = (value: string): string => {
    const token = `⟦KEEP:${values.size}⟧`;
    values.set(token, value);
    return token;
  };

  for (const line of lines) {
    if (fence) {
      fence.push(line);
      if (FENCE.test(line.trim())) {
        out.push(keep(fence.join("\n")));
        fence = null;
      }
      continue;
    }
    if (FENCE.test(line.trim())) {
      fence = [line];
      continue;
    }
    if (PROTECTED_LINE.test(line.trimStart())) {
      out.push(keep(line));
      continue;
    }
    out.push(
      line.replace(LINK_TARGET, (_, target: string) => {
        const token = `⟦LINK:${values.size}⟧`;
        values.set(token, target);
        return `](${token})`;
      }),
    );
  }

  // An unclosed fence is kept as it is.
  if (fence) {
    out.push(keep(fence.join("\n")));
  }

  return { text: out.join("\n"), values };
}

/** Puts the original values back. Reports every placeholder that is not present exactly once. */
export function restoreMarkdown(
  rewritten: string,
  values: Map<string, string>,
): RestoreResult {
  const problems: string[] = [];
  let text = rewritten;

  for (const [token, value] of values) {
    const count = text.split(token).length - 1;
    if (count !== 1) {
      problems.push(`${token} occurs ${count} times`);
      continue;
    }
    text = text.replace(token, () => value);
  }

  const stray = (text.match(/⟦(KEEP|LINK):\d+⟧/g) ?? []).filter(
    (token) => !values.has(token),
  );
  if (stray.length > 0) {
    problems.push(`unknown placeholders: ${stray.join(", ")}`);
  }

  return { text, problems };
}

/** Converts a markdown body to the prose that Grammarly should score. */
export function markdownToPlainText(body: string): string {
  const out: string[] = [];
  let inFence = false;
  // A wrapped line continues the paragraph above it, so Grammarly sees whole sentences.
  let canContinue = false;

  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (FENCE.test(line)) {
      inFence = !inFence;
      canContinue = false;
      continue;
    }
    if (inFence || line.startsWith("![") || line.startsWith("|")) {
      canContinue = false;
      continue;
    }
    if (line === "") {
      out.push("");
      canContinue = false;
      continue;
    }

    const startsBlock = /^(#{1,6}\s|>|[-*+]\s|\d+\.\s)/.test(line);
    const isHeading = /^#{1,6}\s/.test(line);
    const text = line
      .replace(/<[^>]+>/g, "")
      .replace(/^#{1,6}\s+/, "")
      .replace(/^>\s?/, "")
      .replace(/^([-*+]|\d+\.)\s+/, "")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/(\*\*|__)(.+?)\1/g, "$2")
      .replace(/(\*|_)(.+?)\1/g, "$2")
      .replace(/`([^`]*)`/g, "$1")
      .trim();

    if (canContinue && !startsBlock && out.length > 0) {
      out[out.length - 1] = `${out[out.length - 1]} ${text}`;
    } else {
      out.push(text);
    }
    canContinue = !isHeading;
  }

  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Instruction appended to the rewrite prompt when placeholders are present. */
export const PLACEHOLDER_INSTRUCTIONS =
  "The text is markdown. Tokens such as ⟦KEEP:3⟧ stand for headings, images, tables and code, " +
  "and tokens such as ⟦LINK:7⟧ stand for link targets. Copy every token exactly once, unchanged, " +
  "in the same place relative to the text around it. Keep each ⟦KEEP:n⟧ token on its own line. " +
  "Keep the markdown link syntax [anchor text](⟦LINK:n⟧), list markers, bold and italics. " +
  "A rewrite that drops, changes or repeats a token is rejected.";
