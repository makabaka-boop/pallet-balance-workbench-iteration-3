import { signedDistanceToEdge } from './geometry';
import type { CargoItem, Point, RobustEdgeInfo, RobustWitness } from './types';

/**
 * 鲁棒重量区间分析。
 *
 * 每件货物的实际重量 w_i ∈ [wmin_i, wmax_i]（均为正数），合成重心是重量的
 * 分式线性函数。对每条支撑边 e，重心到 e 的有符号距离可写成
 *
 *   d_e(w) = N_e(w) / D(w)，
 *   N_e(w) = Σ_i a_{e,i}·w_i + γ_e，
 *   D(w)   = Σ_i w_i，
 *
 * 其中 a、γ 只依赖于货物位置与边的几何；D(w) 恒正。
 *
 * 关键事实：d_e 在重量盒上是**分式线性**函数，分式线性函数在盒上的极值
 * 必在盒的角点取得。因此「对所有允许重量组合满足 d_e ≥ margin」等价于
 * 「对所有 2^n 个角点满足」——枚举角点即是完整证明，而非抽样。
 *
 * 件数较少（≤ EXACT_CORNER_LIMIT）时直接枚举全部角点（同时充当测试预言机）；
 * 件数较多时改用 Charnes–Cooper 线性化 + 两阶段单纯形求解同一分式线性规划，
 * 并以启发式角点扫描做数值交叉校验；任一处无法可靠裁决时返回
 * indeterminate，调用方不得放行。
 */

/** 不超过该件数时使用 2^n 全角点枚举（= 独立预言机） */
export const EXACT_CORNER_LIMIT = 12;

export interface WeightRange {
  min: number;
  max: number;
}

/** 取一件货物的允许重量区间；缺省/等宽区间退化为确定重量 */
export function itemRange(it: CargoItem): WeightRange {
  const lo = it.weightMin ?? it.weight;
  const hi = it.weightMax ?? it.weight;
  return { min: lo, max: hi };
}

/** 全部货物是否都是确定重量（无任何真实区间） */
export function allItemsExact(items: CargoItem[]): boolean {
  return items.every((it) => {
    const lo = it.weightMin ?? it.weight;
    const hi = it.weightMax ?? it.weight;
    return lo === hi && lo === it.weight;
  });
}

/** 一组重量下的加权重心与合计重量（按全局最大重量归一化，溢出时仍然可靠） */
export function centroidAtWeights(
  items: CargoItem[],
  weights: number[],
): { cog: Point; totalWeight: number | null; overflowed: boolean } {
  // 先尝试直接求和（常规量级路径，与标称计算保持同一舍入顺序）
  let sx = 0;
  let sy = 0;
  let sw = 0;
  for (let i = 0; i < items.length; i++) {
    sx += weights[i] * items[i].center.x;
    sy += weights[i] * items[i].center.y;
    sw += weights[i];
  }
  if (Number.isFinite(sx) && Number.isFinite(sy) && Number.isFinite(sw) && sw > 0) {
    return { cog: { x: sx / sw, y: sy / sw }, totalWeight: sw, overflowed: false };
  }

  // 极端重量兜底：按最大重量缩放，件数 ≤ 200 时归一化和恒有限
  const maxW = weights.reduce((m, w) => Math.max(m, w), 0);
  sx = 0;
  sy = 0;
  sw = 0;
  for (let i = 0; i < items.length; i++) {
    const w = weights[i] / maxW;
    sx += w * items[i].center.x;
    sy += w * items[i].center.y;
    sw += w;
  }
  const rescaled = sw * maxW;
  if (Number.isFinite(sx) && Number.isFinite(sy) && Number.isFinite(sw) && sw > 0) {
    return {
      cog: { x: sx / sw, y: sy / sw },
      totalWeight: Number.isFinite(rescaled) ? rescaled : null,
      overflowed: !Number.isFinite(rescaled),
    };
  }
  return { cog: { x: NaN, y: NaN }, totalWeight: null, overflowed: true };
}

/** 一条边的分式线性系数：N_e(w) = Σ a_i w_i + γ，分母 D(w) = Σ w_i */
interface EdgeForm {
  a: number[];
  gamma: number;
}

function edgeForm(polygon: Point[], edgeIndex: number, items: CargoItem[]): EdgeForm {
  const n = polygon.length;
  const av = polygon[edgeIndex];
  const bv = polygon[(edgeIndex + 1) % n];
  const dx = bv.x - av.x;
  const dy = bv.y - av.y;
  const len = Math.hypot(dx, dy);
  // 支撑边顶点在边上（自身叉积为 0），故常数项 γ = 0：
  // cross(a,b,cog)/length = Σ w_i·cross(a,b,p_i)/(len·Σw_i)
  const coef = items.map(
    (it) => (dx * (it.center.y - av.y) - dy * (it.center.x - av.x)) / len,
  );
  return { a: coef, gamma: 0 };
}

