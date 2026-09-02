export interface WoodenPillBody {
  x: number;
  y: number;
  angle: number;
  vx: number;
  vy: number;
  angularVelocity: number;
  axisX: number;
  axisY: number;
  halfSegment: number;
  radius: number;
  invMass: number;
  invInertia: number;
  enteredViewport: boolean;
  contacted: boolean;
}

export interface WoodenPillsStepOptions {
  dt: number;
  width: number;
  height: number;
  gravityX: number;
  gravityY: number;
  normalGravity: number;
  draggedIndex: number;
  dragX: number;
  dragY: number;
  dragLocalX: number;
  dragLocalY: number;
}

const MAX_SUBSTEP_SECONDS = 1 / 120;
const MAX_FRAME_SECONDS = 1 / 30;
const SOLVER_ITERATIONS = 4;
const GRAVITY_DP_PER_SECOND_SQUARED = 12000;
// Dry, light wood: contact should grip and turn sliding into rotation, while
// rolling resistance brings a loose pill to rest without a viscous/oily drag.
const BASE_ROLLING_DECELERATION = 70;
const PLANE_ROLLING_DECELERATION = 220;
const LINEAR_DAMPING_PER_SECOND = 0.18;
const ANGULAR_DAMPING_PER_SECOND = 1;
const BODY_RESTITUTION = 0.2;
const WALL_RESTITUTION = 0.17;
const RESTITUTION_MIN_IMPACT_SPEED = 220;
const BODY_FRICTION = 0.38;
const WALL_FRICTION = 0.26;
const POSITION_CORRECTION = 0.82;
const POSITION_SLOP = 0.04;
// A capsule must not travel farther than roughly its radius in one 120 Hz
// frame, otherwise it can tunnel into another body and appear to jump.
const MAX_LINEAR_SPEED = 2600;
const MAX_ANGULAR_SPEED = 10;
const DRAG_STIFFNESS = 1150;
const DRAG_DAMPING = 68;

function clamp(value: number, min: number, max: number) {
  'worklet';
  return Math.min(max, Math.max(min, value));
}

function cross(ax: number, ay: number, bx: number, by: number) {
  'worklet';
  return ax * by - ay * bx;
}

function closestPointsOnSegments(
  aStartX: number,
  aStartY: number,
  aEndX: number,
  aEndY: number,
  bStartX: number,
  bStartY: number,
  bEndX: number,
  bEndY: number
) {
  'worklet';
  const aX = aEndX - aStartX;
  const aY = aEndY - aStartY;
  const bX = bEndX - bStartX;
  const bY = bEndY - bStartY;
  const betweenX = aStartX - bStartX;
  const betweenY = aStartY - bStartY;
  const aLengthSquared = aX * aX + aY * aY;
  const bLengthSquared = bX * bX + bY * bY;
  const bProjection = bX * betweenX + bY * betweenY;

  let aT = 0;
  let bT = 0;

  if (aLengthSquared <= 0.000001 && bLengthSquared <= 0.000001) {
    return { aX: aStartX, aY: aStartY, bX: bStartX, bY: bStartY };
  }

  if (aLengthSquared <= 0.000001) {
    bT = clamp(bProjection / bLengthSquared, 0, 1);
  } else {
    const aProjection = aX * betweenX + aY * betweenY;
    if (bLengthSquared <= 0.000001) {
      aT = clamp(-aProjection / aLengthSquared, 0, 1);
    } else {
      const axesDot = aX * bX + aY * bY;
      const denominator = aLengthSquared * bLengthSquared - axesDot * axesDot;
      const parallelTolerance = aLengthSquared * bLengthSquared * 0.000001;

      // Parallel capsule spines have an interval of equally valid closest
      // points. Picking one arbitrary endpoint creates a fake torque and makes
      // a settled stack tremble. Use the middle of their projected overlap.
      if (Math.abs(denominator) <= parallelTolerance) {
        const bStartOnA =
          ((bStartX - aStartX) * aX + (bStartY - aStartY) * aY) /
          aLengthSquared;
        const bEndOnA =
          ((bEndX - aStartX) * aX + (bEndY - aStartY) * aY) /
          aLengthSquared;
        const overlapStart = Math.max(0, Math.min(bStartOnA, bEndOnA));
        const overlapEnd = Math.min(1, Math.max(bStartOnA, bEndOnA));
        if (overlapStart <= overlapEnd) {
          aT = (overlapStart + overlapEnd) / 2;
          const pointOnAX = aStartX + aX * aT;
          const pointOnAY = aStartY + aY * aT;
          bT = clamp(
            ((pointOnAX - bStartX) * bX + (pointOnAY - bStartY) * bY) /
              bLengthSquared,
            0,
            1
          );
          return {
            aX: pointOnAX,
            aY: pointOnAY,
            bX: bStartX + bX * bT,
            bY: bStartY + bY * bT,
          };
        }
      }

      if (Math.abs(denominator) > parallelTolerance) {
        aT = clamp(
          (axesDot * bProjection - aProjection * bLengthSquared) / denominator,
          0,
          1
        );
      }
      bT = (axesDot * aT + bProjection) / bLengthSquared;
      if (bT < 0) {
        bT = 0;
        aT = clamp(-aProjection / aLengthSquared, 0, 1);
      } else if (bT > 1) {
        bT = 1;
        aT = clamp((axesDot - aProjection) / aLengthSquared, 0, 1);
      }
    }
  }

  return {
    aX: aStartX + aX * aT,
    aY: aStartY + aY * aT,
    bX: bStartX + bX * bT,
    bY: bStartY + bY * bT,
  };
}

