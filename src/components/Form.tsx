import { useEffect, useId, useState, type FormHTMLAttributes } from 'react';

type Field = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
type Problem = { field: Field; message: string };
function firstProblem(form: HTMLFormElement): Problem | null {
  for (const element of Array.from(form.elements)) {
    if (!(
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement
    ))
      continue;
    if (!element.willValidate || element.validity.valid) continue;
    const label = element.labels?.[0]?.cloneNode(true) as HTMLElement | undefined;
    label?.querySelectorAll('input,textarea,select').forEach((control) => control.remove());
    const name = element.getAttribute('aria-label') || label?.textContent?.trim() || '此项';
    const validity = element.validity;
    let message = '请检查输入格式。';
    if (validity.valueMissing) message = '请填写此项。';
    else if (validity.typeMismatch)
      message =
        element.type === 'url'
          ? '请输入完整的服务或网页地址，例如 https://example.com。'
          : '请输入有效的邮箱地址。';
    else if (validity.tooShort) message = `至少需要 ${(element as HTMLInputElement).minLength} 个字符。`;
    else if (validity.tooLong) message = `最多允许 ${(element as HTMLInputElement).maxLength} 个字符。`;
    else if (validity.rangeUnderflow) message = `不能小于 ${(element as HTMLInputElement).min}。`;
    else if (validity.rangeOverflow) message = `不能大于 ${(element as HTMLInputElement).max}。`;
    else if (validity.badInput || validity.stepMismatch) message = '请输入符合范围和步长要求的数字。';
    else if (validity.patternMismatch) message = element.title || '请输入与要求一致的内容。';
    else if (validity.customError) message = element.validationMessage;
    return { field: element, message: `${name}：${message}` };
  }
  return null;
}

export function Form({
  children,
  onSubmit,
  onChange,
  onInvalidCapture,
  ...props
}: Omit<FormHTMLAttributes<HTMLFormElement>, 'noValidate'>) {
  const [problem, setProblem] = useState<Problem | null>(null);
  const errorId = useId();
  useEffect(() => {
    if (!problem) return;
    const { field } = problem;
    const invalid = field.getAttribute('aria-invalid');
    const describedBy = field.getAttribute('aria-describedby');
    field.setAttribute('aria-invalid', 'true');
    field.setAttribute('aria-describedby', [describedBy, errorId].filter(Boolean).join(' '));
    return () => {
      if (invalid === null) field.removeAttribute('aria-invalid');
      else field.setAttribute('aria-invalid', invalid);
      if (describedBy === null) field.removeAttribute('aria-describedby');
      else field.setAttribute('aria-describedby', describedBy);
    };
  }, [problem, errorId]);
  function validate(form: HTMLFormElement) {
    const next = firstProblem(form);
    setProblem(next);
    next?.field.focus();
    return !next;
  }
  return (
    <form
      {...props}
      noValidate
      onSubmit={(event) => {
        if (!validate(event.currentTarget)) {
          event.preventDefault();
          return;
        }
        onSubmit?.(event);
      }}
      onInvalidCapture={(event) => {
        event.preventDefault();
        validate(event.currentTarget);
        onInvalidCapture?.(event);
      }}
      onChange={(event) => {
        if (problem) setProblem(null);
        onChange?.(event);
      }}
    >
      {problem && (
        <p id={errorId} className="error form-validation-error" role="alert">
          {problem.message}
        </p>
      )}
      {children}
    </form>
  );
}
