import type { AiCompletionRequest, AiCompletionResult, AiProvider } from "./base.js";

export interface GroqOptions {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
}

/**
 * Groq implementation (OpenAI-compatible chat completions).
 * https://api.groq.com/openai/v1/chat/completions
 *
 * Fails closed: returns `null` on any error (timeout, quota, malformed).
 * Retries are handled by the AI engine, not here, to avoid double-retry.
 */
export class GroqProvider implements AiProvider {
  readonly name = "groq";
  readonly model: string;
  private apiKey: string;
  private timeoutMs: number;

  constructor(options: GroqOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? "llama-3.3-70b-versatile";
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  available(): boolean {
    return this.apiKey.length > 10;
  }

  async complete(request: AiCompletionRequest): Promise<AiCompletionResult | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: request.messages,
          max_tokens: request.maxTokens ?? 700,
          temperature: request.temperature ?? 0.4,
        }),
      });
      if (!response.ok) return null;
      const json = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { total_tokens?: number };
        model?: string;
      };
      const text = json.choices?.[0]?.message?.content;
      if (!text) return null;
      return {
        text,
        model: json.model ?? this.model,
        tokensUsed: json.usage?.total_tokens ?? null,
      };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
