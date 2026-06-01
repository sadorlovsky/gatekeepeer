// Классификация сообщения как спама через OpenAI-compatible API
// (POST {baseUrl}/chat/completions). Без SDK — обычный fetch. При любой ошибке
// или невалидном ответе считаем сообщение НЕ спамом (fail-open): модерация не
// должна удалять легитимный контент из-за сбоя LLM.

import { config } from "../config.ts";

export interface SpamVerdict {
  spam: boolean;
  reason: string;
}

const SYSTEM_PROMPT = [
  "Ты — модератор Telegram-чата. Определи, является ли сообщение спамом:",
  "реклама, мошенничество, фишинг, массовая рассылка, накрутка, призывы перейти",
  "по сомнительным ссылкам. Обычное общение, вопросы и легитимные ссылки — не спам.",
  'Ответь строго JSON-объектом: {"spam": boolean, "reason": string}.',
  "reason — краткое пояснение на русском.",
].join(" ");

const NOT_SPAM = (reason: string): SpamVerdict => ({ spam: false, reason });

export async function classifySpam(text: string): Promise<SpamVerdict> {
  if (!config.llm.apiKey) return NOT_SPAM("LLM не настроен");

  try {
    const res = await fetch(`${config.llm.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.llm.apiKey}`,
      },
      body: JSON.stringify({
        model: config.llm.model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: text },
        ],
      }),
    });

    if (!res.ok) {
      console.error(`LLM-классификация: HTTP ${res.status}`);
      return NOT_SPAM("ошибка LLM");
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string") return NOT_SPAM("пустой ответ LLM");

    const parsed = JSON.parse(content) as Partial<SpamVerdict>;
    return {
      spam: parsed.spam === true,
      reason: typeof parsed.reason === "string" ? parsed.reason : "",
    };
  } catch (err) {
    console.error("LLM-классификация: исключение:", err);
    return NOT_SPAM("исключение LLM");
  }
}
