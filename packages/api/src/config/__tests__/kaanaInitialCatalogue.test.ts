import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  KAANA_INITIAL_BALANCED_FORMULA_REF,
  KAANA_INITIAL_INVENTORY_SNAPSHOT_ID,
  KAANA_INITIAL_MODEL,
  KAANA_INITIAL_MODEL_REFERENCE,
  KAANA_INITIAL_PROVIDERS,
  KAANA_INITIAL_ROUTING_PROFILE_IDS,
  KAANA_INITIAL_ROUTING_PROFILES,
  KAANA_INITIAL_SCORECARD_REASON,
  KAANA_INITIAL_SCORE_VALID_UNTIL,
  KAANA_REVIEWED_CATALOGUES,
  KAANA_REVIEWED_PROVIDERS,
  KAANA_SCORE_RENEWAL_2026_09_24,
  KAANA_SPEECH_CATALOGUE,
  KAANA_SPEECH_MODEL,
  KAANA_SPEECH_MODEL_REFERENCE,
  KAANA_SPEECH_PROVIDERS,
  KAANA_SPEECH_ROUTING_PROFILE_ID,
  KAANA_SPEECH_ROUTING_PROFILES,
  KAANA_TEXT_CATALOGUE,
  KAANA_PRE_VOICE_INVENTORY_SNAPSHOT_ID,
  KAANA_VOICE_CATALOGUE_STATUS,
  KAANA_VOICE_MODEL,
  KAANA_VOICE_OBSERVATION,
  kaanaVoiceCatalogue,
  requireKaanaVoiceCatalogue,
  kaanaCurrentScorecardReview,
  kaanaReviewedCatalogueOperations,
  kaanaReviewedCatalogueProjection,
  requireSingleKaanaBootstrapScoreEvent,
} from "../kaanaInitialCatalogue";

