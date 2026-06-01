// Проверка пользователя по внешнему blocklist CAS (Combot Anti-Spam System):
// GET {apiUrl}?user_id=<id> → {"ok": true}, если юзер в базе спамеров. Дёшево
// отсекает известных спамеров до дорогой LLM-классификации. При любой ошибке/
// таймауте/выключенном CAS считаем «не спамер» (fail-open) — внешний сервис не
// должен блокировать обработку или провоцировать ложные удаления.

import { config } from "../config.ts";

// Результат на user_id почти не меняется в пределах часов — кэшируем, чтобы не
// бить по сети на каждое сообщение одного автора. Кэшируем только валидные
// ответы; ошибки не кэшируем, чтобы быстро восстановиться после сбоя CAS.
const CAS_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 часов
const cache = new Map<number, { banned: boolean; expires: number }>();

/**
 * true — пользователь найден в базе спамеров CAS.
 * false — не найден, ошибка, таймаут или CAS отключён (fail-open).
 */
export async function checkCas(userId: number): Promise<boolean> {
  if (!config.cas.enabled) return false;

  const cached = cache.get(userId);
  if (cached && cached.expires > Date.now()) return cached.banned;

  try {
    const res = await fetch(`${config.cas.apiUrl}?user_id=${userId}`, {
      signal: AbortSignal.timeout(config.cas.timeoutMs),
    });
    if (!res.ok) {
      console.error(`CAS-проверка: HTTP ${res.status}`);
      return false;
    }
    const data = (await res.json()) as { ok?: unknown };
    const banned = data.ok === true;
    cache.set(userId, { banned, expires: Date.now() + CAS_CACHE_TTL_MS });
    return banned;
  } catch (err) {
    console.error("CAS-проверка: исключение:", err);
    return false;
  }
}
