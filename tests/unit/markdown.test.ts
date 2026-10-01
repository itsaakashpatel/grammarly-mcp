import { describe, expect, it } from "vitest";
import {
	markdownToPlainText,
	protectMarkdown,
	restoreMarkdown,
	splitFrontMatter,
} from "../../src/markdown";

describe("splitFrontMatter", () => {
	it("separates YAML front matter from the body", () => {
		const { frontMatter, body } = splitFrontMatter("---\ntitle: x\n---\n\nBody.");
		expect(frontMatter).toBe("---\ntitle: x\n---\n");
		expect(body).toBe("\nBody.");
	});

	it("returns the whole text as body when there is no front matter", () => {
		expect(splitFrontMatter("Just text.")).toEqual({ frontMatter: "", body: "Just text." });
	});

	it("accepts a byte order mark and a missing final newline", () => {
		expect(splitFrontMatter("﻿---\ntitle: x\n---\nBody.").body).toBe("Body.");
		expect(splitFrontMatter("---\ntitle: x\n---").body).toBe("");
	});
});

describe("protectMarkdown and restoreMarkdown", () => {
	const body = [
		'Intro with a [link](/a/b) and [another](https://x.test "t").',
		"",
		"## Heading",
		"",
		"![Alt.](img:k/v?1x1)",
		"",
		"| a | b |",
		"| - | - |",
		"| 1 | 2 |",
		"",
		"```js",
		"const x = 1;",
		"```",
		"",
		"- A list item",
		"",
	].join("\n");

	it("replaces structure and link targets with placeholders", () => {
		const { text, values } = protectMarkdown(body);
		expect(text).not.toContain("## Heading");
		expect(text).not.toContain("/a/b");
		expect(text).not.toContain("const x");
		expect(text).toContain("[link](⟦LINK:0⟧)");
		expect(text).toContain("- A list item");
		// 2 links, heading, image, one token for the whole table, one for the code block
		expect(values.size).toBe(6);
	});

	it("round-trips to the original text, final newline included", () => {
		const locked = protectMarkdown(body);
		expect(restoreMarkdown(locked.text, locked)).toEqual({ text: body, problems: [] });
	});

	it("restores the final newline when the rewrite drops it", () => {
		const locked = protectMarkdown("One line.\n");
		expect(restoreMarkdown("One line, rewritten.", locked).text).toBe("One line, rewritten.\n");
	});

	it("converts CRLF to LF", () => {
		const locked = protectMarkdown("## H\r\n\r\nText.\r\n");
		expect(restoreMarkdown(locked.text, locked).text).toBe("## H\n\nText.\n");
	});

	it("reports a missing placeholder", () => {
		const locked = protectMarkdown(body);
		const result = restoreMarkdown(locked.text.replace("⟦KEEP:2⟧", ""), locked);
		expect(result.problems).toContain("⟦KEEP:2⟧ occurs 0 times");
	});

	it("reports a repeated placeholder once", () => {
		const locked = protectMarkdown(body);
		const result = restoreMarkdown(`${locked.text}\n\n[x](⟦LINK:0⟧)`, locked);
		expect(result.problems).toEqual(["⟦LINK:0⟧ occurs 2 times"]);
	});

	it("reports an invented placeholder", () => {
		const locked = protectMarkdown(body);
		const result = restoreMarkdown(`${locked.text}\n\n⟦KEEP:99⟧`, locked);
		expect(result.problems[0]).toBe("unknown placeholders: ⟦KEEP:99⟧");
	});

	it("rejects swapped link targets", () => {
		const locked = protectMarkdown("[a](/one) and [b](/two).");
		const swapped = locked.text.replace("⟦LINK:0⟧", "#").replace("⟦LINK:1⟧", "⟦LINK:0⟧").replace("#", "⟦LINK:1⟧");
		expect(restoreMarkdown(swapped, locked).problems).toEqual(["placeholders are out of order"]);
	});

	it("rejects a KEEP token moved into a paragraph", () => {
		const locked = protectMarkdown("Para one.\n\n## Heading\n\nPara two.");
		const moved = "Para one ⟦KEEP:0⟧ now.\n\nPara two.";
		expect(restoreMarkdown(moved, locked).problems).toContain("⟦KEEP:0⟧ is not on its own line");
	});

	it("rejects a KEEP token that loses its blank line", () => {
		const locked = protectMarkdown("Para one.\n\n![Alt.](img:k)\n\nPara two.");
		const glued = "Para one.\n⟦KEEP:0⟧\n\nPara two.";
		expect(restoreMarkdown(glued, locked).problems).toContain(
			"⟦KEEP:0⟧ lost or gained a blank line around it",
		);
	});

	it("keeps a whole table in one token, so its rows cannot separate", () => {
		const locked = protectMarkdown("Text.\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nMore.");
		expect(locked.text).toBe("Text.\n\n⟦KEEP:0⟧\n\nMore.");
	});

	it("protects a URL that contains parentheses", () => {
		const source = "See [w](https://en.wikipedia.org/wiki/Stuttering_(disorder)) here.";
		const locked = protectMarkdown(source);
		expect(locked.text).toBe("See [w](⟦LINK:0⟧) here.");
		expect(restoreMarkdown(locked.text, locked).text).toBe(source);
	});

	it("protects single-quoted titles, angle targets, autolinks, bare URLs and reference definitions", () => {
		const source = [
			"A [t](/x 'T') and [u](<a b>) and <https://auto.test> and https://bare.test/p.",
			"",
			"A [ref][1] link.",
			"",
			"[1]: https://ref.test",
		].join("\n");
		const locked = protectMarkdown(source);
		expect(locked.text).not.toMatch(/\/x|a b|auto\.test|bare\.test|ref\.test/);
		expect(restoreMarkdown(locked.text, locked).text).toBe(source);
	});

	it("closes a four-backtick fence only at a matching fence", () => {
		const source = "````md\n```\ninner\n```\n````\n\nProse.";
		const locked = protectMarkdown(source);
		expect(locked.text).toBe("⟦KEEP:0⟧\n\nProse.");
	});

	it("protects a multi-line HTML comment", () => {
		const locked = protectMarkdown("<!--\nnote to self\n-->\n\nProse.");
		expect(locked.text).toBe("⟦KEEP:0⟧\n\nProse.");
	});

	it("restores a value that contains a dollar sign literally", () => {
		const locked = protectMarkdown("Price [here]($1-and-$&).");
		expect(restoreMarkdown(locked.text, locked).text).toBe("Price [here]($1-and-$&).");
	});
});

