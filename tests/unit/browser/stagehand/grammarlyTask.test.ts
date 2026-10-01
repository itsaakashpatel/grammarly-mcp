import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/config", () => ({
	log: vi.fn(),
}));

// Run every sleep at once, so the polling loops finish immediately.
vi.stubGlobal(
	"setTimeout",
	vi.fn((cb: () => void) => {
		cb();
		return 0 as unknown as NodeJS.Timeout;
	})
);

import type { Stagehand } from "@browserbasehq/stagehand";
import {
	cleanupGrammarlyDocument,
	countWords,
	parseScores,
	parseSuggestionCount,
	parseWordCount,
	runStagehandGrammarlyTask,
} from "../../../../src/browser/stagehand/grammarlyTask";

// Panel text copied from a real Grammarly session (September 2026).
const SUGGESTIONS_PANEL =
	"Review suggestions\nCheck for AI\ntext & plagiarism\nGrammarly Assistant\nReview suggestions\n16\nCorrectness\nClarity\nEngagement\nDelivery\nStyle guide\nCorrectness · Correct the verb\nIt was released in 2021 and…\nAccept";
const CHECKING_PANEL =
	"Review suggestions\nCheck for AI\ntext & plagiarism\nGrammarly Assistant\nChecking for plagiarism and AI text...\nWe’re comparing your document to billions of web pages and academic papers, and detecting patterns often used by AI.";
const RESULT_PANEL =
	"Review suggestions\nCheck for AI\ntext & plagiarism\nGrammarly Assistant\nPlagiarism and AI text check\nAPA\nThis section resembles AI text\nWe didn’t detect plagiarism\nYour document doesn’t match anything in our references\n37% of your text has patterns that resemble AI text\nThese patterns may show AI text or occur in your writing";
const EMPTY_DOC_PANEL =
	"Review suggestions\nCheck for AI\ntext & plagiarism\nGrammarly Assistant\nNo plagiarism or AI text detected\nYour document doesn’t match anything in our references or contain common AI text patterns.";

interface FakeGrammarly {
	editorText: string;
	aiTabOpen: boolean;
	checkPolls: number;
	/** Words Grammarly reports; defaults to the real count of the editor text. */
	wordCountOverride?: number;
	/** When false, the paste event is dispatched but Grammarly ignores it. */
	pasteRegisters: boolean;
	resultPanel: string;
	checkingPollsBeforeResult: number;
}

let fake: FakeGrammarly;

function pageText(): string {
	const words = fake.wordCountOverride ?? countWords(fake.editorText);
	let panel = SUGGESTIONS_PANEL;
	if (fake.aiTabOpen) {
		fake.checkPolls += 1;
		panel = fake.checkPolls <= fake.checkingPollsBeforeResult ? CHECKING_PANEL : fake.resultPanel;
	}
	// The real page puts the document before the counter and the panels.
	return `${fake.editorText}Saved\nGoals\n--\nOverall score\n${words} words\n${panel}`;
}

const mockEvaluate = vi.fn(async (_fn: unknown, arg?: unknown) => {
	if (arg && typeof arg === "object" && "value" in arg) {
		if (fake.pasteRegisters) {
			fake.editorText = (arg as { value: string }).value;
		}
		return true;
	}
	return { pageText: pageText(), editorText: fake.editorText };
});

const mockObserve = vi.fn();
const mockAct = vi.fn();
const mockExtract = vi.fn();
const mockGoto = vi.fn();

function createStagehand(url = "https://app.grammarly.com") {
	const page = {
		url: vi.fn().mockReturnValue(url),
		goto: mockGoto,
		evaluate: mockEvaluate,
		waitForLoadState: vi.fn().mockResolvedValue(undefined),
	};
	return {
		context: { pages: vi.fn().mockReturnValue([page]) },
		observe: mockObserve,
		act: mockAct,
		extract: mockExtract,
	} as unknown as Stagehand;
}

const ARTICLE = "Speaking on the phone feels hard.\n\nCalls take away the face you would read. ".repeat(20);

