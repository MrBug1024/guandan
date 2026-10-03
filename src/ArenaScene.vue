<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from 'vue';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { rankName, type Card, type Entry, type Move } from '../shared/types';
import type { ArenaMood } from './arena-events';
import type { PlayerAnchor } from './arena-projection';
import { createRobotBuilder, ROBOT_FACE, type RobotRig } from './arena-robot';
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
  moods: (ArenaMood | undefined)[];
  reducedMotion: boolean;
  settlement: boolean;
  winnerTeam: number | null;
}>();
const emit = defineEmits<{
  anchors: [positions: PlayerAnchor[]];
  tableAnchor: [position: { x: number; y: number }];
}>();
const host = ref<HTMLDivElement>(),
  fallback = ref(false),
  fallbackMessage = ref('');
let renderer: THREE.WebGLRenderer | undefined,
  scene: THREE.Scene,
  frame = 0,
  observer: ResizeObserver;
interface Actor extends RobotRig {
  root: THREE.Group;
  fan: THREE.Group;
  emotionWeight: number;
  chair: THREE.Group;
  seatHalo: THREE.Mesh;
  headVelocity: number;
  bodyVelocity: number;
  nextBlink: number;
  blinkStart: number;
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
    roughness: 0.52,
    metalness: 0,
    clearcoat: 0.18,
    clearcoatRoughness: 0.5,
    sheen: 0.36,
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
  surface.bumpMap.colorSpace = THREE.NoColorSpace;
  surface.bumpScale = 0.0025;
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
    scene.environmentIntensity = 0.26;
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
    const rim = new THREE.DirectionalLight(0xb9d7ef, 0.65);
    rim.position.set(0, 5, -7);
    scene.add(rim);
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
    const tableAccessories: THREE.Mesh[] = [];
    const buildRobot = createRobotBuilder(characterMaterial(palette[0]).bumpMap!);
    for (let i = 0; i < 4; i++) {
      const [position, yaw] = positions[i],
        root = new THREE.Group();
      root.position.set(...position);
      root.rotation.y = yaw;
      scene.add(root);
      const seatHalo = new THREE.Mesh(
        new THREE.RingGeometry(0.98, 1.05, 64),
        new THREE.MeshBasicMaterial({
          color: palette[i],
          transparent: true,
          opacity: 0.5,
          depthWrite: false,
        }),
      );
      seatHalo.rotation.x = -Math.PI / 2;
      seatHalo.position.set(0, -0.325, -0.08);
      seatHalo.visible = false;
      root.add(seatHalo);
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
      const rig = buildRobot(root, i, palette[i]);
      const fan = new THREE.Group();
      fan.position.set(0, 1.66, 1.04);
      root.add(fan);
      actors.push({
        ...rig,
        root,
        fan,
        emotionWeight: 0,
        chair,
        seatHalo,
        headVelocity: 0,
        bodyVelocity: 0,
        nextBlink: 1.8 + i * 0.73,
        blinkStart: -1,
      });
      const cup = new THREE.Mesh(
        new THREE.CylinderGeometry(0.12, 0.1, 0.24, 24),
        material(palette[i], 0.25),
      );
      cup.position.copy(root.localToWorld(new THREE.Vector3(1.05, 1.48, 1.34)));
      cup.castShadow = true;
      scene.add(cup);
      tableAccessories.push(cup);
    }
    scene.add(temporary);
    const victoryStage = new THREE.Group();
    const podium = new THREE.Mesh(
      new THREE.CylinderGeometry(4.6, 4.8, 0.2, 80),
      material(0x172a35, 0.4),
    );
    podium.position.y = -0.28;
    podium.receiveShadow = true;
    victoryStage.add(podium);
    const stageTrim = new THREE.Mesh(
      new THREE.TorusGeometry(4.6, 0.024, 8, 80),
      new THREE.MeshBasicMaterial({ color: 0xeacb86 }),
    );
    stageTrim.rotation.x = -Math.PI / 2;
    stageTrim.position.y = -0.17;
    victoryStage.add(stageTrim);
    for (const x of [-2.8, 2.8]) {
      const light = new THREE.SpotLight(0xffdca0, 26, 18, 0.38, 0.75);
      light.position.set(x, 7, 2);
      light.target.position.set(x * 0.4, 0, 0);
      victoryStage.add(light, light.target);
    }
    victoryStage.visible = false;
    scene.add(victoryStage);
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
      // Preserve the side characters on tall desktop windows as well as phones.
      const horizontalHalf = THREE.MathUtils.lerp(
        50,
        57,
        THREE.MathUtils.clamp((camera.aspect - 0.8) / 0.4, 0, 1),
      );
      camera.fov = Math.max(
        75,
        THREE.MathUtils.radToDeg(
          2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(horizontalHalf)) / camera.aspect),
        ),
      );
      camera.zoom = 1;
      if (overview) {
        camera.position.set(0, narrow ? 8.2 : 7.6, narrow ? 7.2 : 9.4);
        camera.lookAt(0, 1.1, 0);
        camera.fov = narrow
          ? THREE.MathUtils.radToDeg(
              2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(26)) / camera.aspect),
            )
          : height < 360
            ? 36
            : 44;
      }
      if (props.settlement) {
        camera.position.set(0, 4.6, 11.5);
        camera.lookAt(0, narrow ? 0.45 : 0.7, 0);
        camera.fov = narrow
          ? THREE.MathUtils.radToDeg(
              2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(24)) / camera.aspect),
            )
          : 42;
      }
      firstPerson.visible = !overview;
      firstPerson.position.set(...positions[props.viewpointSeat][0]);
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
      updateAnchors();
    };
    const projectedPoint = new THREE.Vector3();
    const updateAnchors = () => {
      const bounds = host.value!.getBoundingClientRect();
      const parent = host.value!.parentElement!.getBoundingClientRect();
      projectedPoint.set(0, 1.7, -0.35).project(camera);
      emit('tableAnchor', {
        x: bounds.left - parent.left + ((projectedPoint.x + 1) * bounds.width) / 2,
        y: bounds.top - parent.top + ((1 - projectedPoint.y) * bounds.height) / 2,
      });
      emit(
        'anchors',
        actors.map(({ root, body, hips }) => {
          const point = root.localToWorld(new THREE.Vector3(0, 1.59, 0)).project(camera);
          const character = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
          for (const group of [body, hips])
            group.traverseVisible((mesh) => {
              if (!(mesh instanceof THREE.Mesh)) return;
              if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
              const box = mesh.geometry.boundingBox!;
              for (let corner = 0; corner < 8; corner++) {
                projectedPoint
                  .set(
                    corner & 1 ? box.max.x : box.min.x,
                    corner & 2 ? box.max.y : box.min.y,
                    corner & 4 ? box.max.z : box.min.z,
                  )
                  .applyMatrix4(mesh.matrixWorld)
                  .project(camera);
                const x = bounds.left - parent.left + ((projectedPoint.x + 1) * bounds.width) / 2;
                const y = bounds.top - parent.top + ((1 - projectedPoint.y) * bounds.height) / 2;
                character.left = Math.min(character.left, x);
                character.right = Math.max(character.right, x);
                character.top = Math.min(character.top, y);
                character.bottom = Math.max(character.bottom, y);
              }
            });
          return {
            x: bounds.left - parent.left + ((point.x + 1) * bounds.width) / 2,
            y: bounds.top - parent.top + ((1 - point.y) * bounds.height) / 2,
            bounds: character,
          };
        }),
      );
    };
    watch(() => [props.viewpointSeat, props.cameraMode, props.settlement], resize);
    observer = new ResizeObserver(resize);
    observer.observe(host.value!);
    resize();
    const clock = new THREE.Clock();
    let attentionSeat = props.thinking ?? props.turn,
      attentionTime = -10,
      anchorTime = -1;
    const animate = () => {
      frame = requestAnimationFrame(animate);
      const dt = Math.min(0.05, clock.getDelta()),
        t = clock.elapsedTime;
      updateFans();
      updateHeldCards();
      table.visible = !props.settlement;
      temporary.visible = !props.settlement;
      victoryStage.visible = props.settlement;
      tableAccessories.forEach((accessory) => {
        accessory.visible = !props.settlement;
      });
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
        const narrow = camera.aspect < 1.15;
        const winning = i % 2 === props.winnerTeam;
        const partnerIndex = Math.floor(i / 2);
        const stageX = winning
          ? partnerIndex === 0
            ? -1.15
            : 1.15
          : partnerIndex === 0
            ? -3.15
            : 3.15;
        const stageZ = winning ? 0.8 : -0.65;
        const targetPosition = props.settlement
          ? new THREE.Vector3(
              narrow ? (partnerIndex === 0 ? -1 : 1) * (winning ? 1.05 : 2.7) : stageX,
              winning ? 0.18 : 0.25,
              narrow ? (winning ? 1.25 : -1) : stageZ,
            )
          : new THREE.Vector3(...positions[i][0]);
        a.root.position.lerp(targetPosition, props.reducedMotion ? 1 : 1 - Math.exp(-dt * 5));
        a.chair.visible = !props.settlement;
        a.seatHalo.visible = !props.settlement && activeSeat === i && !props.finished.includes(i);
        (a.seatHalo.material as THREE.MeshBasicMaterial).opacity = props.reducedMotion
          ? 0.55
          : 0.5 + Math.sin(t * 2) * 0.12;
        a.root.visible =
          props.settlement || props.cameraMode === 'third' || i !== props.viewpointSeat;
        const mood = props.moods[i];
        const motion = props.reducedMotion ? 0 : 1;
        const mt = props.reducedMotion ? 0 : t;
        a.emotionWeight = THREE.MathUtils.damp(a.emotionWeight, mood ? 1 : 0, 5, dt);
        const emotion = a.emotionWeight;
        const thinking = props.thinking === i,
          elapsed = t - actionTime,
          acting = actionSeat === i && elapsed < 1.35,
          reach =
            motion && acting && props.entry?.move?.kind !== 'pass'
              ? Math.sin(Math.min(1, elapsed / 1.15) * Math.PI)
              : 0;
        a.body.rotation.x = 0.02 + Math.sin(mt * 1.55 + i) * 0.008 * motion + reach * 0.045;
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
          !props.reducedMotion &&
          i === 0 &&
          actionSeat === 0 &&
          elapsed > 0.9 &&
          elapsed < 3.6 &&
          (props.finished.includes(0) ||
            ['bomb', 'flush', 'kings'].includes(props.entry?.move?.kind ?? ''));
        // A brief audience acknowledgement is tied to finishing or a strong play.
        if (ownHighlight) gaze = 2.65 * Math.sin(((elapsed - 0.9) / 2.7) * Math.PI);
        let bodyTarget = ownHighlight ? gaze * 0.19 : THREE.MathUtils.clamp(gaze * 0.18, -0.2, 0.2);
        let headTarget = ownHighlight
          ? gaze - bodyTarget
          : THREE.MathUtils.clamp(gaze - bodyTarget, -1.12, 1.12);
        if (mood === 'celebrate' || mood === 'sad' || mood === 'proud') {
          // Turn the whole character toward the audience; the chair stays put.
          const audience = camera.position.clone().sub(a.root.position);
          const angle = Math.atan2(audience.x, audience.z) - a.root.rotation.y;
          const facing = Math.atan2(Math.sin(angle), Math.cos(angle));
          bodyTarget = THREE.MathUtils.lerp(bodyTarget, facing * 0.72, emotion);
          headTarget = THREE.MathUtils.lerp(headTarget, facing * 0.28, emotion);
        }
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
          eye.position.x = (j === 0 ? -ROBOT_FACE.eyeX : ROBOT_FACE.eyeX) + eyeGaze * 0.026;
          a.eyeGlints[j].position.x = eye.position.x;
          a.eyeSmiles[j].position.x = eye.position.x;
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
        a.fan.rotation.z = thinking ? Math.sin(mt * 1.8) * 0.025 * motion : 0;
        a.fan.position.y = 1.66;
        a.fan.visible = props.counts[i] > 0 && !(props.cameraMode === 'third' && i === 0);
        if (motion && t >= a.nextBlink) {
          a.blinkStart = t;
          a.nextBlink = t + 4.1 + Math.sin(t * 0.83 + i) * 1.15 + i * 0.13;
        }
        const blinkPhase = (t - a.blinkStart) / 0.22;
        const blink =
          motion && blinkPhase >= 0 && blinkPhase <= 1
            ? Math.pow(Math.sin(blinkPhase * Math.PI), 0.7)
            : 0;
        a.eyes.forEach((eye) =>
          eye.scale.set(
            ROBOT_FACE.eyeWidth,
            ROBOT_FACE.eyeHeight * (1 - blink * 0.94),
            ROBOT_FACE.eyeDepth,
          ),
        );
        if (props.finished.includes(i) && actionSeat === i && elapsed < 3.5) {
          a.right.rotation.z = -0.35 - Math.sin(mt * 3) * 0.14 * motion;
        } else a.right.rotation.z = -reach * 0.22;
        // Poses are blended over the normal table animation and use reusable meshes.
        const breath = Math.sin(mt * 1.65 + i * 0.8) * motion;
        a.body.scale.set(1 + breath * 0.004, 1 + breath * 0.006, 1 + breath * 0.003);
        let bodyY = 0.95 + breath * 0.006,
          roll = 0,
          lean = a.body.rotation.x;
        let leftX = a.left.rotation.x,
          rightX = a.right.rotation.x;
        let leftZ = a.left.rotation.z,
          rightZ = a.right.rotation.z;
        let headPitch = a.head.rotation.x;
        a.mouth.rotation.z = Math.PI;
        a.mouth.scale.set(1, 1, 1);
        a.tears.forEach((tear) => {
          tear.visible = mood === 'sad';
        });
        if (mood === 'celebrate') {
          const beat = mt * 7 + i * 0.7;
          bodyY += (0.08 + Math.abs(Math.sin(beat)) * 0.22 * motion) * emotion;
          roll = Math.sin(beat * 0.55) * 0.13 * motion;
          leftX = -1.65 + Math.sin(beat) * 0.3 * motion;
          rightX = -1.65 - Math.sin(beat) * 0.3 * motion;
          leftZ = -0.55;
          rightZ = 0.55;
          headPitch = -0.12;
          a.mouth.scale.set(1.45, 1.2, 1);
          a.fan.visible = false;
        } else if (mood === 'clap') {
          const clap = (0.5 + Math.sin(mt * 11) * 0.5 * motion) * 0.6;
          leftX = rightX = -0.65;
          leftZ = -0.6 - clap;
          rightZ = 0.6 + clap;
          headPitch = -0.1;
        } else if (mood === 'shocked') {
          lean = -0.18;
          bodyY += 0.035;
          leftX = rightX = -1.15;
          leftZ = -0.25;
          rightZ = 0.25;
          headPitch = -0.18;
          a.eyes.forEach((eye) => {
            eye.scale.set(0.125, 0.18, ROBOT_FACE.eyeDepth);
          });
          a.mouth.rotation.z = 0;
          a.mouth.scale.set(0.85, 1.8, 1);
        } else if (mood === 'sad') {
          bodyY -= 0.07;
          lean = 0.14;
          headPitch = 0.3;
          roll = Math.sin(mt * 5 + i) * 0.025 * motion;
          leftX = rightX = -1.1;
          leftZ = -0.55;
          rightZ = 0.55;
          a.mouth.rotation.z = 0;
          a.eyes.forEach((eye) => {
            eye.scale.y = 0.075;
          });
          a.tears.forEach((tear, index) => {
            const fall = props.reducedMotion ? 0.25 : (t * 1.5 + index * 0.45) % 1;
            tear.position.y = -0.08 - fall * 0.32;
            tear.scale.y = 0.05 + Math.sin(fall * Math.PI) * 0.04;
          });
          a.fan.rotation.z = -0.08;
        } else if (mood === 'bow') {
          lean = 0.22 + Math.sin(mt * 2.5) * 0.06 * motion;
          headPitch = 0.3;
          rightX = -0.45;
        } else if (mood === 'proud') {
          headPitch = -0.17;
          rightX = -1.4;
          rightZ = 0.2;
          roll = Math.sin(mt * 3) * 0.035 * motion;
        } else if (mood === 'worried') {
          headPitch = 0.2;
          leftX = -0.85;
          leftZ = -0.2;
          a.mouth.rotation.z = 0;
        }
        const blend = 1 - Math.exp(-dt * 8);
        a.body.position.y = THREE.MathUtils.lerp(a.body.position.y, bodyY, blend);
        a.body.rotation.z = THREE.MathUtils.lerp(a.body.rotation.z, roll * emotion, blend);
        a.body.rotation.x = THREE.MathUtils.lerp(a.body.rotation.x, lean, emotion);
        a.hips.position.y = a.body.position.y;
        a.hips.rotation.y = a.body.rotation.y * emotion;
        a.hips.rotation.z = a.body.rotation.z;
        a.head.rotation.x = THREE.MathUtils.lerp(a.head.rotation.x, headPitch, emotion);
        a.left.rotation.x = THREE.MathUtils.lerp(a.left.rotation.x, leftX, emotion);
        a.right.rotation.x = THREE.MathUtils.lerp(a.right.rotation.x, rightX, emotion);
        a.left.rotation.z = THREE.MathUtils.lerp(a.left.rotation.z, leftZ, emotion);
        a.right.rotation.z = THREE.MathUtils.lerp(a.right.rotation.z, rightZ, emotion);
        const smiling = mood === 'celebrate' || mood === 'clap';
        a.eyes.forEach((eye, j) => {
          eye.visible = !smiling;
          a.eyeSmiles[j].visible = smiling;
          a.eyeGlints[j].visible = !smiling && eye.scale.y > ROBOT_FACE.eyeHeight * 0.55;
          a.eyeGlints[j].scale.y = eye.scale.y / ROBOT_FACE.eyeHeight;
          const side = j === 0 ? -1 : 1;
          a.brows[j].rotation.z = THREE.MathUtils.damp(
            a.brows[j].rotation.z,
            mood === 'sad' || mood === 'worried' ? side * -0.28 : 0,
            6,
            dt,
          );
          a.brows[j].position.y = THREE.MathUtils.damp(
            a.brows[j].position.y,
            mood === 'shocked' ? 0.285 : 0.24,
            6,
            dt,
          );
        });
        a.mouth.visible = mood !== 'shocked';
        a.surprisedMouth.visible = mood === 'shocked';
        a.ears.forEach((ear, j) => {
          const side = j === 0 ? -1 : 1;
          const target =
            motion *
            (THREE.MathUtils.clamp(-a.headVelocity * 0.025, -0.12, 0.12) +
              Math.sin(mt * 1.8 + i + j * 0.8) * 0.015 +
              roll * (i === 1 ? 1.2 : 0.45));
          let offset = (ear.userData.offset as number) || 0;
          let velocity = (ear.userData.velocity as number) || 0;
          velocity += (40 * (target - offset) - 7 * velocity) * dt;
          offset += velocity * dt;
          ear.userData.offset = props.reducedMotion ? 0 : offset;
          ear.userData.velocity = props.reducedMotion ? 0 : velocity;
          ear.rotation.z = ear.userData.rest + (props.reducedMotion ? 0 : offset);
          ear.rotation.x = THREE.MathUtils.damp(
            ear.rotation.x,
            mood === 'sad' ? 0.2 : mood === 'shocked' ? -0.14 : breath * 0.018 * side,
            5,
            dt,
          );
        });
        a.tail.rotation.y =
          Math.sin(mt * (mood === 'celebrate' ? 7 : 1.8) + i) *
          (mood === 'celebrate' ? 0.24 : 0.045) *
          motion;
      });
      for (const pile of tablePlays) {
        const p = props.reducedMotion
            ? 1
            : Math.min(1, Math.max(0, (t - pile.userData.start - 0.16) / 0.75)),
          ease = 1 - Math.pow(1 - p, 3);
        pile.position.lerpVectors(pile.userData.from, pile.userData.target, ease);
        pile.position.y += Math.sin(p * Math.PI) * pile.userData.lift;
        pile.rotation.y = pile.userData.yaw + (1 - ease) * 0.25;
      }
      renderer!.render(scene, camera);
      if (t - anchorTime > 0.18) {
        anchorTime = t;
        updateAnchors();
      }
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
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>(resources);
  scene?.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      geometries.add(o.geometry);
      (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => materials.add(m));
    }
  });
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((m) => m.dispose());
  textures.forEach((t) => t.dispose());
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
