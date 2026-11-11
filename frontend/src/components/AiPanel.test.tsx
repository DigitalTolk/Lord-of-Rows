import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../i18n';

const preview = {
  token: 'tok', task: 'explain_sql', system: 'SYS', user: 'Task: Explain this SQL.\nSELECT ?', text: '[system]\nSYS\n\n[user]\nTask: Explain this SQL.\nSELECT ?',
  bytes: 30, provider: 'anthropic', model: 'claude-opus-5-5', base_url: 'https://api.anthropic.com',
};

vi.mock('../lib/ipc', () => ({
  api: {
    aiPreview: vi.fn(async () => preview),
    aiSend: vi.fn(async () => ({ text: 'Try:\n```sql\nSELECT 2\n```', sql: 'SELECT 2', truncated: false, provider: 'anthropic', model: 'claude-opus-5-5', duration_ms: 5 })),
  },
  IpcError: class extends Error {},
}));

import { api } from '../lib/ipc';
import { AiPanel } from './AiPanel';

describe('AiPanel', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  it('sends only after preview + explicit Send, and only inserts SQL', async () => {
    const onInsert = vi.fn();
    render(<AiPanel sources={{ sql: () => "SELECT 'secret'", error: null, plan: null }} onInsert={onInsert} onClose={() => undefined} />);
    expect(api.aiSend).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByText('Preview prompt'));
    });
    // Default context: just the input — no dialect, no tables.
    expect(api.aiPreview).toHaveBeenCalledWith({ task: 'explain_sql', input: "SELECT 'secret'", sql: null, session_id: null, include_dialect: false, tables: [] });
    expect(screen.getByTestId('ai-preview').textContent).toBe(preview.text);
    expect(api.aiSend).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByText('Send'));
    });
    expect(api.aiSend).toHaveBeenCalledWith(preview);
    expect(screen.getByTestId('ai-answer').textContent).toContain('SELECT 2');

    fireEvent.click(screen.getByText('Insert SQL into editor'));
    expect(onInsert).toHaveBeenCalledWith('SELECT 2');
  });

  it('editing the input discards the preview', async () => {
    render(<AiPanel sources={{ sql: () => 'SELECT 1', error: null, plan: null }} onInsert={() => undefined} onClose={() => undefined} />);
    await act(async () => {
      fireEvent.click(screen.getByText('Preview prompt'));
    });
    expect(screen.queryByTestId('ai-preview')).not.toBeNull();
    fireEvent.change(screen.getByLabelText('SQL'), { target: { value: 'SELECT 3' } });
    expect(screen.queryByTestId('ai-preview')).toBeNull();
    expect(screen.queryByText('Send')).toBeNull();
  });
});
