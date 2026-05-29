import { beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

const dbPath = `/private/tmp/gatekeepeer-test-${process.pid}-${Date.now()}.sqlite`;

type DbModule = typeof import("../src/db.ts");
let db: DbModule;
let commandsModule: typeof import("../src/handlers/commands.ts");
let callbacksModule: typeof import("../src/handlers/callbacks.ts");
let joinRequestModule: typeof import("../src/handlers/joinRequest.ts");
let chatMemberModule: typeof import("../src/handlers/chatMember.ts");

function seedLegacyDb(): void {
  const legacy = new Database(dbPath, { create: true });
  try {
    legacy.run(`
      CREATE TABLE channels (
        chat_id      INTEGER PRIMARY KEY,
        title        TEXT,
        type         TEXT,
        added_by     INTEGER NOT NULL,
        auto_approve INTEGER NOT NULL DEFAULT 1,
        active       INTEGER NOT NULL DEFAULT 1,
        created_at   INTEGER NOT NULL
      )
    `);
    legacy.run(`
      CREATE TABLE join_events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id    INTEGER NOT NULL,
        user_id    INTEGER NOT NULL,
        username   TEXT,
        decision   TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);

    const insertChannel = legacy.query(`
      INSERT INTO channels (chat_id, title, type, added_by, auto_approve, active, created_at)
      VALUES ($chat_id, $title, $type, $added_by, $auto_approve, $active, $created_at)
    `);
    insertChannel.run({
      $chat_id: -100,
      $title: "Owner one",
      $type: "channel",
      $added_by: 1,
      $auto_approve: 1,
      $active: 1,
      $created_at: 1_000,
    });
    insertChannel.run({
      $chat_id: -200,
      $title: "Owner two",
      $type: "channel",
      $added_by: 2,
      $auto_approve: 1,
      $active: 1,
      $created_at: 2_000,
    });

    const insertEvent = legacy.query(`
      INSERT INTO join_events (chat_id, user_id, username, decision, created_at)
      VALUES ($chat_id, $user_id, $username, $decision, $created_at)
    `);
    insertEvent.run({
      $chat_id: -100,
      $user_id: 10,
      $username: "dup",
      $decision: "approved",
      $created_at: 10_000,
    });
    insertEvent.run({
      $chat_id: -100,
      $user_id: 10,
      $username: "dup",
      $decision: "approved",
      $created_at: 10_000,
    });
    insertEvent.run({
      $chat_id: -100,
      $user_id: 11,
      $username: "unique",
      $decision: "approved",
      $created_at: 11_000,
    });
    insertEvent.run({
      $chat_id: -100,
      $user_id: 12,
      $username: "declined",
      $decision: "declined",
      $created_at: 12_000,
    });
    insertEvent.run({
      $chat_id: -200,
      $user_id: 20,
      $username: "other",
      $decision: "approved",
      $created_at: 20_000,
    });
  } finally {
    legacy.close();
  }
}

beforeAll(async () => {
  process.env.BOT_TOKEN = "test-token";
  process.env.WEBHOOK_URL = "https://example.com";
  process.env.WEBHOOK_SECRET = "test-secret-1234567890_ABCDEFGHijkl";
  process.env.DB_PATH = dbPath;

  seedLegacyDb();
  db = await import("../src/db.ts");
  commandsModule = await import("../src/handlers/commands.ts");
  callbacksModule = await import("../src/handlers/callbacks.ts");
  joinRequestModule = await import("../src/handlers/joinRequest.ts");
  chatMemberModule = await import("../src/handlers/chatMember.ts");
});

type Handler = (ctx: any) => Promise<void> | void;

function commandHarness(): { bot: any; handlers: Record<string, Handler> } {
  const handlers: Record<string, Handler> = {};
  return {
    bot: {
      command(name: string, handler: Handler): void {
        handlers[name] = handler;
      },
    },
    handlers,
  };
}

function callbackHarness(): {
  bot: any;
  handler: Handler | null;
  pattern: RegExp | null;
} {
  let handler: Handler | null = null;
  let pattern: RegExp | null = null;
  return {
    bot: {
      callbackQuery(nextPattern: RegExp, nextHandler: Handler): void {
        pattern = nextPattern;
        handler = nextHandler;
      },
    },
    get handler() {
      return handler;
    },
    get pattern() {
      return pattern;
    },
  };
}

function eventHarness(): { bot: any; handlers: Record<string, Handler> } {
  const handlers: Record<string, Handler> = {};
  return {
    bot: {
      on(name: string, handler: Handler): void {
        handlers[name] = handler;
      },
    },
    handlers,
  };
}

describe("database migrations", () => {
  test("migrates legacy schema and backfills stats after deduplication", async () => {
    expect(await db.statsByOwner(1)).toEqual([
      { chat_id: -100, title: "Owner one", approved: 2 },
    ]);
    expect(await db.statsByOwner(2)).toEqual([
      { chat_id: -200, title: "Owner two", approved: 1 },
    ]);
  });
});

describe("channel ownership", () => {
  test("does not transfer ownership when an existing channel is re-registered", async () => {
    await db.upsertChannel({
      chatId: -300,
      title: "Original",
      type: "channel",
      addedBy: 1,
    });
    await db.setAutoApprove(-300, 1, false);

    await db.upsertChannel({
      chatId: -300,
      title: "Renamed",
      type: "channel",
      addedBy: 2,
    });

    const channel = await db.getChannel(-300);
    expect(channel?.added_by).toBe(1);
    expect(channel?.title).toBe("Renamed");
    expect(channel?.auto_approve).toBe(0);
    expect(await db.setAutoApprove(-300, 2, true)).toBe(false);
    expect(await db.setAutoApprove(-300, 1, true)).toBe(true);
  });
});

describe("join event accounting", () => {
  test("counts repeated delivery of the same approved request only once", async () => {
    await db.upsertChannel({
      chatId: -400,
      title: "Webhook retry",
      type: "channel",
      addedBy: 1,
    });

    const event = {
      chatId: -400,
      userId: 42,
      username: "retry",
      decision: "approved" as const,
      requestedAt: 123_456,
    };
    await db.logJoin(event);
    await db.logJoin(event);

    expect(await db.statsByOwner(1)).toContainEqual({
      chat_id: -400,
      title: "Webhook retry",
      approved: 1,
    });
  });

  test("retention pruning does not change all-time approved stats", async () => {
    const before = (await db.statsByOwner(1)).find(
      (stat) => stat.chat_id === -100,
    );
    expect(before?.approved).toBe(2);

    const removed = await db.pruneJoinEvents(0);
    expect(removed).toBeGreaterThan(0);

    const after = (await db.statsByOwner(1)).find(
      (stat) => stat.chat_id === -100,
    );
    expect(after?.approved).toBe(2);
  });
});

describe("commands", () => {
  test("start and help reply with onboarding text", async () => {
    const { bot, handlers } = commandHarness();
    commandsModule.registerCommands(bot);
    const replies: unknown[] = [];
    const ctx = {
      reply: async (...args: unknown[]) => {
        replies.push(args);
      },
    };

    await handlers.start?.(ctx);
    await handlers.help?.(ctx);

    expect(replies).toHaveLength(2);
    expect(String((replies[0] as unknown[])[0])).toContain("/channels");
    expect(String((replies[1] as unknown[])[0])).toContain("/stats");
  });

  test("management commands ignore non-private chats", async () => {
    const { bot, handlers } = commandHarness();
    commandsModule.registerCommands(bot);
    const replies: unknown[] = [];
    const ctx = {
      chat: { type: "supergroup" },
      from: { id: 1 },
      reply: async (...args: unknown[]) => {
        replies.push(args);
      },
    };

    await handlers.channels?.(ctx);
    await handlers.status?.(ctx);
    await handlers.stats?.(ctx);

    expect(replies).toEqual([]);
  });

  test("channels, status, and stats are scoped to the requesting owner", async () => {
    await db.upsertChannel({
      chatId: -500,
      title: "Owner scoped",
      type: "channel",
      addedBy: 50,
    });
    await db.upsertChannel({
      chatId: -501,
      title: "Other owner",
      type: "channel",
      addedBy: 51,
    });
    await db.logJoin({
      chatId: -500,
      userId: 5000,
      username: "owner",
      decision: "approved",
      requestedAt: 5000,
    });
    await db.logJoin({
      chatId: -501,
      userId: 5100,
      username: "other",
      decision: "approved",
      requestedAt: 5100,
    });

    const { bot, handlers } = commandHarness();
    commandsModule.registerCommands(bot);
    const replies: unknown[][] = [];
    const ctx = {
      chat: { type: "private" },
      from: { id: 50 },
      reply: async (...args: unknown[]) => {
        replies.push(args);
      },
    };

    await handlers.channels?.(ctx);
    await handlers.status?.(ctx);
    await handlers.stats?.(ctx);

    expect(String(replies[0]?.[0])).toContain("Ваши каналы");
    expect(replies[0]?.[1]).toHaveProperty("reply_markup");
    expect(String(replies[1]?.[0])).toContain("Owner scoped");
    expect(String(replies[1]?.[0])).not.toContain("Other owner");
    expect(String(replies[2]?.[0])).toContain("Принято заявок: 1");
    expect(String(replies[2]?.[0])).toContain("Owner scoped");
    expect(String(replies[2]?.[0])).not.toContain("Other owner");
  });

  test("channels, status, and stats report empty state for unknown owners", async () => {
    const { bot, handlers } = commandHarness();
    commandsModule.registerCommands(bot);
    const replies: unknown[][] = [];
    const ctx = {
      chat: { type: "private" },
      from: { id: 999_999 },
      reply: async (...args: unknown[]) => {
        replies.push(args);
      },
    };

    await handlers.channels?.(ctx);
    await handlers.status?.(ctx);
    await handlers.stats?.(ctx);

    expect(String(replies[0]?.[0])).toContain("пока нет подключённых каналов");
    expect(replies[1]?.[0]).toBe("Нет подключённых каналов.");
    expect(replies[2]?.[0]).toBe("Нет подключённых каналов.");
  });
});

describe("callbacks", () => {
  test("toggle callback validates pattern and private chat", async () => {
    const harness = callbackHarness();
    callbacksModule.registerCallbacks(harness.bot);

    expect(harness.pattern?.test("toggle:-123")).toBe(true);
    expect(harness.pattern?.test("toggle:not-a-number")).toBe(false);

    const answers: unknown[][] = [];
    await harness.handler?.({
      chat: { type: "supergroup" },
      from: { id: 1 },
      match: ["toggle:-100", "-100"],
      answerCallbackQuery: async (...args: unknown[]) => {
        answers.push(args);
      },
    });

    expect(answers).toEqual([[]]);
  });

  test("toggle callback rejects channels owned by someone else", async () => {
    await db.upsertChannel({
      chatId: -600,
      title: "Private toggle",
      type: "channel",
      addedBy: 60,
    });
    const harness = callbackHarness();
    callbacksModule.registerCallbacks(harness.bot);
    const answers: unknown[][] = [];

    await harness.handler?.({
      chat: { type: "private" },
      from: { id: 61 },
      match: ["toggle:-600", "-600"],
      answerCallbackQuery: async (...args: unknown[]) => {
        answers.push(args);
      },
    });

    expect(answers).toEqual([[{ text: "Этот канал вам не принадлежит." }]]);
    expect((await db.getChannel(-600))?.auto_approve).toBe(1);
  });

  test("toggle callback flips auto approve and refreshes markup for the owner", async () => {
    await db.upsertChannel({
      chatId: -601,
      title: "Toggle me",
      type: "channel",
      addedBy: 60,
    });
    const harness = callbackHarness();
    callbacksModule.registerCallbacks(harness.bot);
    const answers: unknown[][] = [];
    const edits: unknown[][] = [];

    await harness.handler?.({
      chat: { type: "private" },
      from: { id: 60 },
      match: ["toggle:-601", "-601"],
      answerCallbackQuery: async (...args: unknown[]) => {
        answers.push(args);
      },
      editMessageReplyMarkup: async (...args: unknown[]) => {
        edits.push(args);
      },
    });

    expect((await db.getChannel(-601))?.auto_approve).toBe(0);
    expect(answers).toEqual([[{ text: "Авто-приём выключен ⛔️" }]]);
    expect(edits[0]?.[0]).toHaveProperty("reply_markup");
  });
});

describe("join request handler", () => {
  test("ignores unmanaged, inactive, and disabled channels", async () => {
    await db.upsertChannel({
      chatId: -700,
      title: "Disabled",
      type: "channel",
      addedBy: 70,
    });
    await db.setAutoApprove(-700, 70, false);
    await db.upsertChannel({
      chatId: -701,
      title: "Inactive",
      type: "channel",
      addedBy: 70,
    });
    await db.deactivateChannel(-701);

    const { bot, handlers } = eventHarness();
    joinRequestModule.registerJoinRequest(bot);
    let approvals = 0;
    const approveChatJoinRequest = async () => {
      approvals += 1;
    };

    for (const chatId of [-799, -700, -701]) {
      await handlers.chat_join_request?.({
        chatJoinRequest: {
          chat: { id: chatId },
          from: { id: 7000, username: "pending" },
          date: 7000,
        },
        approveChatJoinRequest,
      });
    }

    expect(approvals).toBe(0);
  });

  test("approves and records active auto-approve channel requests", async () => {
    await db.upsertChannel({
      chatId: -702,
      title: "Approvals",
      type: "channel",
      addedBy: 70,
    });
    const { bot, handlers } = eventHarness();
    joinRequestModule.registerJoinRequest(bot);
    const approvedUsers: number[] = [];

    await handlers.chat_join_request?.({
      chatJoinRequest: {
        chat: { id: -702 },
        from: { id: 7020, username: "approved" },
        date: 7020,
      },
      approveChatJoinRequest: async (userId: number) => {
        approvedUsers.push(userId);
      },
    });

    expect(approvedUsers).toEqual([7020]);
    expect(await db.statsByOwner(70)).toContainEqual({
      chat_id: -702,
      title: "Approvals",
      approved: 1,
    });
  });
});

describe("chat member handler", () => {
  test("registers a new channel to the chat creator and notifies that owner", async () => {
    const { bot, handlers } = eventHarness();
    chatMemberModule.registerChatMember(bot);
    const sentMessages: unknown[][] = [];

    await handlers.my_chat_member?.({
      myChatMember: {
        chat: { id: -800, type: "channel", title: "Creator owned" },
        new_chat_member: { status: "administrator", can_invite_users: true },
      },
      api: {
        getChatAdministrators: async () => [
          { status: "administrator", user: { id: 801 } },
          { status: "creator", user: { id: 800 } },
        ],
        sendMessage: async (...args: unknown[]) => {
          sentMessages.push(args);
        },
      },
    });

    expect((await db.getChannel(-800))?.added_by).toBe(800);
    expect(sentMessages[0]?.[0]).toBe(800);
    expect(String(sentMessages[0]?.[1])).toContain("Creator owned");
  });

  test("reactivates an existing channel without transferring owner or sending duplicate DM", async () => {
    await db.upsertChannel({
      chatId: -801,
      title: "Existing",
      type: "channel",
      addedBy: 810,
    });
    await db.deactivateChannel(-801);
    const { bot, handlers } = eventHarness();
    chatMemberModule.registerChatMember(bot);
    let adminFetches = 0;
    let sentMessages = 0;

    await handlers.my_chat_member?.({
      myChatMember: {
        chat: { id: -801, type: "channel", title: "Existing renamed" },
        new_chat_member: { status: "administrator", can_invite_users: true },
      },
      api: {
        getChatAdministrators: async () => {
          adminFetches += 1;
          return [{ status: "creator", user: { id: 999 } }];
        },
        sendMessage: async () => {
          sentMessages += 1;
        },
      },
    });

    const channel = await db.getChannel(-801);
    expect(channel?.active).toBe(1);
    expect(channel?.added_by).toBe(810);
    expect(channel?.title).toBe("Existing renamed");
    expect(adminFetches).toBe(0);
    expect(sentMessages).toBe(0);
  });

  test("skips unsupported chat types and deactivates on permission loss", async () => {
    await db.upsertChannel({
      chatId: -802,
      title: "Permission loss",
      type: "channel",
      addedBy: 820,
    });
    const { bot, handlers } = eventHarness();
    chatMemberModule.registerChatMember(bot);

    await handlers.my_chat_member?.({
      myChatMember: {
        chat: { id: -803, type: "group", title: "Plain group" },
        new_chat_member: { status: "administrator", can_invite_users: true },
      },
      api: {
        getChatAdministrators: async () => {
          throw new Error("should not fetch admins for unsupported chat type");
        },
      },
    });

    expect(await db.getChannel(-803)).toBeNull();

    await handlers.my_chat_member?.({
      myChatMember: {
        chat: { id: -802, type: "channel", title: "Permission loss" },
        new_chat_member: { status: "administrator", can_invite_users: false },
      },
    });

    expect((await db.getChannel(-802))?.active).toBe(0);
  });
});
