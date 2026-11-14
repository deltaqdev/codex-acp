// Real codex-acp + real `codex app-server`; only the model is a local mock.
import * as acp from "@agentclientprotocol/sdk/unstable";
import {afterEach, beforeEach, expect, it} from "vitest";
import type {SpawnedAgentFixture} from "../CodexACPAgent/e2e/spawned-agent-fixture";
import {legacySetSessionModel} from "../../AcpExtensions";
import {SESSION_REWIND_METHOD} from "../../SessionRewind";
import {
    connectAndLogin,
    describeIntegration,
    expectNoUnscriptedModelRequests,
    INTEGRATION_MODEL_ID,
    openSession,
    sendPrompt,
    spawnAgent,
    stopAll,
} from "./integration-fixture";
import {type MockResponsesServer, startMockResponsesServer, textResponse} from "./mock-responses-server";

describeIntegration("integration: session rewind", () => {
    let mock: MockResponsesServer;
    let agent: SpawnedAgentFixture;

    beforeEach(async () => {
        mock = await startMockResponsesServer();
        // Every model call gets "ok": the turns, and the title of the session.
        mock.setResponseHandler(() => textResponse("ok"));
        agent = await spawnAgent();
        await connectAndLogin(agent, mock.baseUrl);
    });

    afterEach(async () => {
        await stopAll(agent, mock);
    });

    /** What Codex sent the model for the prompt: the conversation it holds. */
    async function recall(sessionId: string): Promise<string> {
        const before = mock.requests.length;
        await sendPrompt(agent, sessionId, "Recall the code words");
        // The title of the session is a model call of its own, with the first prompt only.
        const sent = mock.requests.slice(before).map(request => JSON.stringify((request as {input: unknown}).input))
            .filter(input => input.includes("Recall the code words"));
        expect(sent).toHaveLength(1);
        return sent[0]!;
    }

    /** A new codex-acp process on the same Codex home, back on the session's model: a switch would compact first. */
    async function reopen(sessionId: string, method: typeof acp.methods.agent.session.load | typeof acp.methods.agent.session.resume): Promise<void> {
        agent = await agent.restart();
        await connectAndLogin(agent, mock.baseUrl);
        await agent.connection.request(method, {sessionId, cwd: agent.workspaceDir, mcpServers: []});
        await legacySetSessionModel(agent.connection, {sessionId, modelId: INTEGRATION_MODEL_ID.toString()});
    }

    /**
     * Scenario:
     * 1. Prompt A sets code word PELICAN, prompt B sets TANGERINE.
     * 2. The client rewinds to the reply of prompt A.
     * Expected:
     * - the rewind answers that reply as the last message kept, and the client sees nothing of the reload;
     * - the next prompt reaches the model without prompt B;
     * - a new process replays the session without prompt B on `session/load`, and leaves it out of the model
     *   input after `session/load` and after `session/resume`.
     */
    it("discards the turns after a message in place, also for a new process", async () => {
        const sessionId = await openSession(agent);
        await sendPrompt(agent, sessionId, "Code word A is PELICAN");
        const replyA = agent.readSessionUpdates(sessionId)
            .filter(update => update.sessionUpdate === "agent_message_chunk")
            .at(-1)?.messageId;
        expect(replyA).toEqual(expect.any(String));
        await sendPrompt(agent, sessionId, "Code word B is TANGERINE");

        const beforeRewind = agent.readSessionUpdates(sessionId).length;
        expect(await agent.connection.request(SESSION_REWIND_METHOD, {sessionId, toMessageId: replyA}))
            .toEqual({lastMessageId: replyA});
        // The client sees nothing of the reload: at most the usage of the kept turn.
        await new Promise(resolve => setTimeout(resolve, 500));
        expect(agent.readSessionUpdates(sessionId).slice(beforeRewind).map(update => update.sessionUpdate)
            .filter(kind => kind !== "usage_update")).toEqual([]);
        const sameProcess = await recall(sessionId);
        expect(sameProcess).toContain("PELICAN");
        expect(sameProcess).not.toContain("TANGERINE");

        const before = agent.readSessionUpdates(sessionId).length;
        await reopen(sessionId, acp.methods.agent.session.load);
        const replayed = JSON.stringify(agent.readSessionUpdates(sessionId).slice(before));
        expect(replayed).toContain("PELICAN");
        expect(replayed).toContain(replyA);
        expect(replayed).not.toContain("TANGERINE");
        const afterLoad = await recall(sessionId);
        expect(afterLoad).toContain("PELICAN");
        expect(afterLoad).not.toContain("TANGERINE");

        await reopen(sessionId, acp.methods.agent.session.resume);
        const afterResume = await recall(sessionId);
        expect(afterResume).toContain("PELICAN");
        expect(afterResume).not.toContain("TANGERINE");
        expectNoUnscriptedModelRequests(mock);
    });
}, 120_000);
