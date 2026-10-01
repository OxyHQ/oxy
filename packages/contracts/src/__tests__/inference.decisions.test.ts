import {
  decisionAnswerSchema,
  decisionAnswersMatch,
  decisionRequestSchema,
  decisionInputBudget,
} from "../inference/decisions";

const request = {
  model: "typesafe/jev@fixture-v1",
  state: "Synthetic state",
  questions: [
    { id: "q", kind: "noul" as const, question: "Is this synthetic?" },
  ],
};
it("accepts only the declared effort range and exact immutable model", () => {
  for (const effort of ["instant", "low", "medium", "high", "xhigh"])
    expect(
      decisionRequestSchema.safeParse({ ...request, effort }).success,
    ).toBe(true);
  for (const effort of ["auto", "pro", "ultra", "max", "", null])
    expect(
      decisionRequestSchema.safeParse({ ...request, effort }).success,
    ).toBe(false);
  expect(
    decisionRequestSchema.safeParse({ ...request, model: "typesafe/jev" })
      .success,
  ).toBe(false);
  expect(
    decisionRequestSchema.safeParse({ ...request, stream: true }).success,
  ).toBe(false);
});
it("bounds exclusive options, ordered levels and exact unique IDs", () => {
  const question = {
    id: "q",
    question: "Select",
    kind: "choice",
    options: Array.from({ length: 255 }, (_, i) => String(i)),
  };
  expect(
    decisionRequestSchema.safeParse({ ...request, questions: [question] })
      .success,
  ).toBe(true);
  for (const options of [[], ["a"], ["a", "a"], [...question.options, "extra"]])
    expect(
      decisionRequestSchema.safeParse({
        ...request,
        questions: [{ ...question, options }],
      }).success,
    ).toBe(false);
  for (const count of [1, 11])
    expect(
      decisionRequestSchema.safeParse({
        ...request,
        questions: [
          {
            id: "q",
            kind: "score",
            question: "Rate",
            levels: Array.from({ length: count }, (_, i) => String(i)),
          },
        ],
      }).success,
    ).toBe(false);
  expect(
    decisionRequestSchema.safeParse({
      ...request,
      questions: [request.questions[0], request.questions[0]],
    }).success,
  ).toBe(false);
});
it("validates finite probabilities, distributions and zero-based means without fake confidence", () => {
  expect(
    decisionAnswerSchema.safeParse({
      id: "q",
      kind: "choice",
      probabilities: [0.2, 0.8],
    }).success,
  ).toBe(true);
  expect(
    decisionAnswerSchema.safeParse({
      id: "q",
      kind: "score",
      mean: 1.5,
      distribution: [0, 0.5, 0.5],
    }).success,
  ).toBe(true);
  for (const probabilities of [
    [0.2, 0.7],
    [Number.NaN, 1],
    [Number.POSITIVE_INFINITY, 0],
    [-0.1, 1.1],
  ])
    expect(
      decisionAnswerSchema.safeParse({ id: "q", kind: "choice", probabilities })
        .success,
    ).toBe(false);
  expect(
    decisionAnswerSchema.safeParse({
      id: "q",
      kind: "score",
      mean: 0.5,
      distribution: [0, 0.5, 0.5],
    }).success,
  ).toBe(false);
  expect(
    decisionAnswerSchema.safeParse({
      id: "q",
      kind: "noul",
      probability: 0.8,
      confidence: 0.9,
    }).success,
  ).toBe(false);
});
it("requires exactly one correctly shaped answer for every exact question ID", () => {
  const answer = { id: "q", kind: "noul" as const, probability: 0.7 };
  expect(decisionAnswersMatch(request, [answer])).toBe(true);
  for (const answers of [
    [],
    [answer, answer],
    [{ ...answer, id: "Q" }],
    [{ id: "q", kind: "choice" as const, probabilities: [0.5, 0.5] }],
  ])
    expect(decisionAnswersMatch(request, answers)).toBe(false);
});
it("counts instructions, criteria, labels and multibyte state in both bounds", () => {
  const empty = { ...request, state: "" };
  const overhead = decisionInputBudget(empty).gateway;
  expect(
    decisionRequestSchema.safeParse({
      ...empty,
      state: "x".repeat(32768 - overhead),
    }).success,
  ).toBe(true);
  expect(
    decisionRequestSchema.safeParse({
      ...empty,
      state: "x".repeat(32769 - overhead),
    }).success,
  ).toBe(false);
  expect(
    decisionRequestSchema.safeParse({
      ...empty,
      instructions: "x".repeat(32768),
    }).success,
  ).toBe(false);
  expect(
    decisionRequestSchema.safeParse({ ...empty, state: "😀".repeat(8192) })
      .success,
  ).toBe(false);
  expect(
    decisionRequestSchema.safeParse({
      ...empty,
      questions: [{ ...request.questions[0], criteria: "x".repeat(32768) }],
    }).success,
  ).toBe(false);
  expect(
    decisionRequestSchema.safeParse({
      ...empty,
      questions: Array.from({ length: 3 }, (_, i) => ({
        id: String(i),
        kind: "noul",
        question: "x".repeat(24000),
      })),
    }).success,
  ).toBe(false);
});