describe("the reviewed initial Kaana catalogue", () => {
  it("pins one unique opaque UUIDv7 primary key for every routing profile", () => {
    const ids = KAANA_INITIAL_ROUTING_PROFILES.map((profile) => profile.id);

    expect(ids).toEqual(Object.values(KAANA_INITIAL_ROUTING_PROFILE_IDS));
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
  });

  it("uses unique permanent deployment identities instead of names as route keys", () => {
    const ids = KAANA_INITIAL_PROVIDERS.map(
      (provider) => provider.deploymentId,
    );

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([
      "dep_cerebras_gpt_oss_120b_observed_2026_09_01",
      "dep_groq_openai_gpt_oss_120b_observed_2026_09_01",
      "dep_openrouter_openai_gpt_oss_120b_observed_2026_09_01",
    ]);
    for (const provider of KAANA_INITIAL_PROVIDERS) {
      expect(provider.deploymentId).not.toBe(provider.displayName);
      expect(provider.deploymentId).not.toBe(provider.upstreamModelId);
    }
  });

  it("prices every possible text usage unit and every request explicitly", () => {
    const required = new Set([
      "input_tokens",
      "cached_input_tokens",
      "output_tokens",
      "reasoning_tokens",
      "requests",
    ]);

    for (const provider of KAANA_INITIAL_PROVIDERS) {
      expect(new Set(provider.unitPrices.map((price) => price.unit))).toEqual(
        required,
      );
      expect(
        provider.unitPrices.find((price) => price.unit === "requests"),
      ).toEqual({
        unit: "requests",
        amount: "0",
        per: 1,
      });
    }
  });

  it("uses the conservative common capability ceiling", () => {
    expect(KAANA_INITIAL_MODEL.inputModalities).toEqual(["text"]);
    expect(KAANA_INITIAL_MODEL.outputModalities).toEqual(["text"]);
    expect(KAANA_INITIAL_MODEL.supportsParallelToolCalls).toBe(false);
    expect(KAANA_INITIAL_MODEL.maxContextTokens).toBe(131_072);
    expect(KAANA_INITIAL_MODEL.maxOutputTokens).toBe(40_960);
  });

  it("adds only the live exact OpenRouter deployment for the existing revision", () => {
    const openRouter = KAANA_INITIAL_PROVIDERS.find(
      (provider) => provider.slug === "openrouter",
    );

    expect(openRouter).toMatchObject({
      deploymentId:
        "dep_openrouter_openai_gpt_oss_120b_observed_2026_09_01",
      upstreamModelId: "openai/gpt-oss-120b",
      retainsPayloads: false,
      retentionDays: 0,
      trainsOnCustomerData: false,
      zeroDataRetentionAvailable: true,
      scores: { price: 1_000, latency: 500, throughput: 500, balanced: 750 },
    });
    expect(openRouter?.unitPrices).toEqual([
      { unit: "input_tokens", amount: "0.03", per: 1_000_000 },
      { unit: "cached_input_tokens", amount: "0.03", per: 1_000_000 },
      { unit: "output_tokens", amount: "0.17", per: 1_000_000 },
      { unit: "reasoning_tokens", amount: "0.17", per: 1_000_000 },
      { unit: "requests", amount: "0", per: 1 },
    ]);
    expect(openRouter?.legalEvidenceRef).toContain(
      "scope=internal-alia-standard-application-use-not-api-resale",
    );
    expect(openRouter?.performanceEvidenceRef).toMatch(/^not-measured:/);
  });

  it("publishes the reviewed speech profile and keeps every other modality profile absent", () => {
    const profiles = KAANA_REVIEWED_CATALOGUES.flatMap((catalogue) =>
      catalogue.routingProfiles.map((profile) => profile.slug),
    );

    // Inbox's profile and Alia's speech profile are the only reviewed ones
    // left: the Alia text presets were retired in favour of the synced
    // catalogue of real models.
    expect(profiles).toEqual(["kaana-v1", "kaana-v1-speech"]);
    for (const retired of [
      "kaana-lite",
      "kaana-v1-codea",
      "kaana-v1-cowork",
      "kaana-v1-browser",
      "kaana-v1-pro",
      "kaana-v1-thinking",
      "kaana-v1-pro-max",
    ]) {
      expect(profiles).not.toContain(retired);
    }
    expect(new Set(profiles).size).toBe(profiles.length);
    expect(profiles).not.toContain("kaana-v1-vision");
    expect(profiles).not.toContain("kaana-v1-audio");
    expect(profiles).not.toContain("kaana-v1-voice");
    expect(profiles).not.toContain("kaana-v1-multimodal");
    // Speech output only: the text profiles never gain an audio candidate.
    expect(KAANA_INITIAL_MODEL.outputModalities).toEqual(["text"]);
  });

  it("does not publish the unsupported quality optimisation dimension", () => {
    expect(
      KAANA_REVIEWED_CATALOGUES.flatMap((catalogue) =>
        catalogue.routingProfiles.map((profile) => profile.optimiseFor),
      ),
    ).not.toContain("quality");
  });

  it("does not let unmeasured latency introduce a provider preference", () => {
    expect(
      KAANA_INITIAL_PROVIDERS.map((provider) => provider.scores.latency),
    ).toEqual([500, 500, 500]);
    expect(
      KAANA_INITIAL_ROUTING_PROFILES.map((profile) => profile.optimiseFor),
    ).not.toContain("latency");
  });

  it("stores reviewed score dimensions rather than deriving priority from provider names", () => {
    for (const provider of KAANA_REVIEWED_PROVIDERS) {
      const expectedBalanced = Math.round(
        (provider.scores.price + provider.scores.throughput) / 2,
      );
      expect(provider.scores.balanced).toBe(expectedBalanced);
    }
  });

  it("describes neutral latency honestly instead of claiming it as primary-source evidence", () => {
    expect(KAANA_INITIAL_SCORECARD_REASON).toContain(
      "primary-source price/throughput",
    );
    expect(KAANA_INITIAL_SCORECARD_REASON).toContain(
      "neutral unmeasured latency",
    );
  });

  it("requires exactly one append-only provenance event", () => {
    const event = { id: "event-1" };
    expect(requireSingleKaanaBootstrapScoreEvent("deployment-1", [event])).toBe(
      event,
    );
    expect(() =>
      requireSingleKaanaBootstrapScoreEvent("deployment-1", []),
    ).toThrow(/exactly one.*found 0/);
    expect(() =>
      requireSingleKaanaBootstrapScoreEvent("deployment-1", [event, event]),
    ).toThrow(/exactly one.*found 2/);
  });
});

