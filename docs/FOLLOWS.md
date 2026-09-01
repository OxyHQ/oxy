# The follow graph

One relationship per user and target, shared by every Oxy application, with
per-application context on top.

The thing to understand before anything else: **the user owns the follow, and
the application borrows it.** Following a person in Mention and then opening
Syra means Syra already knows. Turning that follow off in Syra does not take it
away from Mention, and does not take it away from the user.

That is the whole design, and the rest of this document is what it costs you to
join it.

## The three questions, and who answers each

| Question | Answered by | Owned by |
|---|---|---|
| Who is allowed to define this? | a **namespace** | one application, permanently |
| What does following it *mean*? | a **kind** | the namespace's owner |
| Which thing? | a **target** | whoever registered it first |
| Does this user follow it? | a **relationship** | the user |
| Does it act *here*? | an **override** | each application, per relationship |

## Onboarding an application

Three calls, once. All of them are idempotent, which matters — an application
that fails the second time it runs them is an application that fails.

**Not on your server's boot, though, and this surprises people.** Every one of
these is authorized by a *capability*, and a capability is derived from a user's
session — the application half comes from the authorization record behind that
session. There is deliberately no service-credential path: a service token can
prove which application is calling but not that any user asked it to, and this
whole design refuses to let an application act on the graph on its own account.

So an application registers **lazily**: the first time somebody holding
`follow-targets:register` opens a screen that needs it. That is a one-off cost
in the lifetime of the application, not a recurring one, and the calls are
idempotent precisely so the guard can be "have I done this in this session"
rather than anything durable.

If your deployment needs to be self-sufficient in this respect, say so — it is a
real limitation, not a decision that has to stand forever. It just cannot be
fixed by handing a service credential the ability to write here.

```ts
// 1. Claim your namespace. First come; yours forever.
await oxyServices.claimFollowNamespace('mercaria');

// 2. Say what following one of your things means.
await oxyServices.registerFollowKind({
  kind: 'mercaria.store',
  label: 'Store',
  capabilities: {
    verb: 'subscribe',    // what a button says
    reverse: 'aggregate', // who may see a store's followers: a count, not a list
    federated: false,     // does following this have to reach another server
  },
});
```

`capabilities.reverse` is a **privacy decision, and it is required to be an
explicit one**. A user's followers are public; a hashtag's are nobody's
business. The default is the private answer, so a kind registered carelessly
leaks nothing — but "I did not think about it" and "I decided it should be
private" produce the same row, and only one of them is a decision.

```ts
// 3. Resolve a target, on the way into a screen.
const { id } = await oxyServices.ensureFollowTarget({
  uri: `https://mercaria.example/stores/${store.id}`,
  kind: 'mercaria.store',
  metadata: { name: store.name, icon: store.iconFileId },
});
```

Then render:

```tsx
<FollowTargetButton targetId={id} verb="subscribe" applicationName="Mercaria" />
```

Keeping something else in step with the follow — a local shelf, a ranking
signal — goes through `onChange`, which fires only on an accepted write:

```tsx
<FollowTargetButton targetId={id} onChange={(following) => mirror(following)} />
```

## Things that will surprise you

**A target's URI is its identity, not its id.** Two applications describing the
same fediverse actor must pass the same URI, and then they get the same row —
which is what makes one relationship per user rather than one per app. Passing a
URI you invented per-app quietly gives every user a second, parallel follow.

**Following takes a target id, never a URI.** If following created targets, a
typo would become a permanent row that one user follows and nobody else can ever
reach, and a client could mint unbounded rows by following URIs it made up.
Registration is the moment you vouch that the thing exists, and it is the call
that costs a scope.

**`effectiveState: 'not_following'` does not mean the user is not following.**
It means *this application should not act on it right now* — which is also true
of a follow the user deliberately switched off here. A button that reads it as
"not followed" will offer to follow something already followed. Read
`globalState` for "does the user follow this", or use `isFollowedGlobally`.

**Only the providing application refreshes a target's metadata.** Whoever
registered it owns the display snapshot. If a second application could overwrite
it, the name would flip depending on which app last looked.

**Which is exactly why `metadata` must not contain an environment-dependent
URL.** The obvious thing to pass is the image URL your app already resolved —
and in development that is `http://localhost:4120/...`. Because your app is the
providing one, one developer running one screen overwrites the snapshot every
other app renders, in production, from their laptop. Pass an Oxy **file id**, or
an absolute URL that is the same everywhere, or omit the field. There is no
validation stopping you; this paragraph is the guard.

