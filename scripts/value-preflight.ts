import { EvalProvider } from '../src/eval-provider';
const provider = await EvalProvider.open('.eval-local/value-v1');
try {
  const result = await provider.call('preflight', { messages: [{ role: 'user', content: 'Reply with exactly READY. This is a connectivity check.' }] });
  console.log(JSON.stringify({ ready: result.choices[0].message.content?.trim() === 'READY', model: result.model, usage: result.usage }));
} finally { await provider.close(); }
