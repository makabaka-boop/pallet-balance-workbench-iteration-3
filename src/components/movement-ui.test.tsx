import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import MovePanel, { canApplyMovePreview } from './MovePanel';
import PlanView from './PlanView';
import ResultPanel from './ResultPanel';
import { previewMovement } from '../lib/movement';
import type { FormState } from '../lib/form';
import type { Point, Workspace } from '../lib/types';

const square: Point[] = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 100 },
  { x: 0, y: 100 },
];

const form: FormState = {
  margin: '40',
  items: [
    { id: 'A', weight: '10', weightMin: '9', weightMax: '11', x: '40', y: '50' },
    { id: 'B', weight: '10', weightMin: '9', weightMax: '11', x: '50', y: '50' },
  ],
};

const ws: Workspace = {
  polygon: square,
  margin: 40,
  items: [
    { id: 'A', weight: 10, weightMin: 9, weightMax: 11, center: { x: 40, y: 50 } },
    { id: 'B', weight: 10, weightMin: 9, weightMax: 11, center: { x: 50, y: 50 } },
  ],
};

describe('移动预演页面状态', () => {
  it('途中失守：应用按钮禁用，面板、数值面板和俯视图显示同一份边界与见证', () => {
    const state = previewMovement(ws, 'A', { x: 99, y: 50 });
    expect(state.preview.status).toBe('fails-after-start');

    const controls = renderToStaticMarkup(
      createElement(MovePanel, {
        items: form.items,
        preview: state.preview,
        previewError: null,
        onPreview: vi.fn(),
        onClear: vi.fn(),
        onApply: vi.fn(),
      }),
    );
    const panel = renderToStaticMarkup(createElement(ResultPanel, { result: state.displayResult }));
    const svg = renderToStaticMarkup(createElement(PlanView, { result: state.displayResult }));

    expect(controls).toContain('data-status="fails-after-start"');
    expect(controls).toContain('disabled');
    expect(controls).toContain('移动途中失守');
    expect(panel).toContain('移动途中失守');
    expect(panel).toContain('已证安全比例上界');
    expect(svg).toContain('data-status="fails-after-start"');
    expect(svg).toContain('目标');
    expect(panel).toContain(`边 #${state.preview.witness!.criticalEdge.index}`);
    expect(controls).toContain(`边 #${state.preview.witness!.criticalEdge.index}`);
  });

  it('全程安全：应用按钮可用，图与数值面板均显示全程安全', () => {
    // 使用宽松 margin，使 10→15 的短路径全程通过
    const safeWs: Workspace = { ...ws, margin: 20 };
    const state = previewMovement(safeWs, 'A', { x: 15, y: 50 });
    expect(state.preview.status).toBe('all-safe');

    const controls = renderToStaticMarkup(
      createElement(MovePanel, {
        items: form.items,
        preview: state.preview,
        previewError: null,
        onPreview: vi.fn(),
        onClear: vi.fn(),
        onApply: vi.fn(),
      }),
    );
    // 初始输入框为空时不应用，避免旧输入对应另一个目标；输入与目标一致后可应用
    expect(controls).toContain('disabled');
    expect(canApplyMovePreview(state.preview, 'A', '', '')).toBe(false);
    expect(canApplyMovePreview(state.preview, 'A', '15', '50')).toBe(true);
    expect(canApplyMovePreview(state.preview, 'A', '16', '50')).toBe(false);
    expect(controls).toContain('移动预演全程安全');

    const panel = renderToStaticMarkup(createElement(ResultPanel, { result: state.displayResult }));
    const svg = renderToStaticMarkup(createElement(PlanView, { result: state.displayResult }));
    expect(panel).toContain('移动预演全程安全');
    expect(svg).toContain('data-status="all-safe"');
  });

  it('非法目标：撤销预演并显示错误，应用按钮保持禁用', () => {
    const html = renderToStaticMarkup(
      createElement(MovePanel, {
        items: form.items,
        preview: null,
        previewError: '目标中心 X 必须是绝对值不超过 1000000 的有限数',
        onPreview: vi.fn(),
        onClear: vi.fn(),
        onApply: vi.fn(),
      }),
    );
    expect(html).toContain('非法目标，已撤销预演');
    expect(html).toMatch(/<button[^>]*data-testid="apply-move"[^>]*disabled/);
  });
});