beforeEach(() => {
	vi.clearAllMocks();
	fake = {
		editorText: "",
		aiTabOpen: false,
		checkPolls: 0,
		pasteRegisters: true,
		resultPanel: RESULT_PANEL,
		checkingPollsBeforeResult: 2,
	};
	mockGoto.mockResolvedValue(undefined);
	mockObserve.mockImplementation(async (instruction: string) =>
		/AI text and plagiarism/i.test(instruction)
			? [{ description: "Tab to check for AI text & plagiarism" }]
			: [{ description: "New document button" }]
	);
	mockAct.mockImplementation(async (action: unknown) => {
		const label = typeof action === "string" ? action : (action as { description: string }).description;
		if (/AI text/i.test(label)) {
			fake.aiTabOpen = true;
		}
	});
	mockExtract.mockImplementation(async (instruction: string) =>
		instruction.includes("suggestions sidebar")
			? {
					suggestionCount: 16,
					suggestions: [{ category: "Correctness", original: "released", suggestion: "was released" }],
				}
			: { aiDetectionPercent: 99, plagiarismPercent: 99, notes: "LLM reader" }
	);
});

describe("parsers", () => {
	it("counts words like Grammarly", () => {
		expect(countWords("  One two\n\nthree  ")).toBe(3);
		expect(countWords("   ")).toBe(0);
	});

	it("reads the word counter", () => {
		expect(parseWordCount("Overall score\n684 words\n")).toBe(684);
		expect(parseWordCount("Overall score\n1,204 words")).toBe(1204);
		expect(parseWordCount("Overall score\n--")).toBeNull();
	});

	it("reads the suggestion total", () => {
		expect(parseSuggestionCount(SUGGESTIONS_PANEL)).toBe(16);
		expect(parseSuggestionCount(RESULT_PANEL)).toBeNull();
	});

	it("reads the real result panel", () => {
		expect(parseScores(RESULT_PANEL)).toEqual({
			aiDetectionPercent: 37,
			plagiarismPercent: 0,
			checking: false,
		});
	});

	it("reports the checking state with no scores", () => {
		expect(parseScores(CHECKING_PANEL)).toEqual({
			aiDetectionPercent: null,
			plagiarismPercent: null,
			checking: true,
		});
	});

	it("reads the all-clear message as zero for both", () => {
		expect(parseScores(EMPTY_DOC_PANEL)).toMatchObject({ aiDetectionPercent: 0, plagiarismPercent: 0 });
	});

	it("reads a plagiarism percentage", () => {
		const panel = "12% of your text matches existing sources\n40% of your text has patterns that resemble AI text";
		expect(parseScores(panel)).toMatchObject({ aiDetectionPercent: 40, plagiarismPercent: 12 });
	});

	it("never turns unrelated text into a score", () => {
		expect(parseScores("Grammarly Assistant\nAll the world's a page.")).toMatchObject({
			aiDetectionPercent: null,
			plagiarismPercent: null,
		});
	});
});

