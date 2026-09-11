export function DeploymentSteps() {
  return (
    <section className="deployment-guide">
      <h3>先选择如何获得服务端</h3>
      <p>桌面客户端连接 InfoHub 服务；服务负责保存资料、运行采集任务和连接 PostgreSQL。</p>
      <ol>
        <li>
          <strong>已有服务：</strong>向部署者取得 InfoHub 的 HTTPS
          地址，在“连接已有服务”中测试并保存，然后使用工作台主密码登录。
        </li>
        <li>
          <strong>自行部署：</strong>在装有 Docker Compose 的服务器取得项目源码。首次部署时复制{' '}
          <code>.env.example</code> 为 <code>.env</code>，填写独立的 <code>POSTGRES_PASSWORD</code>。
        </li>
      </ol>
      <p>在项目源码目录运行：</p>
      <pre className="response-body">
        {'docker compose up --build -d\ndocker compose ps\ncurl -fsS http://127.0.0.1:3210/api/health'}
      </pre>
      <p>
        健康检查成功后，本机浏览器打开 <code>http://127.0.0.1:3210</code> 创建主密码。远程访问需配置 HTTPS
        反向代理，将域名加入 <code>ALLOWED_ORIGINS</code>，然后在客户端填写该域名。
      </p>
      <details>
        <summary>连接失败时检查什么</summary>
        <ul>
          <li>连接被拒绝或超时：检查容器状态、端口、防火墙和地址是否可达。</li>
          <li>
            返回网页而非服务状态：确认反向代理把 <code>/api</code> 转发给 InfoHub。
          </li>
          <li>浏览器跨域错误：服务端允许来源需要包含实际网页或桌面应用的来源。</li>
          <li>数据库连接失败：查看应用日志，核对 PG 地址、账号、密码和 SSL 配置。</li>
        </ul>
      </details>
      <p className="muted">
        源码中的 <code>docs/deploy-docker.md</code>、<code>docs/deploy-external-pg.md</code> 和{' '}
        <code>docs/operations.md</code> 提供完整部署、升级和恢复步骤。PG 密码与工作台主密码是两个独立密码。
      </p>
    </section>
  );
}
