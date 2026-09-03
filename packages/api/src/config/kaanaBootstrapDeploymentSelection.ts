/**
 * Return the one stored row for a reviewed logical deployment.
 *
 * During the rolling storage rename, the legacy and current availability
 * values are intentionally both legal. They are the same logical identity,
 * never two candidates: finding both must fail closed instead of depending on
 * PostgreSQL row order.
 */
export function requireSingleLogicalDeployment<Row>(
  rows: readonly Row[],
  deploymentId: string,
): Row {
  if (rows.length !== 1) {
    throw new Error(
      `Deployment ${deploymentId} must have exactly one legacy/current row after create; found ${rows.length}`,
    );
  }
  const row = rows[0];
  if (row === undefined) throw new Error(`Deployment ${deploymentId} could not be read after create`);
  return row;
}