export interface EdgeVerdict {
  index: number;
  status: 'proven' | 'indeterminate';
  /** 该边在允许重量组合下的最坏有符号距离；无法裁决时为 null */
  worstDistance: number | null;
  /** 取得最坏值的重量向量（indeterminate 时为 null） */
  weights: number[] | null;
}

export interface RobustEdgeAnalysis {
  edges: EdgeVerdict[];
  /** 是否存在任一角点组合的合计重量溢出 double */
  anyCornerOverflow: boolean;
}

/**
 * 全角点枚举（2^n）。n ≤ EXACT_CORNER_LIMIT 时使用，本身即为严格证明。
 * 用全局最大重量归一化端点，保证 1e308 级重量求和也不溢出；分式比值不变。
 */
function enumerateCorners(
  form: EdgeForm,
  ranges: WeightRange[],
  scaleW: number,
): { ratio: number; weights: number[] } {
  const n = ranges.length;
  const lo = ranges.map((r) => r.min / scaleW);
  const span = ranges.map((r) => (r.max - r.min) / scaleW);
  const g0 = form.gamma / scaleW;

  let best = Infinity;
  let bestMask = 0;
  const total = 1 << n;
  for (let mask = 0; mask < total; mask++) {
    let nSum = g0;
    let d = 0;
    for (let i = 0; i < n; i++) {
      const w = lo[i] + ((mask >> i) & 1) * span[i];
      nSum += form.a[i] * w;
      d += w;
    }
    const ratio = nSum / d;
    // 平局保留较小 mask（确定性见证）
    if (ratio < best) {
      best = ratio;
      bestMask = mask;
    }
  }
  const weights = ranges.map(
    (r, i) => r.min + ((bestMask >> i) & 1) * (r.max - r.min),
  );
  return { ratio: best, weights };
}

/* -------------------------------------------------------------------------- */
/* Charnes–Cooper 线性化 + 两阶段单纯形（n 较大时）                            */
/*                                                                            */
/* 最小化 d(w) = (Σ a_i w_i + γ)/(Σ w_i)：令 t = 1/Σw、z_i = w_i·t，则        */
/* Σz = 1 且 z_i ∈ [l_i t, u_i t]。再平移 q_i = z_i - l_i t（q_i ≥ 0）：     */
/*   L·t + Σ q_i = 1,           L = Σ l_i                                     */
/*   q_i ≤ s_i·t,               s_i = u_i - l_i ≥ 0（s_i=0 时变量恒 0）      */
/* 目标 min Σ a_i q_i + (Σ a_i·l_i + γ)·t。                                   */
/* 平移形式对窄区间（如重量 100±0.001）条件数远优于直接盒约束。               */
/* -------------------------------------------------------------------------- */

interface SimplexResult {
  ok: boolean;
  /** 原变量解；不可行/无界/未收敛时为 null */
  x: number[] | null;
}

const LP_ITER_LIMIT = 200000;
/** 相对误差容限（双精度约 1e-16，取 1e-10 远宽于舍入噪声又远严于判定需求） */
const LP_EPS = 1e-10;

/**
 * 两阶段单纯形：最大化 c·x，约束 A x {≤,=} b，变量非负。
 * fixedZeroCols 中的列系数恒为 0（对应 s_i = 0 的 q_i），永不入基。
 */
