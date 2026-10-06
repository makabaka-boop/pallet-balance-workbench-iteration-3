import type { MovementPreview, StabilityResult } from '../lib/types';
import { fmt, fmtPair } from '../lib/form';

interface Props {
  result: StabilityResult;
}

/**
 * 数值结论面板。全部数值直接来自传入的 StabilityResult，
 * 与 SVG 使用同一计算结果；边界判断使用未舍入值，
 * 展示值附带 title 提供原始精度。
 *
 * 分两层结论：
 * - 标称结论（登记重量下的 STABLE / UNSTABLE，保持旧口径兼容）；
 * - 鲁棒放行结论（对每条支撑边证明全部允许重量组合满足 margin）。
 * 只有鲁棒通过且无任何不可审核量才可放行；失败时给出可独立复算的
 * 极端重量、对应重心与首先失守的边；无法可靠裁决时绝不显示可放行。
 */
export default function ResultPanel({ result }: Props) {
  const {
    stable,
    releasable,
    warnings,
    cog,
    totalWeight,
    minDistance,
    margin,
    shortfall,
    criticalEdge,
    edges,
    robust,
  } = result;

  // 实际余量 / 要求余量成对展示
  const [distText, marginText] = fmtPair(minDistance, margin);
  const surplus = minDistance - margin;
  const [surplusOrShortText] = fmtPair(stable ? surplus : shortfall, 0);

  // 鲁棒最坏余量 / margin 成对展示
  const worst = robust.worstMinDistance;
  const [worstText, worstMarginText] = fmtPair(worst ?? NaN, margin);

  // 顶层徽标：以鲁棒放行结论为准（无法裁决也是不可放行）
  const verdictClass =
    robust.status === 'robust-fail' || !stable
      ? 'unstable'
      : releasable
        ? 'stable'
        : 'blocked';
  const verdictText =
    robust.status === 'robust-fail' || !stable
      ? 'UNSTABLE'
      : releasable
        ? 'STABLE'
        : '暂缓放行';

  const witness = robust.witness;
  const worstEdgeIndex =
    robust.edgeWorst && robust.edgeWorst.length > 0
      ? robust.edgeWorst.reduce((m, e) => (e.worstDistance < m.worstDistance ? e : m)).index
      : null;

  return (
    <section className={`panel verdict ${verdictClass}`}>
      <div className="verdict-badge">{verdictText}</div>

      {result.movement && <MovementBox preview={result.movement} />}

      {/* 鲁棒放行结论（同一分析结果驱动） */}
      <RobustBox result={result} />

      {warnings.length > 0 && (
        <div className="warn-box" role="alert">
          <strong>存在无法可靠表达 / 无法可靠裁决的量，禁止据此放行：</strong>
          <ul>
            {warnings.map((w) => (
              <li key={w.code} data-code={w.code}>
                {w.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <h3 className="section-title">标称结论（登记重量）</h3>
      <dl className="metric-grid">
        <div>
          <dt>标称合成重心 X</dt>
          <dd title={String(cog.x)}>{fmt(cog.x)}</dd>
        </div>
        <div>
          <dt>标称合成重心 Y</dt>
          <dd title={String(cog.y)}>{fmt(cog.y)}</dd>
        </div>
        <div>
          <dt>标称总重量</dt>
          {totalWeight === null ? (
            <dd className="warn-val" title="合计重量超出数值可表达范围（缺失值）">
              缺失（溢出，不可审核）
            </dd>
          ) : (
            <dd title={String(totalWeight)}>{fmt(totalWeight)}</dd>
          )}
        </div>
        <div>
          <dt>标称最小有符号距离</dt>
          <dd className={stable ? 'pos' : 'neg'} title={String(minDistance)}>
            {distText}
          </dd>
        </div>
        <div>
          <dt>要求安全余量 margin</dt>
          <dd title={String(margin)}>{marginText}</dd>
        </div>
        <div>
          <dt>{stable ? '标称富余' : '标称短缺量'}</dt>
          <dd className={stable ? 'pos' : 'neg'} title={String(stable ? surplus : shortfall)}>
            {surplusOrShortText}
          </dd>
        </div>
      </dl>

      {!stable && (
        <div className="danger-box">
          <strong>标称最危险边：</strong>
          边 #{criticalEdge.index}（
          {`(${fmt(criticalEdge.a.x)}, ${fmt(criticalEdge.a.y)}) → (${fmt(
            criticalEdge.b.x,
          )}, ${fmt(criticalEdge.b.y)})`}
          ）
          <div className="danger-line">
            标称实际余量 {distText} ＜ margin {marginText}，短缺 {surplusOrShortText}
          </div>
          <div className="danger-note">
            距离为{minDistance < 0 ? '负，重心已越出该支撑边' : '正但不足 margin'}，
            叉运前必须重新配载。
          </div>
        </div>
      )}

      {/* 鲁棒失败见证：可独立复算的极端重量、对应重心、首先失守边 */}
      {witness && (
        <div className="witness-box" data-testid="robust-witness">
          <strong>鲁棒失败见证（可按下列端点重量复算）：</strong>
          <dl className="witness-grid">
            <div>
              <dt>见证重心 X</dt>
              <dd title={String(witness.cog.x)}>{fmt(witness.cog.x)}</dd>
            </div>
            <div>
              <dt>见证重心 Y</dt>
              <dd title={String(witness.cog.y)}>{fmt(witness.cog.y)}</dd>
            </div>
            <div>
              <dt>见证合计重量</dt>
              {witness.totalWeight === null ? (
                <dd className="warn-val">缺失（溢出，不可审核）</dd>
              ) : (
                <dd title={String(witness.totalWeight)}>{fmt(witness.totalWeight)}</dd>
              )}
            </div>
            <div>
              <dt>该组合最小距离</dt>
              <dd className="neg" title={String(witness.minDistance)}>{fmt(witness.minDistance)}</dd>
            </div>
            <div>
              <dt>首先失守的边</dt>
              <dd className="neg">#{witness.criticalEdge.index}</dd>
            </div>
            <div>
              <dt>相对 margin 短缺</dt>
              <dd className="neg" title={String(witness.shortfall)}>{fmt(witness.shortfall)}</dd>
            </div>
          </dl>
          <div className="witness-edge">
            边 #{witness.criticalEdge.index}：
            {`(${fmt(witness.criticalEdge.a.x)}, ${fmt(witness.criticalEdge.a.y)}) → (${fmt(
              witness.criticalEdge.b.x,
            )}, ${fmt(witness.criticalEdge.b.y)})`}
            ，见证距离 {fmt(witness.criticalEdge.signedDistance)} ＜ {fmt(margin)}
          </div>
          <details>
            <summary>极端重量向量（与货物同序，均为区间端点）</summary>
            <table className="edge-table">
              <thead>
                <tr><th>货物</th><th>见证重量</th><th>允许区间</th></tr>
              </thead>
              <tbody>
                {result.items.map((it, i) => (
                  <tr key={it.id}>
                    <td>{it.id}</td>
                    <td title={String(witness.weights[i])}>{fmt(witness.weights[i])}</td>
                    <td>
                      {robust.ranges[i].min === robust.ranges[i].max
                        ? `${fmt(robust.ranges[i].min)}（确定）`
                        : `[${fmt(robust.ranges[i].min)}, ${fmt(robust.ranges[i].max)}]`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </div>
      )}

      <details className="edge-details">
        <summary>各支撑边有符号距离（标称 / 鲁棒最坏；未舍入判断，展示保留 6 位小数）</summary>
        <table className="edge-table">
          <thead>
            <tr>
              <th>边</th>
              <th>起点</th>
              <th>终点</th>
              <th>标称距离</th>
              <th>允许组合最坏距离</th>
            </tr>
          </thead>
          <tbody>
            {edges.map((e) => {
              const ew = robust.edgeWorst?.find((x) => x.index === e.index);
              const isWorst = ew !== undefined && ew.index === worstEdgeIndex;
              return (
                <tr
                  key={e.index}
                  className={
                    isWorst ? 'critical' : e.index === criticalEdge.index ? 'nominal-critical' : ''
                  }
                >
                  <td>#{e.index}</td>
                  <td>({fmt(e.a.x)}, {fmt(e.a.y)})</td>
                  <td>({fmt(e.b.x)}, {fmt(e.b.y)})</td>
                  <td title={String(e.signedDistance)}>{fmt(e.signedDistance)}</td>
                  <td
                    className={ew && ew.worstDistance < margin ? 'neg' : 'pos'}
                    title={ew ? String(ew.worstDistance) : '无法可靠裁决'}
                  >
                    {ew ? fmt(ew.worstDistance) : '无法裁决'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {robust.status === 'indeterminate' && (
          <p className="danger-note">
            至少一条边的最坏距离无法在当前数值精度内可靠求出；
            表中“无法裁决”的边一律按不满足处理，禁止放行。
          </p>
        )}
      </details>

      <p className="compat-note">
        {robust.allExact
          ? '本工作区货物均为确定重量（无区间）：鲁棒最坏距离与标称距离一致，结论与旧版口径完全兼容。'
          : '存在重量区间：放行依据为“允许组合最坏距离”，标称结论仅按登记重量展示。'}
        {worst !== null && (
          <> 全局最坏距离 {worstText}，要求 {worstMarginText}。</>
        )}
      </p>
    </section>
  );
}

/** 鲁棒放行结论横幅（pass / fail / indeterminate 三态，均来自同一结果） */
function RobustBox({ result }: { result: StabilityResult }) {
  const { robust } = result;
  if (robust.status === 'robust-pass') {
    return (
      <div className="robust-box pass" data-testid="robust-pass">
        <strong>鲁棒放行成立：</strong>
        已对支撑多边形全部 {result.edges.length} 条边、
        {robust.allExact ? '唯一确定重量组合' : '重量盒的全部角点组合'}
        证明有符号距离 ≥ margin（未舍入比较，边界相等算通过；非抽样）。
      </div>
    );
  }
  if (robust.status === 'robust-fail') {
    const w = robust.worstMinDistance;
    return (
      <div className="robust-box fail" data-testid="robust-fail">
        <strong>鲁棒放行不成立：</strong>
        存在允许重量组合使某条边距离失守。最坏距离{' '}
        <span title={String(w ?? NaN)}>{fmt(w ?? NaN)}</span> ＜ margin{' '}
        {fmt(robust.margin)}；下方给出可复算的极端重量、对应重心与首先失守的边。
      </div>
    );
  }
  return (
    <div className="robust-box unknown" data-testid="robust-indeterminate">
      <strong>鲁棒结论无法可靠裁决：</strong>
      区间分析未通过数值交叉校验。无法证明所有组合满足 ≠ 已满足，
      本载荷<strong>不得显示为可放行</strong>；请调整区间或配载后重试。
    </div>
  );
}

/** 移动预演横幅：数值与 SVG 均读取同一份 MovementPreview */
function MovementBox({ preview }: { preview: MovementPreview }) {
  const title: Record<MovementPreview['status'], string> = {
    'all-safe': '移动预演全程安全',
    'fails-after-start': '移动途中失守',
    'start-fail': '起点不能放行',
    indeterminate: '移动预演暂缓',
  };
  const cls =
    preview.status === 'all-safe'
      ? 'pass'
      : preview.status === 'indeterminate'
        ? 'unknown'
        : 'fail';

  return (
    <div className={`move-box ${cls}`} data-testid="move-panel-result" data-status={preview.status}>
      <strong>{title[preview.status]}：</strong>
      {preview.status === 'all-safe' && (
        <>连续路径比例 [0,1] 已由两端点与最坏距离凹性证明满足标称和重量区间鲁棒余量，目标位置可以应用。</>
      )}
      {preview.status === 'fails-after-start' && (
        <>
          已证安全比例上界 {fmt(preview.safeRatio!, 7)}，已证失守比例下界 {fmt(preview.unsafeRatio!, 7)}，
          边界宽度 {fmt(preview.boundaryWidth!, 7)}（不超过 0.0001；恰等于 margin 算安全）。
          {preview.witness && (
            <div>
              失守比例 {fmt(preview.witness.ratio, 7)} 处，见证重心
              ({fmt(preview.witness.cog.x)}, {fmt(preview.witness.cog.y)})，
              首先失守边 #{preview.witness.criticalEdge.index}，距离
              {fmt(preview.witness.criticalEdge.signedDistance)} ＜ {fmt(preview.targetResult.margin)}。
            </div>
          )}
        </>
      )}
      {preview.status === 'start-fail' && (preview.reason ?? '起点未通过，禁止开始移动。')}
      {preview.status === 'indeterminate' && (preview.reason ?? '存在无法裁决的路径点，只能暂缓。')}
    </div>
  );
}
