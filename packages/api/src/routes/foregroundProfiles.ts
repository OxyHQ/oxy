/** Opt-in foreground Capability lane; legacy HTTP/session routes remain separate. */
import { Router } from 'express';
import { oxyProfileCapabilityRead } from '../capabilities/oxy-profile.transport';
const router = Router();

/**
 * @openapi
 * /_oxy/capabilities/profiles/recommendations:
 *   post:
 *     tags: [Capabilities]
 *     summary: Rank profiles for the signed present subject and verified presenting application
 *     security: [{ capabilityTicketAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: false
 *             properties:
 *               clientId: { type: string, minLength: 1, description: Must equal the signed presenting Application.id if supplied. }
 *               limit: { type: integer, minimum: 1, maximum: 100 }
 *               offset: { type: integer, minimum: 0 }
 *               excludeTypes: { type: array, items: { type: string, enum: [federated, agent, automated] } }
 *               excludeIds: { type: array, maxItems: 500, items: { type: string, minLength: 1 } }
 *               boosts:
 *                 type: array
 *                 maxItems: 50
 *                 items:
 *                   type: object
 *                   additionalProperties: false
 *                   required: [userIds, weight]
 *                   properties:
 *                     userIds: { type: array, minItems: 1, maxItems: 200, items: { type: string, minLength: 1 } }
 *                     weight: { type: number, minimum: -5, maximum: 5 }
 *                     reason: { type: string, maxLength: 120 }
 *               signalWeights:
 *                 type: object
 *                 additionalProperties: false
 *                 properties:
 *                   graph: { type: number, minimum: 0, maximum: 10 }
 *                   verified: { type: number, minimum: 0, maximum: 10 }
 *                   repCandidate: { type: number, minimum: 0, maximum: 10 }
 *                   interest: { type: number, minimum: 0, maximum: 10 }
 *                   completeness: { type: number, minimum: 0, maximum: 10 }
 *                   curation: { type: number, minimum: 0, maximum: 10 }
 *                   appBoost: { type: number, minimum: 0, maximum: 10 }
 *                   affinity: { type: number, minimum: 0, maximum: 10 }
 *     responses:
 *       200:
 *         description: Existing recommendation domain result for the signed subject and application.
 *         content:
 *           application/json:
 *             schema: { type: object, required: [recommendations], properties: { recommendations: { type: array, items: { type: object, additionalProperties: true } } } }
 *       401: { description: Capability authorization required. }
 *       403: { description: Signed catalogue, tool or current authority refused. }
 */
router.post('/profiles/recommendations', oxyProfileCapabilityRead('recommendProfiles'));

/**
 * @openapi
 * /_oxy/capabilities/users/me/graph:
 *   get:
 *     tags: [Capabilities]
 *     summary: Read the graph of the signed present subject with no free account selector
 *     security: [{ capabilityTicketAuth: [] }]
 *     responses:
 *       200:
 *         description: Existing viewer graph domain result; no other account selector is accepted.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               additionalProperties: false
 *               required: [followingIds, mutualIds, blockedIds, restrictedIds]
 *               properties:
 *                 followingIds: { type: array, items: { type: string } }
 *                 mutualIds: { type: array, items: { type: string } }
 *                 blockedIds: { type: array, items: { type: string } }
 *                 restrictedIds: { type: array, items: { type: string } }
 *       401: { description: Capability authorization required. }
 *       403: { description: Signed catalogue, tool or current authority refused. }
 */
router.get('/users/me/graph', oxyProfileCapabilityRead('readViewerGraph'));
export default router;