function simplex(
  c: number[],
  A: number[][],
  b: number[],
  types: Array<'<' | '='>,
  fixedZeroCols: Set<number>,
): SimplexResult {
  const nVar = c.length;
  const m = b.length;
  const nSlack = types.filter((t) => t === '<').length;
  const nArt = m;
  const nCols = nVar + nSlack + nArt;
  const rhsCol = nCols;

  let slackCursor = 0;
  const rowSlackCol = types.map((t) => (t === '<' ? nVar + slackCursor++ : -1));
  const artCol = (row: number) => nVar + nSlack + row;

  const T: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(nCols + 1).fill(0),
  );
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < nVar; j++) T[i][j] = A[i][j];
    if (rowSlackCol[i] >= 0) T[i][rowSlackCol[i]] = 1;
    T[i][artCol(i)] = 1;
    T[i][rhsCol] = b[i];
  }
  for (let j = 0; j < nVar; j++) T[m][j] = c[j];

  const basis = new Array<number>(m);
  for (let i = 0; i < m; i++) basis[i] = rowSlackCol[i] >= 0 ? rowSlackCol[i] : artCol(i);

  /** 非人工列系数的绝对尺度，用于把转轴容差相对化 */
  const rowScale = (row: number[]): number => {
    let s = 1e-12;
    for (let j = 0; j < nVar + nSlack; j++) s = Math.max(s, Math.abs(row[j]));
    return s;
  };

  const canonicalizeObjective = (objRow: number[]) => {
    for (let i = 0; i < m; i++) {
      const cval = objRow[basis[i]];
      if (cval !== 0) {
        for (let j = 0; j <= nCols; j++) objRow[j] -= cval * T[i][j];
      }
    }
  };

  /** 单轮转轴（Bland 规则防循环）。null=已最优，false=数值异常/无界。 */
  const pivot = (): boolean | null => {
    const row = T[m];
    const tol = LP_EPS * rowScale(row);
    let enter = -1;
    // 两个阶段都允许松弛列入基；人工列（j ≥ nVar+nSlack）永不入基。
    const colLimit = nVar + nSlack;
    for (let j = 0; j < colLimit; j++) {
      if (fixedZeroCols.has(j)) continue;
      if (row[j] > tol) {
        enter = j;
        break;
      }
    }
    if (enter < 0) return null;

    let leave = -1;
    let bestRatio = Infinity;
    const rhsScale = Math.max(1e-12, ...T.slice(0, m).map((r) => Math.abs(r[rhsCol])));
    for (let i = 0; i < m; i++) {
      const aij = T[i][enter];
      if (aij > LP_EPS * Math.max(1, Math.abs(T[i][rhsCol]), Math.abs(aij))) {
        const ratio = T[i][rhsCol] / aij;
        if (ratio < -LP_EPS * rhsScale) return false;
        // 严格最小比，行号升序遍历即 Bland 平局规则
        if (ratio < bestRatio) {
          bestRatio = ratio;
          leave = i;
        }
      }
    }
    if (leave < 0) return false; // 无界（本问题中不应出现）

    const piv = T[leave][enter];
    for (let j = 0; j <= nCols; j++) T[leave][j] /= piv;
    for (let i = 0; i <= m; i++) {
      if (i === leave) continue;
      const factor = T[i][enter];
      if (factor !== 0) {
        for (let j = 0; j <= nCols; j++) T[i][j] -= factor * T[leave][j];
      }
    }
    basis[leave] = enter;
    return true;
  };

  /* ---- Phase 1：最小化人工变量之和 ---- */
  const phase1Row = new Array<number>(nCols + 1).fill(0);
  for (let i = 0; i < m; i++) {
    if (basis[i] === artCol(i)) {
      for (let j = 0; j <= nCols; j++) phase1Row[j] -= T[i][j];
    }
  }
  T[m] = phase1Row;

  let iter = 0;
  for (;;) {
    if (++iter > LP_ITER_LIMIT) return { ok: false, x: null };
    const r = pivot();
    if (r === null) break;
    if (r === false) return { ok: false, x: null };
  }
  const bScale = Math.max(1e-12, ...b.map(Math.abs));
  if (T[m][rhsCol] > 1e-8 * bScale) {
    return { ok: false, x: null }; // 不可行
  }

  // 把残留于基中的人工变量转出
  for (let i = 0; i < m; i++) {
    if (basis[i] >= nVar + nSlack) {
      let swap = -1;
      const rowTol = LP_EPS * rowScale(T[i]);
      for (let j = 0; j < nVar + nSlack; j++) {
        if (fixedZeroCols.has(j)) continue;
        if (Math.abs(T[i][j]) > rowTol) {
          swap = j;
          break;
        }
      }
      if (swap < 0) {
        if (Math.abs(T[i][rhsCol]) > 1e-8 * bScale) return { ok: false, x: null };
        continue; // 冗余零行
      }
      const piv = T[i][swap];
      for (let j = 0; j <= nCols; j++) T[i][j] /= piv;
      for (let k = 0; k <= m; k++) {
        if (k === i) continue;
        const factor = T[k][swap];
        if (factor !== 0) for (let j = 0; j <= nCols; j++) T[k][j] -= factor * T[i][j];
      }
      basis[i] = swap;
    }
  }

  /* ---- Phase 2：恢复真实目标（人工列不参与入基） ---- */
  const phase2Row = new Array<number>(nCols + 1).fill(0);
  for (let j = 0; j < nVar; j++) phase2Row[j] = c[j];
  T[m] = phase2Row;
  canonicalizeObjective(T[m]);

  for (;;) {
    if (++iter > LP_ITER_LIMIT) return { ok: false, x: null };
    const r = pivot();
    if (r === null) break;
    if (r === false) return { ok: false, x: null };
  }

  const x = new Array<number>(nVar).fill(0);
  for (let i = 0; i < m; i++) {
    if (basis[i] < nVar) x[basis[i]] = T[i][rhsCol];
  }
  for (let j = 0; j < nVar; j++) {
    if (x[j] < 0 && x[j] > -1e-8) x[j] = 0;
  }
  return { ok: true, x };
}

