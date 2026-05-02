import { logger } from '../utils/logger';

const LLM_BASE_URL = (process.env.LLM_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/$/, '');
const LLM_API_KEY = process.env.LLM_API_KEY || '';
const LLM_MODEL = process.env.LLM_MODEL || 'llama-3.3-70b-versatile';

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmOptions {
  temperature?: number;
  max_tokens?: number;
  response_format?: { type: 'json_object' };
}

export class LlmService {
  private static instance: LlmService;

  private constructor() {}

  public static getInstance(): LlmService {
    if (!LlmService.instance) {
      LlmService.instance = new LlmService();
    }
    return LlmService.instance;
  }

  async chat(messages: LlmMessage[], options: LlmOptions = {}, retries = 3): Promise<string> {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const response = await fetch(`${LLM_BASE_URL}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${LLM_API_KEY}`,
          },
          body: JSON.stringify({
            model: LLM_MODEL,
            messages,
            temperature: options.temperature ?? 0.3,
            max_tokens: options.max_tokens ?? 2000,
            response_format: options.response_format,
          }),
        });

        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`LLM API error ${response.status}: ${errText}`);
        }

        const data = await response.json() as {
          choices: Array<{ message: { content: string } }>;
        };

        const content = data.choices[0]?.message?.content ?? '';
        if (!content) throw new Error('Empty response from LLM');

        return content;
      } catch (err) {
        logger.error(`LLM call failed (attempt ${attempt}/${retries})`, { err });
        if (attempt === retries) throw err;
        await new Promise(res => setTimeout(res, 1000 * attempt)); // exponential backoff-ish
      }
    }
    throw new Error('LLM call failed after retries');
  }
}
