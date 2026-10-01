import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the config module for logging
vi.mock("../../../../src/config", () => ({
	log: vi.fn(),
}));

// Mock the setTimeout to prevent actual delays
// Using fake timers with sleep() requires advancing timers in each test
// Instead, immediately invoke callbacks for test speed without test modifications
vi.stubGlobal(
	"setTimeout",
	vi.fn((cb: () => void) => {
		cb();
		return 0 as unknown as NodeJS.Timeout;
	})
);

// Mock functions at top level
const mockPageUrl = vi.fn();
const mockPageGoto = vi.fn();
const mockPageEvaluate = vi.fn();
const mockStagehandObserve = vi.fn();
const mockStagehandAct = vi.fn();
const mockStagehandExtract = vi.fn();

// Mock for waitForLoadState
const mockWaitForLoadState = vi.fn();

// What the Grammarly editor holds. fill() and the "Type" act write it; the
// task reads it back through page.evaluate() to confirm the new text arrived.
let editorContent = "";
const TYPE_PREFIX = "Type the following text exactly: ";
const fillEditor = () =>
	vi.fn(async (value: string) => {
		editorContent = value;
	});

// Create mock page factory
function createMockPage(url = "https://other-site.com") {
	return {
		url: mockPageUrl.mockReturnValue(url),
		goto: mockPageGoto,
		evaluate: mockPageEvaluate,
		waitForLoadState: mockWaitForLoadState.mockResolvedValue(undefined),
		locator: vi.fn().mockReturnValue({
			fill: fillEditor(),
		}),
	};
}

// Create mock Stagehand factory
function createMockStagehand(pages: unknown[] = [createMockPage()]) {
	return {
		context: {
			pages: vi.fn().mockReturnValue(pages),
		},
		observe: mockStagehandObserve,
		act: mockStagehandAct,
		extract: mockStagehandExtract,
	};
}

// Import after mocking (the module uses named imports)
import type { Stagehand } from "@browserbasehq/stagehand";
import {
	cleanupGrammarlyDocument,
	runStagehandGrammarlyTask,
} from "../../../../src/browser/stagehand/grammarlyTask";

