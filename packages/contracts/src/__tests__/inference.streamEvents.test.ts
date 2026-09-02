import {
  inferenceRouteSwitchDetailSchema,
  inferenceStreamDeltaEventSchema,
  inferenceStreamDoneEventSchema,
  inferenceStreamErrorEventSchema,
  inferenceStreamEventSchema,
  inferenceStreamRouteSwitchEventSchema,
  inferenceStreamStartEventSchema,
  inferenceStreamUsageEventSchema,
  normalizedUsageReportSchema,
  safeParseContract,
} from '../index';

const start = {
  schemaVersion: 1 as const,
  type: 'start' as const,
  requestId: 'req_1',
  sequence: 0,
  resolvedModelReference: 'openai/gpt-5@2026-06-01',
  servingProvider: 'openai',
  startedAt: '2026-08-15T09:41:00.000Z',
};

const delta = {
  schemaVersion: 1 as const,
  type: 'delta' as const,
  requestId: 'req_1',
  sequence: 1,
  outputIndex: 0,
  channel: 'output_text' as const,
  text: 'hello',
};

const routeSwitch = {
  schemaVersion: 1 as const,
  type: 'route_switch' as const,
  requestId: 'req_1',
  sequence: 2,
  reason: 'provider_timeout' as const,
  detail: {
    scope: 'deployment' as const,
    modelReference: 'openai/gpt-5@2026-06-01',
    toProvider: 'azure-openai',
  },
  occurredAt: '2026-08-15T09:41:01.000Z',
};

describe('inferenceStreamEventSchema', () => {
  it('discriminates on type', () => {
    expect(safeParseContract(inferenceStreamEventSchema, start)?.type).toBe('start');
    expect(safeParseContract(inferenceStreamEventSchema, delta)?.type).toBe('delta');
    expect(safeParseContract(inferenceStreamEventSchema, routeSwitch)?.type).toBe('route_switch');
  });

  it('rejects an unknown event type rather than defaulting it to output', () => {
    expect(
      inferenceStreamEventSchema.safeParse({ ...delta, type: 'partial_result' }).success,
    ).toBe(false);
  });

  it('puts the request id on every event, not just the first', () => {
    for (const event of [start, delta, routeSwitch]) {
      const { requestId, ...withoutRequestId } = event;
      expect(requestId).toBe('req_1');
      expect(inferenceStreamEventSchema.safeParse(withoutRequestId).success).toBe(false);
    }
  });

  it('requires a sequence so a redelivered event is detectable', () => {
    const { sequence, ...withoutSequence } = delta;
    expect(sequence).toBe(1);
    expect(inferenceStreamEventSchema.safeParse(withoutSequence).success).toBe(false);
    expect(inferenceStreamEventSchema.safeParse({ ...delta, sequence: -1 }).success).toBe(false);
  });
});

describe('inferenceStreamStartEventSchema', () => {
  it('resolves the model to an immutable revision', () => {
    const parsed = inferenceStreamStartEventSchema.parse(start);
    expect(parsed.resolvedModelReference).toBe('openai/gpt-5@2026-06-01');
  });

  it('carries no deployment id, route health or upstream cost', () => {
    expect(Object.keys(inferenceStreamStartEventSchema.shape).sort()).toEqual([
      'generationId',
      'requestId',
      'resolvedModelReference',
      'schemaVersion',
      'sequence',
      'servingProvider',
      'startedAt',
      'type',
    ]);
  });
});

describe('inferenceStreamDeltaEventSchema', () => {
  it('separates visible output from reasoning and refusals', () => {
    for (const channel of ['output_text', 'reasoning', 'refusal'] as const) {
      expect(inferenceStreamDeltaEventSchema.safeParse({ ...delta, channel }).success).toBe(true);
    }
    expect(
      inferenceStreamDeltaEventSchema.safeParse({ ...delta, channel: 'thoughts' }).success,
    ).toBe(false);
  });
});

