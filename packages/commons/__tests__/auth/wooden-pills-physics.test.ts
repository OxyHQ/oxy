import {
  stepWoodenPills,
  type WoodenPillBody,
} from '../../components/auth/woodenPillsPhysics';

const WIDTH = 400;
const HEIGHT = 720;
const PILL_HEIGHT = 46;

function makeBody(x: number, y: number, width = 110): WoodenPillBody {
  const mass = width / PILL_HEIGHT;
  return {
    x,
    y,
    angle: 0,
    vx: 0,
    vy: 0,
    angularVelocity: 0,
    axisX: 1,
    axisY: 0,
    halfSegment: (width - PILL_HEIGHT) / 2,
    radius: PILL_HEIGHT / 2,
    invMass: 1 / mass,
    invInertia: 12 / (mass * (width * width + PILL_HEIGHT * PILL_HEIGHT)),
    enteredViewport: y >= PILL_HEIGHT / 2,
    contacted: false,
  };
}

function step(
  bodies: WoodenPillBody[],
  gravityX = 0,
  gravityY = 1
) {
  return stepWoodenPills(bodies, {
    dt: 1 / 120,
    width: WIDTH,
    height: HEIGHT,
    gravityX,
    gravityY,
    normalGravity: 0,
    draggedIndex: -1,
    dragX: 0,
    dragY: 0,
    dragLocalX: 0,
    dragLocalY: 0,
  });
}

describe('wooden pill physics', () => {
  it('settles a pill on the floor without perpetual bounce', () => {
    const bodies = [makeBody(WIDTH / 2, 200)];

    for (let frame = 0; frame < 600; frame += 1) step(bodies);

    expect(bodies[0].y).toBeCloseTo(HEIGHT - PILL_HEIGHT / 2, 1);
    expect(Math.hypot(bodies[0].vx, bodies[0].vy)).toBeLessThan(0.01);
    expect(Math.abs(bodies[0].angularVelocity)).toBeLessThan(0.01);
  });

  it('keeps a tall supported stack still', () => {
    const bodies = Array.from({ length: 6 }, (_, index) =>
      makeBody(WIDTH / 2, 650 - index * PILL_HEIGHT)
    );

    for (let frame = 0; frame < 1200; frame += 1) step(bodies);

    const maximumSpeed = Math.max(
      ...bodies.map((body) => Math.hypot(body.vx, body.vy))
    );
    expect(maximumSpeed).toBeLessThan(0.01);
    expect(bodies.every((body) => body.contacted)).toBe(true);
  });

  it('closes the top boundary after a pill has entered the viewport', () => {
    const bodies = [makeBody(WIDTH / 2, -80)];

    for (let frame = 0; frame < 360; frame += 1) step(bodies);
    expect(bodies[0].enteredViewport).toBe(true);

    for (let frame = 0; frame < 360; frame += 1) step(bodies, 0, -1);
    expect(bodies[0].y - bodies[0].radius).toBeGreaterThanOrEqual(-0.1);
  });

  it('reports firm landing energy on the initial fall and ignores resting contacts', () => {
    const bodies = [makeBody(WIDTH / 2, 100)];
    let maximumImpact = 0;

    for (let frame = 0; frame < 240; frame += 1) {
      maximumImpact = Math.max(maximumImpact, step(bodies));
    }

    expect(maximumImpact).toBeGreaterThan(1200);
    expect(step(bodies)).toBeLessThan(220);
  });
});
