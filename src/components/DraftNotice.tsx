export function DraftNotice({
  draft,
}: {
  draft: {
    recovery: unknown;
    status: string;
    error: string;
    conflict: boolean;
    recover: () => void;
    discard: () => void;
    retry: () => void;
  };
}) {
  return (
    <>
      {!!draft.recovery && (
        <div className="draft-notice" role="status">
          <span>
            {draft.conflict ? '发现恢复草稿，正式内容已更新。恢复后请检查差异。' : '发现上次未保存的草稿。'}
          </span>
          <button type="button" onClick={draft.recover}>
            恢复草稿
          </button>
          <button type="button" onClick={draft.discard}>
            丢弃恢复草稿
          </button>
        </div>
      )}
      {draft.error ? (
        <div className="draft-status error" role="alert">
          {draft.error}{' '}
          <button type="button" onClick={draft.retry}>
            重试草稿同步
          </button>
        </div>
      ) : (
        draft.status && (
          <p className="draft-status" role="status">
            {draft.status}
          </p>
        )
      )}
    </>
  );
}