/**
 * 平移变量形式的 Charnes–Cooper LP，最小化边距离 d(w)。
 * 变量 x = [t, q_0..q_{n-1}]，w_i = l_i + q_i/t。
 */
function minimizeEdgeDistanceLP(
  form: EdgeForm,
  ranges: WeightRange[],
): { ok: boolean; ratio: number | null; weights: number[] | null } {
  const n = ranges.length;
  const lo = ranges.map((r) => r.min);
  const span = ranges.map((r) => r.max - r.min);
  const L = lo.reduce((s, v) => s + v, 0);
  const aL = form.a.reduce((s, ai, i) => s + ai * lo[i], 0) + form.gamma;

  const N = n + 1;
  // max -(Σ a_i q_i + aL·t)
  const c = new Array<number>(N).fill(0);
  c[0] = -aL;
  for (let i = 0; i < n; i++) c[1 + i] = -form.a[i];

  const A: number[][] = [];
  const b: number[] = [];
  const types: Array<'<' | '='> = [];
  // L·t + Σq = 1
  {
    const row = new Array<number>(N).fill(0);
    row[0] = L;
    for (let i = 0; i < n; i++) row[1 + i] = 1;
    A.push(row);
    b.push(1);
    types.push('=');
  }
  // t ≥ 0 是所有变量非负的一部分；再补 -t ≤ 0 的显式约束，
  // 给等式行之外提供一个以 t 为松弛基的 ≤ 行（同时强化初始基稳定性）。
  {
    const row = new Array<number>(N).fill(0);
    row[0] = -1;
    A.push(row);
    b.push(0);
    types.push('<');
  }
  // q_i ≤ s_i·t  →  q_i - s_i·t ≤ 0（s_i = 0 时系数全 0，列固定不入基）
  const fixedZeroCols = new Set<number>();
  for (let i = 0; i < n; i++) {
    if (span[i] === 0) fixedZeroCols.add(1 + i);
    const row = new Array<number>(N).fill(0);
    row[0] = -span[i];
    row[1 + i] = 1;
    A.push(row);
    b.push(0);
    types.push('<');
  }

  const sol = simplex(c, A, b, types, fixedZeroCols);
  if (!sol.ok || !sol.x) return { ok: false, ratio: null, weights: null };
  const t = sol.x[0];
  const q = sol.x.slice(1);
  if (!(t > 0) || !Number.isFinite(t)) {
    return { ok: false, ratio: null, weights: null };
  }
  const weights = lo.map((l, i) => l + q[i] / t);
  // 分式线性极值必在盒角点：LP 顶点解对应每个 q_i 位于 0 或上界。
  // 把数值噪声内的端点吸附为精确端点（容差远宽于 ~1e-13 的求解噪声），
  // 保证见证给出的“极端重量”全部是可直接复算的区间端点。
  const SNAP = 1e-8;
  for (let i = 0; i < n; i++) {
    const ref = Math.max(1, Math.abs(weights[i]), lo[i], ranges[i].max);
    if (Math.abs(weights[i] - lo[i]) <= SNAP * ref) weights[i] = lo[i];
    if (Math.abs(ranges[i].max - weights[i]) <= SNAP * ref) weights[i] = ranges[i].max;
    if (!(weights[i] >= ranges[i].min)) weights[i] = ranges[i].min;
    if (!(weights[i] <= ranges[i].max)) weights[i] = ranges[i].max;
  }
  let nSum = form.gamma;
  let d = 0;
  for (let i = 0; i < n; i++) {
    nSum += form.a[i] * weights[i];
    d += weights[i];
  }
  return { ok: true, ratio: nSum / d, weights };
}

