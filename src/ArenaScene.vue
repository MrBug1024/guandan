<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from 'vue';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { rankName, type Card, type Entry, type Move } from '../shared/types';
const props = defineProps<{
  cameraMode: 'first' | 'third';
  viewpointSeat: number;
  turn: number;
  thinking: number | null;
  finished: number[];
  hand: Card[];
  counts: number[];
  entry?: Entry;
  history: Entry[];
  round: number;
  level: number;
  last: Move | null;
  lastSeat: number;
  gameId: string;
}>();
const emit = defineEmits<{
  anchors: [positions: { x: number; y: number }[]];
}>();
const host = ref<HTMLDivElement>(),
  fallback = ref(false),
  fallbackMessage = ref('');
let renderer: THREE.WebGLRenderer | undefined,
  scene: THREE.Scene,
  frame = 0,
  observer: ResizeObserver;
interface Actor {
  root: THREE.Group;
  body: THREE.Group;
  head: THREE.Group;
  left: THREE.Group;
  right: THREE.Group;
  fan: THREE.Group;
  eyes: THREE.Mesh[];
  eyeGlints: THREE.Mesh[];
  headVelocity: number;
  bodyVelocity: number;
}
const actors: Actor[] = [],
  textures: THREE.Texture[] = [],
  temporary = new THREE.Group(),
  resources = new Set<THREE.Material>();
const palette = [0xe68fa9, 0x84a1e1, 0x82bda1, 0xedb56e],
  textureCache = new Map<string, THREE.Texture>();
let environment: THREE.WebGLRenderTarget | undefined;
let handKey = '',
  previousSeq = -1,
  previousRound = -1,
  previousGame = '',
  actionSeat = -1,
  actionTime = -20,
  played: THREE.Group | undefined;
const tablePlays: THREE.Group[] = [];
const firstPerson = new THREE.Group();
const heldCards = new THREE.Group();
let heldKey = '';
function updateHeldCards() {
  const key = `${props.viewpointSeat}:${props.hand.map((c) => c.id).join(',')}`;
  if (key === heldKey) return;
  heldKey = key;
  disposeGroup(heldCards);
  const n = props.hand.length;
  [...props.hand].reverse().forEach((card, i) => {
    const mesh = makeCard(card);
    mesh.scale.setScalar(0.65);
    const offset = i - (n - 1) / 2;
    const step = Math.min(0.13, 1.45 / Math.max(1, n - 1));
    mesh.position.set(-offset * step, 1.65, 1.04 - i * 0.001);
    mesh.rotation.set(-0.18, 0, 0);
    heldCards.add(mesh);
  });
  const grip = Math.min(
    0.65,
    Math.max(0.16, ((n - 1) * Math.min(0.13, 1.45 / Math.max(1, n - 1))) / 2),
  );
  firstPerson.traverse((o) => {
    if (o instanceof THREE.Mesh && o.userData.ourHand) {
      (o.material as THREE.MeshPhysicalMaterial).color.setHex(palette[props.viewpointSeat]);
      const side = o.userData.side;
      o.position.x = side * (grip + o.userData.gripOffset);
    }
  });
}

function material(color: number, roughness = 0.65) {
  const m = new THREE.MeshStandardMaterial({ color, roughness, metalness: 0.04 });
  resources.add(m);
  return m;
}
function characterMaterial(color: number) {
  const surface = new THREE.MeshPhysicalMaterial({
    color,
    roughness: 0.48,
    metalness: 0,
    clearcoat: 0.18,
    clearcoatRoughness: 0.5,
    sheen: 0.16,
    sheenRoughness: 0.85,
    sheenColor: new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.45),
  });
  surface.bumpMap = texture('soft-surface', (ctx, c) => {
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, c.width, c.height);
    let seed = 37;
    for (let j = 0; j < 18000; j++) {
      seed = (seed * 16807) % 2147483647;
      const x = seed % 512;
      seed = (seed * 16807) % 2147483647;
      const y = seed % 768;
      ctx.fillStyle = j % 2 ? '#909090' : '#707070';
      ctx.fillRect(x, y, 1, 1);
    }
  });
  surface.bumpScale = 0.004;
  resources.add(surface);
  return surface;
}
function sphere(
  parent: THREE.Object3D,
  color: number,
  size: [number, number, number],
  at: [number, number, number],
) {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 40, 28), characterMaterial(color));
  mesh.scale.set(...size);
  mesh.position.set(...at);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}
