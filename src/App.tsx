import { useMemo, useState } from 'react';
import ImportPanel from './components/ImportPanel';
import CargoTable from './components/CargoTable';
import ResultPanel from './components/ResultPanel';
import PlanView from './components/PlanView';
import MovePanel from './components/MovePanel';
import { resolveForm, workspaceToForm, type FormState } from './lib/form';
import {
  applyMoveTarget,
  previewMovement,
  validateMoveTarget,
  type MovementPreviewState,
} from './lib/movement';
import type { Point, Workspace } from './lib/types';

export default function App() {
  // 导入成功后才建立工作区；导入失败不修改这两个状态（整批拒绝、保留工作区）
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  // 每次成功导入递增，作为编辑器的 key，强制丢弃任何未提交的非法草稿
  const [loadId, setLoadId] = useState(0);
  const [move, setMove] = useState<MovementPreviewState | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);

  const applyWorkspace = (ws: Workspace) => {
    setWorkspace(ws);
    setForm(workspaceToForm(ws));
    setLoadId((n) => n + 1);
    setMove(null);
    setMoveError(null);
  };

  const handleFormChange = (next: FormState) => {
    // 任何工作区编辑都可能改变预演路径，先撤销预演；非法编辑同时撤销旧结论
    setForm(next);
    setMove(null);
    setMoveError(null);
  };

  const runMovePreview = (itemId: string, target: Point) => {
    if (!form || !resolved?.ok) return;
    // 表单中的实时重量、区间、margin 才是当前工作区；预演必须与 resolved.result 同源
    const current: Workspace = {
      polygon: resolved.result.polygon,
      items: resolved.result.items,
      margin: resolved.result.margin,
    };
    const errors = validateMoveTarget(current, itemId, target);
    if (errors.length > 0) {
      // 非法目标：只撤销预演和显示错误，不改工作区/表单/既有放行结论
      setMove(null);
      setMoveError(errors.join('\n'));
      return;
    }
    setMove(previewMovement(current, itemId, target));
    setMoveError(null);
  };

  const clearMove = () => {
    setMove(null);
    setMoveError(null);
  };

  const applyMove = () => {
    if (!resolved?.ok || !move || move.preview.status !== 'all-safe') return;
    const current: Workspace = {
      polygon: resolved.result.polygon,
      items: resolved.result.items,
      margin: resolved.result.margin,
    };
    const { itemId, target } = move.preview;
    const nextWorkspace = applyMoveTarget(current, itemId, target);
    applyWorkspace(nextWorkspace);
  };

  // 同一次渲染里，SVG 与数值面板共用 resolved——图形与数值对同一判断负责
  const resolved = useMemo(
    () => (workspace && form ? resolveForm(workspace.polygon, form) : null),
    [workspace, form],
  );
  // handleFormChange 会在任何表单编辑/导入时撤销预演，因此此处 move 与 resolved 同源
  const previewConsistent = move && resolved?.ok ? move : null;
  // 预演未通过时展示失守点结果；无预演时展示原工作区结果。两种展示结果都只有一份。
  const displayResolved = previewConsistent
    ? { ok: true as const, result: previewConsistent.displayResult }
    : resolved;

  return (
    <div className="app">
      <header className="app-header">
        <h1>异形托盘叉车起运 · 稳定性工作台</h1>
        <p className="subtitle">
          纯前端离线运行 · 重量加权合成重心 · 重心到各支撑边最小有符号距离 ·
          标称结论 + 鲁棒放行（对每条边证明全部允许重量组合满足 margin）·
          单件直线移动连续路径预演 · 边界判断全程使用未舍入值
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
          <MovePanel
            items={form.items}
            preview={move?.preview ?? null}
            previewError={moveError}
            onPreview={runMovePreview}
            onClear={clearMove}
            onApply={applyMove}
          />

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

          <main className="work-grid">
            <section className="panel canvas-panel">
              <h2>俯视图</h2>
              {displayResolved && displayResolved.ok ? (
                <>
                  <PlanView result={displayResolved.result} />
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
            {displayResolved?.ok ? (
              <ResultPanel result={displayResolved.result} />
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
        白色箭头=直线移动路径；途中失守时箭头止于见证比例
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
      <span><i className="lg move" /> 移动路径</span>
    </div>
  );
}
