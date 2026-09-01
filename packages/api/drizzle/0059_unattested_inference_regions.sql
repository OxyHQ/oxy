-- oxy:deploy-phase=pre
--
-- WIDENING ONLY. An empty regions array now means that no regional attestation
-- exists for this deployment. The arriving selector excludes such a row under
-- either allowedRegions or deniedRegions, and Kaana requires the signed empty
-- array to match an unattested inventory row exactly.
--
-- This migration changes no row. Do not write an empty array until every Oxy
-- edge accepts contract set 1.4.0 and the matching Kaana build is deployed;
-- older edges reject that envelope refinement. Existing non-empty deployments
-- retain exactly their previous meaning and constraint behaviour.

ALTER TABLE "inference_deployments" DROP CONSTRAINT "inference_deployments_regions_check";
