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
});

describe("protectMarkdown and restoreMarkdown", () => {
	const body = [
		"Intro with a [link](/a/b) and [another](https://x.test \"t\").",
		"## Heading",
		"![Alt.](img:k/v?1x1)",
		"| a | b |",
		"| - | - |",
		"```js",
		"const x = 1;",
		"```",
		"<aside>raw</aside>",
		"- A list item",
	].join("\n");

	it("replaces structure and link targets with placeholders", () => {
		const { text, values } = protectMarkdown(body);
		expect(text).not.toContain("## Heading");
		expect(text).not.toContain("/a/b");
		expect(text).not.toContain("const x");
		expect(text).toContain("[link](⟦LINK:");
		expect(text).toContain("- A list item");
		// 2 links, heading, image, 2 table rows, 1 code block, 1 HTML line
		expect(values.size).toBe(8);
	});

	it("round-trips to the original text", () => {
		const { text, values } = protectMarkdown(body);
		expect(restoreMarkdown(text, values)).toEqual({ text: body, problems: [] });
	});

	it("reports a missing placeholder", () => {
		const { text, values } = protectMarkdown(body);
		const result = restoreMarkdown(text.replace("⟦KEEP:2⟧", ""), values);
		expect(result.problems).toEqual(["⟦KEEP:2⟧ occurs 0 times"]);
	});

	it("reports a repeated placeholder", () => {
		const { text, values } = protectMarkdown(body);
		const result = restoreMarkdown(`${text}\n⟦LINK:0⟧`, values);
		expect(result.problems).toEqual(["⟦LINK:0⟧ occurs 2 times"]);
	});

	it("reports an invented placeholder", () => {
		const { text, values } = protectMarkdown(body);
		const result = restoreMarkdown(`${text}\n⟦KEEP:99⟧`, values);
		expect(result.problems).toEqual(["unknown placeholders: ⟦KEEP:99⟧"]);
	});

	it("restores a value that contains a dollar sign literally", () => {
		const { text, values } = protectMarkdown("Price [here]($1-and-$&).");
		expect(restoreMarkdown(text, values).text).toBe("Price [here]($1-and-$&).");
	});
});

describe("markdownToPlainText", () => {
	it("keeps the prose and drops markup, images, tables and code", () => {
		const plain = markdownToPlainText(
			[
				"## A **bold** heading",
				"",
				"Read the [guide](/g) and use `code` _here_.",
				"![Alt.](img:k)",
				"| a | b |",
				"```",
				"hidden",
				"```",
				"> A quote",
				"1. First step",
			].join("\n"),
		);
		expect(plain).toBe(
			"A bold heading\n\nRead the guide and use code here.\nA quote\nFirst step",
		);
	});

	it("joins wrapped lines into one paragraph line", () => {
		const plain = markdownToPlainText(
			["A sentence that wraps", "onto a second line.", "", "- An item that wraps", "  onto two lines.", "- Next item"].join("\n"),
		);
		expect(plain).toBe(
			"A sentence that wraps onto a second line.\n\nAn item that wraps onto two lines.\nNext item",
		);
	});
});
