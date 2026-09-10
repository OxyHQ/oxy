/**
 * Express application for the Oxy personal data node.
 *
 * This is a THIN adapter over `@oxy.so/protocol`'s generic `createNodeApp`: it
 * wires the node's SQLite {@link NodeStore} (which implements the protocol
 * `RecordStore`/`BlobStore`), the env-resolved {@link NodeConfig}, the
 * owner-key authority ({@link createOwnerAuth}), and the logger. All endpoint
 * behaviour (well-known manifest, `/oxy/head`, `/oxy/log`, `POST /records`,
 * `POST /sync/push`, blob pin/serve, `/health`) lives in the protocol engine, so
 * every Oxy-protocol node deployment shares one implementation.
 *
 * `createApp` is dependency-injected (store, config, logger) so it can be driven
 * by tests with an in-memory store and no network.
 */

import { createNodeApp, type NodeApp } from '@oxy.so/protocol/node';
import type { Logger } from './logger.js';
import type { NodeConfig } from './config.js';
import { createOwnerAuth } from './auth.js';
import type { NodeStore } from './store/nodeStore.js';

export interface AppDependencies {
  store: NodeStore;
  config: NodeConfig;
  logger: Logger;
}

export function createApp(deps: AppDependencies): NodeApp {
  const { store, config, logger } = deps;
  return createNodeApp({
    store,
    ownerAuth: createOwnerAuth(config.ownerPublicKey),
    logger,
    config: {
      wellKnownPath: config.wellKnownPath,
      protocolId: config.protocolId,
      serviceType: config.serviceType,
      mode: config.mode,
      nodePublicKey: config.nodePublicKey,
      maxBlobBytes: config.maxBlobBytes,
      collections: config.collections,
    },
  });
}