describe("runStagehandGrammarlyTask", () => {
	beforeEach(() => {
		vi.clearAllMocks();

		// Default successful mocks
		mockPageGoto.mockResolvedValue(undefined);
		editorContent = "";
		mockPageEvaluate.mockImplementation(async () => editorContent);
		mockWaitForLoadState.mockResolvedValue(undefined);
		mockStagehandObserve.mockResolvedValue([{ description: "New document button" }]);
		mockStagehandAct.mockImplementation(async (instruction: unknown) => {
			if (typeof instruction === "string" && instruction.startsWith(TYPE_PREFIX)) {
				editorContent = instruction.slice(TYPE_PREFIX.length);
			}
		});
		// Route each extract call by its instruction, as the real extractor sees it.
		mockStagehandExtract.mockImplementation(async (instruction: string) =>
			instruction.includes("suggestions sidebar")
				? { suggestionCount: 1, suggestions: [{ category: "Correctness", original: "teh", suggestion: "the" }] }
				: {
						aiDetectionPercent: 15,
						plagiarismPercent: 3,
						overallScore: 85,
						notes: "Scores extracted successfully",
					}
		);
	});

	afterEach(() => {
		vi.resetAllMocks();
	});

	describe("page retrieval", () => {
		it("throws error when no page available in context", async () => {
			const stagehand = createMockStagehand([]);

			await expect(
				runStagehandGrammarlyTask(stagehand as unknown as Stagehand, "Test text")
			).rejects.toThrow("No page available in Stagehand context");
		});

		it("uses first page from context", async () => {
			const mockPage = createMockPage("https://app.grammarly.com/docs/123");
			const stagehand = createMockStagehand([mockPage]);

			await runStagehandGrammarlyTask(stagehand as unknown as Stagehand, "Test text");

			expect(mockPageUrl).toHaveBeenCalled();
		});
	});

	describe("text handling", () => {
		it("processes text longer than 8000 characters", async () => {
			const longText = "a".repeat(10000);
			const mockFill = fillEditor();
			const mockPage = {
				...createMockPage("https://app.grammarly.com"),
				locator: vi.fn().mockReturnValue({
					fill: mockFill,
				}),
			};
			const stagehand = createMockStagehand([mockPage]);

			await runStagehandGrammarlyTask(stagehand as unknown as Stagehand, longText);

			// The full text reaches the editor; nothing is cut off
			expect(mockPage.locator).toHaveBeenCalledWith('[contenteditable="true"]');
			expect(mockFill).toHaveBeenCalledTimes(1);
			expect(mockFill.mock.calls[0][0]).toHaveLength(10000);
		});

		it("processes short text correctly", async () => {
			const shortText = "Short test text";
			const stagehand = createMockStagehand([createMockPage("https://app.grammarly.com")]);

			await runStagehandGrammarlyTask(stagehand as unknown as Stagehand, shortText);

			// Verify the exact text is used for short texts (<=500 chars get typed directly)
			const actCalls = mockStagehandAct.mock.calls;
			const typeCall = actCalls.find(
				(call) => typeof call[0] === "string" && call[0].includes(shortText)
			);
			expect(typeCall).toBeDefined();
		});
	});

	describe("navigation", () => {
		it("navigates to Grammarly when not already there", async () => {
			const mockPage = createMockPage("https://other-site.com");
			const stagehand = createMockStagehand([mockPage]);

			await runStagehandGrammarlyTask(stagehand as unknown as Stagehand, "Test");

			expect(mockPageGoto).toHaveBeenCalledWith("https://app.grammarly.com", {
				waitUntil: "networkidle",
			});
		});

		it("skips navigation when already on Grammarly", async () => {
			const mockPage = createMockPage("https://app.grammarly.com/docs/123");
			const stagehand = createMockStagehand([mockPage]);

			await runStagehandGrammarlyTask(stagehand as unknown as Stagehand, "Test");

			expect(mockPageGoto).not.toHaveBeenCalled();
		});
	});

	describe("observe-then-act pattern", () => {
		it("uses observed element when observation returns results", async () => {
			const observedElement = { description: "New document", selector: "#new-doc" };
			mockStagehandObserve.mockResolvedValue([observedElement]);
			const stagehand = createMockStagehand([createMockPage("https://app.grammarly.com")]);

			await runStagehandGrammarlyTask(stagehand as unknown as Stagehand, "Test");

			// Should call act with the observed element
			expect(mockStagehandAct).toHaveBeenCalledWith(observedElement);
		});

		it("falls back to direct action when observation returns empty array", async () => {
			mockStagehandObserve.mockResolvedValue([]);
			const stagehand = createMockStagehand([createMockPage("https://app.grammarly.com")]);

			await runStagehandGrammarlyTask(stagehand as unknown as Stagehand, "Test");

			// Should call act with a string instruction as fallback
			expect(mockStagehandAct).toHaveBeenCalledWith(
				expect.stringContaining("Click on 'New'")
			);
		});

		it("falls back to direct action when first element is undefined", async () => {
			mockStagehandObserve.mockResolvedValue([undefined]);
			const stagehand = createMockStagehand([createMockPage("https://app.grammarly.com")]);

			await runStagehandGrammarlyTask(stagehand as unknown as Stagehand, "Test");

			// Should call act with a string instruction as fallback
			expect(mockStagehandAct).toHaveBeenCalledWith(
				expect.stringContaining("Click on 'New'")
			);
		});
	});

	describe("text input", () => {
		it("types short text directly (<=500 chars)", async () => {
			const shortText = "Short text under 500 characters";
			const stagehand = createMockStagehand([createMockPage("https://app.grammarly.com")]);

			await runStagehandGrammarlyTask(stagehand as unknown as Stagehand, shortText);

			// Find the act call that types the text directly
			const actCalls = mockStagehandAct.mock.calls;
			const directTypeCall = actCalls.find(
				(call) =>
					typeof call[0] === "string" &&
					call[0].includes("Type the following text exactly:")
			);
			expect(directTypeCall).toBeDefined();
		});

		it("uses locator.fill() for long text (>500 chars)", async () => {
			const longText = "a".repeat(1200); // Long text triggers fill() approach
			const mockFill = fillEditor();
			const mockPage = {
				...createMockPage("https://app.grammarly.com"),
				locator: vi.fn().mockReturnValue({
					fill: mockFill,
				}),
			};
			const stagehand = createMockStagehand([mockPage]);

			await runStagehandGrammarlyTask(stagehand as unknown as Stagehand, longText);

			// Check that locator.fill() was called for long text
			expect(mockPage.locator).toHaveBeenCalledWith('[contenteditable="true"]');
			expect(mockFill).toHaveBeenCalledTimes(1);
			expect(mockFill.mock.calls[0][0]).toBe(longText);
		});

	});

	describe("AI detection observation", () => {
		it("uses observed AI detection element when found", async () => {
			const aiDetectElement = { description: "AI Detection button" };
			mockStagehandObserve
				.mockResolvedValueOnce([{ description: "New document" }]) // First observe
				.mockResolvedValueOnce([aiDetectElement]); // Second observe for AI detection

			const stagehand = createMockStagehand([createMockPage("https://app.grammarly.com")]);

			await runStagehandGrammarlyTask(stagehand as unknown as Stagehand, "Test");

			expect(mockStagehandAct).toHaveBeenCalledWith(aiDetectElement);
		});

		it("falls back to direct action for AI detection when not observed", async () => {
			mockStagehandObserve
				.mockResolvedValueOnce([{ description: "New document" }])
				.mockResolvedValueOnce([]); // Empty AI detection observation

			const stagehand = createMockStagehand([createMockPage("https://app.grammarly.com")]);

			await runStagehandGrammarlyTask(stagehand as unknown as Stagehand, "Test");

			expect(mockStagehandAct).toHaveBeenCalledWith(
				expect.stringContaining("Open the AI detection panel")
			);
		});
	});

	describe("score extraction", () => {
		it("returns extracted scores with all fields", async () => {
			mockStagehandExtract.mockResolvedValue({
				aiDetectionPercent: 25,
				plagiarismPercent: 8,
				overallScore: 90,
				notes: "All scores visible",
			});
			const stagehand = createMockStagehand([createMockPage("https://app.grammarly.com")]);

			const result = await runStagehandGrammarlyTask(
				stagehand as unknown as Stagehand,
				"Test"
			);

			expect(result).toMatchObject({
				aiDetectionPercent: 25,
				plagiarismPercent: 8,
				overallScore: 90,
				notes: "All scores visible",
			});
		});

		it("handles null scores when features unavailable", async () => {
			mockStagehandExtract.mockResolvedValue({
				aiDetectionPercent: null,
				plagiarismPercent: null,
				notes: "Premium features not available",
			});
			const stagehand = createMockStagehand([createMockPage("https://app.grammarly.com")]);

			const result = await runStagehandGrammarlyTask(
				stagehand as unknown as Stagehand,
				"Test"
			);

			expect(result.aiDetectionPercent).toBeNull();
			expect(result.plagiarismPercent).toBeNull();
			expect(result.notes).toContain("Premium");
		});

		it("calls extract with correct schema instruction", async () => {
			const stagehand = createMockStagehand([createMockPage("https://app.grammarly.com")]);

			await runStagehandGrammarlyTask(stagehand as unknown as Stagehand, "Test");

			expect(mockStagehandExtract).toHaveBeenCalledWith(
				expect.stringContaining("AI Detection Percentage"),
				expect.anything() // GrammarlyExtractSchema
			);
		});

		it("tells the extractor never to estimate a score", async () => {
			const stagehand = createMockStagehand([createMockPage("https://app.grammarly.com")]);

			await runStagehandGrammarlyTask(stagehand as unknown as Stagehand, "Test");

			const scoreCall = mockStagehandExtract.mock.calls.find(([instruction]) =>
				String(instruction).includes("AI Detection Percentage")
			);
			expect(scoreCall?.[0]).toContain("Never estimate");
			expect(scoreCall?.[0]).not.toContain("estimate based");
		});
	});

	describe("editor check", () => {
		it("refuses to read scores when the editor does not hold the new text", async () => {
			mockPageEvaluate.mockImplementation(async () => "The text of an older document.");
			const stagehand = createMockStagehand([createMockPage("https://app.grammarly.com")]);

			await expect(
				runStagehandGrammarlyTask(stagehand as unknown as Stagehand, "Brand new text")
			).rejects.toThrow("does not contain the new text");
			const scoreCalls = mockStagehandExtract.mock.calls.filter(([instruction]) =>
				String(instruction).includes("AI Detection Percentage")
			);
			expect(scoreCalls).toHaveLength(0);
		});

		it("accepts editor text with different line breaks", async () => {
			mockPageEvaluate.mockImplementation(async () => "First line\n\nsecond   line");
			const stagehand = createMockStagehand([createMockPage("https://app.grammarly.com")]);

			const result = await runStagehandGrammarlyTask(
				stagehand as unknown as Stagehand,
				"First line second line"
			);
			expect(result.aiDetectionPercent).toBe(15);
		});

		it("ignores zero-width characters in the editor", async () => {
			mockPageEvaluate.mockImplementation(async () => "Zero\u200Bwidth\u2060 text\uFEFF here.");
			const stagehand = createMockStagehand([createMockPage("https://app.grammarly.com")]);

			const result = await runStagehandGrammarlyTask(
				stagehand as unknown as Stagehand,
				"Zerowidth text here."
			);
			expect(result.aiDetectionPercent).toBe(15);
		});

				it("accepts paragraphs joined with no space and typographic quotes", async () => {
			// textContent of <p>One block.</p><p>It's next.</p>
			mockPageEvaluate.mockImplementation(async () => "One block.It\u2019s next \u2014 really.");
			const stagehand = createMockStagehand([createMockPage("https://app.grammarly.com")]);

			const result = await runStagehandGrammarlyTask(
				stagehand as unknown as Stagehand,
				"One block.\n\nIt's next - really."
			);
			expect(result.aiDetectionPercent).toBe(15);
		});
	});

	describe("grammar suggestions", () => {
		it("flows the default sidebar suggestions through", async () => {
			const stagehand = createMockStagehand([createMockPage("https://app.grammarly.com")]);

			const result = await runStagehandGrammarlyTask(stagehand as unknown as Stagehand, "Test");

			expect(result.grammarSuggestionCount).toBe(1);
			expect(result.grammarSuggestions).toEqual([
				{ category: "Correctness", original: "teh", suggestion: "the" },
			]);
		});

		it("returns the suggestions read from the sidebar", async () => {
			mockStagehandExtract
				.mockResolvedValueOnce({
					suggestionCount: 2,
					suggestions: [
						{ category: "Correctness", original: "teh", suggestion: "the" },
						{ category: "Clarity", original: "in order to", suggestion: "to" },
					],
				})
				.mockResolvedValueOnce({
					aiDetectionPercent: 4,
					plagiarismPercent: 0,
					notes: "Scores visible",
				});
			const stagehand = createMockStagehand([createMockPage("https://app.grammarly.com")]);

			const result = await runStagehandGrammarlyTask(stagehand as unknown as Stagehand, "Test");

			expect(result.grammarSuggestionCount).toBe(2);
			expect(result.grammarSuggestions).toHaveLength(2);
			expect(result.grammarSuggestions[0]?.category).toBe("Correctness");
			expect(result.aiDetectionPercent).toBe(4);
		});

		it("still returns scores when the suggestions cannot be read", async () => {
			mockStagehandExtract
				.mockRejectedValueOnce(new Error("Sidebar not found"))
				.mockResolvedValueOnce({
					aiDetectionPercent: 7,
					plagiarismPercent: 1,
					notes: "Scores visible",
				});
			const stagehand = createMockStagehand([createMockPage("https://app.grammarly.com")]);

			const result = await runStagehandGrammarlyTask(stagehand as unknown as Stagehand, "Test");

			expect(result.grammarSuggestionCount).toBeNull();
			expect(result.grammarSuggestions).toEqual([]);
			expect(result.aiDetectionPercent).toBe(7);
		});
	});

	describe("error handling", () => {
		it("throws when score extraction fails, with no partial extraction", async () => {
			mockStagehandExtract
				.mockResolvedValueOnce({ suggestionCount: 0, suggestions: [] })
				.mockRejectedValueOnce(new Error("Primary extraction failed"))
				.mockResolvedValueOnce({
					aiDetectionPercent: 10,
					plagiarismPercent: 2,
					notes: "A stale score from an earlier document",
				});
			const stagehand = createMockStagehand([createMockPage("https://app.grammarly.com")]);

			await expect(
				runStagehandGrammarlyTask(stagehand as unknown as Stagehand, "Test")
			).rejects.toThrow("Primary extraction failed");
			expect(mockStagehandExtract).toHaveBeenCalledTimes(2);
		});
	});

	describe("options handling", () => {
		it("logs iteration number when provided", async () => {
			const stagehand = createMockStagehand([createMockPage("https://app.grammarly.com")]);

			await runStagehandGrammarlyTask(stagehand as unknown as Stagehand, "Test", {
				iteration: 3,
			});

			// Verify the function completed successfully with options
			expect(mockStagehandExtract).toHaveBeenCalled();
		});

		it("logs mode when provided", async () => {
			const stagehand = createMockStagehand([createMockPage("https://app.grammarly.com")]);

			await runStagehandGrammarlyTask(stagehand as unknown as Stagehand, "Test", {
				mode: "analyze",
			});

			expect(mockStagehandExtract).toHaveBeenCalled();
		});

		it("handles undefined options", async () => {
			const stagehand = createMockStagehand([createMockPage("https://app.grammarly.com")]);

			await runStagehandGrammarlyTask(
				stagehand as unknown as Stagehand,
				"Test",
				undefined
			);

			expect(mockStagehandExtract).toHaveBeenCalled();
		});
	});
});

describe("cleanupGrammarlyDocument", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("calls act to delete or close the document", async () => {
		mockStagehandAct.mockResolvedValue(undefined);
		const stagehand = createMockStagehand([createMockPage()]);

		await cleanupGrammarlyDocument(stagehand as unknown as Stagehand);

		expect(mockStagehandAct).toHaveBeenCalledWith(
			expect.stringContaining("Delete the current document")
		);
	});

	it("does not throw when cleanup fails", async () => {
		mockStagehandAct.mockRejectedValue(new Error("Cleanup failed"));
		const stagehand = createMockStagehand([createMockPage()]);

		// Should not throw
		await expect(
			cleanupGrammarlyDocument(stagehand as unknown as Stagehand)
		).resolves.not.toThrow();
	});

	it("completes silently on error", async () => {
		mockStagehandAct.mockRejectedValue(new Error("Cleanup failed"));
		const stagehand = createMockStagehand([createMockPage()]);

		const result = await cleanupGrammarlyDocument(stagehand as unknown as Stagehand);

		// Returns undefined (void function)
		expect(result).toBeUndefined();
	});
});