function box(
  parent: THREE.Object3D,
  color: number,
  size: [number, number, number],
  at: [number, number, number],
) {
  const mesh = new THREE.Mesh(
    new RoundedBoxGeometry(...size, 3, Math.min(...size) * 0.22),
    material(color),
  );
  mesh.position.set(...at);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}
function texture(
  key: string,
  paint: (ctx: CanvasRenderingContext2D, c: HTMLCanvasElement) => void,
) {
  if (textureCache.has(key)) return textureCache.get(key)!;
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 768;
  paint(c.getContext('2d')!, c);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  textures.push(t);
  textureCache.set(key, t);
  return t;
}
function cardTexture(card?: Card) {
  return texture(card ? `${card.rank}-${card.suit}` : 'back', (ctx, c) => {
    ctx.fillStyle = card ? '#fff5e4' : '#334f73';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.strokeStyle = card ? '#ddcdb4' : '#d4b779';
    ctx.lineWidth = 8;
    ctx.strokeRect(20, 20, 472, 728);
    if (!card) {
      ctx.strokeStyle = '#8599b7';
      ctx.lineWidth = 2;
      for (let y = 40; y < 740; y += 35)
        for (let x = 40; x < 490; x += 35) {
          ctx.beginPath();
          ctx.moveTo(x, y - 12);
          ctx.lineTo(x + 12, y);
          ctx.lineTo(x, y + 12);
          ctx.lineTo(x - 12, y);
          ctx.closePath();
          ctx.stroke();
        }
      ctx.fillStyle = '#ddc28c';
      ctx.font = 'bold 130px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('✦', 256, 440);
      return;
    }
    const suit = card.suit === 'J' ? '★' : { S: '♠', H: '♥', C: '♣', D: '♦' }[card.suit];
    ctx.fillStyle =
      card.suit === 'H' || card.suit === 'D' || card.rank === 16 ? '#ae4355' : '#253345';
    ctx.font = 'bold 92px sans-serif';
    ctx.fillText(card.rank >= 15 ? 'J' : rankName(card.rank), 32, 120, 98);
    ctx.font = '80px sans-serif';
    ctx.fillText(suit, 45, 210);
    ctx.textAlign = 'center';
    ctx.font = 'bold 150px sans-serif';
    ctx.fillText(rankName(card.rank), 256, 340, 330);
    ctx.font = '190px sans-serif';
    ctx.fillText(suit, 256, 550);
    ctx.save();
    ctx.translate(512, 768);
    ctx.rotate(Math.PI);
    ctx.textAlign = 'left';
    ctx.font = 'bold 92px sans-serif';
    ctx.fillText(card.rank >= 15 ? 'J' : rankName(card.rank), 32, 120, 98);
    ctx.font = '80px sans-serif';
    ctx.fillText(suit, 45, 210);
    ctx.restore();
  });
}
function makeCard(card?: Card) {
  const group = new THREE.Group(),
    geometry = new THREE.PlaneGeometry(0.4, 0.59);
  const front = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ map: cardTexture(card) }));
  front.castShadow = true;
  front.rotation.y = Math.PI;
  front.position.z = -0.001;
  group.add(front);
  const back = new THREE.Mesh(
    geometry.clone(),
    new THREE.MeshStandardMaterial({ map: cardTexture(), roughness: 0.8 }),
  );
  back.castShadow = true;
  back.position.z = 0.001;
  group.add(back);
  return group;
}
function disposeGroup(group: THREE.Group) {
  group.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.geometry.dispose();
      (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
    }
  });
  group.clear();
}
function updateFans() {
  const key = `${props.viewpointSeat}:${props.round}:${props.hand.map((c) => c.id).join(',')}:${props.counts.join(',')}`;
  if (key === handKey) return;
  handKey = key;
  actors.forEach((a, i) => {
    disposeGroup(a.fan);
    const n = i === props.viewpointSeat ? props.hand.length : Math.min(9, props.counts[i]);
    for (let j = 0; j < n; j++) {
      const card = makeCard(i === props.viewpointSeat ? props.hand[j] : undefined),
        angle = (j - (n - 1) / 2) * Math.min(0.14, 1.12 / Math.max(1, n - 1));
      card.position.set(Math.sin(angle) * 1.15, Math.cos(angle) * 0.15, 0.004 * j);
      card.rotation.z = -angle;
      card.rotation.x = 0.34;
      a.fan.add(card);
    }
  });
}
function clearTable() {
  for (const pile of tablePlays) {
    disposeGroup(pile);
    temporary.remove(pile);
  }
  tablePlays.length = 0;
  played = undefined;
}
function playCards(entry: Entry, t: number, settled = false) {
  if (!entry.move || entry.move.kind === 'pass') return;
  const pile = new THREE.Group();
  pile.scale.setScalar(1.3);
  const scatter = (n: number) => Math.sin(entry.seq * 31.7 + n * 17.13) * 0.5;
  entry.move.cards.forEach((c, j) => {
    const mesh = makeCard(c);
    mesh.position.set(
      (j - (entry.move!.cards.length - 1) / 2) * 0.22 + scatter(j) * 0.025,
      j * 0.003,
      scatter(j + 13) * 0.14,
    );
    mesh.rotation.set(Math.PI / 2, 0, scatter(j + 7) * 0.18);
    pile.add(mesh);
  });
  // All cards land in table coordinates, independently of player/camera transforms.
  // Retain previous plays around the centre; reserve the middle for the latest play.
  tablePlays.forEach((old, index) => {
    const angle = index * 2.399963;
    const radius = 1.25 + (index % 3) * 0.16;
    const archived = new THREE.Vector3(
      Math.cos(angle) * radius,
      1.345 + index * 0.00025,
      Math.sin(angle) * radius,
    );
    old.position.copy(archived);
    old.userData.target.copy(archived);
    old.userData.start = t - 2;
    old.scale.setScalar(0.9);
  });
  const target = new THREE.Vector3(0, 1.375, 0);
  const from = actors[entry.seat].root.localToWorld(actors[entry.seat].fan.position.clone());
  from.y = 2.15;
  pile.position.copy(settled ? target : from);
  const yaw = Math.PI + [0, -Math.PI / 2, Math.PI, Math.PI / 2][props.viewpointSeat];
  pile.rotation.y = yaw;
  pile.userData = {
    seat: entry.seat,
    from,
    target,
    yaw,
    start: settled ? t - 2 : t,
    lift: 0.4,
  };
  tablePlays.push(pile);
  played = pile;
  temporary.add(pile);
}
function restoreTable(t: number) {
  clearTable();
  const history = props.history.filter((e) => e.move && e.after?.round === props.round);
  for (const entry of history) playCards(entry, t, true);
  if (!played && props.last && props.entry)
    playCards({ ...props.entry, move: props.last, seat: props.lastSeat }, t, true);
}

