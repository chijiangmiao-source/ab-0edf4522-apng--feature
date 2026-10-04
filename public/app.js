// 复核台前端：所有解析/合成逻辑均来自共享引擎 ../src/apng.js
import { reviewBase64, pixelTrace, MAX_INPUT_BYTES, MAX_DIMENSION, MAX_FRAMES } from '../src/apng.js';
import { sampleBase64 } from './sample.js';

const $ = (id) => document.getElementById(id);
const srcEl = $('src');
const counterEl = $('counter');
const bannerEl = $('banner');
const resultEl = $('result');

let currentResult = null; // 仅保存最近一次成功复核结论
let activeFrame = 0;
let activeView = 'canvas'; // 'canvas' | 'reconstructed'
let traceCoord = null; // 当前像素轨迹坐标 {x,y}，仅在有效结论内存在；随结论/切帧同步清除
let traceNote = ''; // 轨迹坐标校验提示（不保留任何旧轨迹数据）

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

/* ------------------------------ 像素轨迹 ------------------------------ */

const DISPOSE_SHORT = ['none', 'background', 'previous'];

function pxCell(p) {
  if (!p) return '<span class="muted">—</span>';
  const sw = `background:rgba(${p.r},${p.g},${p.b},${(p.a / 255).toFixed(3)});`;
  return `<span class="px"><span class="swatch" style="${sw}"></span><span class="mono">${p.r}, ${p.g}, ${p.b}, ${p.a}</span></span>`;
}

function samePx(p, q) {
  return Boolean(p && q) && p.r === q.r && p.g === q.g && p.b === q.b && p.a === q.a;
}