**`onChange` reports the EFFECTIVE state — whether this application should act
on the follow now — not the global one.** That is the question a mirror is
actually asking: a user who picks "Don't show in Mercaria" still follows the
shop everywhere else, but it must leave Mercaria's own shelf, which is the
entire purpose of that menu item. Every control reports through one table, so
the primary button and the menu cannot disagree about the same action.

**It fires only when the server accepted the write**, and
the hook's `follow`/`unfollow` resolve to that same boolean. They never reject —
a refusal becomes error state so the button can render it — so a caller that
awaits them without reading the result would mirror failures as successes into
whatever it is keeping in step.

**A namespace you claimed by mistake can be given back, while it is empty.**
`DELETE /v2/follow-targets/namespaces/<namespace>` (or
`oxyServices.releaseFollowNamespace('<namespace>')`), holder only, refused once
any kind is registered inside it. This exists because registration is
client-side and a claim is first-come, so the first person to open a screen on
*any* build triggers it — including a development build using a fallback client
id, which would otherwise bind the name to the wrong application permanently.
Note the asymmetry: a squatted namespace is recoverable, a squatted **target
URI** is not, because `ensureTarget` returns the existing row with its existing
kind and silently ignores the one you passed.

**Deleting your application does not delete anyone's follows.** The
`origin_application_id` on a relationship is provenance, not ownership — it
records where the user was, and `SET NULL` is what keeps the user's choice when
the application is gone. Your namespace is not re-granted either: rows across
the whole graph name kinds inside it, so letting somebody else adopt that
identity would silently change what those rows mean.

## Scopes

| Scope | Lets an application |
|---|---|
| `follows:read` | see what the user follows |
| `follows:write` | follow and unfollow on their behalf |
| `follows:context:write` | turn a follow off, or back on, **in itself** |
| `follows:manage` | do that **on another application's behalf** |
| `follows:events` | consume follow events |
| `follow-targets:register` | claim a namespace, register kinds and targets |

`follows:write` and `follows:context:write` **always require the user to be
asked**, even for a first-party application. A trusted application skips the
consent screen for the scopes that describe itself; it does not skip it for
scopes that change what the user follows.

`follows:manage` is separate from `follows:context:write` on purpose. Acting for
another application is the cross-application authority this design otherwise
refuses, so it is a distinct permission and not a parameter you happen to fill
in.

## What the API will not let you say

Neither the follower nor the acting application is ever taken from a request.
Both are derived from the session, through the authorization record that created
it. There is no body field, no header, and no SDK parameter for either — a
client that could name them could forge a follow on another user's behalf, or
record one as coming from an application it is not.

The central list has no parameter naming a user, so it cannot be pointed at
somebody else's graph.

## Events

Every mutation writes a `follow_events` row in the **same transaction** as the
state change it describes, and a worker delivers from there. Nothing is
delivered inline, so a slow remote server or a dead notification service cannot
fail a user's follow.

`event_id` is deterministic and consumer-facing: delivery is at-least-once, and
seeing an id twice means the same event, not a second one.

The event says what happened to the *relationship* and, separately, what caused
it — `follow.removed` is the same event whether the user pressed unfollow, the
follow expired, or an undo arrived from another server. A consumer that only
cares "this is over" needs one branch; one that has to tell an expiry from a
decision reads `cause`.

**Whether to notify anybody is not in the event.** That is policy, and it
belongs to whoever projects these events — a follow created from Syra notifies
in Syra, and an application that begins consuming an existing relationship
notifies nobody. Recording "should notify" at write time would freeze that
decision and make it un-fixable for events already written.
