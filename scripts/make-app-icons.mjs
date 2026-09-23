/**
 * make-app-icons.mjs — 由品牌 mark 生成 App 图标资源（M5）
 *
 * 背景：App 图标此前是 Expo 模板自带的蓝色占位图（M0 骨架遗留），与品牌（volt 荧光黄）
 * 无关。本脚本从 `reference/web/logo.svg` 解析品牌 mark（斜切平行四边形 + 45° 对角
 * 条纹）的几何，按坐标精确光栅化出 `assets/images/` 的一整套图标源，再经
 * `npx expo prebuild --platform android --no-install` 落到 android 的 mipmap/drawable。
 *
 * 构图对齐参考实现的 `reference/web/icon.png`（512² 深色底 + mark 宽占 62%、垂直居中）
 * 与 `reference/web/favicon.svg`（深色圆角方底，配浅色浏览器标签栏）。
 *
 * 用法：node scripts/make-app-icons.mjs
 * 说明：纯 Node（zlib 手写 PNG 编码），无第三方依赖；几何全部来自 SVG 解析——
 * mark 改版（路径或条纹相位变了）重跑本脚本即可，无需改代码。
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SVG = path.join(ROOT, 'reference/web/logo.svg');
const OUT = path.join(ROOT, 'assets/images');

/** 品牌色（与 web/style.css 的 --volt 一致）与深色底 */
const VOLT = [0xd7, 0xff, 0x3f];
const BG = [0x0a, 0x0d, 0x11];

// ---------------- SVG 几何解析 ----------------

/** 极简 path 解析：支持 M/m h/H l/L v/V z（logo.svg 的 mark 路径只用到这几个） */
function parsePath(d) {
  const toks = d.match(/[MmLlHhVvZz]|-?[\d.]+/g) ?? [];
  const pts = [];
  let i = 0;
  let cx = 0;
  let cy = 0;
  let cmd = null;
  const num = () => Number(toks[i++]);
  while (i < toks.length) {
    if (/[MmLlHhVvZz]/.test(toks[i])) cmd = toks[i++];
    switch (cmd) {
      case 'M':
        cx = num();
        cy = num();
        pts.push([cx, cy]);
        break;
      case 'm':
        cx += num();
        cy += num();
        pts.push([cx, cy]);
        break;
      case 'h':
        cx += num();
        pts.push([cx, cy]);
        break;
      case 'H':
        cx = num();
        pts.push([cx, cy]);
        break;
      case 'l':
        cx += num();
        cy += num();
        pts.push([cx, cy]);
        break;
      case 'L':
        cx = num();
        cy = num();
        pts.push([cx, cy]);
        break;
      case 'v':
        cy += num();
        pts.push([cx, cy]);
        break;
      case 'V':
        cy = num();
        pts.push([cx, cy]);
        break;
      case 'z':
      case 'Z':
        break;
      default:
        throw new Error(`logo.svg 的 mark 路径含未支持的指令: ${cmd}`);
    }
  }
  if (pts.length < 3) throw new Error('mark 路径解析失败（顶点不足）');
  return pts;
}

/**
 * 解析 logo.svg：mark 的四边形（clipPath 路径顶点）+ 条纹带（每个 polygon 的
 * x+y 区间——条纹沿 x+y=c 方向，故多边形的 min/max (x+y) 就是该带的边界）。
 */
function parseLogo() {
  const svg = fs.readFileSync(SVG, 'utf8');
  const clip = /<clipPath[^>]*>\s*<path\s+d="([^"]+)"/.exec(svg);
  if (!clip) throw new Error(`未在 ${SVG} 找到 clipPath path`);
  const quad = parsePath(clip[1]);

  const bands = [];
  for (const m of svg.matchAll(/<polygon\s+points="([^"]+)"/g)) {
    const sums = m[1]
      .trim()
      .split(/\s+/)
      .map((p) => p.split(',').map(Number).reduce((a, b) => a + b, 0));
    bands.push([Math.min(...sums), Math.max(...sums)]);
  }
  if (!bands.length) throw new Error(`未在 ${SVG} 找到条纹 polygon`);
  bands.sort((a, b) => a[0] - b[0]);
  return { quad, bands };
}

// ---------------- 光栅化（超采样抗锯齿） ----------------

