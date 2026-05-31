// Обработка inline-кнопок пульта в личке: навигация (список ↔ экран канала),
// тогглы и выбор режима. Владение каждым каналом проверяет loadOwnedChannel.
// Отдельно — капча-колбэк cap: он срабатывает в личке ЗАЯВИТЕЛЯ (не владельца),
// поэтому проверку владения не проходит.

import type { Bot, Context } from "grammy";
import {
  deleteCaptchaPending,
  getCaptchaPending,
  getChannel,
  listChannelsByOwner,
  logJoin,
  setAutoApprove,
  setJoinMode,
  setModerationEnabled,
  type Channel,
  type JoinMode,
} from "../db.ts";
import {
  CAP_PREFIX,
  channelDetailKeyboard,
  channelDetailText,
  channelsKeyboard,
  LIST_PREFIX,
  MOD_PREFIX,
  MODE_PREFIX,
  OPEN_PREFIX,
  TOGGLE_PREFIX,
} from "../keyboards.ts";

const LIST_TEXT = "Ваши каналы. Выберите канал, чтобы настроить:";

/**
 * Достаёт канал из callback_data (группа 1 — chat_id) и проверяет владение.
 * При любой проблеме отвечает на колбэк и возвращает null — вызывающий выходит.
 */
async function loadOwnedChannel(ctx: Context): Promise<Channel | null> {
  if (ctx.chat?.type !== "private") {
    await ctx.answerCallbackQuery();
    return null;
  }
  const userId = ctx.from?.id;
  const match = ctx.match;
  if (!userId || !match || !Array.isArray(match) || match[1] === undefined) {
    await ctx.answerCallbackQuery();
    return null;
  }
  const channel = await getChannel(Number(match[1]));
  if (!channel || channel.added_by !== userId) {
    await ctx.answerCallbackQuery({ text: "Этот канал вам не принадлежит." });
    return null;
  }
  return channel;
}

/** Перерисовывает сообщение в экран канала с актуальными данными. */
async function renderDetail(ctx: Context, channel: Channel): Promise<void> {
  try {
    await ctx.editMessageText(channelDetailText(channel), {
      reply_markup: channelDetailKeyboard(channel),
    });
  } catch (err) {
    // Повторный выбор уже активного режима даёт идентичный текст+разметку, и
    // Telegram отвечает «message is not modified» (400). Для пользователя это
    // no-op (тост уже показан) — глушим, прочие ошибки пробрасываем.
    const description = (err as { description?: string })?.description ?? "";
    if (!description.includes("message is not modified")) throw err;
  }
}

export function registerCallbacks(bot: Bot): void {
  // Открыть экран канала.
  bot.callbackQuery(new RegExp(`^${OPEN_PREFIX}:(-?\\d+)$`), async (ctx: Context) => {
    const channel = await loadOwnedChannel(ctx);
    if (!channel) return;
    await ctx.answerCallbackQuery();
    await renderDetail(ctx, channel);
  });

  // Назад к списку каналов.
  bot.callbackQuery(new RegExp(`^${LIST_PREFIX}$`), async (ctx: Context) => {
    if (ctx.chat?.type !== "private") {
      await ctx.answerCallbackQuery();
      return;
    }
    const userId = ctx.from?.id;
    if (!userId) {
      await ctx.answerCallbackQuery();
      return;
    }
    await ctx.answerCallbackQuery();
    const channels = await listChannelsByOwner(userId);
    await ctx.editMessageText(LIST_TEXT, { reply_markup: channelsKeyboard(channels) });
  });

  // Мастер-выключатель приёма.
  bot.callbackQuery(new RegExp(`^${TOGGLE_PREFIX}:(-?\\d+)$`), async (ctx: Context) => {
    const channel = await loadOwnedChannel(ctx);
    if (!channel) return;
    const next = channel.auto_approve === 0;
    await setAutoApprove(channel.chat_id, channel.added_by, next);
    await ctx.answerCallbackQuery({
      text: next ? "Авто-приём включён ✅" : "Авто-приём выключен ⛔️",
    });
    const updated = await getChannel(channel.chat_id);
    if (updated) await renderDetail(ctx, updated);
  });

  // Выбор режима обработки заявок. Группа 1 — chat_id, группа 2 — режим.
  bot.callbackQuery(
    new RegExp(`^${MODE_PREFIX}:(-?\\d+):(approve|decline|captcha)$`),
    async (ctx: Context) => {
      const channel = await loadOwnedChannel(ctx);
      if (!channel) return;
      const match = ctx.match;
      const mode = Array.isArray(match) ? (match[2] as JoinMode | undefined) : undefined;
      if (!mode) {
        await ctx.answerCallbackQuery();
        return;
      }
      await setJoinMode(channel.chat_id, channel.added_by, mode);
      const labels: Record<JoinMode, string> = {
        approve: "Авто-приём",
        decline: "Авто-отклонение",
        captcha: "Проверка (капча)",
      };
      await ctx.answerCallbackQuery({ text: `Режим: ${labels[mode]}` });
      const updated = await getChannel(channel.chat_id);
      if (updated) await renderDetail(ctx, updated);
    },
  );

  // Тоггл LLM-модерации.
  bot.callbackQuery(new RegExp(`^${MOD_PREFIX}:(-?\\d+)$`), async (ctx: Context) => {
    const channel = await loadOwnedChannel(ctx);
    if (!channel) return;
    const next = channel.moderation_enabled === 0;
    await setModerationEnabled(channel.chat_id, channel.added_by, next);
    await ctx.answerCallbackQuery({
      text: next ? "Модерация включена 🛡" : "Модерация выключена",
    });
    const updated = await getChannel(channel.chat_id);
    if (updated) await renderDetail(ctx, updated);
  });

  // Капча: подтверждение заявителем в его личке. НЕ проверяем владение —
  // нажимает сам заявитель. chat_id канала берём из callback_data, заявителя —
  // из ctx.from.id.
  bot.callbackQuery(new RegExp(`^${CAP_PREFIX}:(-?\\d+)$`), async (ctx: Context) => {
    const userId = ctx.from?.id;
    const match = ctx.match;
    if (!userId || !match || !Array.isArray(match) || match[1] === undefined) {
      await ctx.answerCallbackQuery();
      return;
    }
    const chatId = Number(match[1]);
    const pending = await getCaptchaPending(chatId, userId);
    if (!pending) {
      // Истекло, уже подтверждено или заявки не было — идемпотентный выход.
      await ctx.answerCallbackQuery({ text: "Время вышло или уже подтверждено." });
      return;
    }
    try {
      await ctx.api.approveChatJoinRequest(chatId, userId);
      await logJoin({
        chatId,
        userId,
        username: pending.username,
        decision: "approved",
        requestedAt: pending.requested_at,
      });
      await deleteCaptchaPending(chatId, userId);
      await ctx.answerCallbackQuery({ text: "Готово, вы приняты ✅" });
      try {
        await ctx.editMessageText("Готово, вы приняты ✅");
      } catch {
        // Сообщение могло быть недоступно для редактирования — не критично.
      }
    } catch (err) {
      console.error(`Капча: не удалось одобрить user=${userId} chat=${chatId}:`, err);
      await ctx.answerCallbackQuery({ text: "Не удалось принять заявку, попробуйте позже." });
    }
  });
}
