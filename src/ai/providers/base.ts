/**
 * AI provider abstraction.
 *
 * Implementations must:
 *  - be independent of core filtering/authz (deterministic rules stay in code),
 *  - degrade gracefully (return `null` results instead of throwing to callers),
 *  - be bounded by budgets/timeouts (engine-level enforcement below),
 *  - treat ALL upstream text as data, never as instructions (see prompts).
 */
export interface AiMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AiCompletionRequest {
  messages: AiMessage[];
  maxTokens?: number;
  temperature?: number;
}

export interface AiCompletionResult {
  text: string;
  model: string;
  tokensUsed: number | null;
}

export interface AiProvider {
  readonly name: string;
  readonly model: string;
  /** Cheap capability probe (no network): false when not configured. */
  available(): boolean;
  complete(request: AiCompletionRequest): Promise<AiCompletionResult | null>;
}