function resolvePillPair(
  a: WoodenPillBody,
  b: WoodenPillBody,
  gravityX: number,
  gravityY: number
) {
  'worklet';
  const centreDeltaX = b.x - a.x;
  const centreDeltaY = b.y - a.y;
  const broadRadius = a.halfSegment + a.radius + b.halfSegment + b.radius;
  if (
    centreDeltaX * centreDeltaX + centreDeltaY * centreDeltaY >=
    broadRadius * broadRadius
  ) {
    return 0;
  }
  const closest = closestPointsOnSegments(
    a.x - a.axisX * a.halfSegment,
    a.y - a.axisY * a.halfSegment,
    a.x + a.axisX * a.halfSegment,
    a.y + a.axisY * a.halfSegment,
    b.x - b.axisX * b.halfSegment,
    b.y - b.axisY * b.halfSegment,
    b.x + b.axisX * b.halfSegment,
    b.y + b.axisY * b.halfSegment
  );

  let normalX = closest.bX - closest.aX;
  let normalY = closest.bY - closest.aY;
  let distance = Math.hypot(normalX, normalY);
  const radiusSum = a.radius + b.radius;
  if (distance >= radiusSum) return 0;

  a.contacted = true;
  b.contacted = true;

  if (distance < 0.0001) {
    normalX = b.x - a.x;
    normalY = b.y - a.y;
    distance = Math.hypot(normalX, normalY);
    if (distance < 0.0001) {
      normalX = 1;
      normalY = 0;
      distance = 1;
    }
  }
  normalX /= distance;
  normalY /= distance;

  const gravityMagnitude = Math.hypot(gravityX, gravityY);
  const supportAlignment =
    gravityMagnitude > 0.001
      ? (gravityX * normalX + gravityY * normalY) / gravityMagnitude
      : 0;
  const bRestsOnA = supportAlignment < -0.55;
  const aRestsOnB = supportAlignment > 0.55;
  const correctionInvMassA = bRestsOnA ? 0 : a.invMass;
  const correctionInvMassB = aRestsOnB ? 0 : b.invMass;
  const correctionInverseMassSum = correctionInvMassA + correctionInvMassB;
  const penetration = radiusSum - distance;
  const correction =
    (Math.max(0, penetration - POSITION_SLOP) * POSITION_CORRECTION) /
    correctionInverseMassSum;
  a.x -= normalX * correction * correctionInvMassA;
  a.y -= normalY * correction * correctionInvMassA;
  b.x += normalX * correction * correctionInvMassB;
  b.y += normalY * correction * correctionInvMassB;

  const contactX = (closest.aX + normalX * a.radius + closest.bX - normalX * b.radius) / 2;
  const contactY = (closest.aY + normalY * a.radius + closest.bY - normalY * b.radius) / 2;
  const aContactX = contactX - a.x;
  const aContactY = contactY - a.y;
  const bContactX = contactX - b.x;
  const bContactY = contactY - b.y;
  const aVelocityX = a.vx - a.angularVelocity * aContactY;
  const aVelocityY = a.vy + a.angularVelocity * aContactX;
  const bVelocityX = b.vx - b.angularVelocity * bContactY;
  const bVelocityY = b.vy + b.angularVelocity * bContactX;
  const relativeX = bVelocityX - aVelocityX;
  const relativeY = bVelocityY - aVelocityY;
  const velocityAlongNormal = relativeX * normalX + relativeY * normalY;
  if (velocityAlongNormal >= 0) return 0;

  const impactSpeed = -velocityAlongNormal;
  // During low-energy stacked contact, propagate support from the lower body
  // upward instead of feeding a compression wave back into the pile.
  const useStableSupport =
    impactSpeed < RESTITUTION_MIN_IMPACT_SPEED && (aRestsOnB || bRestsOnA);
  const impulseInvMassA = useStableSupport && bRestsOnA ? 0 : a.invMass;
  const impulseInvMassB = useStableSupport && aRestsOnB ? 0 : b.invMass;
  const impulseInvInertiaA = useStableSupport && bRestsOnA ? 0 : a.invInertia;
  const impulseInvInertiaB = useStableSupport && aRestsOnB ? 0 : b.invInertia;
  const impulseInverseMassSum = impulseInvMassA + impulseInvMassB;

  const aNormalArm = cross(aContactX, aContactY, normalX, normalY);
  const bNormalArm = cross(bContactX, bContactY, normalX, normalY);
  const normalDenominator =
    impulseInverseMassSum +
    aNormalArm * aNormalArm * impulseInvInertiaA +
    bNormalArm * bNormalArm * impulseInvInertiaB;
  const restitution =
    impactSpeed >= RESTITUTION_MIN_IMPACT_SPEED ? BODY_RESTITUTION : 0;
  const normalImpulse = (-(1 + restitution) * velocityAlongNormal) / normalDenominator;
  const impulseX = normalX * normalImpulse;
  const impulseY = normalY * normalImpulse;
  a.vx -= impulseX * impulseInvMassA;
  a.vy -= impulseY * impulseInvMassA;
  a.angularVelocity -=
    cross(aContactX, aContactY, impulseX, impulseY) * impulseInvInertiaA;
  b.vx += impulseX * impulseInvMassB;
  b.vy += impulseY * impulseInvMassB;
  b.angularVelocity +=
    cross(bContactX, bContactY, impulseX, impulseY) * impulseInvInertiaB;

  let tangentX = relativeX - velocityAlongNormal * normalX;
  let tangentY = relativeY - velocityAlongNormal * normalY;
  const tangentLength = Math.hypot(tangentX, tangentY);
  if (tangentLength < 0.0001) return impactSpeed;
  tangentX /= tangentLength;
  tangentY /= tangentLength;
  const aTangentArm = cross(aContactX, aContactY, tangentX, tangentY);
  const bTangentArm = cross(bContactX, bContactY, tangentX, tangentY);
  const tangentDenominator =
    impulseInverseMassSum +
    aTangentArm * aTangentArm * impulseInvInertiaA +
    bTangentArm * bTangentArm * impulseInvInertiaB;
  const tangentVelocity = relativeX * tangentX + relativeY * tangentY;
  const tangentImpulse = clamp(
    -tangentVelocity / tangentDenominator,
    -normalImpulse * BODY_FRICTION,
    normalImpulse * BODY_FRICTION
  );
  const frictionX = tangentX * tangentImpulse;
  const frictionY = tangentY * tangentImpulse;
  a.vx -= frictionX * impulseInvMassA;
  a.vy -= frictionY * impulseInvMassA;
  a.angularVelocity -=
    cross(aContactX, aContactY, frictionX, frictionY) * impulseInvInertiaA;
  b.vx += frictionX * impulseInvMassB;
  b.vy += frictionY * impulseInvMassB;
  b.angularVelocity +=
    cross(bContactX, bContactY, frictionX, frictionY) * impulseInvInertiaB;
  return impactSpeed;
}

