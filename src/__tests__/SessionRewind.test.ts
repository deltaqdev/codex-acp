import {describe, expect, it, vi} from "vitest";
import type {ServerNotification} from "../app-server";
import type {Thread, ThreadItem, ThreadReadResponse, ThreadTokenUsage, Turn} from "../app-server/v2";
import {
    isRewindReloadNotification,
    isRewindReloadStatus,
    restoreContextUsage,
    rewindSession,
    type SessionRewindDependencies,
} from "../SessionRewind";
import {SessionListSubscriptions, type SessionListChanges} from "../SessionListSubscriptions";

function turn(id: string, items: ThreadItem[]): Turn {
    return {
        id, items, rootTurnId: null, itemsView: "full", status: "completed", error: null,
        startedAt: null, completedAt: null, durationMs: null,
    };
}

const user = (id: string, clientId: string | null = null): ThreadItem =>
    ({type: "userMessage", id, clientId, content: [{type: "text", text: id, text_elements: []}]} as ThreadItem);
const agent = (id: string): ThreadItem => ({type: "agentMessage", id, text: id, phase: null} as ThreadItem);
const reasoning = (id: string): ThreadItem => ({type: "reasoning", id, summary: [id], content: []} as ThreadItem);
const command = (id: string): ThreadItem => ({type: "commandExecution", id} as ThreadItem);
const review = (id: string): ThreadItem => ({type: "enteredReviewMode", id, review: "changes"} as ThreadItem);

// Three prompts: the second runs a command between two replies, the third was sent over v2 (`clientId`).
const TURNS = [
    turn("turn-1", [user("user-1"), reasoning("thought-1"), agent("reply-1")]),
    turn("turn-2", [user("user-2"), agent("reply-2a"), command("command-2"), agent("reply-2b")]),
    turn("turn-3", [user("user-3", "client-3"), review("review-3"), agent("reply-3")]),
];

function setup(
    options: {turns?: Turn[]; historyMode?: "paginated" | "legacy"; status?: {type: "idle"} | {type: "active"; activeFlags: []}} = {},
) {
    const history = {
        thread: {id: "thread-id", historyMode: options.historyMode ?? "paginated", status: options.status ?? {type: "idle"}, turns: options.turns ?? TURNS},
    } as unknown as ThreadReadResponse;
    const threadReadWithHistory = vi.fn(async () => history);
    const threadRevert = vi.fn(async () => ({thread: history.thread, turnsBackwardsCursor: null, itemsBackwardsCursor: null}));
    const reverted = vi.fn(async (_turns: {kept: string[]; discarded: string[]}) => {});
    // Records whether `thread/revert` ran inside the reload window.
    let reloading = false;
    const revertedWhileReloading: boolean[] = [];
    threadRevert.mockImplementation(async () => {
        revertedWhileReloading.push(reloading);
        return {thread: history.thread, turnsBackwardsCursor: null, itemsBackwardsCursor: null};
    });
    const whileReloading = vi.fn(async (revert: () => Promise<void>) => {
        reloading = true;
        try { await revert(); } finally { reloading = false; }
    });
    const dependencies = (protocolVersion: 1 | 2): SessionRewindDependencies => ({
        codexClient: {threadReadWithHistory, threadRevert} as unknown as SessionRewindDependencies["codexClient"],
        protocolVersion,
        whileReloading,
        reverted,
    });
    return {threadReadWithHistory, threadRevert, reverted, revertedWhileReloading, dependencies};
}

