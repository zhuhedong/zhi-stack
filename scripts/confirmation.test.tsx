// @vitest-environment jsdom
import { act, StrictMode, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { ConfirmationProvider } from '../src/components/ConfirmationProvider';
import { useConfirm } from '../src/lib/confirmation';
import { Form } from '../src/components/Form';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.spyOn(window, 'alert').mockImplementation(() => {});
  vi.spyOn(window, 'prompt').mockReturnValue('');
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  expect(window.confirm).not.toHaveBeenCalled();
  expect(window.alert).not.toHaveBeenCalled();
  expect(window.prompt).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});
async function render(ui: ReactNode) {
  await act(async () =>
    root.render(
      <StrictMode>
        <ConfirmationProvider>{ui}</ConfirmationProvider>
      </StrictMode>,
    ),
  );
}
async function click(label: string, selector = 'button') {
  const button = [...host.querySelectorAll<HTMLButtonElement>(selector)].find(
    (button) => button.textContent === label,
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
}
async function answer(label: string) {
  await click(label, '[role="alertdialog"] button');
}
function Ask({ done, scope = 'first' }: { done: (accepted: boolean) => void; scope?: string }) {
  const confirm = useConfirm(scope);
  return (
    <button
      onClick={async () =>
        done(
          await confirm({
            title: scope,
            description: '删除后无法恢复。',
            confirmLabel: '删除',
            danger: true,
          }),
        )
      }
    >
      发起确认
    </button>
  );
}

test('confirmation waits for an answer, focuses cancel and treats Escape or close as cancellation', async () => {
  const done = vi.fn();
  await render(<Ask done={done} />);
  host.querySelector('button')!.focus();
  await click('发起确认');
  const dialog = host.querySelector<HTMLDialogElement>('[role="alertdialog"]')!;
  expect(dialog.classList.contains('confirmation-modal')).toBe(true);
  expect(document.activeElement?.textContent).toBe('取消');
  expect(document.getElementById(dialog.getAttribute('aria-describedby')!)?.textContent).toContain(
    '无法恢复',
  );
  expect(done).not.toHaveBeenCalled();
  await act(async () => dialog.dispatchEvent(new Event('cancel', { bubbles: false, cancelable: true })));
  expect(done).toHaveBeenLastCalledWith(false);
  expect(document.activeElement?.textContent).toBe('发起确认');
  await click('发起确认');
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="关闭对话框"]')!.click());
  expect(done.mock.calls).toEqual([[false], [false]]);
  await click('发起确认');
  await answer('删除');
  expect(done.mock.calls).toEqual([[false], [false], [true]]);
  expect(host.querySelector('dialog')).toBeNull();
});

test('concurrent requests are shown one at a time and each receives its own answer', async () => {
  const done = vi.fn();
  function Queue() {
    const confirm = useConfirm();
    return (
      <button
        onClick={() => {
          void confirm({ title: '第一条', description: '第一条说明', confirmLabel: '继续' }).then((value) =>
            done(1, value),
          );
          void confirm({ title: '第二条', description: '第二条说明', confirmLabel: '继续' }).then((value) =>
            done(2, value),
          );
        }}
      >
        排队
      </button>
    );
  }
  await render(<Queue />);
  await click('排队');
  expect(host.querySelectorAll('dialog')).toHaveLength(1);
  expect(host.querySelector('dialog')?.getAttribute('aria-label')).toBe('第一条');
  await answer('取消');
  expect(host.querySelector('dialog')?.getAttribute('aria-label')).toBe('第二条');
  await answer('继续');
  expect(done.mock.calls).toEqual([
    [1, false],
    [2, true],
  ]);
});

test('leaving the requesting component or changing its target cancels a pending action', async () => {
  const done = vi.fn();
  await render(<Ask done={done} scope="first" />);
  await click('发起确认');
  await render(<Ask done={done} scope="second" />);
  expect(done).toHaveBeenLastCalledWith(false);
  expect(host.querySelector('dialog')).toBeNull();
  await click('发起确认');
  await render(<div>已离开编辑</div>);
  expect(done.mock.calls).toEqual([[false], [false]]);
  expect(host.querySelector('dialog')).toBeNull();
});