function resolveWall(
  body: WoodenPillBody,
  normalX: number,
  normalY: number,
  penetration: number
) {
  'worklet';
  if (penetration <= 0) return 0;
  body.contacted = true;
  body.x += normalX * penetration;
  body.y += normalY * penetration;

  const towardWallX = -normalX;
  const towardWallY = -normalY;
  const axisTowardWall = body.axisX * towardWallX + body.axisY * towardWallY;
  // At a nearly parallel wall the capsule's straight side is the contact
  // patch. Resolve through its centre instead of alternating endpoints.
  const endpointSign =
    Math.abs(axisTowardWall) < 0.025 ? 0 : axisTowardWall > 0 ? 1 : -1;
  const contactX =
    body.axisX * body.halfSegment * endpointSign + towardWallX * body.radius;
  const contactY =
    body.axisY * body.halfSegment * endpointSign + towardWallY * body.radius;
  const contactVelocityX = body.vx - body.angularVelocity * contactY;
  const contactVelocityY = body.vy + body.angularVelocity * contactX;
  const velocityAlongNormal = contactVelocityX * normalX + contactVelocityY * normalY;
  if (velocityAlongNormal >= 0) return 0;

  const impactSpeed = -velocityAlongNormal;

  const normalArm = cross(contactX, contactY, normalX, normalY);
  const normalDenominator = body.invMass + normalArm * normalArm * body.invInertia;
  const restitution =
    impactSpeed >= RESTITUTION_MIN_IMPACT_SPEED ? WALL_RESTITUTION : 0;
  const normalImpulse = (-(1 + restitution) * velocityAlongNormal) / normalDenominator;
  const impulseX = normalX * normalImpulse;
  const impulseY = normalY * normalImpulse;
  body.vx += impulseX * body.invMass;
  body.vy += impulseY * body.invMass;
  body.angularVelocity += cross(contactX, contactY, impulseX, impulseY) * body.invInertia;

  const tangentX = -normalY;
  const tangentY = normalX;
  const tangentVelocity = contactVelocityX * tangentX + contactVelocityY * tangentY;
  const tangentArm = cross(contactX, contactY, tangentX, tangentY);
  const tangentDenominator = body.invMass + tangentArm * tangentArm * body.invInertia;
  const tangentImpulse = clamp(
    -tangentVelocity / tangentDenominator,
    -normalImpulse * WALL_FRICTION,
    normalImpulse * WALL_FRICTION
  );
  const frictionX = tangentX * tangentImpulse;
  const frictionY = tangentY * tangentImpulse;
  body.vx += frictionX * body.invMass;
  body.vy += frictionY * body.invMass;
  body.angularVelocity += cross(contactX, contactY, frictionX, frictionY) * body.invInertia;
  return impactSpeed;
}

