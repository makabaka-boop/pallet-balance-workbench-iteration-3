import { analyzeStability } from './geometry';
import { buildWitness } from './robust';
import { COORD_BOUND } from './parse';
import type {
  CargoItem,
  MovementPreview,
  MovementWitness,
  Point,
  StabilityResult,
  Workspace,
} from './types';

/**
 * 单件货物直线移动的连续路径预演。
 *
 * 固定一个允许重量角点 w（每件货的重量均取区间端点），移动第 k 件货物：
 *
 *   p_k(t) = p_k(0) + t·(p_k(1)-p_k(0)),  t ∈ [0,1]
 *
 * 因重量不随位置改变，该角点的总重量为常数，合成重心为 t 的仿射函数；
 * 再经支撑边叉积除以固定边长，某一角点对某一条边的有符号距离也是 t 的仿射函数。
 *
 * 路径上的鲁棒最坏距离为
 *
 *   q(t) = min_{边 e} min_{重量角点 c} d_{e,c}(t)
 *
 * 即一族仿射函数的逐点最小值，因此 q(t) 在 [0,1] 上是凹函数。于是：
 * - 只要 q(0)、q(t₁) 均 ≥ margin，两点之间的整条线段都 ≥ margin
 *   （凹函数位于弦之上，而弦仍在阈值之上）；
 * - 从已放行的 q(0) ≥ margin 出发，若 q(1) < margin，凹函数的斜率单调不增，
 *   失守只会出现一个连续后段；二分得到的每个“安全端/失守端”分别证明一个
 *   安全前缀和失守后段，而不是按少量采样点侥幸放行。
 *
 * 少件货物的端点证明来自 2^n 全角点枚举；多件货物由既有分式线性规划证明。
 * 任一点出现数值无法裁决或不可审核量，整个预演只返回暂缓。
 */

const BOUNDARY_WIDTH = 0.0001;

export interface MovementTargetInput {
  x: number;
  y: number;
}

export interface MovementPreviewState {
  preview: MovementPreview;
  /** 预演、俯视图、数值面板共同使用的结果（移动结论附加在同一份结果上） */
  displayResult: StabilityResult;
}

/** 校验目标中心；非法目标不触碰工作区、表单和既有放行结论 */
export function validateMoveTarget(
  ws: Workspace,
  itemId: string,
  target: MovementTargetInput,
): string[] {
  const errors: string[] = [];
  if (!ws.items.some((it) => it.id === itemId)) {
    errors.push(`未找到货物 "${itemId}"`);
  }
  if (!Number.isFinite(target.x) || Math.abs(target.x) > COORD_BOUND) {
    errors.push(`目标中心 X 必须是绝对值不超过 ${COORD_BOUND} 的有限数`);
  }
  if (!Number.isFinite(target.y) || Math.abs(target.y) > COORD_BOUND) {
    errors.push(`目标中心 Y 必须是绝对值不超过 ${COORD_BOUND} 的有限数`);
  }
  return errors;
}

function workspaceAt(
  ws: Workspace,
  itemIndex: number,
  target: Point,
  ratio: number,
): Workspace {
  const original = ws.items[itemIndex];
  const movedCenter = {
    x: original.center.x + ratio * (target.x - original.center.x),
    y: original.center.y + ratio * (target.y - original.center.y),
  };
  const items = ws.items.map((it, i): CargoItem =>
    i === itemIndex ? { ...it, center: movedCenter } : it,
  );
  return { ...ws, items };
}

type PointVerdict = 'pass' | 'fail' | 'unknown';

/**
 * 单个路径点的裁决。
 * releasable 已经同时要求标称通过、鲁棒通过和无不可审核量；
 * 若存在无法裁决/溢出/低于可靠表达条件的告警，即使另有失守见证也只能暂缓。
 */
function classify(result: StabilityResult): PointVerdict {
  if (result.releasable) return 'pass';
  if (result.robust.status === 'robust-fail' || !result.stable) return 'fail';
  return 'unknown';
}

function resultWitness(
  result: StabilityResult,
  ratio: number,
): MovementWitness {
  if (result.robust.witness) {
    return { ...result.robust.witness, ratio };
  }
  // 标称失守而鲁棒分析未给出见证的兜底：标称重量本身也是各重量区间端点。
  const weights = result.items.map((it) => it.weight);
  return { ...buildWitness(result.polygon, result.items, weights, result.margin), ratio };
}