test('form validation remains enforced and appears inline without a browser popup', async () => {
  const saved = vi.fn();
  function Editor() {
    const [value, setValue] = useState('');
    return (
      <Form
        onSubmit={(event) => {
          event.preventDefault();
          saved(value);
        }}
      >
        <label>
          服务端地址
          <input
            aria-describedby="hint"
            required
            type="url"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        </label>
        <p id="hint">填写部署地址</p>
        <button>保存</button>
      </Form>
    );
  }
  await render(<Editor />);
  await click('保存');
  const input = host.querySelector('input')!;
  expect(host.querySelector('form')?.noValidate).toBe(true);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('服务端地址：请填写');
  expect(input.getAttribute('aria-invalid')).toBe('true');
  expect(input.getAttribute('aria-describedby')).toContain('hint');
  expect(document.activeElement).toBe(input);
  expect(saved).not.toHaveBeenCalled();
  for (const value of ['not-a-url', 'https://example.com']) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(input.getAttribute('aria-invalid')).toBeNull();
    expect(input.getAttribute('aria-describedby')).toBe('hint');
    await click('保存');
    if (value === 'not-a-url') {
      expect(host.querySelector('[role="alert"]')?.textContent).toContain('完整');
      expect(saved).not.toHaveBeenCalled();
    }
  }
  expect(saved).toHaveBeenCalledExactlyOnceWith('https://example.com');
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

test('inline validation respects confirmation text and numeric constraints', async () => {
  const saved = vi.fn();
  await render(
    <Form
      onSubmit={(event) => {
        event.preventDefault();
        saved();
      }}
    >
      <label>
        确认文字
        <input required pattern="永久删除" defaultValue="删除" />
      </label>
      <label>
        间隔
        <input type="number" min="1" max="168" defaultValue="0" />
      </label>
      <button>提交</button>
    </Form>,
  );
  await click('提交');
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('确认文字');
  host.querySelector('input')!.value = '永久删除';
  await click('提交');
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('不能小于 1');
  host.querySelector<HTMLInputElement>('input[type="number"]')!.value = '169';
  await click('提交');
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('不能大于 168');
  expect(saved).not.toHaveBeenCalled();
  host.querySelector<HTMLInputElement>('input[type="number"]')!.value = '24';
  await click('提交');
  expect(saved).toHaveBeenCalledOnce();
});

test('runtime source cannot reintroduce native dialogs or unstyled form validation', () => {
  const failures: string[] = [];
  const forbidden = new Set(['alert', 'confirm', 'prompt']);
  function inspect(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        inspect(path);
        continue;
      }
      if (!/\.tsx?$/.test(path)) continue;
      const file = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
      function visit(node: ts.Node) {
        if (ts.isCallExpression(node)) {
          const call = node.expression;
          if (
            (ts.isPropertyAccessExpression(call) || ts.isElementAccessExpression(call)) &&
            ts.isIdentifier(call.expression) &&
            ['window', 'globalThis', 'self'].includes(call.expression.text)
          ) {
            const name = ts.isPropertyAccessExpression(call)
              ? call.name.text
              : ts.isStringLiteral(call.argumentExpression)
                ? call.argumentExpression.text
                : '';
            if (forbidden.has(name)) failures.push(path + ': native ' + name);
          } else if (ts.isIdentifier(call) && ['alert', 'prompt'].includes(call.text))
            failures.push(path + ': native ' + call.text);
        }
        if (
          (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
          node.tagName.getText(file) === 'form' &&
          !path.endsWith(join('components', 'Form.tsx'))
        )
          failures.push(path + ': raw form');
        ts.forEachChild(node, visit);
      }
      visit(file);
    }
  }
  inspect('src');
  expect(failures).toEqual([]);
});