describe("Alia's reviewed text-to-speech catalogue", () => {
  const [xai] = KAANA_SPEECH_PROVIDERS;

  it("pins the live snapshot that carries every reviewed route", () => {
    // The pre-voice snapshot, until the voice observation moves the pin.
    expect(KAANA_PRE_VOICE_INVENTORY_SNAPSHOT_ID).toBe("snap_37548e4f1f8ec610");
    expect(KAANA_INITIAL_INVENTORY_SNAPSHOT_ID).toBe(
      KAANA_VOICE_OBSERVATION?.inventorySnapshotId ?? "snap_37548e4f1f8ec610",
    );
    expect(KAANA_REVIEWED_PROVIDERS.map((provider) => provider.deploymentId)).toEqual([
      "dep_cerebras_gpt_oss_120b_observed_2026_09_01",
      "dep_groq_openai_gpt_oss_120b_observed_2026_09_01",
      "dep_openrouter_openai_gpt_oss_120b_observed_2026_09_01",
      "dep_xai_tts_observed_2026_09_24",
      ...(KAANA_VOICE_OBSERVATION === null ? [] : [KAANA_VOICE_OBSERVATION.deploymentId]),
    ]);
  });

  it("binds the exact live xAI deployment identity Kaana attests", () => {
    expect(KAANA_SPEECH_PROVIDERS).toHaveLength(1);
    expect(xai).toMatchObject({
      slug: "xai",
      deploymentId: "dep_xai_tts_observed_2026_09_24",
      upstreamModelId: "tts",
    });
    expect(KAANA_SPEECH_MODEL_REFERENCE).toBe(
      "x-ai/text-to-speech@observed-2026-09-24",
    );
    expect(KAANA_SPEECH_CATALOGUE.modelId).toBe("x-ai/text-to-speech");
    expect(
      `${KAANA_SPEECH_CATALOGUE.publisher.slug}/${KAANA_SPEECH_MODEL.slug}`,
    ).toBe(KAANA_SPEECH_CATALOGUE.modelId);
  });

  it("adopts the exact profile ID Alia already pins, ranked on price", () => {
    expect(KAANA_SPEECH_ROUTING_PROFILE_ID).toBe(
      "cc2471c8-807e-46ec-b5da-b6f3b39d2db5",
    );
    expect(KAANA_SPEECH_ROUTING_PROFILES).toEqual([
      {
        id: "cc2471c8-807e-46ec-b5da-b6f3b39d2db5",
        slug: "kaana-v1-speech",
        displayName: "Kaana Speech",
        optimiseFor: "price",
      },
    ]);
    expect(
      KAANA_INITIAL_ROUTING_PROFILES.map((profile) => profile.id),
    ).not.toContain(KAANA_SPEECH_ROUTING_PROFILE_ID);
  });

  it("prices at the xAI list price with no markup and an explicit free request", () => {
    expect(xai?.unitPrices).toEqual([
      { unit: "characters", amount: "15.00", per: 1_000_000 },
      { unit: "requests", amount: "0", per: 1 },
    ]);
    expect(xai?.priceEvidenceRef).toBe("https://docs.x.ai/developers/pricing");
    // The edge's speech ceiling is `{ requests, characters }` and nothing else:
    // every ceiling unit is priced and no priced unit is left unbounded.
    expect(new Set(xai?.unitPrices.map((price) => price.unit))).toEqual(
      new Set(["characters", "requests"]),
    );
  });

  it("serves text in and audio out without claiming any text capability", () => {
    expect(KAANA_SPEECH_MODEL).toMatchObject({
      inputModalities: ["text"],
      outputModalities: ["audio"],
      supportsTools: false,
      supportsStructuredOutput: false,
      supportsJsonMode: false,
      supportsReasoning: false,
      supportsStreaming: false,
      supportsPromptCaching: false,
      releaseKind: "third_party_hosted",
      commercialUseAllowed: true,
    });
    // Audio output must declare provenance or the revision insert is refused.
    expect(KAANA_SPEECH_CATALOGUE.revision).toMatchObject({
      revision: "observed-2026-09-24",
      isCurrent: true,
      contentFilteringDefault: "provider_default",
      provenanceMarking: "none",
    });
    // Kaana's 15,000-unit input limit plus the edge's one-message estimate.
    expect(KAANA_SPEECH_MODEL.maxContextTokens).toBe(15_008);
    expect(KAANA_SPEECH_MODEL.maxOutputTokens).toBeGreaterThan(0);
  });

  it("records xAI's default retention instead of assuming ZDR", () => {
    expect(xai).toMatchObject({
      retainsPayloads: true,
      retentionDays: 30,
      trainsOnCustomerData: false,
      zeroDataRetentionAvailable: true,
      policyUrl: "https://docs.x.ai/developers/faq/security",
    });
    expect(xai?.legalEvidenceRef).toContain(
      "scope=internal-alia-standard-application-use-not-api-resale",
    );
  });

  it("scores the single route like the unmeasured OpenRouter route, valid with the renewed rows", () => {
    expect(xai?.scores).toEqual({
      price: 1_000,
      latency: 500,
      throughput: 500,
      balanced: 750,
    });
    expect(xai?.performanceEvidenceRef).toMatch(/^not-measured:/);
    expect(KAANA_INITIAL_BALANCED_FORMULA_REF).toContain(
      "round((price+throughput)/2)",
    );
    // A first review, not a renewal: the renewal workflow skips it until a
    // later renewal names its exact superseded state.
    expect(xai?.scoreRenewal).toBeUndefined();
    expect(kaanaCurrentScorecardReview(xai!)).toEqual({
      changedAt: "2026-09-24T00:00:00.000Z",
      validUntil: KAANA_INITIAL_SCORE_VALID_UNTIL,
      reason: expect.stringContaining("single exact speech route"),
    });
    expect(KAANA_SCORE_RENEWAL_2026_09_24.validUntil).toBe(
      KAANA_INITIAL_SCORE_VALID_UNTIL,
    );
  });
});