function attachPreview(
  result: StabilityResult,
  preview: MovementPreview,
): StabilityResult {
  return { ...result, movement: preview };
}

/**
 * 对一件已通过校验的货物执行移动预演。
 * 调用方必须先用 validateMoveTarget 拦截非法目标。
 */
export function previewMovement(
  ws: Workspace,
  itemId: string,
  target: Point,
): MovementPreviewState {
  const itemIndex = ws.items.findIndex((it) => it.id === itemId);
  const from = { ...ws.items[itemIndex].center };
  const analyze = (ratio: number) =>
    analyzeStability(workspaceAt(ws, itemIndex, target, ratio));

  const startResult = analyze(0);
  const targetResult = analyze(1);

  const makePreview = (fields: Omit<MovementPreview, 'itemId' | 'from' | 'target' | 'startResult' | 'targetResult'>): MovementPreview => ({
    itemId,
    from,
    target: { ...target },
    startResult,
    targetResult,
    ...fields,
  });

  const startVerdict = classify(startResult);
  if (startVerdict === 'fail') {
    const witness = resultWitness(startResult, 0);
    const preview = makePreview({
      status: 'start-fail',
      safeRatio: null,
      unsafeRatio: null,
      boundaryWidth: null,
      witness,
      reason: '原中心位置已经不满足放行条件，不能开始移动。',
    });
    return { preview, displayResult: attachPreview(startResult, preview) };
  }

  if (startVerdict === 'unknown') {
    const preview = makePreview({
      status: 'indeterminate',
      safeRatio: null,
      unsafeRatio: null,
      boundaryWidth: null,
      witness: null,
      reason: '原中心位置存在无法可靠裁决或不可审核的量，移动预演暂缓。',
    });
    return { preview, displayResult: attachPreview(startResult, preview) };
  }

  const targetVerdict = classify(targetResult);
  if (targetVerdict === 'pass') {
    // 端点均通过 + q 的凹性：[0,1] 全程通过，完全不需要离散采样。
    const preview = makePreview({
      status: 'all-safe',
      safeRatio: 1,
      unsafeRatio: null,
      boundaryWidth: null,
      witness: null,
      reason: null,
    });
    return { preview, displayResult: attachPreview(targetResult, preview) };
  }

  if (targetVerdict === 'unknown') {
    const preview = makePreview({
      status: 'indeterminate',
      safeRatio: null,
      unsafeRatio: null,
      boundaryWidth: null,
      witness: null,
      reason: '目标位置的标称/鲁棒稳定性存在无法可靠裁决或不可审核的量，移动预演暂缓。',
    });
    return { preview, displayResult: attachPreview(targetResult, preview) };
  }

  // 起点可放行、目标已失守：利用凹性二分首个失守后段。
  let safeRatio = 0;
  let unsafeRatio = 1;
  let unsafeResult = targetResult;

  while (unsafeRatio - safeRatio > BOUNDARY_WIDTH) {
    const mid = safeRatio + (unsafeRatio - safeRatio) / 2;
    const midResult = analyze(mid);
    const verdict = classify(midResult);
    if (verdict === 'unknown') {
      const preview = makePreview({
        status: 'indeterminate',
        safeRatio: null,
        unsafeRatio: null,
        boundaryWidth: null,
        witness: null,
        reason: `路径比例 t=${mid} 处存在无法可靠裁决或不可审核的量，不能用相邻点推断放行。`,
      });
      return { preview, displayResult: attachPreview(midResult, preview) };
    }
    if (verdict === 'pass') {
      // [0, mid] 由两个已证安全端点和凹性证明安全。
      safeRatio = mid;
    } else {
      // mid 失守；在起点安全的凹路径上，[mid,1] 为已证失守后段。
      unsafeRatio = mid;
      unsafeResult = midResult;
    }
  }

  const witness = resultWitness(unsafeResult, unsafeRatio);
  const preview = makePreview({
    status: 'fails-after-start',
    safeRatio,
    unsafeRatio,
    boundaryWidth: unsafeRatio - safeRatio,
    witness,
    reason: null,
  });
  return { preview, displayResult: attachPreview(unsafeResult, preview) };
}

/** 全程安全后，返回目标位置对应的新工作区；其余状态不得调用 */
export function applyMoveTarget(
  ws: Workspace,
  itemId: string,
  target: Point,
): Workspace {
  const itemIndex = ws.items.findIndex((it) => it.id === itemId);
  return workspaceAt(ws, itemIndex, target, 1);
}