function resolveWorldBounds(body: WoodenPillBody, width: number, height: number) {
  'worklet';
  const axisReachX = Math.abs(body.axisX * body.halfSegment);
  const axisReachY = Math.abs(body.axisY * body.halfSegment);
  const minX = body.x - axisReachX - body.radius;
  const maxX = body.x + axisReachX + body.radius;
  const minY = body.y - axisReachY - body.radius;
  const maxY = body.y + axisReachY + body.radius;

  let impactSpeed = resolveWall(body, 1, 0, -minX);
  impactSpeed = Math.max(impactSpeed, resolveWall(body, -1, 0, maxX - width));
  impactSpeed = Math.max(impactSpeed, resolveWall(body, 0, -1, maxY - height));
  if (body.enteredViewport) {
    impactSpeed = Math.max(impactSpeed, resolveWall(body, 0, 1, -minY));
  } else if (minY >= 0) {
    body.enteredViewport = true;
  }
  return impactSpeed;
}

function applyRollingResistance(body: WoodenPillBody, normalGravity: number, dt: number) {
  'worklet';
  const speed = Math.hypot(body.vx, body.vy);
  if (speed < 0.001) return;
  const deceleration =
    BASE_ROLLING_DECELERATION +
    PLANE_ROLLING_DECELERATION * clamp(Math.abs(normalGravity), 0, 1.5);
  const nextSpeed = Math.max(0, speed - deceleration * dt);
  const scale = nextSpeed / speed;
  body.vx *= scale;
  body.vy *= scale;
}

