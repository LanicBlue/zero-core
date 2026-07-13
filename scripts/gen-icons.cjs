// 生成 zero-core 图标(零依赖:仅用 Node 内置 zlib,不装任何图像库)。
//   build/trayIconTemplate.png — 32×32 黑色圆环,macOS template image(菜单栏单色)
//   build/icon.png             — 1024×1024 深色圆角方块 + 白圆环(app / Dock 图标)
// 圆环 = "零",契合 zero-core。要换正式 logo:替换这两个文件即可。
//
// 运行: node scripts/gen-icons.cjs
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");

// ── PNG 编码(带 supersampling 抗锯齿)──
const crcTable = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();
function crc32(buf) {
	let c = 0xffffffff;
	for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length, 0);
	const typeBuf = Buffer.from(type, "ascii");
	const crcBuf = Buffer.alloc(4);
	crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
	return Buffer.concat([len, typeBuf, data, crcBuf]);
}
function makePNG(w, h, pixelFn, ss) {
	const raw = Buffer.alloc((w * 4 + 1) * h);
	for (let y = 0; y < h; y++) {
		const rowStart = y * (w * 4 + 1);
		raw[rowStart] = 0; // filter: none
		for (let x = 0; x < w; x++) {
			let r = 0, g = 0, b = 0, a = 0;
			for (let sy = 0; sy < ss; sy++)
				for (let sx = 0; sx < ss; sx++) {
					const px = (x * ss + sx + 0.5) / ss;
					const py = (y * ss + sy + 0.5) / ss;
					const c = pixelFn(px, py);
					r += c[0]; g += c[1]; b += c[2]; a += c[3];
				}
			const n = ss * ss;
			const o = rowStart + 1 + x * 4;
			raw[o] = Math.round(r / n);
			raw[o + 1] = Math.round(g / n);
			raw[o + 2] = Math.round(b / n);
			raw[o + 3] = Math.round(a / n);
		}
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(h, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // color type RGBA
	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		chunk("IHDR", ihdr),
		chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

// 圆角矩形内判定(用于 app icon 的方块外框)
function inRoundedRect(x, y, w, h, r) {
	const dx = Math.min(x, w - x);
	const dy = Math.min(y, h - y);
	if (dx >= r || dy >= r) return true;
	const cdx = r - dx, cdy = r - dy;
	return cdx * cdx + cdy * cdy <= r * r;
}

// tray:菜单栏 template image(setTemplateImage(true) 后自适应单色)。
// macOS 菜单栏原生 ~22pt:用 22×22(@1x)+ 44×44(@2x)一对,nativeImage 自动按
// Retina 选 @2x,显示尺寸固定 22 点且点对点高清,避免缩放发糊 / 偏大。
// 圆环外径 ≈ size×0.345、内径 ≈ size×0.23,占 ~69%,留足菜单栏上下边距。
function trayPixel(size) {
	const outer = size * 0.345;
	const inner = size * 0.23;
	return (x, y) => {
		const c = size / 2;
		const dx = x - c, dy = y - c;
		const r = Math.sqrt(dx * dx + dy * dy);
		if (r >= inner && r <= outer) return [0, 0, 0, 255];
		return [0, 0, 0, 0];
	};
}

// app icon:1024 深色圆角方块 + 白圆环
const S = 1024;
function iconPixel(x, y) {
	if (!inRoundedRect(x, y, S, S, 228)) return [0, 0, 0, 0]; // 透明圆角外
	const dx = x - S / 2, dy = y - S / 2;
	const r = Math.sqrt(dx * dx + dy * dy);
	if (r >= 205 && r <= 340) return [245, 245, 250, 255]; // 白圆环
	return [18, 18, 26, 255]; // 深色背景
}

const buildDir = path.join(__dirname, "..", "build");
fs.mkdirSync(buildDir, { recursive: true });
fs.writeFileSync(path.join(buildDir, "trayIconTemplate.png"), makePNG(22, 22, trayPixel(22), 8));
fs.writeFileSync(path.join(buildDir, "trayIconTemplate@2x.png"), makePNG(44, 44, trayPixel(44), 4));
fs.writeFileSync(path.join(buildDir, "icon.png"), makePNG(1024, 1024, iconPixel, 2));
console.log("✓ generated build/trayIconTemplate.png (22×22) + trayIconTemplate@2x.png (44×44) + icon.png (1024×1024)");