describe("rewindSession", () => {
    it.each([
        {name: "the reply that ends a turn", version: 1, to: "reply-1", beforeTurnId: "turn-2", lastMessageId: "reply-1"},
        {name: "a thought keeps its whole turn", version: 1, to: "thought-1", beforeTurnId: "turn-2", lastMessageId: "reply-1"},
        {name: "a reply inside a turn keeps its whole turn", version: 1, to: "reply-2a", beforeTurnId: "turn-3", lastMessageId: "reply-2b"},
        {name: "a v1 user message by its item id", version: 1, to: "user-2", beforeTurnId: "turn-3", lastMessageId: "reply-2b"},
        {name: "a v2 user message by its client id", version: 2, to: "client-3", beforeTurnId: null, lastMessageId: "reply-3"},
        {name: "a v2 user message without a client id", version: 2, to: "user-1", beforeTurnId: "turn-2", lastMessageId: "reply-1"},
        {name: "a v2 review message", version: 2, to: "review-3", beforeTurnId: null, lastMessageId: "reply-3"},
    ] as const)("reverts before the turn after $name", async ({version, to, beforeTurnId, lastMessageId}) => {
        const {threadRevert, reverted, revertedWhileReloading, dependencies} = setup();

        const response = await rewindSession({sessionId: "thread-id", toMessageId: to}, dependencies(version));

        expect(response).toEqual({lastMessageId});
        if (beforeTurnId === null) {
            expect(threadRevert).not.toHaveBeenCalled();
            expect(reverted).not.toHaveBeenCalled();
        } else {
            const ids = TURNS.map(each => each.id);
            const kept = ids.slice(0, ids.indexOf(beforeTurnId));
            expect(threadRevert.mock.calls).toEqual([[{threadId: "thread-id", beforeTurnId}]]);
            expect(revertedWhileReloading).toEqual([true]);
            expect(reverted.mock.calls).toEqual([[{kept, discarded: ids.slice(kept.length)}]]);
        }
    });

    it("keeps everything and reverts nothing for the last message", async () => {
        const {threadRevert, reverted, dependencies} = setup();

        expect(await rewindSession({sessionId: "thread-id", toMessageId: "reply-3"}, dependencies(1)))
            .toEqual({lastMessageId: "reply-3"});
        expect(threadRevert).not.toHaveBeenCalled();
        expect(reverted).not.toHaveBeenCalled();
    });

    it.each([
        {name: "an id no item has", version: 1, to: "missing"},
        {name: "a tool call, which is no message", version: 1, to: "command-2"},
        {name: "a client id on v1, which never sent it", version: 1, to: "client-3"},
        {name: "a review message on v1, which sent it without an id", version: 1, to: "review-3"},
        {name: "a user message's item id on v2 when it has a client id", version: 2, to: "user-3"},
    ] as const)("refuses $name as an unknown message", async ({version, to}) => {
        const {threadRevert, dependencies} = setup();

        await expect(rewindSession({sessionId: "thread-id", toMessageId: to}, dependencies(version))).rejects.toMatchObject({
            code: -32002,
            data: {reason: "unknown_message_id", sessionId: "thread-id", messageId: to},
        });
        expect(threadRevert).not.toHaveBeenCalled();
    });

    it("refuses a thread with a running turn", async () => {
        const {threadRevert, dependencies} = setup({status: {type: "active", activeFlags: []}});

        await expect(rewindSession({sessionId: "thread-id", toMessageId: "reply-1"}, dependencies(1))).rejects.toMatchObject({
            code: -32600,
            data: {reason: "turn_running"},
        });
        expect(threadRevert).not.toHaveBeenCalled();
    });

    it("refuses a legacy thread, which Codex cannot revert, unless nothing follows the message", async () => {
        const {threadRevert, dependencies} = setup({historyMode: "legacy"});

        await expect(rewindSession({sessionId: "thread-id", toMessageId: "reply-1"}, dependencies(1))).rejects.toMatchObject({
            code: -32600,
            data: {reason: "unsupported_history"},
        });
        expect(await rewindSession({sessionId: "thread-id", toMessageId: "reply-3"}, dependencies(1)))
            .toEqual({lastMessageId: "reply-3"});
        expect(threadRevert).not.toHaveBeenCalled();
    });
});

const own = (method: string, params: Record<string, unknown> = {}) =>
    ({method, params: {threadId: "thread-id", ...params}} as unknown as ServerNotification);

