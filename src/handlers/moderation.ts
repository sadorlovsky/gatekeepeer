// LLM-модерация спама. Читаем сообщения групп/супергрупп (message) и каналов
// (channel_post) и пропускаем через слои перед дорогим LLM:
//   1) гейт канала (active/moderation_enabled/can_delete);
//   2) доверие новичка — после N чистых сообщений автора пропускаем модерацию;
//   3) CAS — внешний blocklist по user_id, попадание → удаление;
//   4) эвристики — расширенный пре-фильтр, решает эскалировать ли к LLM;
//   5) LLM-классификатор — единственный судья контентных удалений (fail-open).
// Удаляем сообщение (MVP — без бана) только при попадании в CAS или вердикте LLM.
// Подключается в bot.ts только если задан LLM-ключ (config.moderationEnabled).
//
// Требование к Telegram: бот должен получать сообщения чата. Для групп это означает
// выключенный privacy mode в BotFather ИЛИ статус админа (наш бот и так админ).

import type { Bot, Context } from "grammy";
import { config } from "../config.ts";
import { getChannel, getSeenCount, bumpSeen } from "../db.ts";
import { classifySpam, type SpamVerdict } from "../moderation/classify.ts";
import { shouldClassify } from "../moderation/heuristics.ts";
import { checkCas } from "../moderation/cas.ts";

/**
 * @param deps инъекция зависимостей. В тестах подменяются стабами, чтобы не
 *   ходить в сеть (classify — LLM, checkCas — внешний CAS-сервис).
 */
export function registerModeration(
  bot: Bot,
  deps: {
    classify?: (text: string) => Promise<SpamVerdict>;
    checkCas?: (userId: number) => Promise<boolean>;
  } = {},
): void {
  const classify = deps.classify ?? classifySpam;
  const cas = deps.checkCas ?? checkCas;

  const tryDelete = async (ctx: Context, chatId: number, msgId: number, reason: string): Promise<void> => {
    try {
      await ctx.deleteMessage();
      console.log(`Удалён спам chat=${chatId} msg=${msgId}: ${reason}`);
    } catch (err) {
      console.error(`Не удалось удалить спам chat=${chatId} msg=${msgId}:`, err);
    }
  };

  const handle = async (ctx: Context): Promise<void> => {
    const msg = ctx.message ?? ctx.channelPost;
    if (!msg) return;
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;

    const channel = await getChannel(chatId);
    // can_delete === 0 → удалять спам нечем, нет смысла дёргать проверки.
    if (
      !channel ||
      channel.active === 0 ||
      channel.moderation_enabled === 0 ||
      channel.can_delete === 0
    ) {
      return;
    }

    const userId = msg.from?.id;

    // --- Ветка message (есть автор): доверие новичка + CAS ---
    if (userId !== undefined) {
      // Команды бота не модерируем — их потребляют свои хендлеры, а расширенные
      // эвристики могли бы ложно эскалировать форвард/эмодзи в команде.
      const isBotCommand = msg.entities?.some(
        (e) => e.type === "bot_command" && e.offset === 0,
      );
      if (isBotCommand) return;

      // Доверенный автор (прислал >= N чистых сообщений) — пропускаем все проверки.
      const seen = await getSeenCount(chatId, userId);
      if (seen >= config.moderation.firstMessages) return;

      // CAS — жёсткий сигнал: известный спамер, удаляем без LLM (доверие не растёт).
      if (await cas(userId)) {
        await tryDelete(ctx, chatId, msg.message_id, "CAS hit");
        return;
      }

      // Пре-фильтр не нашёл подозрительного → сообщение чистое, продвигаем доверие.
      if (!shouldClassify(msg, channel)) {
        await bumpSeen(chatId, userId);
        return;
      }

      const text = msg.text ?? msg.caption;
      // Медиа без текста: LLM нечего классифицировать. Не удаляем (fail-open) и не
      // продвигаем доверие — нейтрально.
      if (!text) return;

      const verdict = await classify(text);
      if (verdict.spam) {
        await tryDelete(ctx, chatId, msg.message_id, verdict.reason);
        return;
      }
      await bumpSeen(chatId, userId);
      return;
    }

    // --- Ветка channel_post (нет автора): укороченный путь, без доверия/CAS ---
    if (!shouldClassify(msg, channel)) return;
    const text = msg.text ?? msg.caption;
    if (!text) return;
    const verdict = await classify(text);
    if (!verdict.spam) return;
    await tryDelete(ctx, chatId, msg.message_id, verdict.reason);
  };

  bot.on("message", handle);
  bot.on("channel_post", handle);
}