/** 凸多边形内测试（mark 是凸四边形；边界按 <= 计） */
function insideConvex(pt, poly) {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    const cross = (x2 - x1) * (pt[1] - y1) - (y2 - y1) * (pt[0] - x1);
    if (cross === 0) continue;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** 点是否落在 mark 的条纹里（x+y 落在任一条纹带内） */
function inStripe(pt, bands) {
  const sum = pt[0] + pt[1];
  return bands.some(([lo, hi]) => sum >= lo && sum <= hi);
}

/**
 * 光栅化 mark：返回 size×size 的 RGBA（Buffer，行优先）+ 可见范围（像素 bbox）。
 * 几何先按 mark（四边形）的包围盒缩放到指定宽度/高度并居中，再逐子像素采样：
 * 落在四边形内且落在条纹带内 → 填充色，否则透明。
 */
function renderMark(size, { widthRatio, stripes = true, supersample = 3, fill = VOLT } = {}) {
  const { quad, bands } = LOGO;
  const xs = quad.map((p) => p[0]);
  const ys = quad.map((p) => p[1]);
  const [qx0, qx1] = [Math.min(...xs), Math.max(...xs)];
  const [qy0, qy1] = [Math.min(...ys), Math.max(...ys)];
  const quadW = qx1 - qx0;
  const quadH = qy1 - qy0;

  const targetW = size * widthRatio;
  const scale = targetW / quadW;
  const offX = (size - targetW) / 2;
  const offY = (size - quadH * scale) / 2;

  // 用户坐标 → canvas 坐标
  const toCanvas = (p) => [offX + (p[0] - qx0) * scale, offY + (p[1] - qy0) * scale];
  const canvasQuad = quad.map(toCanvas);

  const out = Buffer.alloc(size * size * 4);
  const ss = supersample;
  let minX = size;
  let minY = size;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // 超采样：ss×ss 子像素求覆盖
      let hit = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const px = x + (sx + 0.5) / ss;
          const py = y + (sy + 0.5) / ss;
          if (!insideConvex([px, py], canvasQuad)) continue;
          // 像素中心反算回用户坐标后判条纹（避免浮点误差累积到带边界）
          const ux = qx0 + (px - offX) / scale;
          const uy = qy0 + (py - offY) / scale;
          if (!stripes || inStripe([ux, uy], bands)) hit++;
        }
      }
      if (!hit) continue;
      const a = Math.round((hit / (ss * ss)) * 255);
      const o = (y * size + x) * 4;
      out[o] = fill[0];
      out[o + 1] = fill[1];
      out[o + 2] = fill[2];
      out[o + 3] = a;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return { rgba: out, size, bbox: { minX, minY, maxX, maxY } };
}

const LOGO = parseLogo();

/** 自校准：mark 的“可见范围”比四边形小一圈（条纹只覆盖其中一部分），
 *  按 visible 宽度反推四边形宽度，使可见 mark 宽恰为目标比例 */
function calibrateWidthRatio(visibleRatio) {
  const probe = renderMark(256, { widthRatio: 1 });
  const visibleW = (probe.bbox.maxX - probe.bbox.minX + 1) / probe.size;
  return visibleRatio / visibleW;
}

// ---------------- 合成 ----------------

/** 画布上叠加：底色（可透明）+ mark */
function compose(size, { bg = null, markRatio, stripes = true, fill = VOLT, radius = 0 }) {
  const out = Buffer.alloc(size * size * 4);
  if (bg) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const o = (y * size + x) * 4;
        let a = 255;
        if (radius > 0) {
          // 圆角矩形：四角按圆方程做 1px 抗锯齿
          const dx = Math.max(radius - x, x - (size - 1 - radius), 0);
          const dy = Math.max(radius - y, y - (size - 1 - radius), 0);
          const d = Math.hypot(dx, dy);
          a = d <= radius - 0.5 ? 255 : d >= radius + 0.5 ? 0 : Math.round((radius + 0.5 - d) * 255);
        }
        out[o] = bg[0];
        out[o + 1] = bg[1];
        out[o + 2] = bg[2];
        out[o + 3] = a;
      }
    }
  }
  const mark = renderMark(size, { widthRatio: calibrateWidthRatio(markRatio), stripes, fill });
  for (let i = 0; i < size * size; i++) {
    const o = i * 4;
    const a = mark.rgba[o + 3] / 255;
    if (!a) continue;
    const dstA = out[o + 3] / 255;
    const outA = a + dstA * (1 - a);
    for (let c = 0; c < 3; c++) {
      const src = mark.rgba[o + c];
      const dst = out[o + c] * dstA;
      out[o + c] = Math.round((src * a + dst * (1 - a)) / (outA || 1));
    }
    out[o + 3] = Math.round(outA * 255);
  }
  return { rgba: out, bbox: mark.bbox, size };
}

// ---------------- PNG 编码（zlib + CRC32，无第三方依赖） ----------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function writePng(file, { rgba, size }) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(file, png);
  return png.length;
}

// ---------------- 生成一套图标源 ----------------

// 与 reference/web/icon.png 一致：可见 mark 宽占画布的 62%，垂直居中
const ICON_MARK = 0.62;
// 自适应图标前景层：系统会放大 1.5× 做视差，可见内容须留在中央 66/108≈61% 安全区内
const FG_MARK = 0.56;

