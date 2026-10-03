import {
  ACCOUNT_KINDS,
  isDelegatedActAsEligibleKind,
  isOperatorSwitchTargetKind,
} from '../accountGraph';
import {
  ACCOUNT_SUBJECT_CONTRACT_VERSION,
  KIND_INDEPENDENT_ACCOUNT_DIMENSIONS,
  accountActorChainFromSession,
  accountActorChainSchema,
  accountKindActorNature,
  accountKindActsAsItself,
  attributeFinancialEffect,
  financialEffectAttributionSchema,
} from '../accountSubject';

describe('account actor nature', () => {
  it('decides every kind, and never guesses for a non-kind', () => {
    expect(Object.fromEntries(ACCOUNT_KINDS.map((kind) => [kind, accountKindActorNature(kind)]))).toEqual({
      personal: 'person',
      organization: 'operated',
      project: 'operated',
      bot: 'agent',
      channel: 'operated',
    });
    expect(accountKindActorNature(undefined)).toBeNull();
    expect(accountKindActorNature(null)).toBeNull();
    expect(accountKindActorNature('toString' as never)).toBeNull();
  });

  it('makes a bot its own actor, like a person, and never an operated seat', () => {
    expect(accountKindActsAsItself('bot')).toBe(true);
    expect(accountKindActsAsItself('personal')).toBe(true);
    expect(accountKindActsAsItself('organization')).toBe(false);
    expect(accountKindActsAsItself('project')).toBe(false);
    expect(accountKindActsAsItself('channel')).toBe(false);
  });

  it('keeps the seat, the delegation and the actor as three separate answers for a bot', () => {
    // A person never occupies a bot's seat …
    expect(isOperatorSwitchTargetKind('bot')).toBe(false);
    // … may act as it on their own authority …
    expect(isDelegatedActAsEligibleKind('bot')).toBe(true);
    // … and the bot is somebody: the actor of what it does unoperated.
    expect(accountKindActorNature('bot')).toBe('agent');
  });

  it('lists the dimensions a kind never decides', () => {
    expect([...KIND_INDEPENDENT_ACCOUNT_DIMENSIONS]).toEqual([
      'roles',
      'resources',
      'plan',
      'balance',
      'payer',
      'beneficiary',
    ]);
  });
});

describe('account actor chain', () => {
  it('records the account itself as actor when nobody operates it — a bot is never replaced by its owner', () => {
    const chain = accountActorChainFromSession({ subjectAccountId: 'bot-1', operatedByAccountId: null });
    expect(chain).toEqual({
      schemaVersion: ACCOUNT_SUBJECT_CONTRACT_VERSION,
      effectiveAccountId: 'bot-1',
      actorAccountId: 'bot-1',
      delegated: false,
    });
  });

  it('distinguishes the person from the effective account on a delegated session', () => {
    const chain = accountActorChainFromSession({ subjectAccountId: 'org-1', operatedByAccountId: 'nate' });
    expect(chain.effectiveAccountId).toBe('org-1');
    expect(chain.actorAccountId).toBe('nate');
    expect(chain.delegated).toBe(true);
  });

  it('treats an operator equal to the subject as no delegation', () => {
    expect(accountActorChainFromSession({ subjectAccountId: 'a', operatedByAccountId: 'a' }).delegated).toBe(false);
  });

  it('refuses a chain whose delegated flag contradicts its ids', () => {
    const base = { schemaVersion: 1, effectiveAccountId: 'a', actorAccountId: 'b' };
    expect(accountActorChainSchema.safeParse({ ...base, delegated: false }).success).toBe(false);
    expect(accountActorChainSchema.safeParse({ ...base, delegated: true }).success).toBe(true);
    expect(
      accountActorChainSchema.safeParse({ ...base, actorAccountId: 'a', delegated: true }).success
    ).toBe(false);
  });

  it('refuses unknown fields rather than carrying them', () => {
    expect(
      accountActorChainSchema.safeParse({
        schemaVersion: 1,
        effectiveAccountId: 'a',
        actorAccountId: 'a',
        delegated: false,
        ownerAccountId: 'someone-else',
      }).success
    ).toBe(false);
  });
});

describe('financial subject', () => {
  it('attributes a bot paying for itself to the bot, with the bot as actor', () => {
    const effect = attributeFinancialEffect(
      'debit',
      accountActorChainFromSession({ subjectAccountId: 'bot-1' })
    );
    expect(effect.subjectAccountId).toBe('bot-1');
    expect(effect.actor.actorAccountId).toBe('bot-1');
  });

  it('attributes funds a bot receives to the bot', () => {
    const effect = attributeFinancialEffect(
      'credit',
      accountActorChainFromSession({ subjectAccountId: 'bot-1' })
    );
    expect(effect).toMatchObject({ direction: 'credit', subjectAccountId: 'bot-1' });
  });

  it('charges the operated account, never the operator, while recording the operator as actor', () => {
    const effect = attributeFinancialEffect(
      'debit',
      accountActorChainFromSession({ subjectAccountId: 'bot-1', operatedByAccountId: 'owner' })
    );
    expect(effect.subjectAccountId).toBe('bot-1');
    expect(effect.actor.actorAccountId).toBe('owner');
  });

  it('gives a person and a bot the same attribution shape', () => {
    const person = attributeFinancialEffect('debit', accountActorChainFromSession({ subjectAccountId: 'p' }));
    const bot = attributeFinancialEffect('debit', accountActorChainFromSession({ subjectAccountId: 'b' }));
    expect(Object.keys(person).sort()).toEqual(Object.keys(bot).sort());
    expect({ ...person, subjectAccountId: 'x', actor: null }).toEqual({ ...bot, subjectAccountId: 'x', actor: null });
  });

  it('refuses an effect placed on anyone but the effective account', () => {
    const actor = accountActorChainFromSession({ subjectAccountId: 'bot-1', operatedByAccountId: 'owner' });
    expect(
      financialEffectAttributionSchema.safeParse({
        schemaVersion: 1,
        direction: 'debit',
        subjectAccountId: 'owner',
        actor,
      }).success
    ).toBe(false);
  });
});