onMounted(() => {
  try {
    scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x121c28, 19, 37);
    const camera = new THREE.PerspectiveCamera(39, 1, 0.1, 65);
    camera.position.set(0.15, 7.7, 11.7);
    camera.lookAt(0, 1.1, 0.2);
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.02;
    const studio = new RoomEnvironment();
    const pmrem = new THREE.PMREMGenerator(renderer);
    environment = pmrem.fromScene(studio, 0.04);
    scene.environment = environment.texture;
    scene.environmentIntensity = 0.16;
    studio.dispose();
    pmrem.dispose();
    host.value!.appendChild(renderer.domElement);
    scene.add(new THREE.HemisphereLight(0xc9dff0, 0x25212b, 0.85));
    const key = new THREE.DirectionalLight(0xffe4bc, 2.7);
    key.position.set(-4, 10, 5);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -9;
    key.shadow.camera.right = 9;
    key.shadow.camera.top = 9;
    key.shadow.camera.bottom = -9;
    key.shadow.normalBias = 0.003;
    key.shadow.bias = -0.00015;
    scene.add(key);
    const fill = new THREE.PointLight(0x7db8d7, 18);
    fill.position.set(5, 6, -5);
    scene.add(fill);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), material(0x202a36, 0.96));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.38;
    floor.receiveShadow = true;
    scene.add(floor);
    const rug = new THREE.Mesh(new THREE.CircleGeometry(7.2, 80), material(0x303642, 0.98));
    rug.rotation.x = -Math.PI / 2;
    rug.position.y = -0.36;
    rug.scale.z = 0.82;
    rug.receiveShadow = true;
    scene.add(rug);
    for (const r of [6.5, 6.6]) {
      const seam = new THREE.Mesh(new THREE.TorusGeometry(r, 0.012, 6, 100), material(0x716758));
      seam.rotation.x = -Math.PI / 2;
      seam.position.y = -0.35;
      seam.scale.y = 0.82;
      scene.add(seam);
    }
    const table = new THREE.Group();
    table.scale.set(0.82, 1, 0.82);
    scene.add(table);
    const pedestal = new THREE.Mesh(
      new THREE.CylinderGeometry(0.9, 1.35, 1.1, 48),
      material(0x302c32, 0.4),
    );
    pedestal.position.y = 0.15;
    table.add(pedestal);
    const wood = new THREE.Mesh(
      new THREE.CylinderGeometry(3.65, 3.59, 0.24, 96),
      material(0x76554b, 0.35),
    );
    wood.scale.z = 1;
    wood.position.y = 1.17;
    wood.castShadow = true;
    table.add(wood);
    const padding = new THREE.Mesh(
      new THREE.TorusGeometry(3.4, 0.16, 16, 96),
      material(0x38434c, 0.42),
    );
    padding.rotation.x = -Math.PI / 2;
    padding.scale.y = 1;
    padding.position.y = 1.3;
    table.add(padding);
    const feltTex = texture('felt', (ctx, c) => {
      ctx.fillStyle = '#245a50';
      ctx.fillRect(0, 0, c.width, c.height);
      let seed = 712;
      for (let i = 0; i < 22000; i++) {
        seed = (seed * 16807) % 2147483647;
        const x = seed % 512;
        seed = (seed * 16807) % 2147483647;
        const y = seed % 768;
        ctx.fillStyle = i % 2 ? '#ffffff07' : '#00000008';
        ctx.fillRect(x, y, 1, 2);
      }
    });
    const feltMaterial = material(0xffffff, 0.95);
    feltMaterial.map = feltTex;
    const felt = new THREE.Mesh(new THREE.CylinderGeometry(3.26, 3.26, 0.055, 96), feltMaterial);
    felt.position.y = 1.31;
    felt.scale.z = 1;
    felt.receiveShadow = true;
    table.add(felt);
    const trim = new THREE.Mesh(
      new THREE.TorusGeometry(3.57, 0.026, 8, 96),
      material(0xd9b880, 0.28),
    );
    trim.rotation.x = -Math.PI / 2;
    trim.position.y = 1.32;
    trim.scale.y = 1;
    table.add(trim);
    const logoTex = texture('emblem', (ctx, c) => {
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.textAlign = 'center';
      ctx.fillStyle = '#d7cca477';
      ctx.font = '600 46px sans-serif';
      ctx.fillText('GUANDAN', 256, 360);
      ctx.font = '23px sans-serif';
      ctx.fillText('AI  •  CLUB', 256, 410);
    });
    const logo = new THREE.Mesh(
      new THREE.PlaneGeometry(1.4, 1.5),
      new THREE.MeshBasicMaterial({ map: logoTex, transparent: true, depthWrite: false }),
    );
    logo.rotation.x = -Math.PI / 2;
    logo.position.set(0, 1.35, -0.4);
    table.add(logo);
    // Cardinal seat orientations: near player faces away from us; side players face inward.
    const positions: [[number, number, number], number][] = [
      [[0, 0, 3.6], Math.PI],
      [[-3.6, 0, 0], Math.PI / 2],
      [[0, 0, -3.6], 0],
      [[3.6, 0, 0], -Math.PI / 2],
    ];
    for (let i = 0; i < 4; i++) {
      const [position, yaw] = positions[i],
        root = new THREE.Group();
      root.position.set(...position);
      root.rotation.y = yaw;
      scene.add(root);
      const contactMap = texture('seat-contact', (ctx, c) => {
        const gradient = ctx.createRadialGradient(256, 384, 15, 256, 384, 250);
        gradient.addColorStop(0, '#00000080');
        gradient.addColorStop(1, '#00000000');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, c.width, c.height);
      });
      const contact = new THREE.Mesh(
        new THREE.PlaneGeometry(2.4, 2.1),
        new THREE.MeshBasicMaterial({ map: contactMap, transparent: true, depthWrite: false }),
      );
      contact.rotation.x = -Math.PI / 2;
      contact.position.set(position[0], -0.345, position[2]);
      scene.add(contact);
      const chair = new THREE.Group();
      root.add(chair);
      chair.scale.x = 0.88;
      box(chair, 0x343c4c, [1.5, 0.2, 1.25], [0, 0.72, -0.12]);
      const back = box(chair, 0x414859, [1.48, 1.16, 0.18], [0, 1.3, -0.86]);
      back.rotation.x = -0.09;
      for (const side of [-1, 1]) {
        box(chair, 0x8b7260, [0.1, 1.14, 0.12], [side * 0.66, 0.15, -0.4]);
        box(chair, 0x8b7260, [0.1, 1.14, 0.12], [side * 0.66, 0.15, 0.4]);
        box(chair, 0x353d4c, [0.15, 0.15, 0.95], [side * 0.75, 1.23, -0.08]);
      }
      const body = new THREE.Group();
      body.position.y = 0.95;
      root.add(body);
      sphere(body, palette[i], [0.57, 0.61, 0.46], [0, 0.49, 0]);
      sphere(body, 0xffeed8, [0.4, 0.46, 0.21], [0, 0.49, 0.34]);
      const hips = new THREE.Group();
      hips.position.y = 0.95;
      root.add(hips);
      for (const side of [-1, 1]) {
        sphere(hips, palette[i], [0.28, 0.29, 0.39], [side * 0.38, 0.1, 0.39]);
        sphere(hips, palette[i], [0.22, 0.52, 0.22], [side * 0.38, -0.5, 0.46]);
        sphere(hips, palette[i], [0.24, 0.15, 0.29], [side * 0.39, -1.16, 0.59]);
      }
      const head = new THREE.Group();
      head.position.set(0, 1.46, 0);
      head.scale.setScalar(0.82);
      body.add(head);
      sphere(head, palette[i], [0.77, 0.64, 0.61], [0, 0, 0]);
      sphere(head, 0xffeed8, [0.4, 0.24, 0.18], [0, -0.25, 0.49]);
      const eyes: THREE.Mesh[] = [],
        eyeGlints: THREE.Mesh[] = [];
      for (const side of [-1, 1]) {
        const ear = new THREE.Group();
        ear.position.set(side * 0.47, i === 1 ? 0.69 : 0.52, -0.015);
        ear.rotation.z = side * -0.22;
        head.add(ear);
        sphere(
          ear,
          palette[i],
          i === 1 ? [0.18, 0.57, 0.18] : i === 2 ? [0.25, 0.23, 0.23] : [0.22, 0.33, 0.2],
          [0, 0, 0],
        );
        sphere(
          ear,
          i === 2 ? 0x668577 : 0xf5c5c4,
          i === 1 ? [0.1, 0.4, 0.085] : [0.12, 0.17, 0.09],
          [0, 0.02, 0.15],
        );
        eyes.push(sphere(head, 0x243039, [0.075, 0.11, 0.055], [side * 0.25, 0.04, 0.568]));
        const eyeMaterial = eyes.at(-1)!.material as THREE.MeshPhysicalMaterial;
        eyeMaterial.roughness = 0.18;
        eyeMaterial.clearcoat = 0.8;
        eyeMaterial.bumpScale = 0;
        eyeGlints.push(
          sphere(head, 0xffffff, [0.018, 0.022, 0.009], [side * 0.25 - 0.018, 0.067, 0.617]),
        );
        sphere(head, 0xe593a4, [0.095, 0.04, 0.012], [side * 0.41, -0.13, 0.503]);
      }
      sphere(head, 0x704956, [0.056, 0.037, 0.033], [0, -0.25, 0.668]);
      const mouth = new THREE.Mesh(
        new THREE.TorusGeometry(0.07, 0.012, 8, 20, Math.PI),
        material(0x704956),
      );
      mouth.rotation.z = Math.PI;
      mouth.position.set(0, -0.32, 0.652);
      head.add(mouth);
      const antennaHeight = i === 1 ? 0.98 : 0.86;
      const antenna = new THREE.Mesh(
        new THREE.CylinderGeometry(0.025, 0.03, antennaHeight - 0.64, 12),
        material(0xb99b65, 0.35),
      );
      antenna.position.set(0, (antennaHeight + 0.64) / 2, 0);
      head.add(antenna);
      sphere(head, 0xe9c67f, [0.07, 0.07, 0.07], [0, antennaHeight, 0]);
      const left = new THREE.Group(),
        right = new THREE.Group();
      left.position.set(-0.47, 0.59, 0.5);
      right.position.set(0.47, 0.59, 0.5);
      body.add(left, right);
      for (const [arm, side] of [
        [left, -1],
        [right, 1],
      ] as [THREE.Group, number][]) {
        sphere(arm, palette[i], [0.16, 0.15, 0.34], [side * 0.07, -0.06, 0.26]);
        sphere(arm, palette[i], [0.16, 0.16, 0.18], [side * 0.02, -0.04, 0.49]);
      }
      const fan = new THREE.Group();
      fan.position.set(0, 1.66, 1.04);
      root.add(fan);
      actors.push({
        root,
        body,
        head,
        left,
        right,
        fan,
        eyes,
        eyeGlints,
        headVelocity: 0,
        bodyVelocity: 0,
      });
      const cup = new THREE.Mesh(
        new THREE.CylinderGeometry(0.12, 0.1, 0.24, 24),
        material(palette[i], 0.25),
      );
      cup.position.copy(root.localToWorld(new THREE.Vector3(1.05, 1.48, 1.34)));
      cup.castShadow = true;
      scene.add(cup);
    }
    scene.add(temporary);
    scene.add(camera);
    scene.add(firstPerson);
    firstPerson.add(heldCards);

    // Visible forearms and palms belong to the viewer, below the eye line.
    for (const side of [-1, 1]) {
      const forearm = sphere(
        firstPerson,
        palette[props.viewpointSeat],
        [0.14, 0.12, 0.37],
        [side * 0.66, 1.46, 0.63],
      );
      forearm.rotation.y = side * -0.16;
      forearm.userData = { ourHand: true, side, gripOffset: 0.11 };
      const palm = sphere(
        firstPerson,
        palette[props.viewpointSeat],
        [0.13, 0.11, 0.1],
        [side * 0.55, 1.49, 1.02],
      );
      palm.userData = { ourHand: true, side, gripOffset: 0 };
      const thumb = sphere(
        firstPerson,
        palette[props.viewpointSeat],
        [0.055, 0.095, 0.055],
        [side * 0.47, 1.57, 0.93],
      );
      thumb.rotation.z = side * -0.45;
      thumb.userData = { ourHand: true, side, gripOffset: -0.08 };
    }
    const handLight = new THREE.PointLight(0xffeed8, 0.6, 3);
    handLight.position.set(-0.4, 0.3, -0.6);
    camera.add(handLight);
    updateHeldCards();
    updateFans();
    const resize = () => {
      const { width, height } = host.value!.getBoundingClientRect();
      renderer!.setSize(width, height);
      camera.aspect = width / height;
      const narrow = camera.aspect < 1.15;
      // Equal-radius camera poses keep the same table proportions at all four seats.
      // Set poses in world space: localToWorld can use stale matrices after a seat change.
      const yaw = [0, -Math.PI / 2, Math.PI, Math.PI / 2][props.viewpointSeat];
      const overview = props.cameraMode === 'third';
      const distance = 3.55;
      camera.position.set(Math.sin(yaw) * distance, 2.56, Math.cos(yaw) * distance);
      camera.up.set(0, 1, 0);
      camera.lookAt(0, 1.12, 0);
      // Keep a useful horizontal field of view in portrait, rather than cropping
      // the desktop projection to a narrow strip through the table and our hands.
      camera.fov = narrow
        ? THREE.MathUtils.radToDeg(
            2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(50)) / camera.aspect),
          )
        : 75;
      camera.zoom = 1;
      if (overview) {
        camera.position.set(0, narrow ? 8.2 : 7.6, narrow ? 7.2 : 9.4);
        camera.lookAt(0, 1.1, 0);
        camera.fov = narrow
          ? THREE.MathUtils.radToDeg(
              2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(24)) / camera.aspect),
            )
          : height < 360
            ? 36
            : 44;
      }
      firstPerson.visible = !overview;
      firstPerson.position.copy(actors[props.viewpointSeat].root.position);
      // Bring the grip slightly closer on portrait screens so the rank corners
      // remain legible after widening the view to include the other players.
      if (narrow)
        firstPerson.position.add(
          new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw)).multiplyScalar(0.16),
        );
      firstPerson.rotation.y = actors[props.viewpointSeat].root.rotation.y;
      tablePlays.forEach((pile) => {
        pile.userData.yaw = Math.PI + yaw;
        pile.rotation.y = pile.userData.yaw;
      });
      actors.forEach((actor, i) => {
        actor.root.visible = overview || i !== props.viewpointSeat;
      });
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld();
      scene.updateMatrixWorld(true);
      const bounds = host.value!.getBoundingClientRect();
      const parent = host.value!.parentElement!.getBoundingClientRect();
      emit(
        'anchors',
        actors.map(({ root }) => {
          const point = root.localToWorld(new THREE.Vector3(0, 1.59, 0)).project(camera);
          return {
            x: bounds.left - parent.left + ((point.x + 1) * width) / 2,
            y: bounds.top - parent.top + ((1 - point.y) * height) / 2,
          };
        }),
      );
    };
    watch(() => [props.viewpointSeat, props.cameraMode], resize);
    observer = new ResizeObserver(resize);
    observer.observe(host.value!);
    resize();
    const clock = new THREE.Clock();
    let attentionSeat = props.thinking ?? props.turn,
      attentionTime = -10;
    const animate = () => {
      frame = requestAnimationFrame(animate);
      const dt = Math.min(0.05, clock.getDelta()),
        t = clock.elapsedTime;
      updateFans();
      updateHeldCards();
      const activeSeat = props.thinking ?? props.turn;
      if (activeSeat !== attentionSeat) {
        attentionSeat = activeSeat;
        attentionTime = t;
      }
      if (previousRound !== props.round || previousGame !== props.gameId) {
        previousGame = props.gameId;
        previousRound = props.round;
        previousSeq = props.entry?.seq ?? -1;
        actionSeat = -1;
        restoreTable(t);
      } else if ((props.entry?.seq ?? -1) < previousSeq) {
        previousSeq = props.entry?.seq ?? -1;
        restoreTable(t);
      } else if (props.entry && props.entry.seq !== previousSeq) {
        const updates = props.history.filter(
          (e) => e.move && e.after?.round === props.round && e.seq > previousSeq,
        );
        previousSeq = props.entry.seq;
        actionSeat = props.entry.seat;
        actionTime = t;
        for (const entry of updates) playCards(entry, t, entry.seq !== previousSeq);
      }
      actors.forEach((a, i) => {
        const thinking = props.thinking === i,
          elapsed = t - actionTime,
          acting = actionSeat === i && elapsed < 1.35,
          reach =
            acting && props.entry?.move?.kind !== 'pass'
              ? Math.sin(Math.min(1, elapsed / 1.15) * Math.PI)
              : 0;
        a.body.rotation.x = 0.02 + Math.sin(t * 1.55 + i) * 0.008 + reach * 0.045;
        // Attention follows public game events. There is no periodic gaze scheduler.
        const responding = t - attentionTime > 0.1 + i * 0.055;
        const watchingSeat = responding ? activeSeat : actionSeat >= 0 ? actionSeat : activeSeat;
        let target = new THREE.Vector3(0, 1.4, 0);
        const landing =
          played && elapsed >= 0 && elapsed < 1.1 && props.entry?.move?.kind !== 'pass';
        if (landing) target.copy(played!.position);
        else if (i === activeSeat && !props.finished.includes(i)) {
          target.copy(a.root.localToWorld(a.fan.position.clone()));
          // Pressure from an opponent's bomb draws attention back to the table.
          if (props.last && ['bomb', 'flush', 'kings'].includes(props.last.kind))
            target.set(0, 1.4, 0);
        } else if (actors[watchingSeat] && i !== watchingSeat) {
          target.copy(actors[watchingSeat].root.position).add(new THREE.Vector3(0, 2.44, 0));
        }
        const origin = a.root.position.clone().add(new THREE.Vector3(0, 2.44, 0));
        const delta = target.sub(origin);
        const relative = Math.atan2(delta.x, delta.z) - a.root.rotation.y;
        let gaze = Math.atan2(Math.sin(relative), Math.cos(relative));
        const ownHighlight =
          i === 0 &&
          actionSeat === 0 &&
          elapsed > 0.9 &&
          elapsed < 3.6 &&
          (props.finished.includes(0) ||
            ['bomb', 'flush', 'kings'].includes(props.entry?.move?.kind ?? ''));
        // A brief audience acknowledgement is tied to finishing or a strong play.
        if (ownHighlight) gaze = 2.65 * Math.sin(((elapsed - 0.9) / 2.7) * Math.PI);
        const bodyTarget = ownHighlight
          ? gaze * 0.19
          : THREE.MathUtils.clamp(gaze * 0.18, -0.2, 0.2);
        const headTarget = ownHighlight
          ? gaze - bodyTarget
          : THREE.MathUtils.clamp(gaze - bodyTarget, -1.12, 1.12);
        a.headVelocity += (38 * (headTarget - a.head.rotation.y) - 12 * a.headVelocity) * dt;
        a.head.rotation.y += a.headVelocity * dt;
        a.bodyVelocity += (14 * (bodyTarget - a.body.rotation.y) - 7.5 * a.bodyVelocity) * dt;
        a.body.rotation.y += a.bodyVelocity * dt;
        const eyeGaze = THREE.MathUtils.clamp(
          gaze - a.head.rotation.y - a.body.rotation.y,
          -0.35,
          0.35,
        );
        const pitch = ownHighlight
          ? -0.05
          : THREE.MathUtils.clamp(Math.atan2(-delta.y, Math.hypot(delta.x, delta.z)), -0.12, 0.38);
        a.head.rotation.x = THREE.MathUtils.lerp(a.head.rotation.x, pitch, 1 - Math.exp(-dt * 4));
        a.head.rotation.z = THREE.MathUtils.lerp(
          a.head.rotation.z,
          thinking ? eyeGaze * 0.08 : 0,
          1 - Math.exp(-dt * 3),
        );
        a.eyes.forEach((eye, j) => {
          eye.position.x = (j === 0 ? -0.25 : 0.25) + eyeGaze * 0.035;
          a.eyeGlints[j].position.x = eye.position.x - 0.018;
        });
        const pressure = thinking && props.last && props.lastSeat % 2 !== i % 2;
        const ponder = pressure ? Math.min(1, (t - attentionTime) / 1.6) * 0.5 : 0;
        a.left.rotation.x = THREE.MathUtils.lerp(
          a.left.rotation.x,
          -0.02 - ponder * 0.1,
          1 - Math.exp(-dt * 3),
        );
        a.left.rotation.z = ponder * 0.18;
        a.left.position.y = 0.59 + ponder * 0.02;
        a.right.rotation.x = -reach * 0.25;
        a.right.position.z = 0.5 + reach * 0.24;
        a.fan.rotation.z = thinking ? Math.sin(t * 1.8) * 0.025 : 0;
        a.fan.position.y = 1.66;
        a.fan.visible = props.counts[i] > 0 && !(props.cameraMode === 'third' && i === 0);
        const blink = (t + i * 0.63) % 4.7 < 0.13;
        a.eyes.forEach((e) => (e.scale.y = blink ? 0.02 : 0.11));
        a.eyeGlints.forEach((e) => {
          e.visible = !blink;
        });
        if (props.finished.includes(i) && actionSeat === i && elapsed < 3.5) {
          a.right.rotation.z = -0.35 - Math.sin(t * 3) * 0.14;
        } else a.right.rotation.z = -reach * 0.22;
      });
      for (const pile of tablePlays) {
        const p = Math.min(1, Math.max(0, (t - pile.userData.start - 0.16) / 0.75)),
          ease = 1 - Math.pow(1 - p, 3);
        pile.position.lerpVectors(pile.userData.from, pile.userData.target, ease);
        pile.position.y += Math.sin(p * Math.PI) * pile.userData.lift;
        pile.rotation.y = pile.userData.yaw + (1 - ease) * 0.25;
      }
      renderer!.render(scene, camera);
    };
    animate();
  } catch (error) {
    console.error('[ArenaScene] 3D table initialization failed', error);
    fallbackMessage.value = renderer
      ? '3D 牌桌加载失败，请刷新重试。手牌与对局动态仍可查看。'
      : '浏览器暂时无法创建 3D 画面。请关闭多余牌桌标签页后刷新；手牌与对局动态仍可查看。';
    cancelAnimationFrame(frame);
    observer?.disconnect();
    renderer?.dispose();
    renderer?.forceContextLoss();
    renderer?.domElement.remove();
    renderer = undefined;
    fallback.value = true;
  }
});
onBeforeUnmount(() => {
  cancelAnimationFrame(frame);
  observer?.disconnect();
  scene?.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.geometry.dispose();
      (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
    }
  });
  textures.forEach((t) => t.dispose());
  resources.forEach((m) => m.dispose());
  environment?.dispose();
  renderer?.dispose();
  // dispose() releases Three.js resources but does not release the browser's
  // context slot. Explicitly release it when navigating or replacing via HMR.
  renderer?.forceContextLoss();
  renderer?.domElement.remove();
});
</script>
<template>
  <div ref="host" class="immersive-scene">
    <div v-if="fallback" class="scene-fallback">
      {{ fallbackMessage }}
    </div>
  </div>
</template>
