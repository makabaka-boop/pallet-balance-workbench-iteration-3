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

/** 移动预演状态 */
export type MovementPreviewStatus =
  | 'all-safe'
  | 'fails-after-start'
  | 'start-fail'
  | 'indeterminate';

/** 路径失守比例处的见证：复用鲁棒见证并记录路径比例 */
export interface MovementWitness extends RobustWitness {
  /** 见证对应的直线路径比例 t，原中心 t=0、目标中心 t=1 */
  ratio: number;
}

/**
 * 单件货物沿原中心 → 目标中心直线移动的连续预演结果。
 * 这里的安全/失守边界是区间性质证明后的比例括号，不是离散采样结论。
 */
export interface MovementPreview {
  status: MovementPreviewStatus;
  itemId: string;
  from: Point;
  target: Point;
  /** t=0 的原位置分析结果 */
  startResult: StabilityResult;
  /** t=1 的目标位置分析结果 */
  targetResult: StabilityResult;
  /**
   * 已证安全的最大路径比例（括号左端/安全端）。
   * all-safe 时为 1；start-fail/indeterminate 时为 null。
   */
  safeRatio: number | null;
  /**
   * 已证失守的最小路径比例（括号右端/失守端）。
   * 与 safeRatio 之差不超过 1e-4；全程安全或起点无法预演时为 null。
   */
  unsafeRatio: number | null;
  /** unsafeRatio - safeRatio；仅在途中失守时非 null */
  boundaryWidth: number | null;
  /** 失守比例处可复算的极端重量、重心与支撑边见证 */
  witness: MovementWitness | null;
  /** 无法裁决或起点状态说明 */
  reason: string | null;
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
  /** 若本结果用于展示一次移动预演，携带同一份预演结论 */
  movement?: MovementPreview;
}

/** 表单解析结果 */
export type FormResult =
  | { ok: true; workspace: Workspace }
  | { ok: false; errors: string[] };