describe("runStagehandGrammarlyTask", () => {
	it("throws when no page is available", async () => {
		const stagehand = { context: { pages: () => [] } } as unknown as Stagehand;
		await expect(runStagehandGrammarlyTask(stagehand, "Text")).rejects.toThrow("No page available");
	});

	it("navigates to Grammarly when not already there", async () => {
		await runStagehandGrammarlyTask(createStagehand("https://other.test"), ARTICLE);
		expect(mockGoto).toHaveBeenCalledWith("https://app.grammarly.com", expect.anything());
	});

	it("skips navigation when already on Grammarly", async () => {
		await runStagehandGrammarlyTask(createStagehand(), ARTICLE);
		expect(mockGoto).not.toHaveBeenCalled();
	});

	it("pastes the full text into the editor with a paste event", async () => {
		const longText = "word ".repeat(4000);
		await runStagehandGrammarlyTask(createStagehand(), longText);
		const pasteCall = mockEvaluate.mock.calls.find(([, arg]) => arg && typeof arg === "object" && "value" in arg);
		expect((pasteCall?.[1] as { value: string; selector: string }).value).toBe(longText);
		expect((pasteCall?.[1] as { selector: string }).selector).toBe('.ql-editor[contenteditable="true"]');
	});

	it("returns the scores and suggestions from the real panels", async () => {
		const result = await runStagehandGrammarlyTask(createStagehand(), ARTICLE);

		expect(result.aiDetectionPercent).toBe(37);
		expect(result.plagiarismPercent).toBe(0);
		expect(result.grammarSuggestionCount).toBe(16);
		expect(result.grammarSuggestions[0]?.category).toBe("Correctness");
		expect(result.notes).toContain("read from the Grammarly panel text");
		expect(result.notes).toContain(`${countWords(ARTICLE)} words`);
	});

	it("does not use the LLM reader when the panel text gives both scores", async () => {
		await runStagehandGrammarlyTask(createStagehand(), ARTICLE);
		const scoreReads = mockExtract.mock.calls.filter(([instruction]) => !String(instruction).includes("suggestions sidebar"));
		expect(scoreReads).toHaveLength(0);
	});

	it("refuses to read scores when Grammarly ignores the paste", async () => {
		fake.pasteRegisters = false;

		await expect(runStagehandGrammarlyTask(createStagehand(), ARTICLE)).rejects.toThrow(
			/registered 0 words/
		);
		expect(fake.aiTabOpen).toBe(false);
	});

	it("refuses to read scores when the word count is far from the text", async () => {
		fake.wordCountOverride = 12;

		await expect(runStagehandGrammarlyTask(createStagehand(), ARTICLE)).rejects.toThrow(
			/registered 12 words/
		);
	});

	it("ignores a number followed by 'words' inside the document", async () => {
		const text = `Write 300 words a day. ${ARTICLE}`;
		const result = await runStagehandGrammarlyTask(createStagehand(), text);
		expect(result.notes).toContain(`${countWords(text)} words`);
	});

	it("fails when the editor never appears empty", async () => {
		fake.editorText = "An old document that is still open.";

		await expect(runStagehandGrammarlyTask(createStagehand(), ARTICLE)).rejects.toThrow(
			"Could not find an empty Grammarly editor"
		);
	});

	it("returns null scores when Grammarly is still checking at the end of the wait", async () => {
		fake.checkingPollsBeforeResult = 10_000;

		const result = await runStagehandGrammarlyTask(createStagehand(), ARTICLE);

		expect(result.aiDetectionPercent).toBeNull();
		expect(result.plagiarismPercent).toBeNull();
		expect(result.notes).toContain("still checking");
	});

	it("uses the LLM reader only for a score the panel text does not give", async () => {
		fake.resultPanel = "Plagiarism and AI text check\nWe didn’t detect plagiarism\nA reworded AI sentence";

		const result = await runStagehandGrammarlyTask(createStagehand(), ARTICLE);

		expect(result.plagiarismPercent).toBe(0); // from the panel text, not the reader's 99
		expect(result.aiDetectionPercent).toBe(99); // from the LLM reader
		expect(result.notes).toContain("LLM reader used");
	});

	it("still returns scores when the suggestions cannot be read", async () => {
		mockExtract.mockImplementation(async () => {
			throw new Error("Sidebar not found");
		});

		const result = await runStagehandGrammarlyTask(createStagehand(), ARTICLE);

		expect(result.aiDetectionPercent).toBe(37);
		expect(result.grammarSuggestionCount).toBe(16); // from the panel header
		expect(result.grammarSuggestions).toEqual([]);
	});

	it("uses a direct action when observe finds nothing", async () => {
		mockObserve.mockResolvedValue([]);

		await runStagehandGrammarlyTask(createStagehand(), ARTICLE);

		const labels = mockAct.mock.calls.map(([action]) => String(action));
		expect(labels.some((label) => label.includes("create a new document"))).toBe(true);
		expect(labels.some((label) => label.includes("Check for AI text & plagiarism"))).toBe(true);
	});
});

describe("cleanupGrammarlyDocument", () => {
	it("calls act to delete or close the document", async () => {
		await cleanupGrammarlyDocument(createStagehand());
		expect(mockAct).toHaveBeenCalledWith(expect.stringContaining("Delete the current document"));
	});

	it("does not throw when cleanup fails", async () => {
		mockAct.mockRejectedValue(new Error("Cleanup failed"));
		await expect(cleanupGrammarlyDocument(createStagehand())).resolves.toBeUndefined();
	});
});