export function stepWoodenPills(
  bodies: WoodenPillBody[],
  options: WoodenPillsStepOptions
) {
  'worklet';
  let maximumImpactSpeed = 0;
  const frameSeconds = clamp(options.dt, 0, MAX_FRAME_SECONDS);
  const substeps = Math.max(1, Math.ceil(frameSeconds / MAX_SUBSTEP_SECONDS));
  const dt = frameSeconds / substeps;

  for (let substep = 0; substep < substeps; substep += 1) {
    for (let index = 0; index < bodies.length; index += 1) {
      const body = bodies[index];
      body.contacted = false;
      let accelerationX = options.gravityX * GRAVITY_DP_PER_SECOND_SQUARED;
      let accelerationY = options.gravityY * GRAVITY_DP_PER_SECOND_SQUARED;

      if (index === options.draggedIndex) {
        const cos = Math.cos(body.angle);
        const sin = Math.sin(body.angle);
        const targetX =
          options.dragX - (options.dragLocalX * cos - options.dragLocalY * sin);
        const targetY =
          options.dragY - (options.dragLocalX * sin + options.dragLocalY * cos);
        accelerationX += (targetX - body.x) * DRAG_STIFFNESS - body.vx * DRAG_DAMPING;
        accelerationY += (targetY - body.y) * DRAG_STIFFNESS - body.vy * DRAG_DAMPING;
        body.angularVelocity = 0;
      }

      body.vx += accelerationX * dt;
      body.vy += accelerationY * dt;
      applyRollingResistance(body, options.normalGravity, dt);
      const linearDamping = Math.exp(-LINEAR_DAMPING_PER_SECOND * dt);
      body.vx *= linearDamping;
      body.vy *= linearDamping;
      body.angularVelocity *= Math.exp(-ANGULAR_DAMPING_PER_SECOND * dt);

      const speed = Math.hypot(body.vx, body.vy);
      if (speed > MAX_LINEAR_SPEED) {
        const speedScale = MAX_LINEAR_SPEED / speed;
        body.vx *= speedScale;
        body.vy *= speedScale;
      }
      body.angularVelocity = clamp(
        body.angularVelocity,
        -MAX_ANGULAR_SPEED,
        MAX_ANGULAR_SPEED
      );
      body.x += body.vx * dt;
      body.y += body.vy * dt;
      body.angle += body.angularVelocity * dt;
      body.axisX = Math.cos(body.angle);
      body.axisY = Math.sin(body.angle);
    }

    for (let iteration = 0; iteration < SOLVER_ITERATIONS; iteration += 1) {
      for (const body of bodies) {
        maximumImpactSpeed = Math.max(
          maximumImpactSpeed,
          resolveWorldBounds(body, options.width, options.height)
        );
      }
      for (let first = 0; first < bodies.length - 1; first += 1) {
        for (let second = first + 1; second < bodies.length; second += 1) {
          maximumImpactSpeed = Math.max(
            maximumImpactSpeed,
            resolvePillPair(
              bodies[first],
              bodies[second],
              options.gravityX,
              options.gravityY
            )
          );
        }
      }
    }
  }

  return maximumImpactSpeed;
}

export function hitTestWoodenPill(
  x: number,
  y: number,
  bodyX: number,
  bodyY: number,
  angle: number,
  halfSegment: number,
  radius: number
) {
  'worklet';
  const dx = x - bodyX;
  const dy = y - bodyY;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const localX = dx * cos + dy * sin;
  const localY = -dx * sin + dy * cos;
  const closestX = clamp(localX, -halfSegment, halfSegment);
  return Math.hypot(localX - closestX, localY) <= radius;
}
