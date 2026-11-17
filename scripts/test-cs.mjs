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

test('step clearance does not allow walking through a taller wall', () => {
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

test('narrow viewmodel FOV preserves horizontal framing', () => {
  const expression = html.match(/const viewmodelFov = (.*);/)[1];
  const fov = vm.runInNewContext(expression, { CFG: { vmFov: 58 }, DEG: Math.PI / 180 });
  assert.ok(Math.abs(fov(16 / 9) - 58) < 1e-10);
  const radians = Math.PI / 180;
  const horizontal = aspect => Math.tan(fov(aspect) * radians / 2) * aspect;
  assert.ok(Math.abs(horizontal(0.5) - horizontal(4 / 3)) < 1e-10);
});

test('preview framing contains a rotating model for wide and square thumbnails', () => {
  const code = html.slice(html.indexOf('function previewDistance('), html.indexOf('class Showcase {'));
  const distance = vm.runInNewContext(code + '; previewDistance;', { DEG: Math.PI / 180 });
  const aspect = 16 / 9, angle = Math.atan(0.17), sn = Math.sin(angle), cs = Math.cos(angle), tan = Math.tan(14 * Math.PI / 180);
  for (const [radius, halfY] of [[0.7, 0.18], [0.2, 0.25], [0.04, 0.08]]) {
    for (const crop of [1, aspect, 3]) {
      const d = distance(radius, halfY, aspect, crop);
      for (let i = 0; i < 72; i++) for (const y of [-halfY, halfY]) {
        const x = radius * Math.cos(i * Math.PI / 36), z = radius * Math.sin(i * Math.PI / 36), depth = d - y * sn - z * cs;
        assert.ok(Math.abs(x / depth / (tan * Math.min(aspect, crop))) < 1);
        assert.ok(Math.abs((y * cs - z * sn) / depth / (tan * Math.min(1, aspect / crop))) < 1);
      }
    }
  }
});
