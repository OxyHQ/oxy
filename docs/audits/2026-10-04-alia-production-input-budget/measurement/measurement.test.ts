import { describe, expect, it, vi } from 'vitest';
import { generateText } from 'ai';
import { writeFileSync } from 'node:fs';
import { normalizeResponsesRequest } from '/home/nate/Oxy/oxy/.worktrees/1571-alia-machine-principal-20261004/packages/api/src/schemas/inferenceEdge.schemas.ts';
import { controlledInputBudget } from '/home/nate/Oxy/oxy/.worktrees/1571-alia-machine-principal-20261004/packages/api/src/services/inferenceInternalPilot.ts';

const captured = vi.hoisted(() => ({ request: null as Record<string, unknown> | null }));
vi.mock('../../inference/oxy-inference.js', () => ({
  getOxyInferenceClient: () => ({ respond: async (request: Record<string, unknown>) => {
    captured.request = request;
    return { requestId: 'synthetic-budget-measurement', model: 'openai/gpt-oss-120b@observed-2026-09-01',
      output: [{ role: 'assistant', content: [{ type: 'text', text: 'ok' }] }], finishReason: 'stop', usage: [] };
  }}),
}));
vi.mock('../../../db/index.js', () => ({ getDb: () => { throw new Error('No database allowed'); } }));

import { ToolPipeline } from '../../tool-pipeline.js';
import { SystemPromptBuilder } from '../../system-prompt-builder.js';
import { kaanaLanguageModel } from '../../inference/kaana-language-model.js';

describe('controlled input measurement with real Alia builders and adapter', () => {
  it('measures synthetic turns without database, provider or private context', async () => {
    const records: Array<Record<string, unknown>> = [];
    for (const surface of ['chat', 'codea', 'cowork'] as const) {
      const assembled = await ToolPipeline.forUser({ userId: 'synthetic-user', isDirectSession: true,
        actsForPerson: true, toolsEnabled: true, webSearch: true, agentMode: false,
        instancedSources: [], sseEmitter: { emit: () => undefined } });
      const system = await SystemPromptBuilder.build({ surface, isDirectUserSession: true,
        userId: 'synthetic-user', oxyUser: { username: 'synthetic-user' } });
      expect(system).not.toBe('');
      await generateText({ model: kaanaLanguageModel({ target: { kind: 'routing_profile', routingProfile: 'auto' },
          modelId: 'auto', surface }), system, messages: [{ role: 'user', content: 'Hello' }],
        tools: assembled.tools, ...assembled.routing, maxRetries: 0, maxOutputTokens: 2048 });
      const request = captured.request!;
      const normalized = normalizeResponsesRequest(request as Parameters<typeof normalizeResponsesRequest>[0]);
      const input = normalized.input;
      const tools = request.tools as unknown[];
      const controlled = { input, tools, toolChoice: normalized.toolChoice,
        responseFormat: normalized.responseFormat };
      const payloadBytes = Buffer.byteLength(JSON.stringify(controlled), 'utf8');
      const messageCount = (request.input as unknown[]).length;
      const framingBytes = 256 + 32 * messageCount + 32 * tools.length;
      expect(controlledInputBudget(normalized)).toBe(payloadBytes + framingBytes);
      expect(controlledInputBudget(normalized)).toBeGreaterThan(8192);
      expect(controlledInputBudget(normalized)).toBeLessThan(126976);
      records.push({ surface, systemBytes: Buffer.byteLength(system, 'utf8'), toolCount: tools.length,
        toolSchemaBytes: Buffer.byteLength(JSON.stringify(tools), 'utf8'), messageCount,
        payloadBytes, framingBytes, controlledInputBudget: payloadBytes + framingBytes,
        history: 'one synthetic Hello user message', connectedSources: 0, privateContext: false });
    }
    writeFileSync('/home/nate/Oxy/.agent-evidence/coverage-alia-machine-contract-20261004/chat-budget-measurements.json', JSON.stringify({
      kind: 'alia-controlled-input-measurement-v1', source: 'b2bc57f45d83acb53cb4d2d36a68dca9426a2788',
      limit: 8192, units: 'UTF-8 serialized bytes plus framing', records,
      limits: ['synthetic fixtures, not original incident payload', 'external connector sources explicitly absent',
        'no provider HTTP or database calls', 'real Oxy normalizeResponsesRequest and controlledInputBudget used without modification'] }, null, 2) + '\n');
    expect(records).toHaveLength(3);
  });
});
