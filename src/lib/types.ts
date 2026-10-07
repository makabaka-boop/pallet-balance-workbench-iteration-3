/** 共享类型定义 */

export interface Point {
  x: number;
  y: number;
}

/**
 * 单件货物。
 * weight 为登记的标称重量；weightMin / weightMax 为可选的称重不确定区间
 * （均为正数且 weightMin <= weight <= weightMax）。
 * 省略 weightMin/weightMax 时视为确定重量（下界=上界=weight），保持旧 JSON 兼容。
 */
export interface CargoItem {
  id: string;
  weight: number;
  /** 可选正重量下界；缺省等于 weight */
  weightMin?: number;
  /** 可选正重量上界；缺省等于 weight */
  weightMax?: number;
  center: Point;
}

/** 已通过校验、可用于计算的工作区数据 */
export interface Workspace {
  /** 严格凸、逆时针排列的支撑多边形 */
  polygon: Point[];
  /** 1..200 件货物，id 唯一 */
  items: CargoItem[];
  /** 安全余量（非负） */
  margin: number;
}

/** 支撑多边形的一条边及其到某点的有符号距离 */
export interface EdgeInfo {
  index: number;
  a: Point;
  b: Point;
  /** 有符号距离：逆时针多边形内部为正 */
  signedDistance: number;
}

/** 无法可靠表达、必须显式反馈的量 */
export type WarningCode =
  | 'total-weight-overflow'
  | 'margin-below-resolution'
  | 'robust-corner-overflow'
  | 'robust-indeterminate';

export interface StabilityWarning {
  code: WarningCode;
  /** 面板/图形上直接展示的中文说明 */
  message: string;
}

/** 鲁棒分析失败/见证时的首先失守边（取自同一分析结果） */
export interface RobustEdgeInfo {
  index: number;
  a: Point;
  b: Point;
  /** 见证组合下该边的有符号距离（未舍入） */
  signedDistance: number;
}

/** 一组可独立复算的极端重量见证 */
export interface RobustWitness {
  /**
   * 极端重量向量，与 items 同序；若该角点组合的合计重量超出 double
   * 可表达范围，此处仍给出标称区间端点（角点）本身，可经归一化复算重心。
   */
  weights: number[];
  /** 该重量组合下的合成重心（经最大重量缩放计算，合计重量溢出时仍然可靠） */
  cog: Point;
  /** 该组合的合计重量；溢出时为 null（缺失，不可审核） */
  totalWeight: number | null;
  /** 合计重量是否已溢出 double 可表达范围 */
  totalWeightOverflowed: boolean;
  /** 首先失守的支撑边（边序最小者） */
  criticalEdge: RobustEdgeInfo;
  /** 见证组合的最小有符号距离（= criticalEdge.signedDistance） */
  minDistance: number;
  /** 相对 margin 的短缺量 margin - minDistance */
  shortfall: number;
}

/**
 * 鲁棒放行结论状态：
 * - robust-pass：每条支撑边对所有允许重量组合均满足 margin（经全部角点证明）
 * - robust-fail：存在允许组合失守，witness 给出可复算的极端重量与首先失守边
 * - indeterminate：数值上无法可靠裁决（区间分析溢出/求解未收敛），不得显示可放行
 */
export type RobustStatus = 'robust-pass' | 'robust-fail' | 'indeterminate';

/** 鲁棒重量区间分析结果（与标称结论同属一个 StabilityResult） */
export interface RobustResult {
  status: RobustStatus;
  /** 全部货物均为确定重量（无任何区间）时为 true，鲁棒结论应与标称数值一致 */
  allExact: boolean;
  /** 参与分析的重量区间，与 items 同序 */
  ranges: Array<{ min: number; max: number }>;
  /**
   * 各支撑边在允许重量组合下的最坏有符号距离（未舍入）。
   * status === 'indeterminate' 时该数组可能不存在或不完整，
   * 任何消费方都不得据此放行。
   */
  edgeWorst?: Array<{ index: number; worstDistance: number }>;
  /** 最坏情况下的最小有符号距离（indeterminate 时为 null） */
  worstMinDistance: number | null;
  /** robust-fail 时的可复算见证；其余状态为 null */
  witness: RobustWitness | null;
  /** 放行所需 margin，随结果携带以便图、文、面板共用 */
  margin: number;
}