// 仅根据“当前结论 + traceCoord”重绘轨迹区；任何无效状态都只显示提示，不留旧轨迹
function renderTrace() {
  const panel = $('trace');
  if (!panel) return;
  const xInput = $('trace-x');
  const yInput = $('trace-y');
  const noteEl = $('trace-note');
  const bodyEl = $('trace-body');

  if (traceCoord) {
    xInput.value = traceCoord.x;
    yInput.value = traceCoord.y;
  } else {
    xInput.value = '';
    yInput.value = '';
  }

  if (!currentResult) {
    panel.style.display = 'none';
    return;
  }
  panel.style.display = '';

  if (!traceCoord) {
    noteEl.className = 'trace-note';
    noteEl.textContent = traceNote ||
      `输入坐标（0..${currentResult.width - 1}, 0..${currentResult.height - 1}）或点击上方合成画布选择像素，追查其逐帧来源。`;
    bodyEl.innerHTML =
      '<div class="empty">尚未选择像素。坐标超出画布或复核结论失效时不会保留任何旧轨迹。</div>';
    return;
  }

  const trace = pixelTrace(currentResult, traceCoord.x, traceCoord.y);
  if (!trace) {
    // 越界保护：不生成旧轨迹
    noteEl.className = 'trace-note error';
    noteEl.textContent = `坐标 (${traceCoord.x}, ${traceCoord.y}) 超出画布 ${currentResult.width}×${currentResult.height}，已清除轨迹。`;
    bodyEl.innerHTML = '<div class="empty">无有效轨迹。</div>';
    return;
  }

  noteEl.className = 'trace-note ok';
  noteEl.textContent = `画布坐标 (${trace.x}, ${trace.y}) 的逐帧轨迹（画布 ${trace.width}×${trace.height}）。`;

  const rows = trace.frames.map((e) => {
    const inRegion = e.inRegion
      ? '<span class="tag over">在帧区域内</span>'
      : '<span class="tag background">像素不在该帧区域内</span>';
    const region = `(${e.region.x}, ${e.region.y}) ${e.region.width}×${e.region.height}`;
    const sourceCell = e.sourcePixel
      ? pxCell(e.sourcePixel)
      : '<span class="muted">— 不在区域，本帧不写入该像素</span>';
    const blendTag = e.blendOp === 1 ? '<span class="tag over">over</span>' : '<span class="tag source">source</span>';
    let paintMark = '';
    if (!e.inRegion) {
      paintMark = '<div class="hint">区域外：冻结值=绘制前值（画布保留）</div>';
    } else if (!samePx(e.beforePaint, e.frozen)) {
      paintMark = '<div class="hint changed">该帧写入后与绘制前不同</div>';
    } else {
      paintMark = '<div class="hint">写入后与绘制前相同</div>';
    }
    const isLast = e.frame === trace.frames.length;
    let disposeMark = '';
    if (!samePx(e.frozen, e.afterDispose)) {
      disposeMark = `<div class="hint restored">处置已改回（${DISPOSE_SHORT[e.disposeOp]}）</div>`;
    }
    const nextLabel = isLast ? '<span class="muted">末帧处置后（不再显示）</span>' : `下一帧（帧 ${e.frame + 1}）起始`;
    return `
      <tr>
        <td class="mono">帧 ${e.frame}<div class="hint">fcTL seq ${e.sequenceNumber}</div></td>
        <td class="mono">${region}<div class="row-tags">${inRegion}</div></td>
        <td>${pxCell(e.beforePaint)}</td>
        <td>${sourceCell}</td>
        <td>${blendTag}<div class="cell-px">${pxCell(e.frozen)}</div>${paintMark}</td>
        <td><span class="tag ${DISPOSE_SHORT[e.disposeOp]}">${DISPOSE_SHORT[e.disposeOp]}</span><div class="cell-px">${pxCell(e.afterDispose)}</div>${nextLabel}${disposeMark}</td>
      </tr>`;
  }).join('');

  bodyEl.innerHTML = `
    <div class="trace-scroll">
      <table class="trace-table">
        <thead>
          <tr>
            <th>帧号</th><th>帧区域</th><th>绘制前画布 RGBA</th><th>解滤波原像素 RGBA</th>
            <th>冻结画面 RGBA（绘制后/处置前）</th><th>处置后 → 下一帧起始 RGBA</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function applyTraceCoord(x, y) {
  if (!currentResult) {
    traceCoord = null;
    traceNote = '尚无有效复核结果，不能生成像素轨迹。';
    render();
    return;
  }
  if (x === '' || x === null || x === undefined || y === '' || y === null || y === undefined) {
    traceCoord = null;
    traceNote = '请先输入 X、Y 坐标（整数），或点击上方合成画布选择像素。';
    render();
    return;
  }
  const nx = Number(x);
  const ny = Number(y);
  if (!Number.isInteger(nx) || !Number.isInteger(ny) ||
      nx < 0 || ny < 0 || nx >= currentResult.width || ny >= currentResult.height) {
    traceCoord = null; // 越界 / 非法：绝不保留旧轨迹
    traceNote = `坐标无效或超出画布：需要 0..${currentResult.width - 1} 与 0..${currentResult.height - 1} 之间的整数，实际为 (${String(x).trim()}, ${String(y).trim()})。`;
    render();
    return;
  }
  traceCoord = { x: nx, y: ny };
  traceNote = '';
  render();
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
    <div class="trace-panel" id="trace" style="display:none">
      <div class="section-title">像素逐帧轨迹（绘制前 → 解滤波原帧 → source/over 冻结 → 处置恢复）</div>
      <div class="row trace-inputs">
        <label>X <input type="number" id="trace-x" min="0" max="${r.width - 1}" step="1" inputmode="numeric" /></label>
        <label>Y <input type="number" id="trace-y" min="0" max="${r.height - 1}" step="1" inputmode="numeric" /></label>
        <button class="primary" id="btn-trace">追查该像素</button>
        <span class="counter">画布坐标范围 0..${r.width - 1} × 0..${r.height - 1}；也可直接点击上方“合成画布”</span>
      </div>
      <div class="trace-note" id="trace-note"></div>
      <div id="trace-body"></div>
    </div>
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
  if (traceCoord) {
    metaEl.textContent += `；轨迹像素 (${traceCoord.x}, ${traceCoord.y})`;
  }

  // 点击合成画布：把显示坐标换算回画布像素并追查；解滤波原帧尺寸/偏移不同，不参与选择
  canvasEl.classList.toggle('clickable', activeView === 'canvas');
  canvasEl.addEventListener('click', (e) => {
    if (activeView !== 'canvas') return;
    const rect = canvasEl.getBoundingClientRect();
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * r.width);
    const y = Math.floor(((e.clientY - rect.top) / rect.height) * r.height);
    applyTraceCoord(x, y);
  });

  $('tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-frame]');
    if (!btn) return;
    activeFrame = Number(btn.dataset.frame);
    // 轨迹必须与当前结论同步：切帧后清除，避免跨帧/跨视图残留旧结论观感
    traceCoord = null;
    traceNote = '';
    render();
  });
  resultEl.querySelectorAll('button[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeView = btn.dataset.view;
      render(); // 轨迹独立于画面切换，继续保留
    });
  });

  // 轨迹面板事件与内容（只依赖 currentResult/traceCoord）
  $('btn-trace').addEventListener('click', () => {
    applyTraceCoord($('trace-x').value, $('trace-y').value);
  });
  for (const id of ['trace-x', 'trace-y']) {
    $(id).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') applyTraceCoord($('trace-x').value, $('trace-y').value);
    });
  }
  renderTrace();
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
    traceCoord = null; // 新结论：旧轨迹必须随旧结论清除
    traceNote = '';
    showBanner(
      'ok',
      `复核通过：${result.width}×${result.height}，共 ${result.numFrames} 帧；签名、CRC、acTL/fcTL/IDAT/fdAT 顺序与序号均有效。`,
    );
    render();
  } catch (e) {
    // 违约：保留输入文本，清除上一次成功证据及其像素轨迹
    currentResult = null;
    traceCoord = null;
    traceNote = '';
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
  traceCoord = null;
  traceNote = '';
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
