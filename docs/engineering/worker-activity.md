# Asset worker activity

The standalone asset-variant consumer publishes as `oxy-asset-variant-worker` only with `OXY_ECOSYSTEM_ACTIVITY_ENABLED=true`, a valid `AWS_REGION`, and dedicated `OXY_ACTIVITY_API_KEY` / `OXY_ACTIVITY_API_SECRET` credentials. Missing enablement stays off even when AWS storage credentials exist. The worker heartbeat becomes ready after both PostgreSQL and the BullMQ consumer are ready, and becomes unready before shutdown drains the consumer and stops publication.

Each consumed job records an internal inbound media operation. The API adds only its validated infrastructure region to the existing private queue payload; the public aggregate contains no file ID, job ID, user ID, URL or payload. Older queued jobs continue processing with unknown source geography. Failed rendition attempts remain observable operations and still throw to BullMQ for its existing retry behavior. The observer does not invent a completed response or a return queue job.

The shared publisher also observes real outgoing fetch and Node HTTP operations, including media storage requests. Remote geography is shown only when observed and trusted; a storage hostname alone does not locate an external endpoint. Native image transformations are not network hops and generate no synthetic map lines.
