import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { test } from 'node:test';

const html = await readFile(new URL('../games/cs.html', import.meta.url), 'utf8');
const physics = html.slice(html.indexOf('class PhysicsWorld {'), html.indexOf('const CONT_DEFS ='));
const { PhysicsWorld, NavGraph } = vm.runInNewContext(`
  const CFG = { gravity: 23 };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  ${physics}
  ({ PhysicsWorld, NavGraph });
`);

test('navigation follows supported ramps in both directions', () => {
  const world = new PhysicsWorld();
  world.addBox(-5, -1, -3, 0, 0, 3, { ground: true });
  world.addRamp(0, -2, 7, 2, 0, 0, 2.6, 0, 1);
  world.addBox(7, 0, -3, 15, 2.6, 3);
  const graph = new NavGraph(world, [[-1, 0], [8, 0, 2.6], [13, 0, 2.6]]);
  assert.ok(graph.nodes[0].links.some(l => l.to === 1));
  assert.ok(graph.nodes[1].links.some(l => l.to === 0));
  const path = graph.path(-1, 0, 13, 0, 0, 2.6);
  assert.ok(path.some(p => p.y > 2.5));
});

test('navigation rejects unsupported gaps, walls, and low headroom', () => {
  const world = new PhysicsWorld();
  world.addBox(-3, -1, -3, 0, 0, 3, { ground: true });
  world.addBox(2, -1, -3, 7, 0, 3, { ground: true });
  assert.equal(world.walkableLink({ x: -1, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }), false);
  world.addBox(0, -1, -3, 2, 0, 3, { ground: true });
  world.addBox(1, 1.5, -3, 2, 3, 3);
  assert.equal(world.walkableLink({ x: -1, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }), false);
});

test('a step clearance query cannot discard a later wall collision', () => {
  const world = new PhysicsWorld();
  world.addBox(-10, -1, -10, 10, 0, 10, { ground: true });
  world.addBox(0, 0, -1, 1, 0.3, 1);
  world.addBox(0.1, 0, -1, 1, 3, 1);
  const body = { pos: { x: 0, y: 0, z: 0 }, vel: { x: 2, y: 0, z: 0 }, radius: 0.36, height: 1.8, onGround: true, step: 0.55, airStep: 0.34 };
  world._axis(body, 0, 1);
  assert.equal(body.hitX, true);
  assert.ok(body.pos.x <= -0.26);
});

test('barrel changes invalidate static shadows on destruction and reset', () => {
  const start = html.indexOf('  paintDrums() {');
  const end = html.indexOf('  hitDrum(', start);
  const method = html.slice(start, end);
  // Exercise the real method with an empty instance list and renderer adapter.
  const paint = vm.runInNewContext('({' + method + '})', { THREE: { Object3D: class {}, Color: class {} } }).paintDrums;
  const shadowMap = { needsUpdate: false };
  paint.call({ drumMesh: { instanceMatrix: {} }, bandMesh: { instanceMatrix: {} }, barrels: [], drums: [], game: { renderer: { shadowMap } } });
  assert.equal(shadowMap.needsUpdate, true);
});