const plan = [
  // 通用图标（legacy / 圆形图标共用）：深色底 + 品牌 mark
  ['icon.png', 1024, () => compose(1024, { bg: BG, markRatio: ICON_MARK })],
  // 自适应图标：背景层纯深色（app.json 的 backgroundColor 同值），前景层透明 + mark
  ['android-icon-background.png', 512, () => compose(512, { bg: BG })],
  ['android-icon-foreground.png', 512, () => compose(512, { markRatio: FG_MARK })],
  // Android 13+ 主题图标：系统按主题着色，故用**实心剪影**（不带条纹，小尺寸下更干净）
  ['android-icon-monochrome.png', 432, () => compose(432, { markRatio: FG_MARK, stripes: false, fill: [255, 255, 255] })],
  // 启动图（expo-splash-screen 的 imageWidth=76dp，深色底由插件 backgroundColor 给）
  ['splash-icon.png', 512, () => compose(512, { markRatio: 0.92 })],
  // Web favicon：深色圆角方底（同 reference/web/favicon.svg 的处理，浅色标签栏下可见）
  ['favicon.png', 192, () => compose(192, { bg: BG, markRatio: ICON_MARK, radius: 36 })],
];

for (const [name, size, make] of plan) {
  const img = make();
  const bytes = writePng(path.join(OUT, name), img);
  const b = img.bbox;
  const w = ((b.maxX - b.minX + 1) / size).toFixed(3);
  const h = ((b.maxY - b.minY + 1) / size).toFixed(3);
  console.log(`✓ ${name.padEnd(30)} ${size}²  ${(bytes / 1024).toFixed(1)} KB  可见 mark ${w}w × ${h}h`);
}

// ---------------- iOS：assets/expo.icon（Icon Composer 包） ----------------

/**
 * iOS 26 的 `.icon` 是 Icon Composer 目录包：icon.json 描述背景填充与图层，
 * 图层引用 Assets/ 下的图片。这里保持目录结构与图层文件名不变，只换内容：
 * 背景渐变 → 品牌深色、图层符号 → 品牌 mark（去掉模板的装饰网格层）。
 * ⚠️ 未在 macOS/Icon Composer 上验证（iOS 冒烟后置，见 AGENTS）。
 */
function writeIosIcon() {
  const dir = path.join(ROOT, 'assets/expo.icon');
  const jsonPath = path.join(dir, 'icon.json');
  const manifest = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

  const { quad } = LOGO;
  const xs = quad.map((p) => p[0]);
  const ys = quad.map((p) => p[1]);
  const [qx0, qx1] = [Math.min(...xs), Math.max(...xs)];
  const [qy0, qy1] = [Math.min(...ys), Math.max(...ys)];

  // 与 Android 前景层同一构图：mark 可见宽占 ~62%，居中于 1024² 画布
  // （模板的符号 SVG 是 652×606、在 Icon Composer 的 1024 画布里约 64%，这里对齐同一视觉重量）
  const W = 1024;
  const H = 1024;
  const visibleRatio = 0.62;
  const probe = renderMark(256, { widthRatio: 1 });
  const probeRatio = (probe.bbox.maxX - probe.bbox.minX + 1) / probe.size;
  const quadPx = (W * visibleRatio) / probeRatio;
  const scale = quadPx / (qx1 - qx0);
  const tx = (W - quadPx) / 2;
  const ty = (H - (qy1 - qy0) * scale) / 2;

  const stripePolys = LOGO.bands
    .map(([lo, hi]) => `    <polygon points="${lo},0 ${hi},0 0,${hi} 0,${lo}"/>`)
    .join('\n');
  const svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" fill="none" xmlns="http://www.w3.org/2000/svg">
  <!-- 品牌 mark（几何同 reference/web/logo.svg，构图随 Android 图标：可见宽占 62%） -->
  <g transform="translate(${tx.toFixed(2)},${ty.toFixed(2)}) scale(${scale.toFixed(4)}) translate(${-qx0},${-qy0})">
    <g fill="#d7ff3f">
${stripePolys}
    </g>
  </g>
</svg>
`;
  fs.writeFileSync(path.join(dir, 'Assets/expo-symbol 2.svg'), svg);

  manifest.fill = { 'automatic-gradient': 'extended-srgb:0.03922,0.05098,0.06667,1.00000' }; // #0a0d11
  for (const group of manifest.groups ?? []) {
    group.layers = (group.layers ?? []).filter((l) => !String(l['image-name'] ?? '').endsWith('.png'));
  }
  delete manifest['supported-platforms']?.circles; // 保留 squares: shared，去掉 watchOS 圆形
  fs.writeFileSync(jsonPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`✓ assets/expo.icon               背景 #0a0d11 + 品牌 mark 图层（未在 macOS 验证）`);
}

writeIosIcon();

console.log(`\n图标源已写入 ${path.relative(ROOT, OUT)}（几何来自 ${path.relative(ROOT, SVG)}）`);
console.log('落到 android 资源：npx expo prebuild --platform android --no-install');
