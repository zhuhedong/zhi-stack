/// <reference lib="webworker" />
import { evaluate, type Assertion, type ChainResponse, type Extraction } from './chaining';

// Same-origin module worker: no network or storage use, no dynamic code.
self.onmessage = (
  event: MessageEvent<{ response: ChainResponse; extractions: Extraction[]; assertions: Assertion[] }>,
) => {
  try {
    const { response, extractions, assertions } = event.data;
    self.postMessage(evaluate(response, extractions, assertions));
  } catch (e) {
    self.postMessage({ error: e instanceof Error ? e.message : String(e) });
  }
};
