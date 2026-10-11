/**
 * Dev-only asset showcase: `/showcase.html?set=homes&time=13&zoom=3`.
 * Lays a set of models out on a grid under the game's lighting and post
 * so they can be judged close up. Not part of the production build.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLOW, setEnvironment } from '../render/geo.ts';
import { Post } from '../render/post.ts';
import { atmosphereAt } from '../world/daylight.ts';
import { SETS } from './sets.ts';

const params = new URLSearchParams(location.search);
const set = params.get('set') ?? 'homes';
const hour = Number(params.get('time') ?? 13);
const cols = Number(params.get('cols') ?? 0);

const host = document.getElementById('world')!;
const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.shadowMap.enabled = true;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
host.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const a = atmosphereAt(hour);
scene.background = new THREE.Color(...a.fog);
const pmrem = new THREE.PMREMGenerator(renderer);
setEnvironment(pmrem.fromScene(new RoomEnvironment(), 0.04).texture, 0.25 + 0.75 * (1 - a.night));
renderer.toneMappingExposure = a.exposure;
GLOW.night.value = a.night;

const hemi = new THREE.HemisphereLight(new THREE.Color(...a.skyColor), new THREE.Color(...a.groundColor), a.hemiIntensity);
const sun = new THREE.DirectionalLight(new THREE.Color(...a.lightColor), a.lightIntensity);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.03;
scene.add(hemi, sun, sun.target);

const items = SETS[set]?.() ?? [];
const size = Math.max(1, ...items.map((i) => i.size ?? 2));
const n = cols || Math.ceil(Math.sqrt(items.length));
const spacing = size * 1.25;
const labels: { el: HTMLSpanElement; at: THREE.Vector3 }[] = [];
items.forEach((item, i) => {
  const x = (i % n) * spacing;
  const z = Math.floor(i / n) * spacing;
  item.object.position.x += x;
  item.object.position.z += z;
  item.object.traverse((o) => {
    o.castShadow = true;
    o.receiveShadow = true;
  });
  scene.add(item.object);
  const el = document.createElement('span');
  el.textContent = item.label;
  document.getElementById('labels')!.appendChild(el);
  labels.push({ el, at: new THREE.Vector3(x + spacing * 0.35, 0, z + spacing * 0.35) });
});
const extent = Math.max(1, n) * spacing;
const ground = new THREE.Mesh(new THREE.PlaneGeometry(extent + 40, extent + 40).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x8cc65e, roughness: 0.95 }));
ground.position.set(extent / 2 - spacing / 2, -0.005, extent / 2 - spacing / 2);
ground.receiveShadow = true;
scene.add(ground);

const centre = new THREE.Vector3(((Math.min(n, items.length) - 1) * spacing) / 2, 0, ((Math.ceil(items.length / n) - 1) * spacing) / 2);
const span = extent * 0.75;
sun.shadow.camera.left = sun.shadow.camera.bottom = -span;
sun.shadow.camera.right = sun.shadow.camera.top = span;
sun.shadow.camera.far = 400;
sun.target.position.copy(centre);
const [lx, ly, lz] = a.lightDir;
sun.position.set(lx, ly, lz).normalize().multiplyScalar(120).add(centre);

const VIEW = 26;
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -300, 600);
const polar = Math.acos(1 / Math.sqrt(3));
const az = Number(params.get('az') ?? 45) * (Math.PI / 180);
camera.position.copy(centre).add(new THREE.Vector3(Math.sin(az) * Math.sin(polar), Math.cos(polar), Math.cos(az) * Math.sin(polar)).multiplyScalar(100));
camera.zoom = Number(params.get('zoom') ?? VIEW / (extent * 1.1));
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.copy(centre);
controls.screenSpacePanning = true;
controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };

const dbg = params.get('dbg') ?? '';
if (dbg.includes('noenv')) setEnvironment(null);
const post = new Post(renderer, scene, camera, (params.get('quality') as 'low' | 'medium' | 'high') ?? 'high');
function resize() {
  const w = host.clientWidth;
  const h = host.clientHeight;
  camera.left = (-VIEW * w) / h / 2;
  camera.right = (VIEW * w) / h / 2;
  camera.top = VIEW / 2;
  camera.bottom = -VIEW / 2;
  camera.updateProjectionMatrix();
  const pr = Math.min(devicePixelRatio, 2);
  renderer.setPixelRatio(pr);
  renderer.setSize(w, h);
  post.setSize(w, h, pr);
}
resize();
addEventListener('resize', resize);

const clock = new THREE.Timer();
renderer.setAnimationLoop((now) => {
  clock.update(now);
  const t = clock.getElapsed();
  GLOW.time.value = t;
  for (const item of items) item.update?.(clock.getDelta(), t);
  controls.update();
  post.update(t, { bloom: dbg.includes('nobloom') ? 0 : a.bloom, night: a.night, tilt: 0, focusY: 0.5, warmth: 0 });
  if (dbg.includes('raw')) renderer.render(scene, camera);
  else post.render(1 / 60);
  for (const l of labels) {
    const p = l.at.clone().project(camera);
    l.el.style.left = `${((p.x + 1) / 2) * innerWidth}px`;
    l.el.style.top = `${((1 - p.y) / 2) * innerHeight}px`;
  }
});
