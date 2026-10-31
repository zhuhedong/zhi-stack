// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { copySensitiveText } from '../src/lib/api';

let writeText: ReturnType<typeof vi.fn>;
let readText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  writeText = vi.fn().mockResolvedValue(undefined);
  readText = vi.fn().mockResolvedValue('');
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText, readText },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

test('sensitive clipboard content clears after the delay when unchanged', async () => {
  await copySensitiveText('secret', 1000);
  expect(writeText).toHaveBeenCalledWith('secret');
  readText.mockResolvedValue('secret');
  await vi.advanceTimersByTimeAsync(1000);
  expect(writeText).toHaveBeenLastCalledWith('');
});

test('sensitive clipboard content is not cleared after the user copies something else', async () => {
  await copySensitiveText('secret', 1000);
  readText.mockResolvedValue('new content');
  await vi.advanceTimersByTimeAsync(1000);
  expect(writeText).toHaveBeenCalledTimes(1);
  expect(writeText).toHaveBeenCalledWith('secret');
});
