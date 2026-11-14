import {afterEach, describe, expect, it, vi} from "vitest";
import * as acp from "@agentclientprotocol/sdk/unstable";
import * as acpV2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {createAcpAgentRouter} from "../../AcpAgentRouter";
import {CodexAcpServer} from "../../CodexAcpServer";
import {CodexAcpClient} from "../../CodexAcpClient";
import {CodexAppServerClient} from "../../CodexAppServerClient";
import {SESSION_REWIND_CAPABILITY_KEY, SESSION_REWIND_METHOD} from "../../SessionRewind";
import {createTestSessionState} from "../acp-test-utils";
import {createMockConnections} from "./test-utils";

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).reverse().forEach(dispose => dispose()));

const TURNS = [
    {id: "turn-1", items: [{type: "userMessage", id: "user-1", clientId: null, content: []}, {type: "agentMessage", id: "reply-1", text: "A", phase: null}]},
    {id: "turn-2", items: [{type: "userMessage", id: "user-2", clientId: null, content: []}, {type: "agentMessage", id: "reply-2", text: "B", phase: null}]},
];

type Notify = (notification: Record<string, unknown>) => void;

async function connect(version: 1 | 2, options: {revert?: Promise<void>; reload?: (notify: Notify) => void} = {}) {
    const mocks = createMockConnections();
    const notify: Notify = notification => mocks.getUnhandledNotificationHandler()!(notification);
    mocks.mockCodexConnection.sendRequest.mockImplementation(async (method: string, params: any) => {
        if (method === "thread/revert") {
            await options.revert;
            // Codex reloads the thread before it answers.
            options.reload?.(notify);
        }
        switch (method) {
            case "thread/read":
                return {thread: {id: params.threadId, historyMode: "paginated", status: {type: "idle"}, turns: []}};
            case "thread/turns/list":
                return {data: params.sortDirection === "desc" ? TURNS.slice(-1) : TURNS, nextCursor: null, backwardsCursor: null};
            case "thread/revert":
                return {thread: {id: params.threadId, turns: []}, turnsBackwardsCursor: null, itemsBackwardsCursor: null};
            default:
                return {};
        }
    });
    const appServer = new CodexAppServerClient(mocks.mockCodexConnection);
    const client = new CodexAcpClient(appServer);
    vi.spyOn(client, "readAuthRequirement").mockResolvedValue({required: false, account: null});
    vi.spyOn(client, "getAgentConfiguredModelProvider").mockResolvedValue("openai");
    vi.spyOn(client, "getAccount").mockResolvedValue({account: null, requiresOpenaiAuth: false});
    let server: CodexAcpServer | null = null;
    const router = createAcpAgentRouter(connection => (server = new CodexAcpServer(connection, client)));
    const incoming = new TransformStream<Uint8Array, Uint8Array>();
    const outgoing = new TransformStream<Uint8Array, Uint8Array>();
    router.connect(acp.ndJsonStream(outgoing.writable, incoming.readable));
    const [toClient, toTest] = outgoing.readable.tee();
    const sent = recordMessages(toTest);
    const protocol = version === 1 ? acp : acpV2;
    const connection = protocol.client({name: "rewind-test"}).connect(acp.ndJsonStream(incoming.writable, toClient));
    cleanup.push(() => connection.close());
    const request = (method: string, params?: unknown) => (connection.agent.request as any)(method, params);
    const initialize = await request("initialize", version === 1
        ? {protocolVersion: 1, clientCapabilities: {}}
        : {protocolVersion: 2, info: {name: "rewind-test", version: "1"}, capabilities: {}});
    const sessionState = createTestSessionState({sessionId: "thread-id"});
    const agent = server as unknown as {
        sessions: Map<string, unknown>;
        startCodexTurnTracker(sessionId: string, ready: Promise<unknown>): void;
    };
    agent.sessions.set("thread-id", sessionState);
    // Codex notifications of the session reach the client through its tracker, as for an opened session.
    agent.startCodexTurnTracker("thread-id", Promise.resolve(sessionState));
    mocks.mockCodexConnection.sendRequest.mockClear();
    const reverts = () => mocks.mockCodexConnection.sendRequest.mock.calls.filter(([method]: [string]) => method === "thread/revert");
    const drained = () => client.waitForSessionNotifications("thread-id");
    return {request, initialize, sessionState, reverts, notify, sent, drained};
}

/** The `session/update` notifications the agent sent, as JSON text. */
function recordMessages(stream: ReadableStream<Uint8Array>): string[] {
    const updates: string[] = [];
    const decoder = new TextDecoder();
    const reader = stream.getReader();
    let buffered = "";
    const read = async (): Promise<void> => {
        for (;;) {
            const {done, value} = await reader.read();
            if (done) return;
            const lines = (buffered + decoder.decode(value, {stream: true})).split("\n");
            buffered = lines.pop() ?? "";
            for (const line of lines) if (line.includes('"session/update"')) updates.push(line);
        }
    };
    void read().catch(() => {});
    return updates;
}

