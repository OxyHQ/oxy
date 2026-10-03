# Current API task census before DDL and during recovery

An old task omitted from the captured plan can have desired STOPPED while its lastStatus remains STOPPING. The identical frozen regression fails against guard195397 and passes against the corrected reader. The reader now unions both current desired-status lists with the captured tasks, verifies complete response identities, and requires every task to be STOPPED. Historical stopped revisions remain allowed. Recovery remembers omitted baseline tasks and confirms the whole current and tracked census. Failed reads no longer claim that the service is stopped.

Final61 guard checks and10 real canonical shell checks use synthetic AWS responses. The omitted-oldSTOPPING shell case records no registration, migration or update events. No live AWS operation occurred; no product API, SDK or migration changed. proof.json preserves the historical attempts and exact final frozen fixture. Fresh image provenance and complete CI remain pending.
