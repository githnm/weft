export interface ValidationResult {
  status: "pass" | "fail";
  error?: string;
}

export interface Suggestion {
  title: string;
  target_source: string;
  reasoning: string;
  malloy_code: string;
  confidence: "high" | "medium" | "low";
  validation?: ValidationResult;
}

export interface SuggestResponse {
  domain: string;
  suggestions: Suggestion[];
}

export interface SuggestOptions {
  modelsDir: string;
  maxSuggestions: number;
}

export interface SuggestResult {
  response: SuggestResponse;
  model: string;
  inputTokens: number;
  outputTokens: number;
}