/** 稳定性计算结果（图形与数值共用同一份） */
export interface StabilityResult {
  /** 本次计算使用的支撑多边形 */
  polygon: Point[];
  /** 参与本次计算的货物（已通过校验） */
  items: CargoItem[];
  cog: Point;
  /**
   * 合计重量。两件合法大重量之和超出 double 可表达范围时为 null——
   * 未知合计量不得伪装成可审核的正常载荷。
   */
  totalWeight: number | null;
  edges: EdgeInfo[];
  /** 重心到各支撑边的最小有符号距离（未舍入） */
  minDistance: number;
  /** 取得最小距离的边 */
  criticalEdge: EdgeInfo;
  /**
   * margin 内缩后的安全区域（半平面裁剪结果）。
   * margin 大于内切余量时塌缩为空；
   * margin 小到低于当前坐标尺度的浮点分辨极限时同样为空，
   * 由 warnings 显式说明，绝不回贴到原支撑边冒充已内缩。
   */
  safeRegion: Point[];
  /**
   * 原始未舍入数值判定（标称重量）：minDistance >= margin。
   * margin=0 时恰在边上仍算稳定（保持兼容）。
   */
  stable: boolean;
  /**
   * 放行结论：标称稳定、鲁棒对所有允许重量组合证明通过，
   * 且不存在任何“无法可靠表达”的量时才为 true。
   * stable 为 true 但 releasable 为 false 表示计算上稳定、
   * 但鲁棒失守或存在不可审核的量，禁止据此放行。
   */
  releasable: boolean;
  /** 无法可靠表达的量的显式反馈 */
  warnings: StabilityWarning[];
  margin: number;
  /** 不稳定时相对 margin 的短缺量，稳定时为 0 */
  shortfall: number;
  /**
   * 鲁棒放行分析（全部重量角点组合的证明 / 失败见证 / 无法裁决）。
   * 与标称结论同源，类型、导入、表单、数值面板和 SVG 共同消费。
   */
  robust: RobustResult;
}

/** 表单解析结果 */
export type FormResult =
  | { ok: true; workspace: Workspace }
  | { ok: false; errors: string[] };

/* -------------------------------------------------------------------------- */
/* 单件货物「移动预演」                                                         */
/* -------------------------------------------------------------------------- */

/** 预演放行结论 */
export type RehearsalStatus = 'rehearsal-pass' | 'rehearsal-fail' | 'rehearsal-indeterminate';

/**
 * 首次失守点的可复算见证。
 * 全部量均取自同一个失效点 s=breachRatio：该比例处的移动后货物位置、
 * 使该点鲁棒最坏距离取得最小值的角点极端重量向量、对应合成重心与首先失守边。
 */
export interface RehearsalWitness {
  /** 首次失守比例（失效路径段左端点） */
  ratio: number;
  /** 被移动货物在该比例处的中心 = 原中心 + ratio·(目标中心−原中心) */
  movedCenter: Point;
  /** 其余货物不动、被移动货物位于 movedCenter 时的标称合成重心 */
  nominalCog: Point;
  /** 使该点最坏距离取得最小值的极端重量向量（全部为区间端点，与 items 同序） */
  weights: number[];
  /** 该极端重量组合下的合成重心 */
  cog: Point;
  /** 该组合的合计重量；溢出时为 null（缺失，不可审核） */
  totalWeight: number | null;
  /** 首先失守的支撑边（边序最小的最坏边） */
  criticalEdge: RobustEdgeInfo;
  /** 该点的鲁棒最坏有符号距离（= criticalEdge.signedDistance，未舍入） */
  worstDistance: number;
  /** 相对 margin 的短缺量 margin - worstDistance */
  shortfall: number;
}

/**
 * 单件货物移动预演结果。
 *
 * 沿「原中心 → 目标中心」的直线路径（参数 s ∈ [0,1]）逐点检查：
 * 标称距离与允许重量区间下的鲁棒最坏距离对每条支撑边都满足 margin。
 * 利用距离随 s 的分式线性/区间极值结构得到完整证明，而非按少量采样点放行。
 *
 * 边界区间 [0, breachLower) 已证安全、[breachUpper, 1] 已证失守，
 * 宽度 ≤ BREACH_WIDTH_TOLERANCE（0.0001）；breachLower 处恰等于 margin 仍算安全。
 */
export interface MoveRehearsal {
  status: RehearsalStatus;
  /** 被移动货物在 items 中的下标 */
  itemIndex: number;
  /** 目标中心 */
  target: Point;
  /** 起点（该货物原中心） */
  origin: Point;
  /** 要求安全余量 */
  margin: number;
  /** 起点（s=0）是否即可放行：标称与鲁棒均通过且无不可审核量 */
  startReleasable: boolean;

  /**
   * 已证安全比例上界：s ∈ [0, safeRatio)（恰在 safeRatio 上压线也算安全，
   * 即安全段为 [0, safeRatio]）。pass 时为 1。
   */
  safeRatio: number;
  /**
   * 已证失守比例下界：s ∈ [breachRatio, 1] 已证失守。
   * pass 时为 null；fail 时与 safeRatio 的间距不超过 0.0001。
   */
  breachRatio: number | null;
  /** 安全/失守边界宽度（breachRatio - safeRatio）；全程安全时为 0 */
  boundaryWidth: number;

  /**
   * 起点（s=0）的完整稳定性分析——预演、俯视图与数值面板共用的同一份起点结果。
   */
  startResult: StabilityResult;
  /**
   * 目标点（s=1）的完整稳定性分析：供面板复算路径终点指标；
   * 未全程通过时应用按钮必须保持禁用。
   */
  endResult: StabilityResult;
  /** 失守点的可复算见证（极端重量、重心、支撑边）；pass/indeterminate 时为 null */
  witness: RehearsalWitness | null;
  /** 无法裁决（含起点暂缓）时的中文说明 */
  reason: string | null;
}

/** 「已证安全／已证失守」边界允许的最大宽度 */
export const BREACH_WIDTH_TOLERANCE = 0.0001;
