// 复核台前端：所有解析/合成逻辑均来自共享引擎 ../src/apng.js
import { reviewBase64, pixelTrajectory, MAX_INPUT_BYTES, MAX_DIMENSION, MAX_FRAMES } from '../src/apng.js';
import { sampleBase64 } from './sample.js';

const $ = (id) => document.getElementById(id);
const srcEl = $('src');
const counterEl = $('counter');
const bannerEl = $('banner');
const resultEl = $('result');

let currentResult = null; // 仅保存最近一次成功复核结论
let activeFrame = 0;
let activeView = 'canvas'; // 'canvas' | 'reconstructed'
// 坐标输入草稿（跨 render 保留输入框内容；已生成的轨迹不保留，随结论/帧切换同步清除）
let traceDraft = { x: '', y: '' };

/* ------------------------------ 工具 ------------------------------ */

const DISPOSE_TAG = ['none', 'background', 'previous'];

function hex2(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function putPixels(canvas, width, height, pixels) {
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(width, height);
  img.data.set(pixels.subarray(0, width * height * 4));
  ctx.putImageData(img, 0, 0);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

// RGBA 值渲染：棋盘底色块 + 数值
function rgbaCell(v) {
  return (
    `<span class="swatch"><i style="background:rgba(${v[0]},${v[1]},${v[2]},${(v[3] / 255).toFixed(3)})"></i></span>` +
    `<span class="mono">(${v.join(', ')})</span>`
  );
}

/* --------------------------- 像素逐帧轨迹 --------------------------- */

// 生成并渲染坐标 (x, y) 的逐帧轨迹；坐标非法或无有效结论时清除旧轨迹并提示
function showTrace() {
  const traceEl = $('trace-result');
  if (!traceEl) return;
  if (!currentResult) {
    traceEl.innerHTML = '<div class="trace-error">尚无有效复核结论，无法生成像素轨迹。</div>';
    return;
  }
  const sx = traceDraft.x.trim();
  const sy = traceDraft.y.trim();
  if (sx === '' || sy === '') {
    traceEl.innerHTML = '<div class="trace-error">请输入完整的 X / Y 画布坐标。</div>';
    return;
  }
  if (!/^\d+$/.test(sx) || !/^\d+$/.test(sy)) {
    traceEl.innerHTML = '<div class="trace-error">坐标必须为非负整数（十进制）。</div>';
    return;
  }
  let rows;
  try {
    rows = pixelTrajectory(currentResult, Number(sx), Number(sy));
  } catch (e) {
    // 坐标超出画布等：不得生成或保留旧轨迹
    traceEl.innerHTML = `<div class="trace-error">${esc(e?.message || String(e))}</div>`;
    return;
  }
  const x = Number(sx);
  const y = Number(sy);
  const body = rows
    .map((t) => {
      const src = t.inRegion
        ? rgbaCell(t.sourcePixel)
        : '<span class="na">不在该帧区域内</span>';
      return `<tr>
        <td class="mono">帧 ${t.frame}</td>
        <td>${rgbaCell(t.before)}</td>
        <td>${src}</td>
        <td>${rgbaCell(t.blended)}<div class="op">${t.blendOp === 1 ? 'over' : 'source'}</div></td>
        <td>${rgbaCell(t.nextStart)}<div class="op">${DISPOSE_TAG[t.disposeOp]}</div></td>
      </tr>`;
    })
    .join('');
  traceEl.innerHTML = `
    <table class="trace-table">
      <tr><th>帧</th><th>绘制前画布 RGBA</th><th>解滤波原像素</th><th>混合后冻结画面 RGBA</th><th>处置后下一帧起始 RGBA</th></tr>
      ${body}
    </table>
    <div class="trace-note">坐标 (${x}, ${y})：混合 source=直接覆盖 / over=Alpha 叠加；处置 none=保留 / background=恢复全透明 / previous=恢复绘制前快照。</div>`;
}

/* ------------------------------ 渲染 ------------------------------ */

function showBanner(kind, html) {
  bannerEl.className = `banner ${kind}`;
  bannerEl.innerHTML = html;
}

function clearBanner() {
  bannerEl.className = 'banner';
  bannerEl.textContent = '';
}

function render() {
  if (!currentResult) {
    resultEl.innerHTML =
      '<div class="empty">尚无成功复核记录。提交合法 APNG 后在此查看逐帧控制参数、解滤波像素摘要、合成画布摘要，并可切换冻结画面。</div>';
    return;
  }
  const r = currentResult;
  const frame = r.frames[activeFrame];

  const tabs = r.frames
    .map((f, i) => `<button data-frame="${i}" class="${i === activeFrame ? 'active' : ''}">帧 ${i + 1}</button>`)
    .join('');

  resultEl.innerHTML = `
    <div class="overview">
      <div class="item"><div class="k">画布</div><div class="v">${r.width} × ${r.height}</div></div>
      <div class="item"><div class="k">帧数</div><div class="v">${r.numFrames} / ${MAX_FRAMES}</div></div>
      <div class="item"><div class="k">acTL num_plays</div><div class="v">${r.numPlays === 0 ? '0（无限循环）' : r.numPlays}</div></div>
    </div>
    <div class="frame-tabs" id="tabs">${tabs}</div>
    <div class="frame-grid">
      <div>
        <div class="canvas-wrap">
          <canvas id="display"></canvas>
          <div class="canvas-meta" id="canvas-meta"></div>
        </div>
        <div class="row">
          <button data-view="canvas" class="${activeView === 'canvas' ? 'active' : ''}">合成画布</button>
          <button data-view="reconstructed" class="${activeView === 'reconstructed' ? 'active' : ''}">解滤波原帧</button>
        </div>
      </div>
      <div>
        <div class="section-title">fcTL 控制参数（第 ${activeFrame + 1} 帧）</div>
        <table>
          <tr><th>sequence_number</th><td class="mono">${frame.sequenceNumber}</td></tr>
          <tr><th>帧区域</th><td class="mono">${frame.control.width} × ${frame.control.height} @ (${frame.control.xOffset}, ${frame.control.yOffset})</td></tr>
          <tr><th>延时</th><td class="mono">${frame.control.delayNumerator}/${frame.control.delayDenominator === 0 ? 100 : frame.control.delayDenominator} s （${frame.control.delaySeconds.toFixed(3)} s${frame.control.delayDenominator === 0 ? '，den=0 按 100 计' : ''}）</td></tr>
          <tr><th>dispose_op</th><td><span class="tag ${DISPOSE_TAG[frame.control.disposeOp]}">${frame.control.dispose}</span></td></tr>
          <tr><th>blend_op</th><td><span class="tag ${frame.control.blendOp === 1 ? 'over' : 'source'}">${frame.control.blend}</span></td></tr>
          <tr><th>图像数据块</th><td class="mono">${frame.dataKind} × ${frame.dataChunks}</td></tr>
        </table>

        <div class="section-title">解滤波像素摘要（仅该帧区域，合成前）</div>
        <table>
          <tr><th>字节数</th><td class="mono">${frame.reconstructed.bytes}</td></tr>
          <tr><th>SHA-256</th><td class="mono">${frame.reconstructed.sha256}</td></tr>
          <tr><th>非零 Alpha 像素</th><td class="mono">${frame.reconstructed.nonZeroAlphaPixels}</td></tr>
          <tr><th>Alpha 通道累加</th><td class="mono">${frame.reconstructed.alphaSum}</td></tr>
        </table>

        <div class="section-title">合成画布摘要（绘制后 / 处置前冻结快照）</div>
        <table>
          <tr><th>字节数</th><td class="mono">${frame.canvas.bytes}</td></tr>
          <tr><th>SHA-256</th><td class="mono">${frame.canvas.sha256}</td></tr>
          <tr><th>非零 Alpha 像素</th><td class="mono">${frame.canvas.nonZeroAlphaPixels}</td></tr>
          <tr><th>Alpha 通道累加</th><td class="mono">${frame.canvas.alphaSum}</td></tr>
        </table>
      </div>
    </div>
    <div class="section-title">像素逐帧轨迹（画布坐标）</div>
    <div class="trace-controls">
      <label>X <input id="trace-x" class="coord" type="number" min="0" max="${r.width - 1}" step="1" value="${esc(traceDraft.x)}" /></label>
      <label>Y <input id="trace-y" class="coord" type="number" min="0" max="${r.height - 1}" step="1" value="${esc(traceDraft.y)}" /></label>
      <button id="btn-trace">查看轨迹</button>
      <span class="trace-hint">或点击上方画布取点（解滤波原帧视图自动换算为画布坐标）</span>
    </div>
    <div id="trace-result"></div>
  `;

  // 画面只读取冻结快照
  const canvasEl = $('display');
  const metaEl = $('canvas-meta');
  if (activeView === 'canvas') {
    putPixels(canvasEl, r.width, r.height, frame.snapshot);
    metaEl.textContent = `合成画布冻结快照 ${r.width}×${r.height}（绘制后、处置前）`;
  } else {
    putPixels(canvasEl, frame.control.width, frame.control.height, frame.reconstructedPixels);
    metaEl.textContent = `第 ${activeFrame + 1} 帧解滤波原帧 ${frame.control.width}×${frame.control.height}`;
  }

  $('tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-frame]');
    if (!btn) return;
    activeFrame = Number(btn.dataset.frame);
    render(); // render 重建结果区，已显示的轨迹随之同步清除
  });
  resultEl.querySelectorAll('button[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeView = btn.dataset.view;
      render();
    });
  });

  // 点击画布取点：按当前视图换算为画布坐标后立即生成轨迹
  canvasEl.addEventListener('click', (e) => {
    const rect = canvasEl.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const px = Math.floor(((e.clientX - rect.left) / rect.width) * canvasEl.width);
    const py = Math.floor(((e.clientY - rect.top) / rect.height) * canvasEl.height);
    if (px < 0 || py < 0 || px >= canvasEl.width || py >= canvasEl.height) return;
    let cx = px;
    let cy = py;
    if (activeView === 'reconstructed') {
      cx += frame.control.xOffset;
      cy += frame.control.yOffset;
    }
    traceDraft = { x: String(cx), y: String(cy) };
    $('trace-x').value = traceDraft.x;
    $('trace-y').value = traceDraft.y;
    showTrace();
  });

  // 坐标输入：保留草稿（跨 render 回填），Enter 或按钮生成轨迹
  const txEl = $('trace-x');
  const tyEl = $('trace-y');
  txEl.addEventListener('input', () => { traceDraft.x = txEl.value; });
  tyEl.addEventListener('input', () => { traceDraft.y = tyEl.value; });
  const onEnter = (e) => { if (e.key === 'Enter') showTrace(); };
  txEl.addEventListener('keydown', onEnter);
  tyEl.addEventListener('keydown', onEnter);
  $('btn-trace').addEventListener('click', showTrace);
}