describe("the reviewed bootstrap projection", () => {
  it("keeps the text projection the workflow has always required", () => {
    expect(kaanaReviewedCatalogueProjection(KAANA_TEXT_CATALOGUE)).toEqual({
      publisher: "openai",
      model: "openai/gpt-oss-120b",
      revision: KAANA_INITIAL_MODEL_REFERENCE,
      candidate: { modelReference: KAANA_INITIAL_MODEL_REFERENCE, priority: 100 },
      providers: ["cerebras", "groq", "openrouter"],
      deployments: KAANA_INITIAL_PROVIDERS.map((provider) => provider.deploymentId),
      routingProfileIds: Object.values(KAANA_INITIAL_ROUTING_PROFILE_IDS),
    });
  });

  it("includes the speech profile with its one exact route and pinned candidate", () => {
    expect(kaanaReviewedCatalogueProjection(KAANA_SPEECH_CATALOGUE)).toEqual({
      publisher: "x-ai",
      model: "x-ai/text-to-speech",
      revision: "x-ai/text-to-speech@observed-2026-09-24",
      candidate: {
        modelReference: "x-ai/text-to-speech@observed-2026-09-24",
        priority: 100,
      },
      providers: ["xai"],
      deployments: ["dep_xai_tts_observed_2026_09_24"],
      routingProfileIds: ["cc2471c8-807e-46ec-b5da-b6f3b39d2db5"],
    });
  });

  it("allow-lists exactly the speech inserts a first apply may perform", () => {
    expect(kaanaReviewedCatalogueOperations(KAANA_SPEECH_CATALOGUE)).toEqual([
      "publisher:x-ai",
      "model:x-ai/text-to-speech",
      "revision:x-ai/text-to-speech@observed-2026-09-24",
      "provider:xai",
      "price:x-ai/text-to-speech@observed-2026-09-24:xai",
      "deployment:dep_xai_tts_observed_2026_09_24",
      "scorecard:dep_xai_tts_observed_2026_09_24",
      "profile:kaana-v1-speech",
      "profile-candidate:kaana-v1-speech:x-ai/text-to-speech@observed-2026-09-24",
    ]);
  });

  it("matches the speech operation allow-list the manual workflow pins", () => {
    const workflow = readFileSync(
      join(__dirname, "../../../../../.github/workflows/bootstrap-kaana-catalogue.yml"),
      "utf8",
    );
    // The workflow composes revision-bearing names from its pinned env value.
    const workflowSpelling = (operation: string): string =>
      operation.includes(KAANA_SPEECH_MODEL_REFERENCE) && !operation.startsWith("model:")
        ? `(${operation
            .split(KAANA_SPEECH_MODEL_REFERENCE)
            .map((part) => (part === "" ? undefined : `"${part}"`))
            .reduce<string[]>(
              (parts, part, index) => [
                ...parts,
                ...(index === 0 ? [] : ["$speechRevision"]),
                ...(part === undefined ? [] : [part]),
              ],
              [],
            )
            .join(" + ")})`
        : `"${operation}"`;
    for (const operation of kaanaReviewedCatalogueOperations(KAANA_SPEECH_CATALOGUE)) {
      expect(workflow).toContain(workflowSpelling(operation));
    }
  });
});

