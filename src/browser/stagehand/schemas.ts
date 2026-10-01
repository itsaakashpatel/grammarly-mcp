import { z } from "zod";

/**
 * Zod schema for extracting Grammarly AI detection and plagiarism scores.
 * Used with Stagehand's extract() method for structured data extraction.
 */
export const GrammarlyExtractSchema = z.object({
  aiDetectionPercent: z
    .number()
    .min(0)
    .max(100)
    .nullable()
    .describe(
      "AI-generated content percentage (0-100) exactly as Grammarly's AI Detector shows it. Set to null if no number is visible. Never estimate.",
    ),
  plagiarismPercent: z
    .number()
    .min(0)
    .max(100)
    .nullable()
    .describe(
      "Plagiarism percentage (0-100) exactly as Grammarly's Plagiarism Checker shows it. Set to null if no number is visible. Never estimate.",
    ),
  overallScore: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe(
      "Overall Grammarly performance score if visible in the interface. Optional.",
    ),
  notes: z
    .string()
    .describe(
      "Brief observations about what was visible in the UI, including any warnings, loading states, or issues encountered.",
    ),
});

export type GrammarlyExtractResult = z.infer<typeof GrammarlyExtractSchema>;

/** One writing suggestion from the Grammarly sidebar. */
export const GrammarlySuggestionSchema = z.object({
  category: z
    .string()
    .describe(
      "Suggestion category as Grammarly labels it, for example Correctness, Clarity, Engagement or Delivery.",
    ),
  original: z
    .string()
    .describe("The flagged words in the text, copied exactly."),
  suggestion: z
    .string()
    .describe(
      "Grammarly's proposed replacement, or an empty string if none is shown.",
    ),
  explanation: z
    .string()
    .optional()
    .describe("Grammarly's short reason for the suggestion, if visible."),
});

export type GrammarlySuggestion = z.infer<typeof GrammarlySuggestionSchema>;

/** Zod schema for extracting the writing suggestions from the Grammarly sidebar. */
export const GrammarlySuggestionsExtractSchema = z.object({
  suggestionCount: z
    .number()
    .int()
    .min(0)
    .nullable()
    .describe(
      "Total number of suggestions as Grammarly shows it. Set to null if no count is visible.",
    ),
  suggestions: z
    .array(GrammarlySuggestionSchema)
    .describe("Every suggestion visible in the sidebar, in the order shown."),
});

/**
 * Schema for observing UI elements before acting.
 * Used with Stagehand's observe() method to find actionable elements.
 */
export const ObservationSchema = z.object({
  selector: z.string().describe("CSS selector for the observed element"),
  description: z.string().describe("Human-readable description of the element"),
  visible: z.boolean().describe("Whether the element is currently visible"),
  interactable: z
    .boolean()
    .describe("Whether the element can be interacted with"),
});

export type Observation = z.infer<typeof ObservationSchema>;
