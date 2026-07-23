// Render a top-down SVG map from a COLMAP TXT model: camera trajectory
// (ordered by frame name) + 3D points, projected onto the plane fitted through
// the camera centers (the car's camera height is constant, so that plane is
// parallel to the floor).
//
// Usage: node slam/topdown.mjs <sparse-txt-model-dir> <output.svg>
//   <sparse-txt-model-dir> must contain images.txt + points3D.txt
//   (export with: colmap model_converter --output_type TXT)
import { readFileSync, writeFileSync } from "node:fs";

const dir = process.argv[2];
const outPath = process.argv[3];
if (!dir || !outPath) {
  console.error("usage: node topdown.mjs <sparse-txt-model-dir> <output.svg>");
  process.exit(2);
}

// ---- parse images.txt: pose lines are "IMAGE_ID qw qx qy qz tx ty tz CAM NAME"
const cams = [];
const lines = readFileSync(`${dir}/images.txt`, "utf8").split("\n");
for (let i = 0; i < lines.length; i++) {
  const l = lines[i].trim();
  if (!l || l.startsWith("#")) continue;
  const p = l.split(/\s+/);
  if (p.length >= 10 && /\.(jpe?g|png)$/i.test(p[9] || "")) {
    const [qw, qx, qy, qz, tx, ty, tz] = p.slice(1, 8).map(Number);
    // camera center C = -R^T t   (R from quaternion, world->cam convention)
    const R = quatToR(qw, qx, qy, qz);
    const C = [
      -(R[0][0] * tx + R[1][0] * ty + R[2][0] * tz),
      -(R[0][1] * tx + R[1][1] * ty + R[2][1] * tz),
      -(R[0][2] * tx + R[1][2] * ty + R[2][2] * tz),
    ];
    cams.push({ name: p[9], C });
    i++; // skip the points2D line
  }
}
cams.sort((a, b) => a.name.localeCompare(b.name));
if (cams.length < 2) {
  console.error(`topdown: only ${cams.length} camera pose(s) in ${dir}/images.txt — nothing to draw`);
  process.exit(1);
}

function quatToR(w, x, y, z) {
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ];
}

// ---- parse points3D.txt: "ID X Y Z R G B ERROR TRACK..."
const pts = [];
for (const l of readFileSync(`${dir}/points3D.txt`, "utf8").split("\n")) {
  if (!l || l.startsWith("#")) continue;
  const p = l.split(/\s+/).map(Number);
  const track = (p.length - 8) / 2;
  if (p[7] < 2.0 && track >= 3) pts.push([p[1], p[2], p[3]]);
}

// ---- fit plane through camera centers (PCA): normal = least-variance axis
const n = cams.length;
const mean = [0, 1, 2].map((k) => cams.reduce((s, c) => s + c.C[k], 0) / n);
const cov = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
for (const c of cams)
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      cov[i][j] += ((c.C[i] - mean[i]) * (c.C[j] - mean[j])) / n;
// power iteration: largest evec e1, deflate, repeat for e2; plane normal = e1 x e2
function powerIter(M) {
  let v = [1, 0.7, 0.3];
  for (let it = 0; it < 50; it++) {
    const w = [0, 1, 2].map((i) => M[i][0] * v[0] + M[i][1] * v[1] + M[i][2] * v[2]);
    const s = Math.hypot(...w) || 1;
    v = w.map((x) => x / s);
  }
  return v;
}
const e1 = powerIter(cov);
const l1 = e1.reduce((s, x, i) => s + x * (cov[i][0] * e1[0] + cov[i][1] * e1[1] + cov[i][2] * e1[2]), 0);
const defl = cov.map((row, i) => row.map((x, j) => x - l1 * e1[i] * e1[j]));
const e2 = powerIter(defl);
const nrm = [
  e1[1] * e2[2] - e1[2] * e2[1],
  e1[2] * e2[0] - e1[0] * e2[2],
  e1[0] * e2[1] - e1[1] * e2[0],
];

const proj = (P) => {
  const d = [P[0] - mean[0], P[1] - mean[1], P[2] - mean[2]];
  return [
    d[0] * e1[0] + d[1] * e1[1] + d[2] * e1[2],
    d[0] * e2[0] + d[1] * e2[1] + d[2] * e2[2],
    d[0] * nrm[0] + d[1] * nrm[1] + d[2] * nrm[2], // height off the cam plane
  ];
};

const traj = cams.map((c) => proj(c.C));
const pp = pts.map(proj);

// scale: robust bounds from trajectory + points (2..98 pct)
const xs = [...traj, ...pp].map((p) => p[0]).sort((a, b) => a - b);
const ys = [...traj, ...pp].map((p) => p[1]).sort((a, b) => a - b);
const pct = (a, q) => a[Math.floor(q * (a.length - 1))];
const x0 = pct(xs, 0.02), x1 = pct(xs, 0.98), y0 = pct(ys, 0.02), y1 = pct(ys, 0.98);
const W = 900, H = 700, pad = 40;
const sc = Math.min((W - 2 * pad) / (x1 - x0 || 1), (H - 2 * pad) / (y1 - y0 || 1));
const X = (x) => pad + (x - x0) * sc;
const Y = (y) => H - pad - (y - y0) * sc;

let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="#0f1115"/>
<text x="${pad}" y="26" fill="#8a93a6" font-family="monospace" font-size="14">wltoys reconstruction — top-down map, ${cams.length} registered frames (~${Math.round(cams.length / 5)}s of driving), ${pts.length} landmarks</text>`;
// points: color by height above camera-plane (floor below = dim, obstacles = bright)
const orient = Math.sign(pp.reduce((s, q) => s + q[2], 0)) || 1;
for (const p of pp) {
  if (p[0] < x0 || p[0] > x1 || p[1] < y0 || p[1] > y1) continue;
  const above = p[2] * orient;
  const col = above > 0 ? "#5fb4ff" : "#3a4150";
  svg += `<circle cx="${X(p[0]).toFixed(1)}" cy="${Y(p[1]).toFixed(1)}" r="1.6" fill="${col}" fill-opacity="0.75"/>`;
}
// trajectory: polyline, green, start/end markers
svg += `<polyline points="${traj.map((p) => `${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(" ")}" fill="none" stroke="#57d977" stroke-width="2.5" stroke-linejoin="round"/>`;
const s = traj[0], e = traj[traj.length - 1];
svg += `<circle cx="${X(s[0])}" cy="${Y(s[1])}" r="6" fill="#57d977"/><text x="${X(s[0]) + 9}" y="${Y(s[1]) + 4}" fill="#57d977" font-family="monospace" font-size="13">start</text>`;
svg += `<circle cx="${X(e[0])}" cy="${Y(e[1])}" r="6" fill="#ff7a5f"/><text x="${X(e[0]) + 9}" y="${Y(e[1]) + 4}" fill="#ff7a5f" font-family="monospace" font-size="13">end</text>`;
svg += `</svg>`;
writeFileSync(outPath, svg);
console.log(`topdown: frames=${cams.length} landmarks=${pts.length} -> ${outPath}`);
