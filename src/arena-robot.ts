import * as THREE from 'three';

export const ROBOT_FACE = { eyeX: 0.285, eyeWidth: 0.105, eyeHeight: 0.145, eyeDepth: 0.061 };

export interface RobotRig {
  body: THREE.Group;
  hips: THREE.Group;
  head: THREE.Group;
  left: THREE.Group;
  right: THREE.Group;
  eyes: THREE.Mesh[];
  eyeGlints: THREE.Group[];
  eyeSmiles: THREE.Mesh[];
  brows: THREE.Mesh[];
  ears: THREE.Group[];
  mouth: THREE.Mesh;
  surprisedMouth: THREE.Mesh;
  tears: THREE.Mesh[];
  tail: THREE.Group;
}

type Finish = 'soft' | 'cream' | 'ear' | 'glass' | 'metal' | 'tear' | 'blush';
type Triple = [number, number, number];

/** One geometry/material library per arena; all four articulated characters reuse it. */
export function createRobotBuilder(grain: THREE.Texture) {
  const orb = new THREE.SphereGeometry(1, 40, 28);
  const headOrb = orb.clone();
  const positions = headOrb.attributes.position;
  const normals = headOrb.attributes.normal;
  const normal = new THREE.Vector3();
  for (let i = 0; i < positions.count; i++) {
    const y = positions.getY(i);
    const fullness = Math.exp(-Math.pow((y + 0.27) / 0.38, 2));
    const fx = 1 + fullness * 0.055,
      fz = 1 + fullness * 0.05;
    const x = positions.getX(i) * fx,
      z = positions.getZ(i) * fz;
    positions.setXYZ(i, x, y, z);
    // Analytic normals stay continuous across duplicated UV seam vertices.
    const slope = ((-2 * (y + 0.27)) / (0.38 * 0.38)) * fullness;
    normal
      .set(
        x / (fx * fx),
        y - (x * x * 0.055 * slope) / (fx * fx * fx) - (z * z * 0.05 * slope) / (fz * fz * fz),
        z / (fz * fz),
      )
      .normalize();
    normals.setXYZ(i, normal.x, normal.y, normal.z);
  }
  const surfaces = new Map<string, THREE.MeshPhysicalMaterial>();
  function surface(color: number, finish: Finish = 'soft') {
    const key = `${color}:${finish}`;
    if (surfaces.has(key)) return surfaces.get(key)!;
    const glossy = finish === 'glass' || finish === 'tear';
    const m = new THREE.MeshPhysicalMaterial({
      color,
      roughness: glossy ? 0.12 : finish === 'metal' ? 0.28 : finish === 'ear' ? 0.82 : 0.52,
      metalness: finish === 'metal' ? 0.65 : 0,
      clearcoat: glossy ? 1 : finish === 'cream' ? 0.2 : 0.12,
      clearcoatRoughness: glossy ? 0.08 : 0.5,
      sheen: finish === 'soft' || finish === 'ear' ? 0.36 : 0.08,
      sheenRoughness: 0.8,
      sheenColor: new THREE.Color(color).lerp(new THREE.Color(0xfff3e6), 0.4),
      ior: glossy ? 1.46 : 1.4,
    });
    if (finish === 'soft' || finish === 'ear' || finish === 'cream') {
      m.bumpMap = grain;
      m.bumpScale = finish === 'ear' ? 0.006 : 0.0025;
    }
    if (finish === 'tear') {
      m.transparent = true;
      m.opacity = 0.84;
    }
    surfaces.set(key, m);
    return m;
  }
  function ball(
    parent: THREE.Object3D,
    color: number,
    size: Triple,
    at: Triple,
    finish: Finish = 'soft',
  ) {
    const mesh = new THREE.Mesh(orb, surface(color, finish));
    mesh.position.set(...at);
    mesh.scale.set(...size);
    mesh.castShadow = finish !== 'tear' && finish !== 'blush';
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }
  function tube(
    parent: THREE.Object3D,
    color: number,
    points: Triple[],
    radius: number,
    finish: Finish = 'cream',
  ) {
    const path = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)));
    const mesh = new THREE.Mesh(
      new THREE.TubeGeometry(path, 24, radius, 8, false),
      surface(color, finish),
    );
    mesh.castShadow = true;
    parent.add(mesh);
    return mesh;
  }
  function ring(
    parent: THREE.Object3D,
    radius: number,
    thickness: number,
    at: Triple,
    color: number,
    arc = Math.PI * 2,
  ) {
    const mesh = new THREE.Mesh(
      new THREE.TorusGeometry(radius, thickness, 8, 40, arc),
      surface(color, 'metal'),
    );
    mesh.position.set(...at);
    parent.add(mesh);
    return mesh;
  }

  return function build(root: THREE.Group, seat: number, color: number): RobotRig {
    const cream = 0xffefda;
    const accent = new THREE.Color(color).lerp(new THREE.Color(0x33485a), 0.22).getHex();
    const body = new THREE.Group();
    body.position.y = 0.95;
    root.add(body);
    ball(body, color, [0.6, 0.6, 0.48], [0, 0.48, 0]);
    ball(body, accent, [0.415, 0.46, 0.19], [0, 0.49, 0.35]);
    ball(body, cream, [0.395, 0.44, 0.2], [0, 0.5, 0.366], 'cream');
    // Recessed collar and a small enamel power badge establish a crafted robot body.
    const collar = ring(body, 0.29, 0.028, [0, 1.06, 0], 0xc4a574);
    collar.rotation.x = Math.PI / 2;
    ball(body, 0xd3b782, [0.07, 0.07, 0.018], [0, 0.78, 0.53], 'metal');
    ball(body, accent, [0.051, 0.051, 0.012], [0, 0.78, 0.548], 'cream');
    const power = ring(body, 0.024, 0.004, [0, 0.779, 0.561], cream, Math.PI * 1.6);
    power.rotation.z = Math.PI * 0.7;
    tube(
      body,
      cream,
      [
        [0, 0.812, 0.562],
        [0, 0.786, 0.562],
      ],
      0.004,
    );

    const hips = new THREE.Group();
    hips.position.y = 0.95;
    root.add(hips);
    for (const side of [-1, 1]) {
      ball(hips, color, [0.29, 0.28, 0.39], [side * 0.37, 0.1, 0.37]);
      ball(hips, color, [0.255, 0.52, 0.25], [side * 0.37, -0.49, 0.45]);
      ball(hips, accent, [0.28, 0.1, 0.355], [side * 0.38, -1.21, 0.59], 'ear');
      ball(hips, color, [0.295, 0.18, 0.375], [side * 0.38, -1.13, 0.59]);
      for (const toe of [-1, 1]) {
        tube(
          hips,
          accent,
          [
            [side * 0.38 + toe * 0.08, -1.11, 0.947],
            [side * 0.38 + toe * 0.08, -1.055, 0.919],
          ],
          0.007,
        );
      }
    }

    const head = new THREE.Group();
    head.position.set(0, 1.44, 0);
    head.scale.setScalar(0.92);
    body.add(head);
    const skull = ball(head, color, [0.79, 0.66, 0.625], [0, 0, 0]);
    skull.geometry = headOrb;
    // The lower cheeks belong to a continuous sculpted surface, without sphere seams.
    for (const side of [-1, 1]) {
      const blush = ball(
        head,
        0xe8a0b2,
        [0.105, 0.05, 0.016],
        [side * 0.445, -0.165, 0.533],
        'blush',
      );
      blush.rotation.y = side * 0.57;
    }
    ball(head, cream, [0.36, 0.215, 0.17], [0, -0.265, 0.53], 'cream');
    ball(head, 0x805563, [0.067, 0.046, 0.038], [0, -0.23, 0.696], 'glass');
    ball(head, 0xd3a1a3, [0.018, 0.008, 0.004], [-0.018, -0.218, 0.73], 'cream');
    tube(
      head,
      0x805563,
      [
        [0, -0.267, 0.707],
        [0, -0.293, 0.706],
      ],
      0.008,
    );
    const mouth = new THREE.Mesh(
      new THREE.TorusGeometry(0.075, 0.012, 8, 28, Math.PI),
      surface(0x805563, 'cream'),
    );
    mouth.position.set(0, -0.315, 0.694);
    mouth.rotation.z = Math.PI;
    head.add(mouth);
    const surprisedMouth = new THREE.Mesh(
      new THREE.TorusGeometry(0.047, 0.015, 8, 28),
      surface(0x805563, 'cream'),
    );
    surprisedMouth.position.set(0, -0.345, 0.689);
    surprisedMouth.scale.y = 1.25;
    surprisedMouth.visible = false;
    head.add(surprisedMouth);

    const eyes: THREE.Mesh[] = [],
      eyeGlints: THREE.Group[] = [],
      eyeSmiles: THREE.Mesh[] = [];
    const brows: THREE.Mesh[] = [],
      tears: THREE.Mesh[] = [],
      ears: THREE.Group[] = [];
    for (const side of [-1, 1]) {
      const ear = new THREE.Group();
      ear.position.set(side * 0.49, seat === 1 ? 0.665 : 0.55, -0.035);
      ear.rotation.z = side * (seat === 0 ? -0.34 : -0.2);
      ear.userData.rest = ear.rotation.z;
      head.add(ear);
      ears.push(ear);
      if (seat === 0) {
        const profile = [
          [0, -1],
          [0.65, -0.85],
          [1, -0.3],
          [0.77, 0.35],
          [0.32, 0.9],
          [0, 1.05],
        ].map(([r, y]) => new THREE.Vector2(r, y));
        const shape = new THREE.LatheGeometry(profile, 32);
        const outer = new THREE.Mesh(shape, surface(color));
        outer.scale.set(0.245, 0.34, 0.195);
        outer.castShadow = true;
        ear.add(outer);
        const inner = new THREE.Mesh(shape, surface(0xf2bdca, 'ear'));
        inner.scale.set(0.135, 0.23, 0.035);
        inner.position.set(0, 0.025, 0.17);
        ear.add(inner);
      } else {
        ball(ear, color, seat === 1 ? [0.185, 0.62, 0.195] : [0.265, 0.25, 0.235], [
          0,
          seat === 1 ? 0.1 : 0.04,
          0,
        ]);
        ball(
          ear,
          seat === 2 ? 0xb9d7b2 : 0xf2c7bd,
          seat === 1 ? [0.103, 0.455, 0.06] : [0.155, 0.148, 0.065],
          [0, seat === 1 ? 0.11 : 0.04, seat === 1 ? 0.172 : 0.192],
          'ear',
        );
      }
      const eye = ball(
        head,
        0x182832,
        [ROBOT_FACE.eyeWidth, ROBOT_FACE.eyeHeight, ROBOT_FACE.eyeDepth],
        [side * ROBOT_FACE.eyeX, 0.026, 0.584],
        'glass',
      );
      eyes.push(eye);
      const highlights = new THREE.Group();
      highlights.position.set(side * ROBOT_FACE.eyeX, 0.026, 0.584);
      head.add(highlights);
      ball(highlights, 0xffffff, [0.025, 0.031, 0.006], [-0.027, 0.043, 0.058], 'glass');
      ball(highlights, 0xb4dce6, [0.01, 0.012, 0.004], [0.035, -0.045, 0.055], 'glass');
      eyeGlints.push(highlights);
      const smile = tube(
        head,
        0x24343e,
        [
          [-0.088, -0.015, 0.023],
          [-0.045, 0.052, 0.045],
          [0, 0.07, 0.051],
          [0.045, 0.052, 0.045],
          [0.088, -0.015, 0.023],
        ],
        0.014,
      );
      smile.position.set(side * ROBOT_FACE.eyeX, 0.026, 0.584);
      smile.visible = false;
      eyeSmiles.push(smile);
      const brow = tube(
        head,
        accent,
        [
          [-0.072, 0, -0.005],
          [0, 0.015, 0.003],
          [0.065, -0.007, -0.005],
        ],
        0.011,
      );
      brow.position.set(side * ROBOT_FACE.eyeX, 0.24, 0.548);
      brows.push(brow);
      const tear = ball(head, 0x9bdef5, [0.039, 0.08, 0.025], [side * 0.3, -0.14, 0.621], 'tear');
      tear.visible = false;
      tears.push(tear);
    }
    const antennaHeight = seat === 1 ? 1.02 : 0.9;
    ball(head, accent, [0.085, 0.035, 0.085], [0, 0.655, 0], 'ear');
    const stem = new THREE.Mesh(
      new THREE.CylinderGeometry(0.023, 0.03, antennaHeight - 0.665, 16),
      surface(0xba9968, 'metal'),
    );
    stem.position.y = (antennaHeight + 0.665) / 2;
    head.add(stem);
    ball(head, 0xe9c98d, [0.076, 0.076, 0.076], [0, antennaHeight, 0], 'metal');

    const left = new THREE.Group(),
      right = new THREE.Group();
    left.position.set(-0.49, 0.59, 0.5);
    right.position.set(0.49, 0.59, 0.5);
    body.add(left, right);
    for (const [arm, side] of [
      [left, -1],
      [right, 1],
    ] as [THREE.Group, number][]) {
      ball(arm, accent, [0.16, 0.16, 0.16], [0, -0.055, -0.02], 'ear');
      ball(arm, color, [0.175, 0.16, 0.34], [side * 0.045, -0.055, 0.245]);
      ball(arm, color, [0.185, 0.17, 0.2], [side * 0.015, -0.038, 0.5]);
      ball(arm, color, [0.09, 0.105, 0.11], [-side * 0.13, -0.01, 0.46]);
      for (const finger of [-1, 1]) {
        tube(
          arm,
          accent,
          [
            [finger * 0.057, -0.04, 0.694],
            [finger * 0.057, 0.019, 0.687],
          ],
          0.006,
        );
      }
    }
    const tail = new THREE.Group();
    tail.position.set(0, 0.35, -0.43);
    body.add(tail);
    if (seat === 0) {
      tube(
        tail,
        color,
        [
          [0, 0, 0],
          [0.4, -0.05, -0.06],
          [0.62, 0.08, -0.08],
          [0.68, 0.37, -0.03],
          [0.51, 0.46, 0.015],
        ],
        0.1,
        'soft',
      );
      ball(tail, cream, [0.103, 0.105, 0.103], [0.51, 0.46, 0.015], 'cream');
    } else {
      ball(
        tail,
        seat === 1 ? cream : color,
        seat === 1 ? [0.235, 0.235, 0.22] : [0.17, 0.17, 0.16],
        [0, 0.05, -0.09],
      );
    }
    return {
      body,
      hips,
      head,
      left,
      right,
      eyes,
      eyeGlints,
      eyeSmiles,
      brows,
      ears,
      mouth,
      surprisedMouth,
      tears,
      tail,
    };
  };
}
