// Авто-регистрация канала: реагируем на изменение статуса самого бота.
// Стал админом с правом приглашать ИЛИ удалять сообщения → регистрируем канал
// на владельца (создателя канала) и пишем ему в личку. Право приглашать включает
// приём заявок, право удалять — модерацию спама; их можно использовать порознь.
// Потеря обоих прав / понижение / удаление → помечаем канал неактивным.

import type { Bot, Context } from "grammy";
import { deactivateChannel, getChannel, markWelcomePending, upsertChannel } from "../db.ts";

export function registerChatMember(bot: Bot): void {
  bot.on("my_chat_member", async (ctx: Context) => {
    const upd = ctx.myChatMember;
    if (!upd) return;

    const { chat, new_chat_member: member } = upd;

    // Управляем только каналами и супергруппами (там есть заявки на вступление).
    if (chat.type !== "channel" && chat.type !== "supergroup") return;

    const isAdmin = member.status === "administrator";
    const canInvite = isAdmin && member.can_invite_users === true;
    const canDelete = isAdmin && member.can_delete_messages === true;

    // Бот полезен, если может хоть что-то: приглашать (приём заявок) или удалять
    // (модерация). Без обоих прав управлять каналом нечем — деактивируем.
    if (canInvite || canDelete) {
      const existing = await getChannel(chat.id);

      // Владелец — создатель канала (creator), а не тот, кто добавил бота:
      // иначе любой со-админ с правом назначать админов мог бы первым застолбить
      // канал. Для уже известного канала владельца не пересчитываем (он
      // зафиксирован) — заодно не зависим от Telegram на пути реактивации.
      let ownerId: number;
      if (existing) {
        ownerId = existing.added_by;
      } else {
        try {
          const admins = await ctx.api.getChatAdministrators(chat.id);
          const creator = admins.find((a) => a.status === "creator");
          if (!creator) {
            console.error(`Не найден создатель канала chat=${chat.id}, регистрация пропущена`);
            return;
          }
          ownerId = creator.user.id;
        } catch (err) {
          console.error(`Не удалось получить админов канала chat=${chat.id}:`, err);
          return;
        }
      }

      // Каналы и супергруппы всегда имеют title.
      await upsertChannel({
        chatId: chat.id,
        title: chat.title,
        type: chat.type,
        addedBy: ownerId,
        canInvite,
        canDelete,
      });

      // Уведомляем владельца только при первой регистрации, чтобы не слать
      // «подключён» повторно при каждом изменении прав бота. Текст зависит от
      // того, что боту доступно по правам.
      if (!existing) {
        const title = chat.title;
        const caps: string[] = [];
        if (canInvite) caps.push("• авто-приём заявок на вступление");
        if (canDelete) caps.push("• модерация спама (включите в /channels)");
        try {
          await ctx.api.sendMessage(
            ownerId,
            `✅ Канал «${title}» подключён.\nДоступно:\n${caps.join("\n")}\n\n` +
              `Управление — /channels.`,
          );
        } catch {
          // Владелец ещё не запускал бота в личке — DM невозможен. Откладываем
          // приветствие: доставим его на /start (см. handlers/commands.ts).
          await markWelcomePending(chat.id, true);
        }
      }
      return;
    }

    // Бот не админ или админ без полезных прав (понизили / kicked / left /
    // сняли и право приглашать, и право удалять) — управлять нечем.
    await deactivateChannel(chat.id);
  });
}
