import {
  createUrlBuilders,
  INSTANCE_ACTOR_USERNAME,
  normalizeActorUsername,
} from '@oxy.so/federation';
import type { Request, Response } from 'express';

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
    href: createUrlBuilders(domain).actor(username),
  };
  const profilePage = {
    rel: 'http://webfinger.net/rel/profile-page',
    type: 'text/html',
    href: `https://${domain}/@${username}`,
  };
  return {
    subject: `acct:${username}@${domain}`,
    // The instance actor is a signing identity, not a person: it has no profile page.
    links: username === INSTANCE_ACTOR_USERNAME ? [self] : [self, profilePage],
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

      const canonicalUsername = normalizeActorUsername(acct.substring(0, atIndex));
      const domain = acct.substring(atIndex + 1);

      if (!deps.isOwnFederationDomain(domain))
        return res.status(404).json({ error: 'Domain not served here' });

      // Mastodon WebFingers a signing key's owner before trusting the key, so the
      // instance actor must resolve here as it does at `/ap/users/:username`.
      if (canonicalUsername !== INSTANCE_ACTOR_USERNAME) {
        const user = await deps.findUserByUsername(canonicalUsername);
        if (!user || !deps.isFederatableUser(user))
          return res.status(404).json({ error: 'User not found' });
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
