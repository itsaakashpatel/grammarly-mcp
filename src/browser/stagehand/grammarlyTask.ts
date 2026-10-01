import type { Stagehand } from "@browserbasehq/stagehand";
import { log } from "../../config";
import {
  GrammarlyExtractSchema,
  type GrammarlySuggestion,
  GrammarlySuggestionsExtractSchema,
} from "./schemas";

export interface GrammarlyTaskOptions {
  maxSteps?: number;
  iteration?: number;
  mode?: string;
}

export interface GrammarlyTaskResult {
  aiDetectionPercent: number | null;
  plagiarismPercent: number | null;
  overallScore?: number | null;
  grammarSuggestionCount: number | null;
  grammarSuggestions: GrammarlySuggestion[];
  notes: string;
}

/**
 * Sleep utility
 */
async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Collapses whitespace, so line breaks in the editor do not break the comparison. */
function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Run Grammarly scoring task using Stagehand's deterministic automation.
 * Uses the observe()->act()->extract() pattern for reliable, fast execution.
 */
export async function runStagehandGrammarlyTask(
  stagehand: Stagehand,
  text: string,
  options?: GrammarlyTaskOptions,
): Promise<GrammarlyTaskResult> {
  // Access page via context API (V3)
  const page = stagehand.context.pages()[0];
  if (!page) {
    throw new Error("No page available in Stagehand context");
  }

  log("debug", "Starting Stagehand Grammarly scoring task", {
    textLength: text.length,
    iteration: options?.iteration,
    mode: options?.mode,
  });

  try {
    // Step 1: Navigate to Grammarly if not already there
    const currentUrl = page.url();
    if (!currentUrl.includes("app.grammarly.com")) {
      log("debug", "Navigating to Grammarly");
      await page.goto("https://app.grammarly.com", {
        waitUntil: "networkidle",
      });
      await page.waitForLoadState("domcontentloaded");
    }

    // Step 2: Create a new document using observe -> act pattern
    log("debug", "Looking for new document button");
    const newDocObservation = await stagehand.observe(
      "Find the button or link to create a new document. Look for 'New', 'New document', '+', or similar options in the interface.",
    );

    const newDocElement = newDocObservation?.[0];
    if (newDocElement) {
      log("debug", "Found new document element, clicking", {
        element: newDocElement,
      });
      // Pass the observed action directly to act()
      await stagehand.act(newDocElement);
    } else {
      // Fallback: try direct action with instruction string
      log("debug", "No element observed, trying direct action");
      await stagehand.act(
        "Click on 'New' or the button to create a new document in the Grammarly interface",
      );
    }

    // Step 3: Wait for editor to load
    await page.waitForLoadState("domcontentloaded");
    await sleep(1500); // Allow editor to initialize

    // Step 4: Clear any existing content and paste new text
    log("debug", "Pasting text into editor");

    // Try to find and focus the editor first
    await stagehand.act("Click on the main text editor area to focus it");

    // Clear existing content using stagehand act (keyboard simulation)
    await stagehand.act("Select all text in the editor using Ctrl+A or Cmd+A");

    // Type the text using stagehand's act for short text, or page locator.fill() for long text
    log("debug", "Typing text into editor");

    // For shorter texts, type directly using stagehand
    if (text.length <= 500) {
      await stagehand.act(`Type the following text exactly: ${text}`);
    } else {
      // For longer texts, use Playwright's fill() method which handles contenteditable elements
      // This is more reliable than clipboard API and doesn't require permissions
      log("debug", "Filling long text using Playwright locator.fill()");
      const editorLocator = page.locator('[contenteditable="true"]');
      await editorLocator.fill(text);
    }

    // A silent failure of "New document" would leave the old document and its
    // old scores on screen, so confirm the editor holds the start of this text.
    const expectedStart = normalize(text).slice(0, 60);
    const editorText = normalize(
      String(
        (await page.evaluate(
          () =>
            document.querySelector('[contenteditable="true"]')?.textContent ??
            "",
        )) ?? "",
      ),
    );
    if (!editorText.includes(expectedStart)) {
      throw new Error(
        "Grammarly editor does not contain the new text; refusing to read scores",
      );
    }

    log("debug", "Text pasted into editor");
    // Grammarly needs more time to check a long document
    await sleep(text.length > 2000 ? 6000 : 1500);

    // Step 4b: Read the writing suggestions. A failure here never blocks the scores.
    let grammarSuggestionCount: number | null = null;
    let grammarSuggestions: GrammarlySuggestion[] = [];
    try {
      const grammar = await stagehand.extract(
        `Look at the Grammarly suggestions sidebar for the document in the editor.
        1. Suggestion count: the total number of suggestions Grammarly shows, or null if no count is visible.
        2. Suggestions: every suggestion card, in order. For each, give the category label
           (for example Correctness, Clarity, Engagement, Delivery), the flagged words copied exactly,
           the proposed replacement, and the short explanation if one is visible.
        Report only what Grammarly shows. Do not invent suggestions.`,
        GrammarlySuggestionsExtractSchema,
      );
      grammarSuggestionCount = grammar.suggestionCount;
      grammarSuggestions = grammar.suggestions;
    } catch (error) {
      log("warn", "Could not read Grammarly suggestions", { error });
    }

    // Step 5: Trigger AI Detection check
    log("debug", "Looking for AI detection button");

    // First observe to find the AI detection/plagiarism check option
    const aiDetectObservation = await stagehand.observe(
      "Find the button or option to check for AI-generated text or plagiarism. Look for 'AI', 'AI Detection', 'Plagiarism', 'Check for AI', or similar options in the sidebar or toolbar.",
    );

    const aiDetectElement = aiDetectObservation?.[0];
    if (aiDetectElement) {
      log("debug", "Found AI detection element", {
        element: aiDetectElement,
      });
      await stagehand.act(aiDetectElement);
    } else {
      // Try navigating to the specific panel
      await stagehand.act(
        "Open the AI detection panel or click on 'Check for AI text & plagiarism' option in the Grammarly interface",
      );
    }

    // Step 6: Wait for results to load
    log("debug", "Waiting for AI detection results");
    // Wait for network to settle and scores to calculate
    await page.waitForLoadState("networkidle").catch(() => {
      log("debug", "Network idle timeout, continuing anyway");
    });
    await sleep(4000); // Allow time for AI detection scoring

    // Step 7: Extract scores using Stagehand's extract with Zod schema
    // V3 API: stagehand.extract("instruction", schema)
    log("debug", "Extracting Grammarly scores");

    const extractResult = await stagehand.extract(
      `Look at the Grammarly interface and extract the following information:
        1. AI Detection Percentage: The percentage showing how much of the text appears to be AI-generated (0-100).
           This might be labeled as "AI-generated", "Likely AI", "AI content detected", etc.
           Report only a number that Grammarly shows. If no number is visible, set it to null. Never estimate.
        2. Plagiarism Percentage: The percentage of content that matches existing sources (0-100).
           This might be labeled as "Plagiarism", "Originality", "Similar content found", etc.
           Note: If shown as "originality" (e.g., "95% original"), convert to plagiarism (100 - originality).
           Report only a number that Grammarly shows. If no number is visible, set it to null. Never estimate.
        3. Overall Score: The overall Grammarly performance score if visible (optional).
        4. Notes: Any relevant observations about what you see, including if features are unavailable.

        If a percentage is not visible or the feature is not available, set it to null.`,
      GrammarlyExtractSchema,
    );

    log("info", "Extracted Grammarly scores", {
      aiDetectionPercent: extractResult.aiDetectionPercent,
      plagiarismPercent: extractResult.plagiarismPercent,
      overallScore: extractResult.overallScore,
    });

    return {
      aiDetectionPercent: extractResult.aiDetectionPercent,
      plagiarismPercent: extractResult.plagiarismPercent,
      overallScore: extractResult.overallScore,
      grammarSuggestionCount,
      grammarSuggestions,
      notes: extractResult.notes,
    };
  } catch (error) {
    // No partial extraction here: after a failure the page can still show the
    // scores of an earlier document, and a stale score is worse than none.
    // The caller retries the whole task.
    log("error", "Stagehand Grammarly task failed", { error });
    throw error;
  }
}

/**
 * Attempt to clean up a Grammarly document after scoring.
 * This helps keep the Grammarly workspace clean.
 */
export async function cleanupGrammarlyDocument(
  stagehand: Stagehand,
): Promise<void> {
  try {
    // Try to delete or close the current document
    await stagehand.act(
      "Delete the current document or close it without saving to clean up",
    );
    log("debug", "Cleaned up Grammarly document");
  } catch {
    log("debug", "Could not clean up Grammarly document (non-critical)");
  }
}