describe("markdownToPlainText", () => {
	it("keeps the prose and drops markup, images, tables and code", () => {
		const plain = markdownToPlainText(
			[
				"## A **bold** heading",
				"",
				"Read the [guide](/g) and use `code` _here_.",
				"",
				"![Alt.](img:k)",
				"",
				"| a | b |",
				"",
				"```",
				"hidden",
				"```",
				"",
				"> A quote",
				"",
				"1. First step",
			].join("\n"),
		);
		expect(plain).toBe("A bold heading\n\nRead the guide and use code here.\n\nA quote\n\nFirst step");
	});

	it("joins wrapped lines, list items and quotes into whole lines", () => {
		const plain = markdownToPlainText(
			[
				"A sentence that wraps",
				"onto a second line.",
				"",
				"- An item that wraps",
				"  onto two lines.",
				"- Next item",
				"",
				'> _"Good morning, I',
				"> stutter, so give me",
				'> a moment."_',
			].join("\n"),
		);
		expect(plain).toBe(
			'A sentence that wraps onto a second line.\n\nAn item that wraps onto two lines.\nNext item\n\n"Good morning, I stutter, so give me a moment."',
		);
	});

	it("removes bold and links that wrap across lines", () => {
		const plain = markdownToPlainText("**Are you choosing, or is\nthe reflex choosing?** Read [how easy\nonset works](/t/e).");
		expect(plain).toBe("Are you choosing, or is the reflex choosing? Read how easy onset works.");
	});

	it("keeps underscores inside words", () => {
		expect(markdownToPlainText("Use snake_case and file_name.")).toBe("Use snake_case and file_name.");
	});
});
