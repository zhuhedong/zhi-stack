import { Plus, Trash2 } from 'lucide-react';
import type { ItemData } from '../types';
import { PairEditor } from './PairEditor';
import { useConfirm } from '../lib/confirmation';

export function ApiEnvironments({
  data,
  onChange,
}: {
  data: ItemData;
  onChange: (patch: Partial<ItemData>) => void;
}) {
  const confirm = useConfirm();
  const environments = data.environments || [];
  const current = environments.find((env) => env.id === data.activeEnvironment);
  return (
    <section className="environment-editor">
      <div className="section-title">
        <h3>请求环境</h3>
        <button
          disabled={environments.length >= 30}
          onClick={() => {
            const id = crypto.randomUUID();
            onChange({
              environments: [...environments, { id, name: '新环境', variables: [] }],
              activeEnvironment: id,
            });
          }}
        >
          <Plus size={13} />
          添加环境
        </button>
      </div>
      <p className="form-hint">
        用 {'{{baseUrl}}'}、{'{{token}}'}{' '}
        引用当前环境变量，支持基础地址、请求头、参数和正文。变量随接口配置加密保存；请在下方保存参数。
      </p>
      {current ? (
        <>
          <div className="form-grid">
            <label>
              环境名称
              <input
                value={current.name}
                onChange={(event) =>
                  onChange({
                    environments: environments.map((env) =>
                      env.id === current.id ? { ...env, name: event.target.value } : env,
                    ),
                  })
                }
              />
            </label>
            <button
              className="danger-text"
              onClick={async () => {
                if (
                  await confirm({
                    title: '删除请求环境',
                    description: `删除环境「${current.name}」及其变量？保存参数后生效。`,
                    confirmLabel: '删除环境',
                    danger: true,
                  })
                )
                  onChange({
                    environments: environments.filter((env) => env.id !== current.id),
                    activeEnvironment: '',
                  });
              }}
            >
              <Trash2 size={13} />
              删除当前环境
            </button>
          </div>
          <PairEditor
            title="环境变量"
            pairs={current.variables}
            onChange={(variables) =>
              onChange({
                environments: environments.map((env) =>
                  env.id === current.id ? { ...env, variables } : env,
                ),
              })
            }
          />
        </>
      ) : (
        <p className="muted">选择或添加环境后设置变量。默认环境使用接口中填写的原始值。</p>
      )}
    </section>
  );
}