describe("the reload window of a rewind", () => {
    it("drops the thread's own notifications of the reload, and only while it lasts", () => {
        const session = {sessionId: "thread-id", reloadingForRewind: true};
        const reload = [
            own("thread/status/changed", {status: {type: "notLoaded"}}),
            own("warning", {message: "startup warning"}),
            own("thread/status/changed", {status: {type: "idle"}}),
            own("thread/tokenUsage/updated"),
        ];
        expect(reload.map(event => isRewindReloadNotification(session, event))).toEqual([true, true, true, true]);
        expect(isRewindReloadNotification(session, {method: "warning", params: {threadId: "child", message: "w"}} as ServerNotification))
            .toBe(false);
        session.reloadingForRewind = false;
        expect(reload.map(event => isRewindReloadNotification(session, event))).toEqual([false, false, false, false]);
    });

    it.each([
        own("turn/started", {turn: {id: "goal-turn"}}),
        own("thread/status/changed", {status: {type: "active", activeFlags: []}}),
    ])("ends the window when Codex starts a turn: %j", start => {
        const session = {sessionId: "thread-id", reloadingForRewind: true};

        expect(isRewindReloadNotification(session, start)).toBe(false);
        expect(session.reloadingForRewind).toBe(false);
        expect(isRewindReloadNotification(session, own("item/agentMessage/delta", {delta: "goal"}))).toBe(false);
    });

    it("hides only the reload's status changes from the session list, and keeps thread/reverted", () => {
        const sessions = new Map([["thread-id", {sessionId: "thread-id", reloadingForRewind: true}]]);
        const sessionOf = (threadId: string) => sessions.get(threadId);

        expect(isRewindReloadStatus(sessionOf, own("thread/status/changed", {status: {type: "notLoaded"}}))).toBe(true);
        expect(isRewindReloadStatus(sessionOf, own("thread/status/changed", {status: {type: "idle"}}))).toBe(true);
        expect(isRewindReloadStatus(sessionOf, own("thread/status/changed", {status: {type: "active", activeFlags: []}}))).toBe(false);
        expect(isRewindReloadStatus(sessionOf, own("thread/reverted"))).toBe(false);
        expect(isRewindReloadStatus(sessionOf, own("turn/started", {turn: {id: "goal-turn"}}))).toBe(false);
        expect(isRewindReloadStatus(sessionOf, {method: "thread/status/changed", params: {threadId: "other", status: {type: "idle"}}} as ServerNotification))
            .toBe(false);
    });
});

describe("restoreContextUsage", () => {
    const usage = (tokens: number): ThreadTokenUsage => {
        const breakdown = {totalTokens: tokens, inputTokens: tokens, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0};
        return {total: breakdown, last: breakdown, modelContextWindow: 1_000};
    };

    it("restores the usage of the newest kept turn that reported one and forgets the discarded turns", () => {
        const session = {
            turnTokenUsage: new Map([["turn-1", usage(100)], ["turn-3", usage(300)]]),
            lastTokenUsage: null, totalTokenUsage: null, modelContextWindow: null,
        };

        expect(restoreContextUsage(session, {kept: ["turn-1", "turn-2"], discarded: ["turn-3"]}))
            .toEqual({sessionUpdate: "usage_update", used: 100, size: 1_000});
        expect(session.lastTokenUsage).toMatchObject({totalTokens: 100});
        expect([...session.turnTokenUsage.keys()]).toEqual(["turn-1"]);
    });

    it("sends nothing when no kept turn reported usage to this process", () => {
        const session = {turnTokenUsage: new Map([["turn-3", usage(300)]]), lastTokenUsage: null, totalTokenUsage: null, modelContextWindow: null};

        expect(restoreContextUsage(session, {kept: ["turn-1"], discarded: ["turn-3"]})).toBeNull();
        expect(session.lastTokenUsage).toBeNull();
    });
});

describe("the session list after a revert", () => {
    it("sends the row of a reverted thread to a list subscription", async () => {
        vi.useFakeTimers();
        try {
            const reverted = {
                id: "thread-id", cwd: "/repo", updatedAt: 1_000, status: {type: "idle"}, ephemeral: false, source: "vscode",
                path: "/codex-home/sessions/rollout-thread-id.jsonl",
            } as unknown as Thread;
            const sent: SessionListChanges[] = [];
            const clockStart = Date.now();
            const subscriptions = new SessionListSubscriptions({
                reader: () => ({
                    threadList: vi.fn(async () => ({data: [], nextCursor: null, backwardsCursor: null})),
                    threadRead: vi.fn(async () => ({thread: reverted})),
                }) as never,
                codexHome: () => null,
                rows: async entries => entries.map(({thread}) => ({sessionId: thread.id, cwd: thread.cwd})),
                scopeCwds: cwd => [cwd],
                notify: async changes => { sent.push(changes); },
                watchCodexHome: () => ({stop: vi.fn()}),
                timings: {quietMs: 150, maxWaitMs: 1_000, ownChangeDelayMs: 20, minChangeIntervalMs: 1_000, fallbackIntervalMs: 30_000},
                // The clock starts at second 1,000 of `updatedAt`, where the thread is.
                now: () => 1_000_000 + Date.now() - clockStart,
            });
            const subscriptionId = await subscriptions.subscribe("/repo");

            subscriptions.observe({method: "thread/reverted", params: {threadId: "thread-id"}} as ServerNotification);
            await vi.advanceTimersByTimeAsync(20);

            expect(sent).toEqual([{subscriptionId, sessions: [{sessionId: "thread-id", cwd: "/repo"}], removed: []}]);
            subscriptions.dispose();
        } finally {
            vi.useRealTimers();
        }
    });
});