describe("xAI's reviewed realtime voice catalogue", () => {
  const OBSERVED = {
    deploymentId: "dep_xai_realtime_grok_voice_think_fast_2_0_observed_2026_10_02",
    inventorySnapshotId: "snap_0123456789abcdef",
  };
  const workflow = (): string =>
    readFileSync(
      join(__dirname, "../../../../../.github/workflows/bootstrap-kaana-catalogue.yml"),
      "utf8",
    );

  it("is gated until Kaana's observation is recorded, and a recorded one must be valid", () => {
    // Either nothing is recorded (the route is defined but not bootstrapped),
    // or what is recorded builds: a malformed follow-up cannot merge.
    if (KAANA_VOICE_OBSERVATION === null) {
      expect(KAANA_VOICE_CATALOGUE_STATUS.status).toBe("pending");
      expect(() => requireKaanaVoiceCatalogue()).toThrow(
        /not yet published its deployment id and inventory snapshot/,
      );
      expect(KAANA_REVIEWED_CATALOGUES).toHaveLength(2);
    } else {
      expect(KAANA_VOICE_CATALOGUE_STATUS.status).toBe("ready");
      expect(KAANA_REVIEWED_CATALOGUES.at(-1)?.modelId).toBe("x-ai/grok-voice-think-fast-2.0");
    }
  });

  it("refuses an id that is not Kaana's xai-realtime grok-voice id, or a date that cannot be it", () => {
    for (const deploymentId of [
      "dep_xai_realtime_grok_voice_latest_observed_2026_10_02",
      "dep_xai_grok_voice_think_fast_2_0_observed_2026_10_02",
      "dep_xai_realtime_grok_voice_think_fast_2_0_observed_2026_13_02",
      "dep_xai_realtime_grok_voice_think_fast_2_0_observed_2026_09_29",
      " dep_xai_realtime_grok_voice_think_fast_2_0_observed_2026_10_02",
    ]) {
      expect(kaanaVoiceCatalogue({ ...OBSERVED, deploymentId }).status).toBe("pending");
    }
    for (const inventorySnapshotId of ["snap_exact", "snap_37548e4f1f8ec610", ""]) {
      expect(kaanaVoiceCatalogue({ ...OBSERVED, inventorySnapshotId }).status).toBe("pending");
    }
  });

  it("derives the revision from the observation date and binds the exact Kaana route identity", () => {
    const status = kaanaVoiceCatalogue(OBSERVED);
    expect(status.status).toBe("ready");
    const catalogue = requireKaanaVoiceCatalogue(status);
    expect(catalogue.modelReference).toBe("x-ai/grok-voice-think-fast-2.0@observed-2026-10-02");
    expect(catalogue.revision).toMatchObject({
      revision: "observed-2026-10-02",
      releasedAt: "2026-10-02T00:00:00.000Z",
      contentFilteringDefault: "provider_default",
      provenanceMarking: "none",
    });
    expect(catalogue.publisher.slug).toBe("x-ai");
    expect(catalogue.routingProfiles).toEqual([]);
    // session.created is matched on deployment id, model and servingProvider:
    // the provider row is Kaana's own slug for the realtime adapter.
    expect(catalogue.providers).toHaveLength(1);
    expect(catalogue.providers[0]).toMatchObject({
      slug: "xai-realtime",
      deploymentId: OBSERVED.deploymentId,
      upstreamModelId: "grok-voice-think-fast-2.0",
      retainsPayloads: true,
      retentionDays: 30,
      trainsOnCustomerData: false,
    });
    expect(kaanaReviewedCatalogueOperations(catalogue)).toEqual([
      "publisher:x-ai",
      "model:x-ai/grok-voice-think-fast-2.0",
      "revision:x-ai/grok-voice-think-fast-2.0@observed-2026-10-02",
      "provider:xai-realtime",
      "price:x-ai/grok-voice-think-fast-2.0@observed-2026-10-02:xai-realtime",
      `deployment:${OBSERVED.deploymentId}`,
      `scorecard:${OBSERVED.deploymentId}`,
    ]);
  });

  it("prices xAI's list price with no markup, in duration and per-item units only", () => {
    const [route] = requireKaanaVoiceCatalogue(kaanaVoiceCatalogue(OBSERVED)).providers;
    expect(route?.unitPrices).toEqual([
      { unit: "audio_input_milliseconds", amount: "0.08", per: 60_000 },
      { unit: "audio_output_milliseconds", amount: "0.08", per: 60_000 },
      { unit: "requests", amount: "0.004", per: 1 },
    ]);
    // No token unit: the edge holds this route from the signed audio caps and
    // the text-item cap, and a one-shot request to it fails to quote.
    expect(route?.unitPrices.some((price) => price.unit.endsWith("_tokens"))).toBe(false);
    expect(route?.priceEvidenceRef).toBe("https://docs.x.ai/developers/models/speech-to-speech");
  });

  it("declares a push-to-talk conversation over WebSocket, audio in (0126 CHECK) and no one-shot dialect", () => {
    expect(KAANA_VOICE_MODEL).toMatchObject({
      inputModalities: ["text", "audio"],
      outputModalities: ["text", "audio"],
      realtimeTransports: ["websocket"],
      realtimeSessionKinds: ["conversation"],
      releaseKind: "third_party_hosted",
    });
    expect(KAANA_VOICE_MODEL).not.toHaveProperty("apiFormats");
    expect(KAANA_VOICE_MODEL.inputModalities).toContain("audio");
  });

  it("keeps the workflow's two pinned production facts equal to the catalogue's", () => {
    const text = workflow();
    expect(text).toContain(`  INVENTORY_SNAPSHOT_ID: ${KAANA_INITIAL_INVENTORY_SNAPSHOT_ID}\n`);
    expect(text).toContain(`[ "$INVENTORY_SNAPSHOT_ID" = '${KAANA_INITIAL_INVENTORY_SNAPSHOT_ID}' ]`);
    const voiceId = KAANA_VOICE_OBSERVATION?.deploymentId ?? "";
    expect(text).toContain(`  VOICE_DEPLOYMENT_ID: '${voiceId}'\n`);
    expect(text).toContain(`[ "$VOICE_DEPLOYMENT_ID" = '${voiceId}' ]`);
  });

  it("matches the voice operation allow-list the manual workflow composes", () => {
    const text = workflow();
    const catalogue = requireKaanaVoiceCatalogue(kaanaVoiceCatalogue(OBSERVED));
    const spelled = (operation: string): string => {
      if (operation.startsWith("publisher:") || operation.startsWith("model:") || operation.startsWith("provider:")) {
        return `"${operation}"`;
      }
      if (operation.startsWith("revision:")) return `("revision:" + $voiceRevision)`;
      if (operation.startsWith("price:")) return `("price:" + $voiceRevision + ":xai-realtime")`;
      const [kind] = operation.split(":");
      return `("${kind}:" + $voiceDeployment)`;
    };
    for (const operation of kaanaReviewedCatalogueOperations(catalogue)) {
      expect(text).toContain(spelled(operation));
    }
  });
});
