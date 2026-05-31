// LLM-модерация спама. Читаем сообщения групп/супергрупп (message) и каналов
// (channel_post), пропускаем через дешёвый эвристический гейт, и только подозрительные
// отправляем на LLM-классификацию. При вердикте «спам» удаляем сообщение (MVP —
// без бана). Подключается в bot.ts только если задан LLM-ключ (config.moderationEnabled).
//
// Требование к Telegram: бот должен получать сообщения чата. Для групп это означает
// выключенный privacy mode в BotFather ИЛИ статус админа (наш бот и так админ).

import type { Bot, Context } from "grammy";
import { getChannel } from "../db.ts";
import { classifySpam, type SpamVerdict } from "../moderation/classify.ts";
import { shouldClassify } from "../moderation/heuristics.ts";

/**
 * @param classify инъекция классификатора (по умолчанию — реальный LLM).
 *   В тестах подменяется стабом, чтобы не ходить в сеть.
 */
export function registerModeration(
  bot: Bot,
  classify: (text: string) => Promise<SpamVerdict> = classifySpam,
): void {
  const handle = async (ctx: Context): Promise<void> => {
    const msg = ctx.message ?? ctx.channelPost;
    if (!msg) return;
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;

    const channel = await getChannel(chatId);
    // can_delete === 0 → удалять спам нечем, нет смысла дёргать LLM.
    if (
      !channel ||
      channel.active === 0 ||
      channel.moderation_enabled === 0 ||
      channel.can_delete === 0
    ) {
      return;
    }

    const text = msg.text ?? msg.caption;
    if (!shouldClassify(text, channel)) return;

    const verdict = await classify(text as string);
    if (!verdict.spam) return;

    try {
      await ctx.deleteMessage();
      console.log(`Удалён спам chat=${chatId} msg=${msg.message_id}: ${verdict.reason}`);
    } catch (err) {
      console.error(`Не удалось удалить спам chat=${chatId} msg=${msg.message_id}:`, err);
    }
  };

  bot.on("message", handle);
  bot.on("channel_post", handle);
}