/* ------------------------------ 动作 ------------------------------ */

function updateCounter() {
  const len = srcEl.value.length;
  counterEl.textContent = `${len} / ${MAX_INPUT_BYTES} 字节`;
  counterEl.classList.toggle('over', len > MAX_INPUT_BYTES);
}

async function submitReview() {
  const text = srcEl.value;
  try {
    const result = await reviewBase64(text);
    currentResult = result; // 仅成功才覆盖旧结论
    activeFrame = 0;
    activeView = 'canvas';
    showBanner(
      'ok',
      `复核通过：${result.width}×${result.height}，共 ${result.numFrames} 帧；签名、CRC、acTL/fcTL/IDAT/fdAT 顺序与序号均有效。`,
    );
    render();
  } catch (e) {
    // 违约：保留输入文本，清除上一次成功证据
    currentResult = null;
    render();
    if (e && typeof e.offset === 'number') {
      showBanner(
        'error',
        `${esc(e.message)}\n<span class="offset">首个违约原始字节偏移：${e.offset}（0x${e.offset.toString(16).toUpperCase().padStart(4, '0')}）</span>`,
      );
    } else {
      showBanner('error', esc(e?.message || String(e)));
    }
  }
}

function clearAll() {
  srcEl.value = '';
  currentResult = null;
  activeFrame = 0;
  activeView = 'canvas';
  traceDraft = { x: '', y: '' };
  updateCounter();
  clearBanner();
  render();
}

srcEl.addEventListener('input', updateCounter);
$('btn-review').addEventListener('click', submitReview);
$('btn-clear').addEventListener('click', clearAll);
$('btn-sample').addEventListener('click', () => {
  srcEl.value = sampleBase64;
  updateCounter();
  submitReview();
});

srcEl.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') submitReview();
});

updateCounter();
render();

// 暴露给构建检查脚本做静态自检
if (typeof window !== 'undefined') {
  window.__apngReviewVersion = '1.0.0';
  void hex2;
}
