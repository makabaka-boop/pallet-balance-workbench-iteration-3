import { useMemo, useState } from 'react';
import ImportPanel from './components/ImportPanel';
import CargoTable from './components/CargoTable';
import MoveRehearsalPanel from './components/MoveRehearsalPanel';
import ResultPanel from './components/ResultPanel';
import PlanView from './components/PlanView';
import {
  applyTargetToForm,
  resolveForm,
  workspaceToForm,
  type FormState,
} from './lib/form';
import type { MoveRehearsal, Point, Workspace } from './lib/types';

export default function App() {
  // 导入成功后才建立工作区；导入失败不修改这两个状态（整批拒绝、保留工作区）
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [form, setFormState] = useState<FormState | null>(null);
  // 每次成功导入递增，作为编辑器的 key，强制丢弃任何未提交的非法草稿
  const [loadId, setLoadId] = useState(0);
  // 单件货物移动预演：与当前 resolved 同源；任何编辑/重新导入/撤销都清空
  const [rehearsal, setRehearsal] = useState<MoveRehearsal | null>(null);
  const [rehearsalErrors, setRehearsalErrors] = useState<string[] | null>(null);

  const applyWorkspace = (ws: Workspace) => {
    setWorkspace(ws);
    setFormState(workspaceToForm(ws));
    setLoadId((n) => n + 1);
    // 新工作区：旧预演与其路径不再对应，必须丢弃（不保留过期结论）
    setRehearsal(null);
    setRehearsalErrors(null);
  };

  // 任何手输编辑都立即作废预演：预演路径绑定旧表单，不得残留为过期依据
  const handleFormChange = (next: FormState) => {
    setFormState(next);
    setRehearsal(null);
    setRehearsalErrors(null);
  };

  // 同一次渲染里，SVG 与数值面板共用 resolved——图形与数值对同一判断负责。
  // 预演的起点结果也必须取自这同一个 resolved（预演、俯视图、数值面板同源）。
  const resolved = useMemo(
    () => (workspace && form ? resolveForm(workspace.polygon, form) : null),
    [workspace, form],
  );

  // 预演只在起点结果仍然有效、且与当前表单逐项一致时叠加（预演/俯视图/数值面板同源）。
  // 表单一旦变化预演已在 handleFormChange 清空；这里再以起点结果同一性 +
  // 被移动货物中心仍是预演原中心做防御性核对，杜绝任何过期路径残留。
  const liveRehearsal =
    rehearsal &&
    resolved?.ok &&
    rehearsal.startResult === resolved.result &&
    resolved.result.items[rehearsal.itemIndex]?.center.x === rehearsal.origin.x &&
    resolved.result.items[rehearsal.itemIndex]?.center.y === rehearsal.origin.y
      ? rehearsal
      : null;

  const handleApplyTarget = (itemIndex: number, target: Point) => {
    if (!form) return;
    setFormState(applyTargetToForm(form, itemIndex, target));
    // 目标位置已成为新工作区事实：预演使命完成，清空（新起点可重新预演）
    setRehearsal(null);
    setRehearsalErrors(null);
  };

  return (
    <div className="app">
      <header className="app-header">
        <h1>异形托盘叉车起运 · 稳定性工作台</h1>
        <p className="subtitle">
          纯前端离线运行 · 重量加权合成重心 · 重心到各支撑边最小有符号距离 ·
          标称结论 + 鲁棒放行（对每条边证明全部允许重量组合满足 margin）·
          单件货物移动预演（沿完整路径证明，非采样）· 边界判断全程使用未舍入值
        </p>
      </header>

      <ImportPanel onApply={applyWorkspace} />

      {!workspace || !form ? (
        <div className="empty-state">
          尚未建立工作区：请在上方导入按逆时针顺序给出的严格凸支撑多边形与货物清单。
        </div>
      ) : (
        <>
          <CargoTable key={loadId} form={form} onChange={handleFormChange} />

          {resolved && !resolved.ok && (
            <div className="banner err edit-errors">
              <strong>存在非法编辑，稳定性结论已撤销（图形与数值均不可作为起运依据）：</strong>
              <ul>
                {resolved.errors.map((m, i) => (
                  <li key={i}>{m}</li>
                ))}
              </ul>
            </div>
          )}

          {resolved?.ok && (
            <MoveRehearsalPanel
              workspace={workspace}
              startResult={resolved.result}
              rehearsal={liveRehearsal}
              errors={rehearsalErrors}
              onRehearse={setRehearsal}
              onErrors={setRehearsalErrors}
              onApplyTarget={handleApplyTarget}
            />
          )}

          <main className="work-grid">
            <section className="panel canvas-panel">
              <h2>俯视图</h2>
              {resolved && resolved.ok ? (
                <>
                  <PlanView result={resolved.result} rehearsal={liveRehearsal} />
                  <Legend />
                </>
              ) : (
                <div className="canvas-stale">
                  <svg viewBox="0 0 820 620" className="planview stale">
                    <rect x={0} y={0} width={820} height={620} fill="#0f172a" rx={10} />
                    <text
                      x={410}
                      y={300}
                      textAnchor="middle"
                      fontSize={26}
                      fill="#f87171"
                    >
                      结论已撤销
                    </text>
                    <text x={410} y={345} textAnchor="middle" fontSize={16} fill="#94a3b8">
                      请修正标红的编辑项后，图形与数值将同时恢复为同一计算结果
                    </text>
                  </svg>
                </div>
              )}
            </section>
            {resolved?.ok ? (
              <ResultPanel result={resolved.result} rehearsal={liveRehearsal} />
            ) : (
              <section className="panel verdict invalid">
                <div className="verdict-badge">无结论</div>
                <p>输入存在非法值，未执行任何稳定性判断。</p>
                <p className="hint">
                  修正左侧红色提示后会实时重算。任何编辑都立即撤销旧结论，
                  不会残留过期的 STABLE / UNSTABLE。
                </p>
              </section>
            )}
          </main>
        </>
      )}

      <footer className="app-footer">
        支撑多边形：逆时针严格凸 · 绿色描边=鲁棒可放行，琥珀描边=暂缓放行（存在不可表达/无法裁决量），
        红色描边=标称或鲁棒失守 · 蓝色虚线=margin 安全区（仅在能与原边区分时绘制）·
        青色十字=标称重心，红粉五边形=鲁棒失败见证（允许重量组合下的极端重心），
        橙色虚线圈=货物重量区间对应的半径不确定性 ·
        绿色实线=预演已证安全路径，红色实线=已证失守路径，琥珀虚线=无法裁决路径，
        菱形=目标中心，橙色小方块=首次失守比例处的货物位置
      </footer>
    </div>
  );
}

function Legend() {
  return (
    <div className="legend">
      <span><i className="lg support" /> 支撑多边形</span>
      <span><i className="lg safe" /> margin 安全区</span>
      <span><i className="lg danger" /> 最危险边 / 失守边</span>
      <span><i className="lg cargo" /> 货物（半径∝√重量）</span>
      <span><i className="lg cog" /> 标称重心</span>
      <span><i className="lg witness" /> 鲁棒失败见证</span>
      <span><i className="lg path-safe" /> 预演安全路径 / 目标</span>
    </div>
  );
}