const tokenUsage = (tokens: number) => {
    const breakdown = {totalTokens: tokens, inputTokens: tokens, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0};
    return {total: breakdown, last: breakdown, modelContextWindow: 1_000};
};

const reloadNoise: Record<string, unknown>[] = [
    {method: "thread/status/changed", params: {threadId: "thread-id", status: {type: "notLoaded"}}},
    {method: "warning", params: {threadId: "thread-id", message: "reload warning"}},
    {method: "thread/status/changed", params: {threadId: "thread-id", status: {type: "idle"}}},
];

describe.each([1, 2] as const)("_sh.rexa/session/rewind over ACP v%i", version => {
    it("is advertised in the agent capabilities", async () => {
        const {initialize} = await connect(version);
        const capabilities = version === 1 ? initialize.agentCapabilities : initialize.capabilities;
        expect(capabilities._meta[SESSION_REWIND_CAPABILITY_KEY]).toEqual({});
    });

    it("reverts the thread before the turn after the message and answers the last message kept", async () => {
        const {request, reverts} = await connect(version);

        expect(await request(SESSION_REWIND_METHOD, {sessionId: "thread-id", toMessageId: "reply-1"}))
            .toEqual({lastMessageId: "reply-1"});
        expect(reverts()).toEqual([["thread/revert", {threadId: "thread-id", beforeTurnId: "turn-2"}]]);
    });

    it("refuses a rewind while a turn runs", async () => {
        const {request, sessionState, reverts} = await connect(version);
        sessionState.codexReportedRunningTurnId = "turn-3";

        await expect(request(SESSION_REWIND_METHOD, {sessionId: "thread-id", toMessageId: "reply-1"}))
            .rejects.toMatchObject({code: -32600, data: {reason: "turn_running"}});
        expect(reverts()).toEqual([]);
    });

    it("holds new turns back until the revert ends", async () => {
        let finishRevert!: () => void;
        const {request, reverts} = await connect(version, {revert: new Promise(resolve => { finishRevert = resolve; })});

        const rewind = request(SESSION_REWIND_METHOD, {sessionId: "thread-id", toMessageId: "reply-1"});
        await vi.waitFor(() => expect(reverts()).toHaveLength(1));
        // The turn-start queue that prompts wait in is taken: a second rewind finds the session busy.
        await expect(request(SESSION_REWIND_METHOD, {sessionId: "thread-id", toMessageId: "reply-1"}))
            .rejects.toMatchObject({data: {reason: "turn_running"}});
        finishRevert();

        expect(await rewind).toEqual({lastMessageId: "reply-1"});
        expect(await request(SESSION_REWIND_METHOD, {sessionId: "thread-id", toMessageId: "reply-2"}))
            .toEqual({lastMessageId: "reply-2"});
    });

    it("keeps the reload from the client and sends the usage of the kept turn", async () => {
        const {request, notify, sent, drained} = await connect(version, {reload: notify => reloadNoise.forEach(notify)});
        notify({method: "thread/tokenUsage/updated", params: {threadId: "thread-id", turnId: "turn-1", tokenUsage: tokenUsage(100)}});
        notify({method: "thread/tokenUsage/updated", params: {threadId: "thread-id", turnId: "turn-2", tokenUsage: tokenUsage(200)}});
        await drained();
        await vi.waitFor(() => expect(sent.filter(update => update.includes("usage_update"))).toHaveLength(2));
        sent.length = 0;

        expect(await request(SESSION_REWIND_METHOD, {sessionId: "thread-id", toMessageId: "reply-1"}))
            .toEqual({lastMessageId: "reply-1"});
        await vi.waitFor(() => expect(sent).toHaveLength(1));
        expect(sent[0]).toContain('"used":100');

        // After the window, the same notifications are the client's again.
        reloadNoise.forEach(notify);
        await drained();
        await vi.waitFor(() => expect(sent.some(update => update.includes("reload warning"))).toBe(true));
        expect(sent.some(update => update.includes("notLoaded"))).toBe(true);
    });

    it("refuses an unknown message id and an unknown session", async () => {
        const {request, reverts} = await connect(version);

        await expect(request(SESSION_REWIND_METHOD, {sessionId: "thread-id", toMessageId: "missing"}))
            .rejects.toMatchObject({code: -32002, data: {reason: "unknown_message_id"}});
        await expect(request(SESSION_REWIND_METHOD, {sessionId: "other", toMessageId: "reply-1"}))
            .rejects.toMatchObject({code: -32002});
        expect(reverts()).toEqual([]);
    });

    it.each([{}, {sessionId: "thread-id"}, {sessionId: "thread-id", toMessageId: ""}])("rejects malformed params %j", async params => {
        const {request, reverts} = await connect(version);

        await expect(request(SESSION_REWIND_METHOD, params)).rejects.toMatchObject({code: -32602});
        expect(reverts()).toEqual([]);
    });
});
