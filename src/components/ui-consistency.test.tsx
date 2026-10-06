import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import PlanView from './PlanView';
import ResultPanel from './ResultPanel';
import { resolveForm } from '../lib/form';
import type { FormState } from '../lib/form';
import type { Point } from '../lib/types';

const square: Point[] = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 100 },
  { x: 0, y: 100 },
];

describe('类型/面板/SVG 消费同一分析结果（服务端渲染为独立见证）', () => {
  it('鲁棒通过：面板显示 STABLE 且 SVG 为绿色放行态，无失败见证', () => {
    const form: FormState = {
      margin: '5',
      items: [
        { id: 'A', weight: '10', weightMin: '8', weightMax: '12', x: '40', y: '50' },
        { id: 'B', weight: '10', weightMin: '8', weightMax: '12', x: '60', y: '50' },
      ],
    };
    const r = resolveForm(square, form);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const result = r.result;
    expect(result.releasable).toBe(true);
    expect(result.robust.status).toBe('robust-pass');

    const panel = renderToStaticMarkup(createElement(ResultPanel, { result }));
    const svg = renderToStaticMarkup(createElement(PlanView, { result }));

    // 同一结果：面板 STABLE，SVG 不含失败见证
    expect(panel).toContain('STABLE');
    expect(panel).toContain('鲁棒放行成立');
    expect(panel).not.toContain('robust-fail');
    // 不含失败见证的图元文本（aria-label 中的说明文字不算图元）
    expect(svg).not.toContain('>失败见证<');
    expect(svg).toContain('>标称重心<');
    // 有区间：SVG 出现半径不确定性虚线圈（按 strokeDasharray 表达即可）
    expect(svg).toMatch(/2 3/);
  });

  it('鲁棒失败：面板给出失败见证明细，SVG 同时画出标称重心与失败见证', () => {
    const form: FormState = {
      margin: '5',
      items: [
        { id: 'A', weight: '10', weightMin: '10', weightMax: '10', x: '50', y: '50' },
        { id: 'B', weight: '10', weightMin: '1', weightMax: '200', x: '98', y: '50' },
      ],
    };
    const r = resolveForm(square, form);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const result = r.result;
    expect(result.stable).toBe(true); // 标称稳定
    expect(result.robust.status).toBe('robust-fail'); // 鲁棒失守
    expect(result.releasable).toBe(false);

    const panel = renderToStaticMarkup(createElement(ResultPanel, { result }));
    const svg = renderToStaticMarkup(createElement(PlanView, { result }));

    // 面板：不放行 + 见证 + 首先失守边（右边 #1）
    expect(panel).toContain('UNSTABLE');
    expect(panel).toContain('鲁棒放行不成立');
    expect(panel).toContain('鲁棒失败见证');
    expect(panel).toContain('#1');
    expect(panel).toContain('极端重量向量');
    // SVG：标称重心与失败见证两个图元同时存在（区分明确）
    expect(svg).toContain('>标称重心<');
    expect(svg).toContain('>失败见证<');
    // 见证重量端点出现在面板中（200 为 B 上界）
    expect(panel).toContain('200');
  });

  it('无法裁决/不可审核时不出现可放行措辞：溢出组合面板与 SVG 同时告警', () => {
    const form: FormState = {
      margin: '1',
      items: [
        { id: 'A', weight: '1.7e308', weightMin: '1', weightMax: '1.7e308', x: '40', y: '50' },
        { id: 'B', weight: '1.7e308', weightMin: '1', weightMax: '1.7e308', x: '60', y: '50' },
      ],
    };
    const r = resolveForm(square, form);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.releasable).toBe(false);
    const panel = renderToStaticMarkup(createElement(ResultPanel, { result: r.result }));
    const svg = renderToStaticMarkup(createElement(PlanView, { result: r.result }));
    expect(panel).not.toContain('>STABLE<');
    expect(panel).toContain('暂缓放行');
    expect(panel).toContain('robust-corner-overflow');
    expect(svg).toContain('允许重量组合合计溢出');
  });

  it('无范围：兼容提示与标称/最坏同值出现在面板', () => {
    const form: FormState = {
      margin: '0',
      items: [{ id: 'A', weight: '50', weightMin: '', weightMax: '', x: '50', y: '50' }],
    };
    const r = resolveForm(square, form);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.robust.allExact).toBe(true);
    const panel = renderToStaticMarkup(createElement(ResultPanel, { result: r.result }));
    expect(panel).toContain('STABLE');
    expect(panel).toContain('均为确定重量');
  });
});

describe('非法编辑后的图文一致性（resolveForm 失败 → 组件拿不到结果）', () => {
  const startForm: FormState = {
    margin: '5',
    items: [
      { id: 'A', weight: '10', weightMin: '8', weightMax: '12', x: '40', y: '50' },
      { id: 'B', weight: '10', weightMin: '8', weightMax: '12', x: '60', y: '50' },
    ],
  };

  it('下界＞上界：解析失败，面板/SVG 均不会被渲染任何结论', () => {
    const form: FormState = structuredClone(startForm);
    form.items[0].weightMin = '50';
    const r = resolveForm(square, form);
    expect(r.ok).toBe(false);
    // 关键不变量：失败分支不存在 result，App 渲染的是“无结论”占位而非 PlanView/ResultPanel
    if (r.ok) throw new Error('必须失败');
  });

  it('修正后恢复：同一表单重新解析得到可渲染结果', () => {
    const form: FormState = structuredClone(startForm);
    form.items[0].weightMin = '50';
    expect(resolveForm(square, form).ok).toBe(false);
    form.items[0].weightMin = '8';
    const fixed = resolveForm(square, form);
    expect(fixed.ok).toBe(true);
    if (fixed.ok) {
      const panel = renderToStaticMarkup(createElement(ResultPanel, { result: fixed.result }));
      expect(panel).toContain('STABLE');
    }
  });
});