describe('inferenceRouteSwitchDetailSchema', () => {
  it('accepts same-model deployment failover with no authorization field', () => {
    expect(
      inferenceRouteSwitchDetailSchema.safeParse({
        scope: 'deployment',
        modelReference: 'openai/gpt-5@2026-06-01',
        toProvider: 'azure-openai',
      }).success,
    ).toBe(true);
  });

  it('cannot express an unauthorized cross-model switch', () => {
    const crossModel = {
      scope: 'model',
      requestedModelId: 'openai/gpt-5',
      fromModelReference: 'openai/gpt-5@2026-06-01',
      toModelReference: 'anthropic/claude-opus-5@2026-05-01',
      toProvider: 'anthropic',
    };

    // `authorizedByPolicy` is a literal `true`: omitted or false, there is no
    // parse that produces a cross-model switch event.
    expect(inferenceRouteSwitchDetailSchema.safeParse(crossModel).success).toBe(false);
    expect(
      inferenceRouteSwitchDetailSchema.safeParse({ ...crossModel, authorizedByPolicy: false })
        .success,
    ).toBe(false);
    expect(
      inferenceRouteSwitchDetailSchema.safeParse({ ...crossModel, authorizedByPolicy: true })
        .success,
    ).toBe(true);
  });

  it('cannot express a cross-model switch away from a pinned revision', () => {
    // ADR 0008: a request that named `<publisher>/<model>@<revision>` asked for
    // exactly those weights and is served or refused, never substituted. The
    // requested model is the UNPINNED line, so a pinned request has no value
    // that satisfies the field and the event cannot be built.
    expect(
      inferenceRouteSwitchDetailSchema.safeParse({
        scope: 'model',
        requestedModelId: 'openai/gpt-5@2026-06-01',
        fromModelReference: 'openai/gpt-5@2026-06-01',
        toModelReference: 'anthropic/claude-opus-5@2026-05-01',
        toProvider: 'anthropic',
        authorizedByPolicy: true,
      }).success,
    ).toBe(false);
  });

  it('rejects a switch that names no destination provider', () => {
    expect(
      inferenceRouteSwitchDetailSchema.safeParse({
        scope: 'deployment',
        modelReference: 'openai/gpt-5@2026-06-01',
      }).success,
    ).toBe(false);
  });
});

describe('inferenceStreamRouteSwitchEventSchema', () => {
  it('reports a reason from the closed set', () => {
    expect(inferenceStreamRouteSwitchEventSchema.safeParse(routeSwitch).success).toBe(true);
    expect(
      inferenceStreamRouteSwitchEventSchema.safeParse({ ...routeSwitch, reason: 'because' })
        .success,
    ).toBe(false);
  });
});

describe('terminal events', () => {
  it('nests the same versioned error body the non-streaming path returns', () => {
    const event = {
      schemaVersion: 1,
      type: 'error',
      requestId: 'req_1',
      sequence: 3,
      error: {
        schemaVersion: 1,
        code: 'provider_timeout',
        message: 'Upstream timed out.',
        retryable: true,
        requestId: 'req_1',
      },
    };
    const parsed = inferenceStreamErrorEventSchema.parse(event);
    expect(parsed.error.schemaVersion).toBe(1);
    expect(parsed.error.retryable).toBe(true);

    // The nested body obeys its own rules: a non-retryable code cannot claim
    // retryability just because it arrived inside an event.
    expect(
      inferenceStreamErrorEventSchema.safeParse({
        ...event,
        error: { ...event.error, code: 'invalid_request' },
      }).success,
    ).toBe(false);
  });

  it('closes a successful stream with a finish reason', () => {
    const done = {
      schemaVersion: 1,
      type: 'done',
      requestId: 'req_1',
      sequence: 4,
      finishReason: 'stop',
      completedAt: '2026-08-15T09:41:02.000Z',
    };
    expect(inferenceStreamDoneEventSchema.safeParse(done).success).toBe(true);
    expect(
      inferenceStreamDoneEventSchema.safeParse({ ...done, finishReason: 'done' }).success,
    ).toBe(false);
  });
});

describe('inferenceStreamUsageEventSchema', () => {
  const usageEvent = {
    schemaVersion: 2 as const,
    type: 'usage' as const,
    requestId: 'req_1',
    sequence: 2,
    deploymentId: 'dep_openai_gpt5_usw2',
    units: [{ unit: 'output_tokens', quantity: 204 }],
    usageSource: 'provider_reported' as const,
  };

  it('carries units and a source, and nothing money', () => {
    const parsed = inferenceStreamUsageEventSchema.parse(usageEvent);
    expect(parsed.units).toHaveLength(1);
    expect(parsed.usageSource).toBe('provider_reported');

    // A progress signal reporting no units is not progress.
    expect(
      inferenceStreamUsageEventSchema.safeParse({ ...usageEvent, units: [] }).success,
    ).toBe(false);
  });

  it('is NOT widenable into a settleable usage report', () => {
    // The gate on the decision: this event is measurement evidence, not a
    // narrower report. Handing its fields to the report schema fails, and the
    // fields it lacks are exactly the ones only an END of the request knows —
    // the attribution block and the outcome (the edge's), and the resolved
    // route, switch count and timestamps (the data plane's).
    const promoted = normalizedUsageReportSchema.safeParse(usageEvent);
    expect(promoted.success).toBe(false);

    if (!promoted.success) {
      const missing = new Set(promoted.error.issues.map((issue) => issue.path.join('.')));
      for (const field of [
        'attribution',
        'outcome',
        'resolvedModelReference',
        'servingProvider',
        'routeSwitches',
        'startedAt',
        'completedAt',
      ]) {
        expect(missing.has(field)).toBe(true);
      }
    }
  });

  it('refuses partial metering without an exact deployment identity', () => {
    const { deploymentId: _omitted, ...withoutDeployment } = usageEvent;
    expect(inferenceStreamUsageEventSchema.safeParse(withoutDeployment).success).toBe(false);
  });
});
