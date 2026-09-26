import type { Request, Response } from 'express';

/**
 * The username the instance actor is served under: `/ap/users/instance`, whose
 * key (`https://<domain>/ap/users/instance#main-key`) signs every outbound
 * federation GET Oxy makes.
 *
 * WebFinger has to answer for it. Mastodon verifies a signature by resolving the
 * key's owner, and for an actor it has not seen it WebFingers
 * `acct:<preferredUsername>@<host>` before trusting the key. A 404 there fails
 * EVERY signed fetch against a server in authorized-fetch mode (mastodon.social
 * among them) with a 401 — which is how Oxy stopped being able to verify any
 * external actor on those servers.
 */
export const INSTANCE_ACTOR_USERNAME = 'instance';

export interface WebfingerDependencies<User> {
  /** The canonical federation domain every subject and link is written on. */
  domain: string;
  isOwnFederationDomain(domain: string): boolean;
  findUserByUsername(username: string): Promise<User | undefined>;
  isFederatableUser(user: User): boolean;
  logger: { error(message: string, error: unknown): void };
}

function jrdFor(username: string, domain: string) {
  const self = {
    rel: 'self',
    type: 'application/activity+json',
    href: `https://${domain}/ap/users/${username}`,
  };
  // The instance actor is a signing identity, not a person: it has no profile page.
  if (username === INSTANCE_ACTOR_USERNAME) {
    return { subject: `acct:${username}@${domain}`, links: [self] };
  }
  return {
    subject: `acct:${username}@${domain}`,
    links: [
      self,
      {
        rel: 'http://webfinger.net/rel/profile-page',
        type: 'text/html',
        href: `https://${domain}/@${username}`,
      },
    ],
  };
}

/** `GET /.well-known/webfinger` for the users, and the instance actor, Oxy federates. */
export function createWebfingerHandler<User>(deps: WebfingerDependencies<User>) {
  return async (req: Request, res: Response) => {
    try {
      const resource = req.query.resource;
      if (typeof resource !== 'string' || !resource.startsWith('acct:')) {
        return res.status(400).json({ error: 'Invalid resource' });
      }

      const acct = resource.slice('acct:'.length);
      const atIndex = acct.indexOf('@');
      if (atIndex === -1) return res.status(400).json({ error: 'Invalid acct format' });

      const canonicalUsername = acct.substring(0, atIndex).trim().toLowerCase();
      const domain = acct.substring(atIndex + 1);

      if (!deps.isOwnFederationDomain(domain)) return res.status(404).json({ error: 'Domain not served here' });

      // Reserved exactly as `/ap/users/:username` reserves it, so the two agree
      // on who `instance` is.
      if (canonicalUsername !== INSTANCE_ACTOR_USERNAME) {
        const user = await deps.findUserByUsername(canonicalUsername);
        if (!user || !deps.isFederatableUser(user)) return res.status(404).json({ error: 'User not found' });
      }

      res.setHeader('Content-Type', 'application/jrd+json');
      res.setHeader('Cache-Control', 'max-age=3600');
      return res.json(jrdFor(canonicalUsername, deps.domain));
    } catch (err: unknown) {
      deps.logger.error('WebFinger error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  };
}
