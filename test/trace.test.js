// 像素逐帧轨迹（pixelTrajectory）测试：
// 追查画布坐标在每一帧的来源——绘制前画布值、解滤波原像素、source/over 冻结画面值、
// none/background/previous 处置后的下一帧起始值，以及“不在该帧区域内”的标记。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewApng, reviewBase64, pixelTrajectory, APNGError } from '../src/apng.js';
import { buildApng } from './fixtures/apng-builder.js';
import { sampleBase64 } from '../public/sample.js';

const RED = [255, 40, 40, 128];
const GREEN = [40, 255, 60, 160];
const TRANSPARENT = [0, 0, 0, 0];

// 与内置示例同构：帧1 全画布红半透明 over/none；
// 帧2 子区域 5x5@(2,2) 绿半透明 over/previous；帧3 全画布透明 over/none
function sampleLike() {
  return buildApng(8, 8, [
    { painter: () => RED, blend: 1, dispose: 0 },
    { w: 5, h: 5, x: 2, y: 2, painter: () => GREEN, blend: 1, dispose: 2 },
    { painter: () => TRANSPARENT, blend: 1, dispose: 0 },
  ]);
}

test('轨迹按帧给出绘制前 / 解滤波原像素 / 混合后 / 处置后起始值', async () => {
  const r = await reviewApng(sampleLike());
  const t = pixelTrajectory(r, 4, 4); // (4,4) 在帧2 子区域内
  assert.equal(t.length, 3);

  // 帧1：透明底 → over 红 → none 保留到下一帧
  assert.deepEqual(t[0].before, TRANSPARENT);
  assert.deepEqual(t[0].sourcePixel, RED);
  assert.deepEqual(t[0].blended, RED);
  assert.equal(t[0].blendOp, 1);
  assert.equal(t[0].disposeOp, 0);
  assert.deepEqual(t[0].nextStart, RED, 'none 处置后下一帧起始应保留混合结果');

  // 帧2：绘制前 = 帧1 结果；over 绿后混合值必须不同于绘制前
  assert.deepEqual(t[1].before, RED);
  assert.deepEqual(t[1].sourcePixel, GREEN);
  assert.notDeepEqual(t[1].blended, t[1].before, '半透明 over 混合后必须不同于绘制前');
  assert.equal(t[1].disposeOp, 2);
  // previous 处置：下一帧起始恢复为该帧绘制前（即帧1 留下的红色背景）
  assert.deepEqual(t[1].nextStart, RED, 'previous 处置后应恢复绘制前快照');

  // 帧3：起始值已恢复为 previous 前的背景；透明 over 不改变画布
  assert.deepEqual(t[2].before, RED, '第三帧开始值应恢复为 previous 前的背景');
  assert.deepEqual(t[2].sourcePixel, TRANSPARENT);
  assert.deepEqual(t[2].blended, RED);
  assert.deepEqual(t[2].nextStart, RED);
});

test('像素不在该帧区域内时明确标记，且画布值不被该帧触碰', async () => {
  const r = await reviewApng(sampleLike());
  const t = pixelTrajectory(r, 0, 0); // (0,0) 不在帧2 的 5x5@(2,2) 区域内
  assert.equal(t[0].inRegion, true);
  assert.equal(t[1].inRegion, false);
  assert.equal(t[1].sourcePixel, null, '不在区域内时无解滤波原像素');
  assert.deepEqual(t[1].before, RED);
  assert.deepEqual(t[1].blended, RED, '区域外像素混合后应保持绘制前值');
  assert.deepEqual(t[1].nextStart, RED);
  assert.equal(t[2].inRegion, true);
});

test('background 处置：下一帧起始值在帧区域恢复全透明', async () => {
  const r = await reviewApng(
    buildApng(4, 4, [
      { painter: () => RED, blend: 0, dispose: 1 },
      { painter: () => TRANSPARENT, blend: 1, dispose: 0 },
    ]),
  );
  const t = pixelTrajectory(r, 1, 1);
  assert.deepEqual(t[0].blended, RED, 'source 混合直接覆盖');
  assert.deepEqual(t[0].nextStart, TRANSPARENT, 'background 处置后帧区域恢复全透明');
  assert.deepEqual(t[1].before, TRANSPARENT, '下一帧绘制前应看到透明背景');
});

test('source 混合：冻结画面值等于解滤波原像素（含 alpha 覆盖）', async () => {
  const r = await reviewApng(
    buildApng(2, 2, [
      { painter: () => RED, blend: 1, dispose: 0 },
      { painter: () => GREEN, blend: 0, dispose: 0 },
    ]),
  );
  const t = pixelTrajectory(r, 0, 0);
  assert.deepEqual(t[1].before, RED);
  assert.deepEqual(t[1].blended, GREEN, 'source 必须连同 alpha 直接覆盖');
  assert.deepEqual(t[1].blended, t[1].sourcePixel);
});

test('末帧 dispose=previous 时，轨迹末行给出处置完成后的画布起始值', async () => {
  const r = await reviewApng(
    buildApng(2, 2, [
      { painter: () => RED, blend: 1, dispose: 0 },
      { painter: () => GREEN, blend: 1, dispose: 2 },
    ]),
  );
  const t = pixelTrajectory(r, 0, 0);
  assert.notDeepEqual(t[1].blended, t[1].before);
  assert.deepEqual(t[1].nextStart, t[1].before, '末帧 previous 后应恢复为该帧绘制前状态');
  assert.deepEqual(t[1].nextStart, RED);
});

test('坐标超出画布或非法时抛出 APNGError，不生成轨迹', async () => {
  const r = await reviewApng(sampleLike());
  for (const [x, y] of [[-1, 0], [0, -1], [8, 0], [0, 8], [100, 100], [1.5, 1], [NaN, 0]]) {
    assert.throws(() => pixelTrajectory(r, x, y), APNGError, `坐标 (${x}, ${y}) 应被拒绝`);
  }
  assert.throws(() => pixelTrajectory(null, 0, 0), APNGError);
  assert.throws(() => pixelTrajectory({ frames: [] }, 0, 0), APNGError);
});

test('内置三帧示例（半透明 over + previous）：轨迹证据符合验收预期', async () => {
  const r = await reviewBase64(sampleBase64);
  const t = pixelTrajectory(r, 4, 4);
  // 第二帧混合后的值不同于绘制前值
  assert.notDeepEqual(t[1].blended, t[1].before);
  // 第三帧开始值恢复为 previous 前的背景（即帧1 混合结果）
  assert.deepEqual(t[2].before, t[0].blended);
  assert.deepEqual(t[2].before, t[1].nextStart);
  // 区域外像素 (0,0)：第二帧标记为不在区域内
  const outside = pixelTrajectory(r, 0, 0);
  assert.equal(outside[1].inRegion, false);
  assert.equal(outside[1].sourcePixel, null);
});

test('轨迹只读冻结数据：外部修改轨迹结果不影响再次查询', async () => {
  const r = await reviewApng(sampleLike());
  const t1 = pixelTrajectory(r, 4, 4);
  t1[0].blended[0] = 7;
  t1[1].before.fill(9);
  const t2 = pixelTrajectory(r, 4, 4);
  assert.deepEqual(t2[0].blended, RED);
  assert.deepEqual(t2[1].before, RED);
});