/** 启发式角点扫描（大 n 交叉校验用）：全低、全高及按 a_i 排序的分层端点 */
function heuristicCorners(
  form: EdgeForm,
  ranges: WeightRange[],
): { ratio: number; weights: number[] } {
  const n = ranges.length;
  const candidates: number[][] = [
    ranges.map((r) => r.min),
    ranges.map((r) => r.max),
  ];
  // a_i 越小的货物取大重量，越能拉低加权比值
  const order = [...form.a.keys()].sort((i, j) => form.a[i] - form.a[j]);
  for (const frac of [0.125, 0.25, 0.5, 0.75, 0.875]) {
    const cut = Math.max(1, Math.floor(n * frac));
    const w = ranges.map((r) => r.min);
    for (let k = 0; k < cut; k++) w[order[k]] = ranges[order[k]].max;
    candidates.push(w);
  }
  let best = Infinity;
  let bestW = candidates[0];
  for (const w of candidates) {
    let nSum = form.gamma;
    let d = 0;
    for (let i = 0; i < n; i++) {
      nSum += form.a[i] * w[i];
      d += w[i];
    }
    const ratio = nSum / d;
    if (ratio < best) {
      best = ratio;
      bestW = w;
    }
  }
  return { ratio: best, weights: bestW };
}

/** 单条边的完整最坏距离分析（小 n 枚举；大 n LP + 启发式交叉校验） */
function analyzeEdge(
  index: number,
  form: EdgeForm,
  ranges: WeightRange[],
): EdgeVerdict {
  const n = ranges.length;
  const scaleW = Math.max(
    1,
    ...ranges.map((r) => Math.max(Math.abs(r.min), Math.abs(r.max))),
  );

  if (n <= EXACT_CORNER_LIMIT) {
    const { ratio, weights } = enumerateCorners(form, ranges, scaleW);
    return { index, status: 'proven', worstDistance: ratio, weights };
  }

  const lp = minimizeEdgeDistanceLP(form, ranges);
  const heuristic = heuristicCorners(form, ranges);

  if (!lp.ok || lp.ratio === null || !lp.weights) {
    return { index, status: 'indeterminate', worstDistance: null, weights: null };
  }

  // 交叉校验：任何可行角点给出的比值都不会低于真正的最坏值。
  // LP 结果若明显高于启发式角点（更差），说明 LP 数值不可信 → 不裁决。
  const tol = LP_EPS * 1000 * Math.max(1, Math.abs(heuristic.ratio), Math.abs(lp.ratio));
  if (lp.ratio > heuristic.ratio + tol) {
    return { index, status: 'indeterminate', worstDistance: null, weights: null };
  }
  // 保守起见取两者中真正更小的比值及其见证重量
  const useLp = lp.ratio <= heuristic.ratio + tol;
  return {
    index,
    status: 'proven',
    worstDistance: useLp ? lp.ratio! : heuristic.ratio,
    weights: useLp ? lp.weights! : heuristic.weights,
  };
}

/**
 * 对每条支撑边求允许重量组合下的最坏有符号距离。
 * 任一边无法可靠裁决 → 该边 indeterminate；调用方不得放行。
 * 同时检测是否存在角点组合的合计重量溢出 double：重量均为正，
 * Σw 对每个 w_i 单调，故最大总和就是“全部取上界”的角点，只需检查它。
 */
export function analyzeRobustEdges(
  polygon: Point[],
  items: CargoItem[],
  ranges: WeightRange[],
): RobustEdgeAnalysis {
  const edges: EdgeVerdict[] = polygon.map((_, e) =>
    analyzeEdge(e, edgeForm(polygon, e, items), ranges),
  );

  const scaleW = Math.max(1, ...ranges.map((r) => r.max));
  let normSum = 0;
  for (const r of ranges) normSum += r.max / scaleW;
  const anyCornerOverflow = !Number.isFinite(normSum * scaleW);

  return { edges, anyCornerOverflow };
}

/** 用见证重量向量构造可复算见证（重心、首先失守边、短缺量） */
export function buildWitness(
  polygon: Point[],
  items: CargoItem[],
  weights: number[],
  margin: number,
): RobustWitness {
  const { cog, totalWeight, overflowed } = centroidAtWeights(items, weights);
  const n = polygon.length;
  let critical: RobustEdgeInfo | null = null;
  for (let i = 0; i < n; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % n];
    const d = signedDistanceToEdge(cog, a, b);
    // 平局取边序最小（“首先失守的边”可复算且确定）
    if (critical === null || d < critical.signedDistance) {
      critical = { index: i, a, b, signedDistance: d };
    }
  }
  const first = critical!;
  return {
    weights,
    cog,
    totalWeight,
    totalWeightOverflowed: overflowed,
    criticalEdge: first,
    minDistance: first.signedDistance,
    shortfall: margin - first.signedDistance,
  };
}
